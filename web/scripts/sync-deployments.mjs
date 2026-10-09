import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getAddress, getContractAddress, isAddress, isHash, zeroAddress } from 'viem'

// Sticky's contract addresses and scan start blocks come from the repository's
// verified deployment records. Railway builds from web/ alone, so the result is
// committed as src/lib/sticky-deployments.json. `--check` fails when a record
// changed and this script has not been run.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const RECORDS = join(webRoot, '..', 'deployments')
const OUTPUT = join(webRoot, 'src', 'lib', 'sticky-deployments.json')
const OUTPUT_NAME = 'web/src/lib/sticky-deployments.json'
const COLLECTOR_OUTPUT_NAME = 'sticky-source-collectors.json'

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

function nonzeroHash(value) {
  return typeof value === 'string' && isHash(value) && !/^0x0+$/.test(value)
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

/** Only executed, verified destination families enter client configuration. Rehearsals stay out. */
export function collectorsFromRecords(root = RECORDS) {
  const deployments = deploymentsFromRecords(root)
  const families = new Map()
  const records = []
  const keys = new Set()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_test') continue
    const directory = join(root, entry.name)
    const familyRoot = join(directory, 'source-collectors')
    if (!existsSync(familyRoot)) continue
    for (const family of readdirSync(familyRoot, { withFileTypes: true })) {
      if (!family.isDirectory()) continue
      const path = join(familyRoot, family.name)
      if (!existsSync(join(path, 'verified.json'))) continue
      try {
        const record = readJson(join(path, 'verified.json'))
        const sourceChainId = record.chainId
        const destinationChainId = record.destinationChainId
        if (record.kind !== 'verified' || !Number.isSafeInteger(sourceChainId) || sourceChainId <= 0 ||
          !Number.isSafeInteger(destinationChainId) || destinationChainId <= 0 || String(destinationChainId) !== family.name) {
          throw new Error('a verified record must identify its source and home chain')
        }
        if (readJson(join(directory, 'verified.json')).chainId !== sourceChainId) {
          throw new Error('the family record belongs to another source chain')
        }
        if (!deployments[sourceChainId] || !deployments[destinationChainId]) {
          throw new Error('both source and home Sticky deployments must be verified')
        }
        const deployment = {
          sourceChainId, destinationChainId,
          address: checksummed(record.sourceCollector, 'sourceCollector'),
          runtimeCodeHash: record.sourceCollectorCodehash,
          feePayer: checksummed(record.sourceFeePayer, 'sourceFeePayer'),
          feePayerRuntimeCodeHash: record.sourceFeePayerCodehash,
          registry: checksummed(record.registry, 'registry'),
          tokens: checksummed(record.tokens, 'tokens'),
          directory: checksummed(record.directory, 'directory'),
          receiverFactory: checksummed(record.rewardReceiverFactory, 'rewardReceiverFactory'),
        }
        if (![deployment.runtimeCodeHash, deployment.feePayerRuntimeCodeHash].every(nonzeroHash)) {
          throw new Error('the collector and fee payer must have verified runtime hashes')
        }
        if (deployment.receiverFactory !== deployments[sourceChainId].rewardReceiverFactory ||
          deployment.receiverFactory !== deployments[destinationChainId].rewardReceiverFactory) {
          throw new Error('the source and home receiver factories disagree')
        }
        if (getContractAddress({ from: deployment.address, nonce: 1n }) !== deployment.feePayer) {
          throw new Error('the fee payer is not the collector constructor child')
        }
        let creation
        for (const [name, expectedAddress, expectedArgs] of [
          ['StickySourceCollector', deployment.address, [deployment.registry, deployment.tokens, deployment.receiverFactory, String(destinationChainId)]],
          ['StickySourceFeePayer', deployment.feePayer, []],
        ]) {
          const artifact = readJson(join(path, `${name}.json`))
          if (checksummed(artifact.address, `${name} address`) !== expectedAddress ||
            hexNumber(artifact.chainId, `${name} chainId`) !== BigInt(sourceChainId) ||
            artifact.destinationChainId !== destinationChainId || artifact.contractName !== name ||
            artifact.receipt?.status !== '0x1' || !nonzeroHash(artifact.receipt?.transactionHash) ||
            !nonzeroHash(artifact.receipt?.blockHash) ||
            !Array.isArray(artifact.args) || artifact.args.length !== expectedArgs.length ||
            artifact.args.some((arg, index) => typeof arg !== 'string' || arg.toLowerCase() !== expectedArgs[index].toLowerCase())) {
            throw new Error(`${name} artifact does not match the executed destination family`)
          }
          const blockNumber = hexNumber(artifact.receipt.blockNumber, `${name} receipt.blockNumber`)
          const receipt = `${artifact.receipt.transactionHash.toLowerCase()}:${artifact.receipt.blockHash.toLowerCase()}:${blockNumber}`
          if (blockNumber === 0n || (creation !== undefined && creation !== receipt)) {
            throw new Error('the collector and fee payer must share one successful creation transaction')
          }
          creation = receipt
        }
        const key = `${sourceChainId}:${destinationChainId}`
        if (keys.has(key)) throw new Error(`duplicate source/home family ${key}`)
        keys.add(key)
        const identity = { ...deployment }
        delete identity.sourceChainId
        const serialized = JSON.stringify(identity)
        if (families.has(destinationChainId) && families.get(destinationChainId) !== serialized) {
          throw new Error('the same home-chain family differs across source chains')
        }
        families.set(destinationChainId, serialized)
        records.push(deployment)
      } catch (error) {
        throw new Error(`${entry.name}/source-collectors/${family.name}: ${error.message}`)
      }
    }
  }
  return records.sort((a, b) => a.sourceChainId - b.sourceChainId || a.destinationChainId - b.destinationChainId)
}

/** Writes the generated file, or with `check` throws when it is out of date. */
export function syncDeployments({
  check = false,
  records = RECORDS,
  output = OUTPUT,
  collectorOutput = join(dirname(output), COLLECTOR_OUTPUT_NAME),
} = {}) {
  const deployments = deploymentsFromRecords(records)
  const collectors = collectorsFromRecords(records)
  const expected = `${JSON.stringify(deployments, null, 2)}\n`
  const expectedCollectors = `${JSON.stringify(collectors, null, 2)}\n`
  if (!check) {
    writeFileSync(output, expected)
    writeFileSync(collectorOutput, expectedCollectors)
    const count = Object.keys(deployments).length
    return `${OUTPUT_NAME} written for ${count} chains`
  }
  const current = existsSync(output) ? readFileSync(output, 'utf8') : ''
  if (current !== expected) {
    throw new Error(
      `${OUTPUT_NAME} is out of date; run "npm run deployments:sync" in web/`,
    )
  }
  if (!existsSync(collectorOutput) || readFileSync(collectorOutput, 'utf8') !== expectedCollectors) {
    throw new Error(`${COLLECTOR_OUTPUT_NAME} is out of date; run "npm run deployments:sync" in web/`)
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
