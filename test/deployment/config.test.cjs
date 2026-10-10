const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const { checkRequiredTomlOptions } = require('@sphinx-labs/plugins/dist/foundry/options')
const { readSphinxLock } = require('@sphinx-labs/core')
const { getGnosisSafeProxyAddress } = require('@sphinx-labs/contracts')
const { assertValidVersions, getSphinxConfigFromScript, readInterface, validateProposalNetworks } = require('@sphinx-labs/plugins/dist/foundry/utils')

const EXPECTED_SAFE = '0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437'

async function withIsolatedFoundryOutput(callback) {
  const root = mkdtempSync(join(tmpdir(), 'sticky-sphinx-config-'))
  const previous = Object.fromEntries(['FOUNDRY_CACHE_PATH', 'FOUNDRY_OUT', 'FOUNDRY_PROFILE']
    .map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    FOUNDRY_CACHE_PATH: join(root, 'cache'),
    FOUNDRY_OUT: join(root, 'out'),
    FOUNDRY_PROFILE: 'deploy',
  })
  try {
    return await callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

// Exercise the installed Sphinx validator and its real JSON-RPC client without contacting public networks.
test('Sphinx accepts both configured network groups and the required Foundry artifact output', async () => {
  const result = spawnSync('forge', ['config', '--json'], { encoding: 'utf8', env: { ...process.env, FOUNDRY_PROFILE: 'deploy' } })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  checkRequiredTomlOptions({ extraOutput: config.extra_output })
  assert.equal(config.isolate, false, "Sphinx deployment profile must use its compatible call model")
  assert.equal(config.deny, 'notes', 'Sphinx deployment builds must reject compiler warnings and notes')
  assert.equal(config.lint.lint_on_build, false, 'Sphinx deployment builds must not lint non-production fixtures')

  const defaultResult = spawnSync('forge', ['config', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FOUNDRY_PROFILE: 'default' },
  })
  assert.equal(defaultResult.status, 0, defaultResult.stderr)
  assert.equal(JSON.parse(defaultResult.stdout).lint.lint_on_build, false, 'builds must use the V6 lint convention')

  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.equal(scripts['lint:solidity'], 'PATH=$HOME/.foundry/versions/v1.8.1:$PATH forge lint --deny notes src')
  assert.match(scripts['test:deployment'], /^npm run lint:solidity && /)
  assert.match(scripts['test:deployment'], /FOUNDRY_PROFILE=deploy forge build --force script\/Deploy\.s\.sol/)
  assert.doesNotMatch(scripts['test:deployment'], /--contracts/)

  const source = readFileSync('script/Deploy.s.sol', 'utf8')
  const mainnets = JSON.parse(source.match(/sphinxConfig\.mainnets\s*=\s*(\[[^;]+\]);/)[1])
  const testnets = JSON.parse(source.match(/sphinxConfig\.testnets\s*=\s*(\[[^;]+\]);/)[1])
  const chainIds = {
    ethereum: 1, optimism: 10, base: 8453, arbitrum: 42161,
    ethereum_sepolia: 11155111, optimism_sepolia: 11155420,
    base_sepolia: 84532, arbitrum_sepolia: 421614,
  }
  const requested = new Set()
  const server = createServer(async (req, res) => {
    const alias = req.url.slice(1)
    assert.ok(chainIds[alias], `Unexpected RPC alias: ${alias}`)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks))
    const answer = (request) => {
      assert.equal(request.method, 'eth_chainId')
      requested.add(alias)
      return { jsonrpc: '2.0', id: request.id, result: `0x${chainIds[alias].toString(16)}` }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const endpoints = Object.fromEntries(Object.keys(chainIds).map((alias) => {
      assert.ok(config.rpc_endpoints[alias], `Missing Foundry RPC mapping: ${alias}`)
      return [alias, `http://127.0.0.1:${server.address().port}/${alias}`]
    }))
    const mainnet = await validateProposalNetworks(['mainnets'], testnets, mainnets, endpoints)
    assert.equal(mainnet.isTestnet, false)
    assert.equal(mainnet.rpcUrls.length, 4)
    const testnet = await validateProposalNetworks(['testnets'], testnets, mainnets, endpoints)
    assert.equal(testnet.isTestnet, true)
    assert.equal(testnet.rpcUrls.length, 4)
    assert.deepEqual([...requested].sort(), Object.keys(chainIds).sort())
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

// This invokes Sphinx's own local compatibility probe; it does not collect a proposal or use an RPC.
test('the installed Sphinx library and pinned Foundry state-diff recorder are compatible', async () => {
  await withIsolatedFoundryOutput(async () => {
    await assertValidVersions('script/Deploy.s.sol', 'Deploy')
  })
})

// Load the committed public organization/project through Sphinx's own readers and resolve its Safe locally.
test('Sphinx loads the reviewed V6 project and Safe without a proposal or RPC', async () => {
  const lock = await readSphinxLock()
  const source = readFileSync('script/Deploy.s.sol', 'utf8')
  const projectName = source.match(/sphinxConfig\.projectName\s*=\s*"([^"]+)"/)[1]
  assert.equal(projectName, 'sticky')
  const project = lock.projects[projectName]
  assert.equal(project.projectName, projectName)
  await withIsolatedFoundryOutput(async () => {
    const config = await getSphinxConfigFromScript(
      'script/Deploy.s.sol', readInterface('out', 'SphinxPluginTypes'), 'Deploy',
    )
    assert.equal(config.projectName, projectName)
    assert.equal(config.safeAddress.toLowerCase(), EXPECTED_SAFE.toLowerCase())
    assert.equal(config.safeAddress.toLowerCase(), getGnosisSafeProxyAddress(
      project.defaultSafe.owners, project.defaultSafe.threshold, project.defaultSafe.saltNonce,
    ).toLowerCase())
  })
})
