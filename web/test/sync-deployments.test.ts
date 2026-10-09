// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getContractAddress, zeroAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deploymentsFromRecords,
  collectorsFromRecords,
  syncDeployments,
} from '../scripts/sync-deployments.mjs'

const script = fileURLToPath(
  new URL('../scripts/sync-deployments.mjs', import.meta.url),
)

const addresses = {
  deployer: '0xdA38Ec48B5b1d186B02BA99F297e95153BEE33a9',
  hook: '0xa8DcD735031cf96C4213D9A3f66a1DFFDCdba693',
  terminal: '0x130f5Dd2bD8805443Cf41755253D778a75a67f53',
  controller: '0x3Fcec3572e84b624477BcfF4E2CF1f7dEAb648F1',
  distributor: '0xc62b3fED668Cd8a3879ba34890a67C48a52b1Bb8',
  rewardReceiverFactory: '0x41AEC7AacEa4759F2c8AaBD68D4a4C1574A6A737',
  autoStick: '0x9B091e21d25c424De67751F4b6Ae8494351218C5',
}

// One letter's case flipped: a valid checksum turned into an invalid one.
const mistyped = addresses.controller.replace('3Fcec', '3fcec')

type Overrides = {
  verified?: Record<string, unknown>
  deployer?: Record<string, unknown>
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sticky-records-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes the two records the generator reads for one chain. */
function record(
  name: string,
  chainId: number,
  block: number,
  overrides: Overrides = {},
) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'verified.json'),
    JSON.stringify({ chainId, ...addresses, ...overrides.verified }),
  )
  writeFileSync(
    join(directory, 'StickyDeployer.json'),
    JSON.stringify({
      address: addresses.deployer.toLowerCase(),
      chainId: `0x${chainId.toString(16)}`,
      receipt: { blockNumber: `0x${block.toString(16)}` },
      ...overrides.deployer,
    }),
  )
}

describe('deploymentsFromRecords', () => {
  it('sorts by chain id and checksums addresses, with the block in decimal', () => {
    const lowercase = Object.fromEntries(
      Object.entries(addresses).map(([field, value]) => [
        field,
        value.toLowerCase(),
      ]),
    )
    record('a-base', 8453, 51791252, { verified: lowercase })
    record('b-ethereum', 1, 26057164)

    const deployments = deploymentsFromRecords(root)

    expect(Object.keys(deployments)).toEqual(['1', '8453'])
    expect(deployments['8453']).toEqual({ ...addresses, fromBlock: '51791252' })
    expect(Object.keys(deployments['8453'])).toEqual([
      'deployer',
      'hook',
      'terminal',
      'controller',
      'distributor',
      'rewardReceiverFactory',
      'autoStick',
      'fromBlock',
    ])
  })

  it('skips _test and folders without a verified record', () => {
    record('_test', 31337, 1)
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'README.md'), '')
    record('base', 8453, 51791252)

    expect(Object.keys(deploymentsFromRecords(root))).toEqual(['8453'])
  })

  it.each<[string, Overrides, string]>([
    [
      'the zero address',
      { verified: { hook: zeroAddress } },
      'base: hook must not be the zero address',
    ],
    [
      'a malformed address',
      { verified: { terminal: '0x1234' } },
      'base: terminal must be an Ethereum address',
    ],
    [
      'a mistyped checksum',
      { verified: { controller: mistyped } },
      'base: controller must be an Ethereum address',
    ],
    [
      'a missing address',
      { verified: { autoStick: undefined } },
      'base: autoStick must be an Ethereum address',
    ],
    [
      'a chain id that is not a positive integer',
      { verified: { chainId: '8453' } },
      'base: chainId must be a positive integer',
    ],
    [
      'a deployer record for another deployer',
      { deployer: { address: addresses.hook } },
      'base: StickyDeployer.json and verified.json disagree',
    ],
    [
      'a deployer record from another chain',
      { deployer: { chainId: '0xa' } },
      'base: StickyDeployer.json is for another chain',
    ],
    [
      'a creation block that is not a hex number',
      { deployer: { receipt: { blockNumber: 'latest' } } },
      'base: StickyDeployer.json receipt.blockNumber must be a hex number',
    ],
  ])('refuses %s', (_case, overrides, message) => {
    record('base', 8453, 51791252, overrides)

    expect(() => deploymentsFromRecords(root)).toThrow(message)
  })

  it('refuses a missing deployer record', () => {
    record('base', 8453, 51791252)
    rmSync(join(root, 'base', 'StickyDeployer.json'))

    expect(() => deploymentsFromRecords(root)).toThrow(
      /^base: ENOENT.*StickyDeployer\.json/,
    )
  })

  it('refuses two records for one chain', () => {
    record('base', 8453, 51791252)
    record('base-copy', 8453, 51791252)

    expect(() => deploymentsFromRecords(root)).toThrow(
      /chain 8453 is already recorded in base/,
    )
  })

  it('refuses to find nothing', () => {
    expect(() => deploymentsFromRecords(root)).toThrow(
      'no verified.json records found',
    )
  })
})

