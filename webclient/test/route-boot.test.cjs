'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Boot = require('../route-boot.js');

const bootSource = fs.readFileSync(path.join(__dirname, '../route-boot.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const serve = fs.readFileSync(path.join(__dirname, '../serve.py'), 'utf8');
function functionSource(name) {
  const match = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index + (source[match.index] === '\n' ? 1 : 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

const TOKEN = '0x' + '2'.repeat(40);
const STICKY = '0x' + '3'.repeat(40);
const HOOK = '0x' + '4'.repeat(40);
function summary(extra = {}) {
  return {
    info: { stakedToken: TOKEN, stToken: STICKY, symbol: 'SLOPSHOP', name: 'Slop Shop', stSymbol: 'STICKYSLOPSHOP', stName: 'Sticky Slop Shop', decimals: 18, reward: '1000', soulbound: false },
    header: { title: 'Sticky Slop Shop', stuck: '1,010 SLOPSHOP', sticks: '3', average: '2d 4h', top: '5d 1h' },
    chains: [8453, 10],
    details: { sigma: '1010000000000000000000', supply: '1000000000000000000000', orphaned: '0', trusted: 1, hook: HOOK },
    ...extra,
  };
}
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

test('the route kind matches the routes app.js renders', () => {
  assert.equal(Boot.routeKind(''), 'home');
  assert.equal(Boot.routeKind('#/'), 'home');
  assert.equal(Boot.routeKind('#/project/23'), 'project');
  assert.equal(Boot.routeKind('#/project/23/airdrops'), 'project');
  assert.equal(Boot.routeKind('#/project/23/tokens/'), 'project');
  assert.equal(Boot.routeKind('#/@slopshop'), 'project');
  assert.equal(Boot.routeKind('#/@slopshop/latest'), 'project');
  assert.equal(Boot.routeKind('#/account/0x' + 'a'.repeat(40)), 'account');
  // Anything app.js would not render as a project or account is the home page.
  assert.equal(Boot.routeKind('#/project/abc'), 'home');
  assert.equal(Boot.routeKind('#/project/23/nope'), 'home');
  assert.equal(Boot.routeKind('#/account/0x123'), 'home');
});

test('the boot script names the view on <html> before the body exists', () => {
  for (const [hash, kind] of [['#/project/23/airdrops', 'project'], ['#/', 'home'], ['#/account/0x' + 'b'.repeat(40), 'account']]) {
    const documentElement = { dataset: {} };
    const window = { document: { documentElement }, location: { hash } };
    vm.runInNewContext(bootSource, { window });
    assert.equal(documentElement.dataset.route, kind);
    assert.equal(typeof window.StickyRouteBoot.readProject, 'function');
  }
});

test('the boot script is external, first in <head>, and served', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script src="route-boot\.js\?v=\d+"><\/script>/);
  assert.ok(head.indexOf('route-boot.js') < head.indexOf('<style>'), 'runs before the page styles and body');
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
  assert.match(serve, /"route-boot\.js"/);
  const versions = new Set([...html.matchAll(/\.js\?v=(\d+)/g)].map((match) => match[1]));
  assert.equal(versions.size, 1, 'every script shares one cache version');
});

test('CSS hides home and shows the project or account view from the route attribute', () => {
  assert.match(html, /html:is\(\[data-route="project"\], \[data-route="account"\]\) #view-home \{ display: none; \}/);
  assert.match(html, /html\[data-route="project"\] #view-project\.hide, html\[data-route="account"\] #view-account\.hide \{ display: block; \}/);
  assert.match(html, /<div id="view-project" class="hide" data-state="loading" aria-busy="true">/);
  assert.match(html, /#view-project:is\(\[data-state="loading"\], \[data-state="cached"\]\) #p-activity:empty/);
  assert.match(functionSource('route'), /^\s*syncRouteView\(\);$/m);
  assert.match(functionSource('syncRouteView'), /document\.documentElement\.dataset\.route = window\.StickyRouteBoot\?\.routeKind\(location\.hash\)/);
});

test('a project summary round-trips through storage, keyed by chain and project', () => {
  const storage = memoryStorage();
  assert.equal(Boot.writeProject(8453, 23n, summary(), storage, 1000), true);
  assert.deepEqual([...storage.map.keys()], ['sticky.project.v1:8453:23']);
  const read = Boot.readProject(8453, 23n, storage, 2000);
  assert.deepEqual(read, { ...summary(), savedAt: 1000 });
  assert.equal(Boot.readProject(10, 23n, storage, 2000), null, 'another chain has its own entry');
  assert.equal(Boot.readProject(8453, 24n, storage, 2000), null);
});

test('bad JSON, a bad shape, or a stale entry reads as no cache and is dropped', () => {
  const storage = memoryStorage();
  storage.setItem('sticky.project.v1:1:5', '{not json');
  assert.equal(Boot.readProject(1, 5, storage), null);
  assert.equal(storage.getItem('sticky.project.v1:1:5'), null);

  storage.setItem('sticky.project.v1:1:6', JSON.stringify({ ...summary(), savedAt: 1, info: { ...summary().info, stakedToken: 'javascript:alert(1)' } }));
  assert.equal(Boot.readProject(1, 6, storage, 2), null);
  assert.equal(storage.getItem('sticky.project.v1:1:6'), null);

  storage.setItem('sticky.project.v1:1:7', JSON.stringify({ ...summary(), savedAt: 1, details: { ...summary().details, sigma: '-1' } }));
  assert.equal(Boot.readProject(1, 7, storage, 2), null);

  Boot.writeProject(1, 8, summary(), storage, 0);
  assert.equal(Boot.readProject(1, 8, storage, 31 * 24 * 60 * 60 * 1000), null, 'older than 30 days');
  assert.equal(storage.getItem('sticky.project.v1:1:8'), null);

  assert.equal(Boot.writeProject(1, 9, summary({ chains: ['8453'] }), storage), false, 'an invalid summary is never written');
  assert.equal(storage.getItem('sticky.project.v1:1:9'), null);
  assert.equal(Boot.writeProject(1, 9, summary({ details: null }), storage), true, 'details are optional');
});

test('storage that throws, or no storage at all, never breaks the page', () => {
  assert.equal(Boot.readProject(1, 5, throwing), null);
  assert.equal(Boot.writeProject(1, 5, summary(), throwing), false);
  assert.equal(Boot.readHandle(1, 'slopshop', throwing), null);
  assert.equal(Boot.writeHandle(1, 'slopshop', 5n, throwing), false);
  assert.equal(Boot.readProject(1, 5, null), null);
  assert.equal(Boot.writeProject(1, 5, summary(), null), false);
  // A browser whose localStorage accessor throws (blocked site data).
  const window = { document: { documentElement: { dataset: {} } }, location: { hash: '#/project/5' } };
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(bootSource, { window });
  assert.equal(window.StickyRouteBoot.readProject(1, 5), null);
  assert.equal(window.StickyRouteBoot.writeProject(1, 5, summary()), false);
});

test('a verified handle remembers its project per chain, case-insensitively', () => {
  const storage = memoryStorage();
  assert.equal(Boot.writeHandle(8453, 'SlopShop', 23n, storage), true);
  assert.equal(Boot.readHandle(8453, 'slopshop', storage), '23');
  assert.equal(Boot.readHandle(10, 'slopshop', storage), null);
  storage.setItem('sticky.handle.v1:8453:bad', '23; drop');
  assert.equal(Boot.readHandle(8453, 'bad', storage), null);
});

// ------------------------------------------------------------ project view shell
function element(id) {
  const classes = new Set(['view-project', 'view-account', 'p-details-card', 'p-chains-card'].includes(id) ? ['hide'] : []);
  const attributes = {};
  return {
    id, textContent: '', innerHTML: '', dataset: {}, attributes,
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
    querySelectorAll: () => [],
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      toggle: (name, on) => ((on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
  };
}
function shell(storage, extra = {}) {
  const elements = new Map();
  const c = vm.createContext({
    URL, BigInt,
    location: { href: 'https://sticky.center/?chain=8453#/project/23', hash: '#/project/23' },
    window: { STICKY_CONFIG: { defaultChainId: 1 }, StickyRouteBoot: {
      readProject: (chainId, projectId) => Boot.readProject(chainId, projectId, storage),
      writeProject: (chainId, projectId, value) => Boot.writeProject(chainId, projectId, value, storage),
    } },
    ctx: { chainId: 8453, hook: HOOK },
    $: (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    tokenLogo: (address, symbol) => `logo:${symbol}`, stickyLabel: (info) => info.stSymbol, pct: (value) => `${Number(value) / 100}%`,
    detailsHtml: (info, pool, trusted, hook) => `details:${info.symbol}:${pool.sigma}:${trusted}:${hook}`,
    renderProjectChains: (chains) => { c.$('h-chains').textContent = [...chains].join(','); },
    guard: (fn) => fn,
    ...extra,
  });
  vm.runInContext(`let shownProject = null;\n${['pageChainId', 'projectCache', 'enterProjectView', 'paintCachedProject',
    'cacheProjectSummary', 'renderProjectLabels', 'renderDetails', 'projectFailed'].map(functionSource).join('\n')}`, c);
  return c;
}

test('with no cache, a project link shows the project view in its loading state, never home', () => {
  const c = shell(memoryStorage());
  c.$('view-home');
  c.enterProjectView(23n);
  assert.equal(c.$('view-home').classList.contains('hide'), true);
  assert.equal(c.$('view-project').classList.contains('hide'), false);
  assert.equal(c.$('view-project').dataset.state, 'loading');
  assert.equal(c.$('h-staked').textContent, '–');
  assert.equal(c.$('h-symbol').textContent, '');
  assert.equal(c.$('p-details-card').classList.contains('hide'), true);
});

test('a cached summary paints at once, faded until the chain confirms it, and is replaced by fresh reads', () => {
  const storage = memoryStorage();
  Boot.writeProject(8453, 23n, summary(), storage);
  const c = shell(storage);
  c.enterProjectView(23n);
  assert.equal(c.$('view-project').dataset.state, 'cached');
  assert.equal(c.$('h-symbol').textContent, 'STICKYSLOPSHOP');
  assert.equal(c.$('h-name').textContent, 'Sticky Slop Shop');
  assert.equal(c.$('h-staked').textContent, '1,010 SLOPSHOP');
  assert.equal(c.$('h-streakers').textContent, '3');
  assert.equal(c.$('h-chains').textContent, '8453,10');
  assert.equal(c.$('stake-title').textContent, 'Stick SLOPSHOP');
  assert.equal(c.$('stake-symbol').textContent, 'SLOPSHOP');
  assert.equal(c.$('p-details-card').classList.contains('hide'), false);
  assert.equal(c.$('token-info').innerHTML, `details:SLOPSHOP:1010000000000000000000:1:${HOOK}`);
  assert.equal(c.$('token-info').attributes['aria-busy'], 'true');
  // Fresh details clear the faded state.
  c.renderDetails({ ...summary().info, reward: 1000n }, { sigma: 5n, supply: 5n, orphaned: 0n }, 0);
  assert.equal(c.$('token-info').attributes['aria-busy'], undefined);
});

test('re-entering the project on screen keeps it; another project resets to its own cache or placeholders', () => {
  const storage = memoryStorage();
  Boot.writeProject(8453, 23n, summary(), storage);
  const c = shell(storage);
  c.enterProjectView(23n);
  c.$('h-staked').textContent = '2,000 SLOPSHOP';
  c.enterProjectView(23n);
  assert.equal(c.$('h-staked').textContent, '2,000 SLOPSHOP', 'a refresh of the same project keeps what is shown');
  c.enterProjectView(24n);
  assert.equal(c.$('view-project').dataset.state, 'loading');
  assert.equal(c.$('h-staked').textContent, '–');
  assert.equal(c.$('h-symbol').textContent, '');
});

test('the cache holds public project facts only, never the holder position', () => {
  const storage = memoryStorage();
  const c = shell(storage);
  for (const [id, text] of [['h-name', 'Sticky Slop Shop'], ['h-staked', '1,010 SLOPSHOP'], ['h-streakers', '3'], ['h-average', '2d 4h'], ['h-top', '5d 1h'],
    ['p-balance', '5 SLOPSHOP'], ['p-wallet', '9 SLOPSHOP']]) c.$(id).textContent = text;
  const info = { ...summary().info, reward: 1000n };
  c.cacheProjectSummary(23n, info, { sigma: 1010n, supply: 1000n, orphaned: 0n }, 1, [8453, 8453, 10]);
  const saved = JSON.parse(storage.getItem('sticky.project.v1:8453:23'));
  assert.deepEqual(Object.keys(saved).sort(), ['chains', 'details', 'header', 'info', 'savedAt']);
  assert.deepEqual(saved.chains, [8453, 10]);
  assert.deepEqual(saved.header, summary().header);
  assert.doesNotMatch(JSON.stringify(saved), /9 SLOPSHOP|5 SLOPSHOP/);
  assert.doesNotMatch(functionSource('cacheProjectSummary'), /account\(|walletAccount|p-balance|p-wallet|tranche/);
});

test('demo mode never reads or writes the cache', () => {
  const c = shell(memoryStorage());
  c.window.__DEMO_RPC = () => {};
  assert.equal(c.projectCache(), null);
});

test('a failed load leaves the loading state for a plain error state, keeping any cached summary', () => {
  const statuses = [];
  const c = shell(memoryStorage(), { status: (message, cls) => statuses.push([message, cls]) });
  c.enterProjectView(23n);
  c.projectFailed(new Error('project 23 is not a sticky token of this deployer'));
  assert.equal(c.$('view-project').dataset.state, 'error');
  assert.deepEqual(statuses, [['project 23 is not a sticky token of this deployer', 'err']]);
  const storage = memoryStorage();
  Boot.writeProject(8453, 23n, summary(), storage);
  const cached = shell(storage, { status() {} });
  cached.enterProjectView(23n);
  cached.projectFailed(new Error('rpc down'));
  assert.equal(cached.$('view-project').dataset.state, 'cached');
});

test('before the chain loads, a project or handle route enters its own view and never renders home', () => {
  const calls = [];
  const c = vm.createContext({
    ctx: { loaded: false, chainId: undefined, currentId: null },
    location: { hash: '#/project/23/airdrops' }, confirmResolve: null,
    closeWalletMenu() {}, setTab() {}, status() {}, syncRouteView: () => calls.push('sync'),
    $: () => ({ close() {}, classList: { add() {}, remove() {} } }),
    window: {}, pageChainId: () => 8453,
    projectCache: () => ({ readHandle: (chainId, handle) => (chainId === 8453 && handle === 'slopshop' ? '23' : null) }),
    enterProjectView: (id) => calls.push(['enter', id === null ? null : String(id)]),
    renderProject: async (id) => { calls.push(['render', String(id)]); },
    renderHome: async () => calls.push('home'), renderAccount: async () => calls.push('account'),
    projectIdForHandle: async () => { calls.push('lookup'); return null; },
    projectFailed() {}, homeFailed() {},
  });
  vm.runInContext(`let viewSequence = 0;\n${functionSource('route')}`, c);
  c.route();
  c.location.hash = '#/@slopshop';
  c.route();
  c.location.hash = '#/@unknown/latest';
  c.route();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['sync', ['render', '23'], 'sync', ['enter', '23'], 'sync', ['enter', null]]);
});

test('the header meta row puts On: chains right after Sticks, each pair unbroken', () => {
  const row = html.match(/<div class="meta-line">([\s\S]*?)<\/div><\/div>/)[1];
  const labels = [...row.matchAll(/<span class="headline-key">([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Stuck:', 'Sticks:', 'On:', 'Average active stick:', 'Longest active stick:']);
  assert.equal((row.match(/class="meta-pair"/g) || []).length, 5);
  assert.match(html, /\.meta-pair \{ white-space: nowrap; \}/);
  // Each pair draws its own leading pipe; the row's negative margin and overflow clip it at every line start.
  assert.match(html, /\.meta-line \{ display: flex; flex-wrap: wrap; align-items: baseline; margin-left: -21px; \}/);
  assert.match(html, /\.meta-row \{ overflow: hidden; \}/);
});

test('public display reads round-trip, stay bounded, and a corrupt entry reads as nothing', () => {
  const Boot = require('../route-boot.js');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  Boot.writeJson('sticky.ipfs.v1:ipfs://x', { name: 'Slop' }, storage);
  assert.deepEqual(Boot.readJson('sticky.ipfs.v1:ipfs://x', storage), { name: 'Slop' });
  Boot.writeJson('big', { blob: 'x'.repeat(250_000) }, storage);
  assert.equal(store.has('big'), false);
  store.set('bad', '{');
  assert.equal(Boot.readJson('bad', storage), null);
});
