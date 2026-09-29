const { test } = require("node:test");
const assert = require("node:assert/strict");
const Runtime = require("../runtime.js");
const { address, assetUrl, deployment, withoutFixtures, jsonRpc, logs, statedRange } = Runtime;
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const abi = vm.runInNewContext(source.slice(source.indexOf('const strip ='), source.indexOf('// ------------------------------------------------------------- rpc plumbing'))
  + '\n({word, encAddress, decUint, decAddress, decString, decTranches, encode, hexToBytes})', {TextEncoder, TextDecoder});

test("metadata image URLs cannot inject markup or execute scripts", () => {
  assert.equal(assetUrl('javascript:alert(1)'), null);
  assert.equal(assetUrl('data:image/svg+xml,<svg onload="alert(1)">'), null);
  assert.equal(assetUrl('https://user:secret@example.com/logo'), null);
  assert.equal(assetUrl('ipfs://ipfs/bafy/logo.png'), 'https://juicebox.center/ipfs/bafy/logo.png');
  assert.equal(assetUrl('artizen.jpg', true), 'artizen.jpg');
  assert.equal(assetUrl('artizen.jpg'), null);
  assert.equal(assetUrl('../private.png', true), null);
  assert.equal(assetUrl('//evil.example/a.png', true), null);
  assert.equal(assetUrl('javascript:alert(1)', true), null);
  assert.equal(assetUrl('https://example.com/\" onerror=\"alert(1)'), 'https://example.com/%22%20onerror=%22alert(1)');
  assert.throws(() => address('0x' + '0'.repeat(40)));
});
test("a generated default deployment never enables an unconfigured chain", () => {
  const config = {defaultChainId:1,deployer:'main',distributor:'reward',chains:{1:{deployer:'main'},10:{rpcUrl:'op'}}};
  assert.equal(deployment(config,1).deployer,'main');
  assert.equal(deployment(config,10).deployer,undefined);
  assert.equal(deployment(config,10).distributor,undefined);
  assert.equal(deployment(config,8453).deployer,undefined);
  assert.equal(deployment({...config,chains:{10:{deployer:'op'}}},10).deployer,'op');
  assert.equal(deployment({deployer:'legacy',chains:{}},10).deployer,'legacy');
  assert.equal(deployment({deployer:'legacy',chains:{10:{deployer:''}}},10).deployer,'');
});
test("live configs drop demo fixtures; demo and local-mode loopback configs keep them", () => {
  const fixtures = {demoHomeStickiest:[{id:41}],demoHomeAirdrops:[{}],demoChartHistory:[{}],usdPriceOverrides:{a:'1'},
    logoOverrides:{a:'x.png'},projectNameOverrides:{1:'X'},projectChainOverrides:{1:[1]}};
  const live = withoutFixtures({deployer:'main',chains:{1:{}},...fixtures}, 'sticky.center');
  assert.deepEqual(live, {deployer:'main',chains:{1:{}}});
  assert.deepEqual(withoutFixtures({demoMode:true,...fixtures}, 'sticky.center'), {demoMode:true,...fixtures});
  assert.deepEqual(withoutFixtures({localMode:true,...fixtures}, '127.0.0.1'), {localMode:true,...fixtures});
  assert.equal(withoutFixtures({localMode:true,...fixtures}, 'sticky.center').demoHomeStickiest, undefined);
  assert.equal(withoutFixtures({localMode:'true',...fixtures}, 'localhost').logoOverrides, undefined);
});
test("RPC rejects HTTP, malformed and missing-result responses while preserving reverts", async () => {
  const fetch = body => async () => ({ ok: true, json: async () => body });
  await assert.rejects(jsonRpc('rpc', 'eth_call', [], { fetch: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(jsonRpc('rpc', 'eth_call', [], { fetch: fetch({}) }), /no result/);
  await assert.rejects(jsonRpc('rpc', 'eth_call', [], { fetch: fetch({ error: { code: 3, message: 'execution reverted', data: '0x1234' } }) }), error => error.code === 3 && error.data === '0x1234');
  assert.equal(await jsonRpc('rpc', 'eth_call', [], { fetch: fetch({ result: null }) }), null);
});
test("range-limited logs are complete, ordered and deduplicated", async () => {
  const entry = n => ({ blockNumber: `0x${n.toString(16)}`, blockHash: `block${n}`, logIndex: '0x0', transactionHash: `tx${n}` });
  const result = await logs(async (method, [filter] = []) => {
    if (method === 'eth_blockNumber') return '0x7';
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    if (to - from > 2) throw new Error('block range exceeds limit');
    return Array.from({ length: to - from + 1 }, (_, i) => entry(to - i)).flatMap(row => [row, row]);
  }, { fromBlock: '0x2' });
  assert.deepEqual(result.map(row => Number(BigInt(row.blockNumber))), [2, 3, 4, 5, 6, 7]);
});
test("a JSON-RPC error sent with a non-2xx status reaches the caller with the node's message", async () => {
  // base.org answers an oversized log range with HTTP 413 and a JSON-RPC error body.
  const body = { jsonrpc: '2.0', id: 1, error: { code: -32614, message: 'eth_getLogs is limited to a 1,000 range' } };
  await assert.rejects(jsonRpc('rpc', 'eth_getLogs', [], { fetch: async () => ({ ok: false, status: 413, json: async () => body }) }),
    error => error.message === 'eth_getLogs is limited to a 1,000 range' && error.code === -32614 && error.status === 413);
  await assert.rejects(jsonRpc('rpc', 'eth_call', [], { fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('html'); } }) }),
    error => /HTTP 502/.test(error.message) && error.status === 502);
});
test("a node's stated log range is read from its error text", () => {
  assert.equal(statedRange('eth_getLogs is limited to a 1,000 range'), 1000n);
  assert.equal(statedRange('eth_getLogs is limited to a 2,000 range'), 2000n);
  assert.equal(statedRange('exceed maximum block range: 5000'), 5000n);
  assert.equal(statedRange('block range exceeds limit'), 0n);
  assert.equal(statedRange('query returned more than 10000 results'), 0n);
  assert.equal(statedRange('up to a 2K block range'), 0n);
});
test("an HTTP 413 range refusal is split into the node's stated windows, complete and in order", async () => {
  const entry = n => ({ blockNumber: `0x${n.toString(16)}`, blockHash: `block${n}`, logIndex: '0x0', transactionHash: `tx${n}` });
  const spans = [];
  const rpc = async (method, [filter] = []) => {
    if (method === 'eth_blockNumber') return '0x' + (47_295_229).toString(16);
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    if (to - from + 1 > 1000) {
      const error = new Error('eth_getLogs is limited to a 1,000 range');
      error.status = 413;
      throw error;
    }
    spans.push(to - from + 1);
    return from <= 47_263_700 && 47_263_700 <= to ? [entry(47_263_700)] : from <= 47_295_000 && 47_295_000 <= to ? [entry(47_295_000)] : [];
  };
  const result = await logs(rpc, { fromBlock: '0x' + (47_263_633).toString(16) });
  assert.deepEqual(result.map(row => Number(BigInt(row.blockNumber))), [47_263_700, 47_295_000]);
  assert.ok(spans.every(span => span <= 1000));
  assert.equal(spans.length, 32);
  // A bare 413 without a stated span still halves instead of failing.
  const bare = await logs(async (method, [filter] = []) => {
    if (method === 'eth_blockNumber') return '0x7';
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    if (to - from > 2) throw Object.assign(new Error('The chain RPC returned HTTP 413. Please try again.'), { status: 413 });
    return [entry(to)];
  }, { fromBlock: '0x0' });
  assert.ok(bare.length > 0);
});
test("failed historical ranges never produce partial history", async () => {
  await assert.rejects(logs(async (method, [filter] = []) => {
    if (method === 'eth_blockNumber') return '0x2';
    if (filter.fromBlock === filter.toBlock) throw new Error('archive unavailable');
    throw new Error('range limit');
  }, { fromBlock: '0x0' }), /archive unavailable/);
});
test("malformed contract results are never interpreted as a zero balance or usable address", () => {
  for (const invalid of ['0x', '0x01', '0x' + 'g'.repeat(64)]) assert.throws(() => abi.decUint(invalid));
  assert.throws(() => abi.decAddress('0x' + 'ff'.repeat(32)));
  assert.throws(() => abi.encAddress('0x1234'));
  assert.throws(() => abi.word(-1));
  assert.throws(() => abi.word(2n ** 256n));
  assert.throws(() => abi.hexToBytes('0xzz'));
});
test("ERC20 string and bytes32 metadata are decoded without trusting offsets or lengths", () => {
  assert.equal(abi.decString('0x' + abi.encode(['string'], ['Sticky'])), 'Sticky');
  assert.equal(abi.decString('0x' + Buffer.from('ART').toString('hex').padEnd(64, '0')), 'ART');
  assert.throws(() => abi.decString('0x' + abi.word(2n ** 255n) + abi.word(100)));
  assert.throws(() => abi.decString('0x' + abi.word(32) + abi.word(100)));
  assert.throws(() => abi.decTranches('0x' + abi.word(32) + abi.word(2n ** 255n)));
});