describe('syncDeployments', () => {
  it('writes the file, then finds it up to date', () => {
    record('base', 8453, 51791252)
    record('ethereum', 1, 26057164)
    const output = join(root, 'sticky-deployments.json')

    expect(syncDeployments({ records: root, output })).toContain(
      'written for 2 chains',
    )
    expect(readFileSync(output, 'utf8')).toBe(
      `${JSON.stringify(deploymentsFromRecords(root), null, 2)}\n`,
    )
    expect(syncDeployments({ check: true, records: root, output })).toContain(
      'matches the deployment records',
    )
  })

  it('fails the check when the file is missing or a record has changed', () => {
    record('base', 8453, 51791252)
    const output = join(root, 'sticky-deployments.json')

    expect(() =>
      syncDeployments({ check: true, records: root, output }),
    ).toThrow('is out of date')
    syncDeployments({ records: root, output })
    record('base', 8453, 51791253)
    expect(() =>
      syncDeployments({ check: true, records: root, output }),
    ).toThrow('is out of date')
  })

  it('writes nothing when the records are refused', () => {
    const output = join(root, 'sticky-deployments.json')

    expect(() => syncDeployments({ records: root, output })).toThrow()
    expect(existsSync(output)).toBe(false)
  })
})

describe('sync-deployments.mjs', () => {
  it('refuses an unknown flag instead of rewriting the file', () => {
    const { status, stderr } = spawnSync(process.execPath, [script, '--chek'], {
      encoding: 'utf8',
    })

    expect(status).toBe(1)
    expect(stderr).toContain('usage: sync-deployments.mjs [--check]')
  })
})

const collector = '0x1111111111111111111111111111111111111111'
const feePayer = getContractAddress({ from: collector, nonce: 1n })
const codeHash = `0x${'12'.repeat(32)}`
const sourceBindings = {
  registry: addresses.deployer, tokens: addresses.hook, directory: addresses.terminal,
  rewardReceiverFactory: addresses.rewardReceiverFactory,
}

function family(source: string, sourceChainId: number, home = 1, overrides: Record<string, unknown> = {}) {
  const directory = join(root, source, 'source-collectors', String(home))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'verified.json'), JSON.stringify({
    kind: 'verified', chainId: sourceChainId, destinationChainId: home,
    sourceCollector: collector, sourceFeePayer: feePayer,
    sourceCollectorCodehash: codeHash, sourceFeePayerCodehash: codeHash,
    ...sourceBindings, ...overrides,
  }))
  for (const [name, address, args] of [
    ['StickySourceCollector', collector, [sourceBindings.registry, sourceBindings.tokens, sourceBindings.rewardReceiverFactory, String(home)]],
    ['StickySourceFeePayer', feePayer, []],
  ] as const) {
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({
      contractName: name, address, args, chainId: `0x${sourceChainId.toString(16)}`, destinationChainId: home,
      receipt: { status: '0x1', transactionHash: codeHash, blockHash: codeHash, blockNumber: '0x10' },
    }))
  }
  return directory
}

