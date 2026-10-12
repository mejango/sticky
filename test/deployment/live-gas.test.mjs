import assert from 'node:assert/strict';
import test from 'node:test';
import ethers from 'ethers';
import { diagnose, execution } from '../../script/live-gas.mjs';

const { Interface, defaultAbiCoder } = ethers.utils;
const module = `0x${'11'.repeat(20)}`;
const root = `0x${'22'.repeat(32)}`;
const abi = new Interface([
  'function execute(((uint256 chainId,uint256 index,uint8 leafType,bytes data) leaf,bytes32[] proof)[] leaves)',
  'event SphinxActionSucceeded(bytes32 indexed merkleRoot,uint256 leafIndex)',
  'event SphinxActionFailed(bytes32 indexed merkleRoot,uint256 leafIndex)',
  'event SphinxMerkleRootFailed(bytes32 indexed merkleRoot,uint256 leafIndex)',
]);
const relay = new Interface(['function exec(address module,bytes data)']);
const data = defaultAbiCoder.encode(['address', 'uint256', 'uint256', 'bytes', 'uint8', 'bool'], [module, 0, 3_026_638, '0x1234', 0, true]);
const input = relay.encodeFunctionData('exec', [module, abi.encodeFunctionData('execute', [[{ leaf: { chainId: 11155111, index: 1, leafType: 1, data }, proof: [] }]])]);
const transaction = { from: module, to: module, input, value: '0x0', gas: '0x400000', chainId: '0xaa36a7', blockNumber: '0x101' };
const block = { number: '0x100', hash: root, gasLimit: '0x4000000' };
const event = (name, eventRoot = root, index = 1, address = module) => ({ address, ...abi.encodeEventLog(abi.getEvent(name), [eventRoot, index]) });
const simulation = (logs, status = '0x1') => [{ calls: [{ logs, status, gasUsed: '0x1234' }] }];

test('outer success containing caught inner failure is rejected, adequate reservoir succeeds without modifying signed calldata', async () => {
  const seen = [];
  const report = await diagnose({ transaction, block, root, rpc: async (method, params) => {
    assert.equal(method, 'eth_simulateV1');
    assert.equal(params[1], block.number);
    const call = params[0].blockStateCalls[0].calls[0];
    assert.deepEqual({ ...call, gas: transaction.gas }, { from: transaction.from, to: transaction.to, data: input, value: transaction.value, gas: transaction.gas });
    seen.push(BigInt(call.gas));
    return seen.length < 4 ? simulation([event('SphinxActionFailed'), event('SphinxMerkleRootFailed')]) : simulation([event('SphinxActionSucceeded')]);
  } });
  assert.deepEqual(seen, [4_194_304n, 8_388_608n, 16_777_216n, 33_554_432n]);
  assert.equal(report.sufficientOuterGas, '33554432');
  assert.deepEqual(report.attempts.map(attempt => attempt.success), [false, false, false, true]);
  assert.equal(report.actions[0].signedGas, '3026638');
});

test('wrong root, leaf index, event emitter, missing events, failed status, and root failure cannot establish execution', async () => {
  for (const result of [
    simulation([event('SphinxActionSucceeded', `0x${'33'.repeat(32)}`)]),
    simulation([event('SphinxActionSucceeded', root, 2)]),
    simulation([event('SphinxActionSucceeded', root, 1, `0x${'44'.repeat(20)}`)]),
    simulation([]), simulation([event('SphinxActionSucceeded')], '0x0'),
    simulation([event('SphinxActionSucceeded'), event('SphinxMerkleRootFailed')]),
  ]) {
    let attempts = 0;
    const report = await diagnose({ transaction, block, root, rpc: async () => { attempts++; return result; } });
    assert.equal(report.sufficientOuterGas, null);
    assert.equal(attempts, 5);
    assert.equal(report.attempts.at(-1).outerGas, BigInt(block.gasLimit).toString());
  }
});

test('simulation response and historical execution identity fail closed', async () => {
  await assert.rejects(diagnose({ transaction, block: { ...block, number: '0x99' }, root, rpc: async () => { assert.fail('must not call RPC'); } }), /pre-transaction/);
  await assert.rejects(diagnose({ transaction, block, root, rpc: async () => [] }), /Invalid live simulation/);
  await assert.rejects(diagnose({ transaction, block, root: `0x${'00'.repeat(32)}`, rpc: async () => [] }), /nonzero active root/);
  assert.throws(() => execution({ ...transaction, chainId: '0x1' }), /Unexpected Sphinx execution leaf/);
});