test('reads issued together travel as one batch and each caller gets its own answer or error', async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { ok: true, json: async () => body.map(({ id, method }) => method === 'eth_getCode' ? { jsonrpc: '2.0', id, error: { code: 3, message: 'no code' } } : { jsonrpc: '2.0', id, result: `r${id}` }).reverse() };
  };
  const rpc = Runtime.batchedRpc({ fetch, windowMs: 1 });
  const results = await Promise.allSettled([rpc('https://rpc', 'eth_call', [{}]), rpc('https://rpc', 'eth_blockNumber', []), rpc('https://rpc', 'eth_getCode', ['0x1'])]);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].map(item => item.method), ['eth_call', 'eth_blockNumber', 'eth_getCode']);
  assert.deepEqual(results.slice(0, 2).map(r => r.value), ['r0', 'r1']);
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[2].reason.message, 'no code');
  assert.equal(results[2].reason.code, 3);
});

test('a node that rejects batches gets each read on its own, and logs and sends never batch', async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (Array.isArray(body)) return { ok: false, status: 400, json: async () => ({ error: { message: 'batch not supported' } }) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: body.method }) };
  };
  const rpc = Runtime.batchedRpc({ fetch, windowMs: 1 });
  assert.deepEqual(await Promise.all([rpc('https://rpc', 'eth_call', []), rpc('https://rpc', 'eth_chainId', [])]), ['eth_call', 'eth_chainId']);
  assert.equal(bodies.filter(Array.isArray).length, 1);
  bodies.length = 0;
  await Promise.all([rpc('https://rpc', 'eth_getLogs', [{}]), rpc('https://rpc', 'eth_sendRawTransaction', ['0x']), rpc('https://rpc', 'eth_estimateGas', [{}])]);
  assert.equal(bodies.filter(Array.isArray).length, 0);
  assert.deepEqual(bodies.map(body => body.method), ['eth_getLogs', 'eth_sendRawTransaction', 'eth_estimateGas']);
});
