import { describe, expect, it } from 'vitest'

const libraryPath = '../../scripts/lib/test-titles.mjs'
const { provingTitleWords } = await import(libraryPath)

const marker = 'wallet-action:send'
const proves = (source: string) =>
  (provingTitleWords(source, 'proof.test.ts') as Set<string>).has(marker)

describe('test titles that can prove a wallet action', () => {
  it('counts it and test titles, .each tables included, under a running suite', () => {
    for (const source of [
      `describe('suite', () => { it('${marker} proves', () => {}) })`,
      `test('${marker} proves', () => {})`,
      `it.each([1, 2])('${marker} proves %s', () => {})`,
      `describe.each([1])('suite %s', () => { it.concurrent('${marker} proves', () => {}) })`,
      `suite('suite', () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('counts a test that runs wherever it is written directly: nested suites, any callback form, any non-skipping context', () => {
    for (const source of [
      `describe('a', () => { describe('b', () => { it('${marker} proves', () => {}) }) })`,
      `describe('suite', function () { it('${marker} proves', function () {}) })`,
      `describe('suite', async () => { it('${marker} proves', async () => {}) })`,
      `it('${marker} proves', { timeout: 5_000 }, () => {})`,
      `it(\`${marker} proves\`, () => {})`,
      // A setup statement, an if without an early exit, or a return inside a helper function does not end the suite body.
      `describe('suite', () => { const helper = () => { return 1 }; it('${marker} proves', () => { helper() }) })`,
      `describe('suite', () => { if (ready) { vi.stubEnv('MODE', 'test') } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(() => { reset() }); it('${marker} proves', () => {}) })`,
      // Tables with at least one row, wrapped as TypeScript allows.
      `it.each([1, 2] as const)('${marker} proves %s', () => {})`,
      `it.each([{ id: 1 }] satisfies { id: number }[])('${marker} proves $id', ({ id }) => {})`,
      `it.each(([1]))('${marker} proves %s', () => {})`,
      `it.concurrent.each([[1, 2]])('${marker} proves %s', () => {})`,
      `it.for([1])('${marker} proves %s', (row, { expect }) => {})`,
      `it.each(<number[]>[1, 2])('${marker} proves %s', () => {})`,
      `it.each([...rows, 1])('${marker} proves %s', () => {})`,
      `describe.each([1])('suite %s', () => { it('${marker} proves', () => {}) })`,
      // A context that is read for something other than skip, or a local that merely shares its name.
      `it('${marker} proves', ({ expect }) => { expect(1).toBe(1) })`,
      `it('${marker} proves', (ctx) => { ctx.expect(1).toBe(1) })`,
      `it('${marker} proves', () => { const skip = 1; expect(skip).toBe(1) })`,
      `it('${marker} proves', async () => { await query({ skip: 0 }) })`,
      `it('${marker} proves', () => { page.skip() })`,
      `it.each([1])('${marker} proves %s', skip => { expect(skip).toBe(1) })`,
      `it.for([[1, 2]])('${marker} proves %s', ([first, skip]) => { expect(skip).toBe(2) })`,
      `it.for([[1]])('${marker} proves %s', row => { expect(row[0]).toBe(1) })`,
      `it('${marker} proves', () => { const { skip } = helpers; expect(skip).toBeDefined() })`,
      `describe('suite', () => { beforeEach((ctx) => { ctx.task.meta.ran = true }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { beforeEach(() => { reset() }) } it('${marker} proves', () => {}) })`,
      // A skipping hook belongs to its own suite: it takes that suite's tests, not the tests beside or above it.
      `describe('outer', () => { describe('inner', () => { beforeEach((ctx) => { ctx.skip() }) }); it('${marker} proves', () => {}) })`,
      `describe('a', () => { beforeEach((ctx) => { ctx.skip() }) }); describe('b', () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('counts a test or suite whose arguments leave it running: harmless options, a timeout after the callback, any suite name', () => {
    for (const source of [
      `it('${marker} proves', () => {}, TIMEOUT)`,
      `test('${marker} proves', async () => {}, LIMITS_TIMEOUT)`,
      `describe(name, () => { it('${marker} proves', () => {}) })`,
      `describe(\`suite \${name}\`, () => { it('${marker} proves', () => {}) })`,
      `describe(Foo.name, () => { it('${marker} proves', () => {}) })`,
      `describe(String(chain), () => { it('${marker} proves', () => {}) })`,
      `describe(Foo, () => { it('${marker} proves', () => {}) })`,
      `suite(name, () => { it('${marker} proves', () => {}) })`,
      `describe.each([1])(name, () => { it('${marker} proves', () => {}) })`,
      `it('${marker} proves', { retry: 2, timeout: 1000 }, () => {})`,
      `it('${marker} proves', { timeout: LIMIT }, () => {})`,
      `it('${marker} proves', { timeout }, () => {})`,
      `it('${marker} proves', { 'timeout': 5 }, () => {})`,
      `it('${marker} proves', { concurrent: true, tags: ['wallet'] }, () => {})`,
      `it('${marker} proves', { timeout: 5 } as const, () => {})`,
      `it('${marker} proves', {}, () => {})`,
      `it('${marker} proves', () => {}, 15_000)`,
      `test('${marker} proves', { timeout: 5_000 }, () => {})`,
      `it.each([1])('${marker} proves %s', { retry: 1 }, () => {})`,
      `it.for([1])('${marker} proves %s', { timeout: 1 }, () => {})`,
      `describe('suite', { timeout: 5_000 }, () => { it('${marker} proves', () => {}) })`,
      `describe.each([1])('suite %s', { sequential: true }, () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('counts a test whose context is only read as ctx.name, and table rows that have a skip field', () => {
    for (const source of [
      `it('${marker} proves', (ctx) => {})`,
      `it('${marker} proves', (ctx) => { ctx.task.meta.ran = true })`,
      `it('${marker} proves', (ctx) => { ctx?.expect(1).toBe(1) })`,
      `it('${marker} proves', (ctx) => { (ctx as Context).expect(1).toBe(1) })`,
      `it('${marker} proves', (ctx) => { ctx!.expect(1).toBe(1) })`,
      `it('${marker} proves', async (ctx) => { await ctx.expect(1).resolves.toBe(1) })`,
      `it('${marker} proves', (ctx) => { const run = () => ctx.expect(1); run() })`,
      `it('${marker} proves', (ctx) => { run(ctx.expect) })`,
      `it('${marker} proves', ({ task: { meta } }) => { expect(meta).toBeDefined() })`,
      `it('${marker} proves', ({ expect = fallback }) => { expect(1).toBe(1) })`,
      // `arguments` of a test function is its context, so only `arguments.name` reads count; an arrow's `arguments` is not its own, and .each passes row values.
      `it('${marker} proves', function () { expect(arguments.length).toBe(1) })`,
      `describe.each([1])('suite %s', function () { it('${marker} proves', () => { expect(arguments[0]).toBe(1) }) })`,
      `it.each([1])('${marker} proves %s', function () { expect(arguments[0]).toBe(1) })`,
      // A member or a key that merely shares the context's name is not the context.
      `it('${marker} proves', (ctx) => { expect(page.ctx).toBe(1) })`,
      `it('${marker} proves', (ctx) => { render({ ctx: 1 }) })`,
      `describe('suite', () => { aroundEach(async (runTest) => { await runTest() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach(async (runTest, ctx) => { await runTest(); ctx.task.meta.ran = true }); it('${marker} proves', () => {}) })`,
      // The context is the first parameter of a plain test, the second of .for, and absent from .each, which passes only row values.
      `it.each([{ skip: 0 }])('${marker} proves %j', ({ skip }) => { expect(skip).toBe(0) })`,
      `it.each([{ skip: 0 }])('${marker} proves %j', row => { expect(row.skip).toBe(0) })`,
      `it.each([[1, 2]])('${marker} proves %s', (...row) => { expect(row.length).toBe(2) })`,
      `it.for([{ skip: 0 }])('${marker} proves %j', ({ skip }) => { expect(skip).toBe(0) })`,
      `it.for([{ skip() {} }])('${marker} proves', row => { row.skip() })`,
      `it.for([[1, 2]])('${marker} proves %s', ([first, ...others], { expect }) => { expect(others.length).toBe(1) })`,
      `it.for([1])('${marker} proves %s', (row, ctx) => { ctx.expect(row).toBe(1) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('ignores suite titles and anything skipped, conditional or expected to fail', () => {
    for (const source of [
      `describe('${marker} suite', () => { it('proves', () => {}) })`,
      `describe.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.skipIf(true)('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.runIf(ci)('suite', () => { it('${marker} proves', () => {}) })`,
      `it.skip('${marker} proves', () => {})`,
      `it.todo('${marker} proves')`,
      `it.skipIf(true)('${marker} proves', () => {})`,
      `it.fails('${marker} proves', () => {})`,
      `test.skip.each([1])('${marker} proves %s', () => {})`,
      `suite('${marker} suite', () => { it('proves', () => {}) })`,
      `suite.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe['skip']('suite', () => { it('${marker} proves', () => {}) })`,
      `it['skip']('${marker} proves', () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test in dead or conditional code, where nothing registers it', () => {
    for (const source of [
      `if (false) { it('${marker} proves', () => {}) }`,
      `if (false) it('${marker} proves', () => {})`,
      `describe('suite', () => { if (false) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { if (enabled) it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (enabled) {} else { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { for (const row of rows) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { while (false) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { try { it('${marker} proves', () => {}) } catch {} })`,
      `describe('suite', () => { { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { switch (mode) { case 1: it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { rows.forEach(() => { it('${marker} proves', () => {}) }) })`,
      `function register() { it('${marker} proves', () => {}) }`,
      `describe('suite', () => { const register = () => { it('${marker} proves', () => {}) } })`,
      `it('outer', () => { it('${marker} proves', () => {}) })`,
      `describe('suite', () => { describe('inner', () => { if (false) { it('${marker} proves', () => {}) } }) })`,
      `if (false) { describe('suite', () => { it('${marker} proves', () => {}) }) }`,
      // After a return or throw, or after a conditional one, the suite body never reaches the test.
      `describe('suite', () => { return; it('${marker} proves', () => {}) })`,
      `describe('suite', () => { throw new Error('stop'); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (!process.env.CI) return; it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { return } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { for (const row of rows) { if (row) return } it('${marker} proves', () => {}) })`,
      `describe('outer', () => { describe('inner', () => { return; it('${marker} proves', () => {}) }) })`,
      `throw new Error('stop'); it('${marker} proves', () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test or suite whose .each or .for table is empty or not a literal array', () => {
    for (const source of [
      `it.each([])('${marker} proves %s', () => {})`,
      `test.each([])('${marker} proves %s', () => {})`,
      `it.for([])('${marker} proves %s', () => {})`,
      `it.each([] as const)('${marker} proves %s', () => {})`,
      `it.each(([]))('${marker} proves %s', () => {})`,
      `it.concurrent.each([])('${marker} proves %s', () => {})`,
      `it.each([...rows])('${marker} proves %s', () => {})`,
      `it.each([,])('${marker} proves %s', () => {})`,
      `it.each(rows)('${marker} proves %s', () => {})`,
      `it.each(rows.slice(1))('${marker} proves %s', () => {})`,
      `it.each(Object.keys(rows))('${marker} proves %s', () => {})`,
      `it.each()('${marker} proves', () => {})`,
      `it.each\`a\n\${1}\`('${marker} proves', () => {})`,
      `describe.each([])('suite %s', () => { it('${marker} proves', () => {}) })`,
      `describe.each(rows)('suite %s', () => { it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it.each([])('${marker} proves %s', () => {}) })`,
      `describe.each([1])('suite %s', () => { it.each([])('${marker} proves %s', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test that skips itself at run time through its context', () => {
    for (const source of [
      `it('${marker} proves', (ctx) => { ctx.skip() })`,
      `it('${marker} proves', (context) => { context.skip() })`,
      `it('${marker} proves', (ctx) => { ctx.skip(!ready, 'not ready') })`,
      `it('${marker} proves', async (ctx) => { if (!ready) ctx.skip(); await run() })`,
      `it('${marker} proves', (ctx) => { ctx.skip?.() })`,
      `it('${marker} proves', (ctx) => { ctx['skip']() })`,
      `it('${marker} proves', (ctx) => { const bail = () => ctx.skip(); bail() })`,
      `it('${marker} proves', (ctx) => { const bail = ctx.skip; bail() })`,
      `it('${marker} proves', function (ctx) { ctx.skip() })`,
      `it('${marker} proves', ({ skip }) => { skip() })`,
      `it('${marker} proves', ({ skip: stop }) => { stop() })`,
      `it('${marker} proves', ({ 'skip': stop }) => { stop() })`,
      `it('${marker} proves', ({ ['skip']: stop }) => { stop() })`,
      `it('${marker} proves', ({ expect, skip }) => { skip() })`,
      `it('${marker} proves', (ctx) => { const { skip } = ctx; skip() })`,
      `it('${marker} proves', (ctx) => { (ctx as Context).skip() })`,
      `it('${marker} proves', (ctx) => { (<Context>ctx).skip() })`,
      `it('${marker} proves', (ctx) => { ctx!.skip() })`,
      `it('${marker} proves', (ctx) => { const { skip } = ctx as Context; skip() })`,
      `it('${marker} proves', { timeout: 5_000 }, (ctx) => { ctx.skip() })`,
      `it.concurrent('${marker} proves', (ctx) => { ctx.skip() })`,
      `it.for([1])('${marker} proves %s', (row, ctx) => { ctx.skip() })`,
      `describe('suite', () => { it('${marker} proves', (ctx) => { ctx.skip() }) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test or suite whose options skip it, mark it todo or expect it to fail, or cannot be read', () => {
    for (const source of [
      `it('${marker} proves', { skip: true }, () => {})`,
      `it('${marker} proves', { todo: true }, () => {})`,
      `it('${marker} proves', { fails: true }, () => {})`,
      `it('${marker} proves', { skip: false }, () => {})`,
      `it('${marker} proves', { timeout: 1000, skip: true }, () => {})`,
      `it('${marker} proves', { 'skip': true }, () => {})`,
      `it('${marker} proves', { skip }, () => {})`,
      `it('${marker} proves', { get skip() { return true } }, () => {})`,
      `it('${marker} proves', { skip() { return true } }, () => {})`,
      `it('${marker} proves', { skip: true } as const, () => {})`,
      `it('${marker} proves', () => {}, { skip: true })`,
      `test('${marker} proves', { skip: true }, () => {})`,
      `it.concurrent('${marker} proves', { skip: true }, () => {})`,
      `it.each([1])('${marker} proves %s', { skip: true }, () => {})`,
      `it.for([1])('${marker} proves %s', { skip: true }, () => {})`,
      `describe('suite', { skip: true }, () => { it('${marker} proves', () => {}) })`,
      `describe('suite', { todo: true }, () => { it('${marker} proves', () => {}) })`,
      `suite('suite', { skip: true }, () => { it('${marker} proves', () => {}) })`,
      `describe.each([1])('suite %s', { skip: true }, () => { it('${marker} proves', () => {}) })`,
      // Options that cannot be read: a spread, a variable, a computed key.
      `it('${marker} proves', { ...options }, () => {})`,
      `it('${marker} proves', { timeout: 1000, ...options }, () => {})`,
      `it('${marker} proves', options, () => {})`,
      `it('${marker} proves', { ['skip']: true }, () => {})`,
      `it('${marker} proves', { [name]: true }, () => {})`,
      `describe('suite', options, () => { it('${marker} proves', () => {}) })`,
      // After the callback only a number or a constant is a timeout.
      `it('${marker} proves', TIMEOUT, () => {})`,
      `it('${marker} proves', () => {}, ...limits)`,
      `it('${marker} proves', () => {}, config.timeout)`,
      `it('${marker} proves', () => {}, { timeout: 1000, skip: true })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test whose context reaches skip without naming it: aliased, passed on, indexed, spread or assigned', () => {
    for (const source of [
      `it('${marker} proves', (ctx) => { const c = ctx; c.skip() })`,
      `it('${marker} proves', (ctx) => { gate(ctx) })`,
      `it('${marker} proves', (ctx) => { return ctx })`,
      `it('${marker} proves', (ctx) => ctx)`,
      `it('${marker} proves', (ctx) => { run({ ctx }) })`,
      `it('${marker} proves', (ctx) => { run([ctx]) })`,
      `it('${marker} proves', (ctx) => { run({ [gate(ctx)]: 1 }) })`,
      `it('${marker} proves', (ctx) => { Object.assign({}, ctx).skip() })`,
      `it('${marker} proves', (ctx) => { Reflect.get(ctx, 'skip')() })`,
      `it('${marker} proves', (ctx) => { let stop; ({ skip: stop } = ctx); stop() })`,
      // Only ctx.name is read, so even a harmless destructure or index is refused.
      `it('${marker} proves', (ctx) => { const { expect } = ctx })`,
      `it('${marker} proves', (ctx) => { ctx['expect'] })`,
      `it('${marker} proves', (ctx) => { ctx[key]() })`,
      `it('${marker} proves', (ctx) => { const key = 'skip'; ctx[key]() })`,
      // A function's `arguments` holds the context too.
      `it('${marker} proves', function () { arguments[0].skip() })`,
      `it('${marker} proves', function () { Array.from(arguments)[0].skip() })`,
      `it('${marker} proves', function () { const [ctx] = arguments; ctx.skip() })`,
      `it('${marker} proves', function () { run(arguments) })`,
      `it('${marker} proves', function () { [...arguments][0].skip() })`,
      `it('${marker} proves', function (other = arguments[0].skip()) {})`,
      `it.for([1])('${marker} proves %s', function (row) { arguments[1].skip() })`,
      // A default value runs with the test.
      `it('${marker} proves', (ctx, other = ctx.skip()) => {})`,
      `it('${marker} proves', (ctx, other = gate(ctx)) => {})`,
      // A rest parameter or element holds skip, and so does a computed key or an array pattern.
      `it('${marker} proves', ({ ...rest }) => { rest.skip() })`,
      `it('${marker} proves', ({ expect, ...rest }) => { rest.skip() })`,
      `it('${marker} proves', ({ task: { ...rest } }) => { rest.skip })`,
      `it('${marker} proves', ({ [name]: member }) => { member() })`,
      `it('${marker} proves', ({ ['expect']: member }) => {})`,
      `it('${marker} proves', (...args) => { args[0].skip() })`,
      `it('${marker} proves', async (...args) => {})`,
      `it('${marker} proves', ([ctx]) => {})`,
      // For .for the context is the second parameter.
      `it.for([1])('${marker} proves %s', (row, ...rest) => { rest[0].skip() })`,
      `it.for([1])('${marker} proves %s', (...args) => { args[1].skip() })`,
      `it.for([1])('${marker} proves %s', (row, ctx) => { gate(ctx) })`,
      `it.for([1])('${marker} proves %s', (row, { skip }) => { skip() })`,
      `it.for([1])('${marker} proves %s', (row, { ...rest }) => {})`,
      // Fixtures can skip the test and are not read here.
      `test.extend({ gate: async ({ skip }, use) => { skip(); await use(1) } })('${marker} proves', ({ gate }) => {})`,
      `test.extend({ a: 1 })('${marker} proves', ({ a }) => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores every test under a hook that skips at run time', () => {
    for (const source of [
      `beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {})`,
      `describe('suite', () => { beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it('${marker} proves', () => {}); beforeEach(({ skip }) => { skip() }) })`,
      `describe('suite', () => { beforeEach((ctx) => { if (!ready) ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { afterEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach((runTest, ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (!ready) { beforeEach((ctx) => { ctx.skip() }) } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { for (const row of rows) beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach((ctx) => { const c = ctx; c.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach((ctx) => { gate(ctx) }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(({ ...rest }) => { rest.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { afterEach((...args) => { args[0].skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach((runTest, ctx) => { gate(ctx) }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach((...args) => { args[1].skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(function () { arguments[0].skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach(function () { arguments[1].skip() }); it('${marker} proves', () => {}) })`,
      `describe('outer', () => { beforeEach((ctx) => { ctx.skip() }); describe('inner', () => { it('${marker} proves', () => {}) }) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('counts a test whose suite has only setup that cannot skip it: Vitest vi and expect, inline hooks, hooks without a test context', () => {
    for (const source of [
      `describe('suite', () => { beforeEach(vi.clearAllMocks); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { afterEach(vi.restoreAllMocks); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(vi.clearAllMocks, 5_000); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { beforeEach(vi.resetAllMocks) } it('${marker} proves', () => {}) })`,
      `afterEach(vi.restoreAllMocks); it('${marker} proves', () => {})`,
      `vi.mock('./wallet', () => ({})); it('${marker} proves', () => {})`,
      `await vi.hoisted(async () => {}); it('${marker} proves', () => {})`,
      `describe('suite', () => { vi.useFakeTimers(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { vi.stubEnv('MODE', 'test'); it('${marker} proves', () => {}) })`,
      `expect.extend({}); it('${marker} proves', () => {})`,
      `describe('suite', () => { expect.hasAssertions(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { vitest.useFakeTimers(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(vitest.clearAllMocks); it('${marker} proves', () => {}) })`,
      // A table written as a tagged template is not read as a test, but it is Vitest's own call and taints nothing.
      `describe('suite', () => { it.each\`a\n\${1}\`('other', () => {}); it('${marker} proves', () => {}) })`,
      `describe('outer', () => { describe.each\`a\n\${1}\`('inner', () => {}); it('${marker} proves', () => {}) })`,
      `it.each\`a\n\${1}\`('other', () => {}); it('${marker} proves', () => {})`,
      `describe('suite', () => { expect(setup).toBeDefined(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { vi.mocked(fetchThing).mockResolvedValue(1); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { vi['useFakeTimers'](); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeAll(setup); afterAll(teardown); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundAll(wrap); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(async function () { await reset() }); it('${marker} proves', () => {}) })`,
      // Helpers that run inside a function, or in a suite that is not this one or one around it, do not reach this test.
      `describe('suite', () => { const gate = () => installGate(); it('${marker} proves', () => { gate() }) })`,
      `describe('a', () => { installGate() }); describe('b', () => { it('${marker} proves', () => {}) })`,
      `describe('outer', () => { describe('inner', () => { installGate() }); it('${marker} proves', () => {}) })`,
      `describe('outer', () => { describe('inner', () => { beforeEach(setup) }); it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('ignores every test under a hook it cannot read, or a call statement it cannot see into that may register one', () => {
    for (const source of [
      // A hook passed by name, built by a call or reached through a member is not read. Only a direct vi.name is safe.
      `describe('suite', () => { beforeEach(setup); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { afterEach(teardown); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach(wrap); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(helpers.setup); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(makeHook()); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(vi.fn()); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(vi.mocked.thing); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { const hook = () => {}; beforeEach(hook); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { beforeEach(setup) } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it('${marker} proves', () => {}); afterEach(teardown) })`,
      `beforeEach(setup); it('${marker} proves', () => {})`,
      `describe('outer', () => { beforeEach(setup); describe('inner', () => { it('${marker} proves', () => {}) }) })`,
      // A call statement the check cannot see into may register a hook that skips.
      `describe('suite', () => { installGate(); it('${marker} proves', () => {}) })`,
      `describe('suite', async () => { await installGate(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { void installGate(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { (installGate()); it('${marker} proves', () => {}) })`,
      `describe('suite', async () => { await (installGate() as Promise<void>); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { installGate?.(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { helpers.install(); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { installGate\`a\n\${1}\`('x', () => {}); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { installGate() } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { for (const row of rows) installGate(row); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { try { installGate() } finally {} it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it('${marker} proves', () => {}); installGate() })`,
      `installGate(); it('${marker} proves', () => {})`,
      `await installGate(); it('${marker} proves', () => {})`,
      `describe('outer', () => { installGate(); describe('inner', () => { it('${marker} proves', () => {}) }) })`,
      `describe.each([1])('suite %s', () => { installGate(); it('${marker} proves', () => {}) })`,
      // Hooks hung off the test API skip like the plain ones.
      `describe('suite', () => { test.beforeEach(({ skip }) => { skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it.afterEach(({ skip }) => { skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { test.aroundEach(async (runTest, { skip }) => { skip(); await runTest() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { test.beforeAll(setup); it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a title that is not a plain string: a template with a substitution, a variable, a concatenation', () => {
    for (const source of [
      `it(\`${marker} \${suffix}\`, () => {})`,
      `it(title, () => {})`,
      `it('${marker} ' + suffix, () => {})`,
      `it({ timeout: 5 }, () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test whose callback it cannot read: none (a todo), a named function, or a suite with an expression body', () => {
    for (const source of [
      `it('${marker} proves')`,
      `it('${marker} proves', runCase)`,
      `it.each([1])('${marker} proves %s')`,
      `describe('suite', () => it('${marker} proves', () => {}))`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })
})