describe('collectorsFromRecords', () => {
  beforeEach(() => {
    record('ethereum', 1, 1)
    record('base', 8453, 2)
  })

  it('publishes only executed verified families, with the source and home explicitly bound', () => {
    family('base', 8453)
    family('ethereum', 1)
    expect(collectorsFromRecords(root)).toEqual([1, 8453].map(sourceChainId => ({
      sourceChainId, destinationChainId: 1, address: collector, feePayer,
      runtimeCodeHash: codeHash, feePayerRuntimeCodeHash: codeHash,
      registry: sourceBindings.registry, tokens: sourceBindings.tokens, directory: sourceBindings.directory,
      receiverFactory: addresses.rewardReceiverFactory,
    })))
  })

  it('does not promote rehearsal records or a legacy flat collector to live configuration', () => {
    const directory = family('base', 8453)
    const verified = readFileSync(join(directory, 'verified.json'))
    rmSync(join(directory, 'verified.json'))
    writeFileSync(join(directory, 'simulation.json'), verified)
    writeFileSync(join(root, 'base', 'StickySourceCollector.json'), readFileSync(join(directory, 'StickySourceCollector.json')))
    const flatPath = join(root, 'base', 'verified.json')
    writeFileSync(flatPath, JSON.stringify({ ...JSON.parse(readFileSync(flatPath, 'utf8')), sourceCollector: collector }))
    expect(collectorsFromRecords(root)).toEqual([])
  })

  it.each([
    { kind: 'simulation' }, { destinationChainId: 10 }, { chainId: 1 },
    { chainId: 10 }, { sourceCollectorCodehash: '0x123' },
    { sourceFeePayerCodehash: `0x${'00'.repeat(32)}` },
    { rewardReceiverFactory: addresses.hook }, { sourceFeePayer: collector },
  ])('rejects mismatched or incomplete verified evidence: %j', overrides => {
    family('base', 8453, 1, overrides)
    expect(() => collectorsFromRecords(root)).toThrow()
  })

  it.each([
    { chainId: '0x1' }, { destinationChainId: 10 }, { address: addresses.hook },
    { args: [sourceBindings.registry, sourceBindings.tokens, sourceBindings.rewardReceiverFactory, '10'] },
    { receipt: { status: '0x0', transactionHash: codeHash, blockHash: codeHash, blockNumber: '0x10' } },
  ])('rejects an artifact that does not prove the reviewed family: %j', overrides => {
    const directory = family('base', 8453)
    const path = join(directory, 'StickySourceCollector.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...overrides }))
    expect(() => collectorsFromRecords(root)).toThrow('artifact does not match')
  })

  it('requires the same complete family identity on each source chain', () => {
    family('ethereum', 1)
    family('base', 8453, 1, { sourceCollectorCodehash: `0x${'34'.repeat(32)}` })
    expect(() => collectorsFromRecords(root)).toThrow('differs across source chains')
  })

  it.each(['transactionHash', 'blockHash'])('rejects a zero creation %s', field => {
    const directory = family('base', 8453)
    const path = join(directory, 'StickySourceFeePayer.json')
    const artifact = JSON.parse(readFileSync(path, 'utf8'))
    artifact.receipt[field] = `0x${'00'.repeat(32)}`
    writeFileSync(path, JSON.stringify(artifact))
    expect(() => collectorsFromRecords(root)).toThrow('artifact does not match')
  })

  it.each([
    { transactionHash: `0x${'34'.repeat(32)}` },
    { blockHash: `0x${'34'.repeat(32)}` },
    { blockNumber: '0x11' }, { blockNumber: '0x0' },
  ])('requires parent and child evidence from one nonzero creation block: %j', overrides => {
    const directory = family('base', 8453)
    const path = join(directory, 'StickySourceFeePayer.json')
    const artifact = JSON.parse(readFileSync(path, 'utf8'))
    artifact.receipt = { ...artifact.receipt, ...overrides }
    writeFileSync(path, JSON.stringify(artifact))
    expect(() => collectorsFromRecords(root)).toThrow('share one successful creation transaction')
  })

  it('requires a verified home-chain deployment', () => {
    family('base', 8453, 10)
    expect(() => collectorsFromRecords(root)).toThrow('both source and home')
  })

  it('fails synchronization before writing either output when family evidence is invalid', () => {
    family('base', 8453, 1, { kind: 'simulation' })
    const output = join(root, 'sticky-deployments.json')
    expect(() => syncDeployments({ records: root, output })).toThrow()
    expect(existsSync(output)).toBe(false)
    expect(existsSync(join(root, 'sticky-source-collectors.json'))).toBe(false)
  })

  it('checks collector configuration independently of the existing singleton records', () => {
    const output = join(root, 'sticky-deployments.json')
    syncDeployments({ records: root, output })
    expect(readFileSync(join(root, 'sticky-source-collectors.json'), 'utf8')).toBe('[]\n')
    family('base', 8453)
    expect(() => syncDeployments({ check: true, records: root, output })).toThrow('sticky-source-collectors.json is out of date')
    syncDeployments({ records: root, output })
    expect(syncDeployments({ check: true, records: root, output })).toContain('matches')
  })
})
