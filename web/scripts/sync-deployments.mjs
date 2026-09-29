import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getAddress, isAddress, zeroAddress } from 'viem'

// Sticky's contract addresses and scan start blocks come from the repository's
// verified deployment records. Railway builds from web/ alone, so the result is
// committed as src/lib/sticky-deployments.json. `--check` fails when a record
// changed and this script has not been run.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const RECORDS = join(webRoot, '..', 'deployments')
const OUTPUT = join(webRoot, 'src', 'lib', 'sticky-deployments.json')
const OUTPUT_NAME = 'web/src/lib/sticky-deployments.json'

// The fields of verified.json that sticky-addresses.ts exposes.
const ADDRESS_FIELDS = [
  'deployer',
  'hook',
  'terminal',
  'controller',
  'distributor',
  'rewardReceiverFactory',
  'autoStick',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function checksummed(value, name) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${name} must be an Ethereum address`)
  }
  const address = getAddress(value)
  if (address === zeroAddress) {
    throw new Error(`${name} must not be the zero address`)
  }
  return address
}

function hexNumber(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be a hex number`)
  }
  return BigInt(value)
}

function deploymentFrom(directory) {
  const record = readJson(join(directory, 'verified.json'))
  const deployer = readJson(join(directory, 'StickyDeployer.json'))
  const { chainId } = record
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('chainId must be a positive integer')
  }

  const addresses = Object.fromEntries(
    ADDRESS_FIELDS.map(field => [field, checksummed(record[field], field)]),
  )
  // The deployer has the same address on every chain, so the address alone
  // cannot show that its record belongs here. Its own chain id does.
  if (
    checksummed(deployer.address, 'StickyDeployer.json address') !==
    addresses.deployer
  ) {
    throw new Error('StickyDeployer.json and verified.json disagree')
  }
  if (
    hexNumber(deployer.chainId, 'StickyDeployer.json chainId') !==
    BigInt(chainId)
  ) {
    throw new Error('StickyDeployer.json is for another chain')
  }
  // Projects can only exist from the deployer's creation, so scans start there.
  const fromBlock = hexNumber(
    deployer.receipt?.blockNumber,
    'StickyDeployer.json receipt.blockNumber',
  )
  return { chainId, deployment: { ...addresses, fromBlock: String(fromBlock) } }
}

export function deploymentsFromRecords(root = RECORDS) {
  const byChain = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // The Solidity deployment tests write throwaway artifacts to _test.
    if (!entry.isDirectory() || entry.name === '_test') continue
    const directory = join(root, entry.name)
    if (!existsSync(join(directory, 'verified.json'))) continue
    try {
      const { chainId, deployment } = deploymentFrom(directory)
      if (byChain.has(chainId)) {
        const first = byChain.get(chainId).name
        throw new Error(`chain ${chainId} is already recorded in ${first}`)
      }
      byChain.set(chainId, { name: entry.name, deployment })
    } catch (error) {
      throw new Error(`${entry.name}: ${error.message}`)
    }
  }
  if (byChain.size === 0) {
    throw new Error(`no verified.json records found in ${root}`)
  }
  return Object.fromEntries(
    [...byChain]
      .sort(([a], [b]) => a - b)
      .map(([chainId, { deployment }]) => [String(chainId), deployment]),
  )
}

/** Writes the generated file, or with `check` throws when it is out of date. */
export function syncDeployments({
  check = false,
  records = RECORDS,
  output = OUTPUT,
} = {}) {
  const deployments = deploymentsFromRecords(records)
  const expected = `${JSON.stringify(deployments, null, 2)}\n`
  if (!check) {
    writeFileSync(output, expected)
    const count = Object.keys(deployments).length
    return `${OUTPUT_NAME} written for ${count} chains`
  }
  const current = existsSync(output) ? readFileSync(output, 'utf8') : ''
  if (current !== expected) {
    throw new Error(
      `${OUTPUT_NAME} is out of date; run "npm run deployments:sync" in web/`,
    )
  }
  return `${OUTPUT_NAME} matches the deployment records`
}

// Node resolves symlinks in the entry file's URL but not in argv[1], so compare
// real paths: a script that quietly does nothing would pass `--check`.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const args = process.argv.slice(2)
  try {
    if (args.some(arg => arg !== '--check')) {
      throw new Error('usage: sync-deployments.mjs [--check]')
    }
    process.stdout.write(`${syncDeployments({ check: args.length > 0 })}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
