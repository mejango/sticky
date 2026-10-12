import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ethers from 'ethers';
import dotenv from 'dotenv';

const { Interface, defaultAbiCoder } = ethers.utils;
const relay = new Interface(['function exec(address module, bytes data)']);
const moduleAbi = new Interface([
  'function execute(((uint256 chainId,uint256 index,uint8 leafType,bytes data) leaf,bytes32[] proof)[] leaves)',
  'function activeMerkleRoot() view returns (bytes32)',
  'event SphinxActionSucceeded(bytes32 indexed merkleRoot,uint256 leafIndex)',
  'event SphinxActionFailed(bytes32 indexed merkleRoot,uint256 leafIndex)',
  'event SphinxMerkleRootFailed(bytes32 indexed merkleRoot,uint256 leafIndex)',
]);
const hex = value => `0x${BigInt(value).toString(16)}`;

export function execution(transaction) {
  const [module, data] = relay.decodeFunctionData('exec', transaction.input);
  const [leaves] = moduleAbi.decodeFunctionData('execute', data);
  if (!leaves.length) throw new Error('The transaction has no Sphinx execution leaves.');
  const chain = BigInt(transaction.chainId).toString();
  const actions = leaves.map(({ leaf }) => {
    if (leaf.chainId.toString() !== chain || leaf.leafType !== 1) throw new Error('Unexpected Sphinx execution leaf.');
    const [, , gas] = defaultAbiCoder.decode(['address', 'uint256', 'uint256', 'bytes', 'uint8', 'bool'], leaf.data);
    return { index: leaf.index.toString(), signedGas: gas.toString() };
  });
  if (new Set(actions.map(action => action.index)).size !== actions.length) throw new Error('Duplicate Sphinx execution index.');
  return { module, chain, actions };
}

// Replay exact signed calldata. A successful receipt is insufficient because Sphinx catches inner failures.
export async function diagnose({ transaction, block, root, rpc }) {
  const { module, chain, actions } = execution(transaction);
  if (!/^0x[\da-f]{64}$/i.test(root) || /^0x0{64}$/i.test(root)) throw new Error('A nonzero active root is required.');
  if (BigInt(block.number) + 1n !== BigInt(transaction.blockNumber)) throw new Error('Replay requires the pre-transaction block.');
  const expected = new Set(actions.map(action => action.index));
  const report = { chainId: chain, blockNumber: BigInt(block.number).toString(), blockHash: block.hash, root, module, actions, attempts: [] };
  const ceiling = BigInt(block.gasLimit);
  let budget = BigInt(transaction.gas);
  if (budget <= 0n || budget > ceiling) throw new Error('Invalid original gas budget.');
  for (let attempt = 0; attempt < 8; attempt++) {
    const call = { from: transaction.from, to: transaction.to, data: transaction.input, value: transaction.value ?? '0x0', gas: hex(budget) };
    const result = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [call] }], traceTransfers: false, validation: false, returnFullTransactions: false }, hex(block.number)]);
    const simulated = result?.[0]?.calls?.[0];
    if (!simulated || result.length !== 1 || result[0].calls.length !== 1 || !Array.isArray(simulated.logs)) throw new Error('Invalid live simulation response.');
    const succeeded = new Set();
    let failed = false;
    for (const log of simulated.logs) {
      if (log.address?.toLowerCase() !== module.toLowerCase()) continue;
      let event;
      try { event = moduleAbi.parseLog(log); } catch { continue; }
      if (event.name !== 'SphinxActionSucceeded') { failed = true; continue; }
      if (event.args.merkleRoot.toLowerCase() !== root.toLowerCase() || !expected.has(event.args.leafIndex.toString())) continue;
      succeeded.add(event.args.leafIndex.toString());
    }
    const success = BigInt(simulated.status ?? 0) === 1n && !failed && succeeded.size === expected.size;
    report.attempts.push({ outerGas: budget.toString(), gasUsed: BigInt(simulated.gasUsed ?? 0).toString(), success });
    if (success) return { ...report, sufficientOuterGas: budget.toString() };
    if (budget === ceiling) break;
    budget = budget * 2n > ceiling ? ceiling : budget * 2n;
  }
  return { ...report, sufficientOuterGas: null };
}

async function main() {
  const hash = process.argv[2];
  if (process.argv.length !== 3 || !/^0x[\da-f]{64}$/i.test(hash ?? '')) throw new Error('Usage: node script/live-gas.mjs <Sepolia transaction hash>');
  const env = { ...dotenv.parse(readFileSync(process.env.STICKY_ENV_FILE || '.env')), ...process.env };
  if (!env.RPC_ETHEREUM_SEPOLIA) throw new Error('RPC_ETHEREUM_SEPOLIA is required.');
  const rpc = async (method, params) => {
    let detail = '';
    try {
      const response = await fetch(env.RPC_ETHEREUM_SEPOLIA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(45_000) });
      const payload = await response.json();
      detail = ` (HTTP ${response.status}${Number.isInteger(payload.error?.code) ? `, RPC ${payload.error.code}` : ''})`;
      if (!response.ok || payload.error || !('result' in payload)) throw new Error();
      return payload.result;
    } catch { throw new Error(`Read-only ${method} failed${detail}; an archive RPC supporting eth_simulateV1 is required.`); }
  };
  const transaction = await rpc('eth_getTransactionByHash', [hash]);
  if (!transaction?.blockNumber || BigInt(transaction.chainId) !== 11155111n) throw new Error('A mined Sepolia transaction is required.');
  const block = await rpc('eth_getBlockByNumber', [hex(BigInt(transaction.blockNumber) - 1n), false]);
  const { module } = execution(transaction);
  const encodedRoot = await rpc('eth_call', [{ to: module, data: moduleAbi.encodeFunctionData('activeMerkleRoot') }, hex(block.number)]);
  const [root] = moduleAbi.decodeFunctionResult('activeMerkleRoot', encodedRoot);
  const report = await diagnose({ transaction, block, root, rpc });
  const pinned = await rpc('eth_getBlockByNumber', [hex(block.number), false]);
  if (pinned.hash !== block.hash) throw new Error('Historical block identity changed during replay.');
  console.log(JSON.stringify(report, null, 2));
  if (!report.sufficientOuterGas) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
