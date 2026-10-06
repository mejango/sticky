import ts from 'typescript'

/**
 * Modifiers (`it.skip`) and option keys (`{ skip: true }`) under which nothing runs, or nothing proves an action: a
 * skipped, conditional or expected-to-fail test or suite, or one with fixtures (`extend`), which can skip it from
 * code that is not read here.
 */
const NOT_PROVING = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails', 'extend'])

/** Suites: their titles prove nothing. `suite` is Vitest's alias for `describe`. */
const SUITES = new Set(['describe', 'suite'])

/** Modifiers that register a test or suite once per row of the table they are called with, so an empty table registers nothing. */
const TABLES = new Set(['each', 'for'])

/** Hooks that receive the context of each test of their suite, and so can skip it, with the position of that context among their parameters. */
const HOOKS = new Map([
  ['beforeEach', 0],
  ['afterEach', 0],
  ['aroundEach', 1],
])

/** Hooks that get no test context. None can skip a test: one that fails, or never runs its callback, fails the suite. */
const OTHER_HOOKS = new Set(['beforeAll', 'afterAll', 'aroundAll'])

/** `vi`, and `vitest`, which is another name for it. */
const VITEST_OBJECT = new Set(['vi', 'vitest'])

/** Vitest's own APIs, which register no hook that can skip a test. */
const VITEST_API = new Set([...VITEST_OBJECT, 'expect'])

/** An expression without the wrappers that leave its value alone: parentheses, `as`, `satisfies`, `<T>` and `!`. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression
  }
  return node
}

/**
 * A test call's function, modifiers and tables: `it.skipIf(cond).each(rows)('…')`
 * → { name: 'it', modifiers: ['each', 'skipIf'], tables: [rows] }. A bracketed
 * modifier (`describe['skip']`) is not read: it counts as one that proves nothing.
 */
function testCall(callee) {
  const modifiers = []
  const tables = []
  let node = callee
  for (;;) {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && TABLES.has(node.expression.name.text)) {
        tables.push(node.arguments[0])
      }
      node = node.expression
    } else if (ts.isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text)
      node = node.expression
    } else if (ts.isElementAccessExpression(node)) {
      modifiers.push('skip')
      node = node.expression
    } else break
  }
  return ts.isIdentifier(node) && (SUITES.has(node.text) || ['it', 'test'].includes(node.text))
    ? { name: node.text, modifiers, tables }
    : null
}

/** Whether a `.each` or `.for` table is an array literal with a row: an element that is neither a spread nor a hole. */
function hasRow(table) {
  const rows = table && unwrap(table)
  return (
    !!rows &&
    ts.isArrayLiteralExpression(rows) &&
    rows.elements.some(row => !ts.isSpreadElement(row) && !ts.isOmittedExpression(row))
  )
}

/** The function a call passes inline, wherever it sits among the arguments. A named function cannot be read here. */
function inlineCallback(call) {
  return call.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
}

/**
 * Whether a call's arguments leave its test or suite running as written. The name, the first argument, is not read.
 * Besides the callback, each other argument is a number, a constant after the callback (a timeout), or an options
 * object of plain keys without `skip`, `todo` or `fails` (`{ timeout: 5_000 }`). A spread, a variable before the
 * callback, a computed key or any other argument is not read, so it counts as one that can skip.
 */
function runsAsWritten(call, callback) {
  const callbackAt = call.arguments.indexOf(callback)
  return call.arguments.every((argument, position) => {
    if (position === 0 || argument === callback || ts.isNumericLiteral(argument)) return true
    if (position > callbackAt && ts.isIdentifier(argument)) return true
    const options = unwrap(argument)
    return (
      ts.isObjectLiteralExpression(options) &&
      options.properties.every(
        property => property.name && !ts.isComputedPropertyName(property.name) && !NOT_PROVING.has(property.name.text),
      )
    )
  })
}

/** Where the test context sits among a callback's parameters: first for a plain test, after the row for `.for`, and nowhere for `.each`, which passes only row values. */
function contextIndex(test) {
  if (test.modifiers.includes('each')) return -1
  return test.modifiers.includes('for') ? 1 : 0
}

/** Whether an object pattern taken from the context can hold `skip`: it names it, or has a rest element or a computed key. Any other kind of pattern is taken to hold it. */
function holdsSkip(pattern) {
  return (
    !ts.isObjectBindingPattern(pattern) ||
    pattern.elements.some(element => {
      const key = element.propertyName ?? element.name
      if (element.dotDotDotToken || ts.isComputedPropertyName(key)) return true
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'skip') return true
      return ts.isBindingPattern(element.name) && holdsSkip(element.name)
    })
  )
}

/** Whether the context `name` is used in `root` other than as `name.member` with a member other than `skip`: aliased, passed on, indexed, spread, destructured or assigned. */
function escapes(root, name) {
  function visit(node) {
    if (ts.isPropertyAccessExpression(node)) {
      const object = unwrap(node.expression)
      if (ts.isIdentifier(object) && object.text === name) return node.name.text === 'skip'
      return visit(node.expression)
    }
    if (ts.isPropertyAssignment(node)) {
      return (ts.isComputedPropertyName(node.name) && visit(node.name.expression)) || visit(node.initializer)
    }
    if (ts.isIdentifier(node)) return node.text === name
    return ts.forEachChild(node, visit) === true
  }
  return visit(root)
}

/**
 * Whether a test or hook callback can skip at run time through its context, the parameter at `index` (none when it
 * is -1). Only `ctx.name` reads of the context are followed, so anything else counts as skipping: a rest parameter or
 * element that holds it, `skip` named or computed, or the context aliased, passed on or indexed.
 */
function skipsItself(callback, index) {
  if (index < 0) return false
  const { parameters } = callback
  const code = [callback.body, ...parameters.map(parameter => parameter.initializer)].filter(Boolean)
  // A function's own `arguments` holds the context too; an arrow function has none of its own.
  if (ts.isFunctionExpression(callback) && code.some(node => escapes(node, 'arguments'))) return true
  if (parameters.slice(0, index + 1).some(parameter => parameter.dotDotDotToken)) return true
  const context = parameters[index]
  if (!context) return false
  if (!ts.isIdentifier(context.name)) return holdsSkip(context.name)
  return code.some(node => escapes(node, context.name.text))
}

/** Whether a statement can end its enclosing body early: a return or throw, outside any nested function. */
function mayEnd(node) {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true
  return !ts.isFunctionLike(node) && ts.forEachChild(node, mayEnd) === true
}

/** The name a chain of calls, members and indexes starts from: `vi` in `vi.mocked(x).mockReturnValue(1)`. */
function rootName(node) {
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    node = node.expression
  }
  return ts.isIdentifier(node) ? node.text : null
}

/** The call a statement makes, through `await` and `void`: `helper()`, `await helper()`. Null for any other node. */
function callOf(node) {
  if (!ts.isExpressionStatement(node)) return null
  let expression = unwrap(node.expression)
  while (ts.isAwaitExpression(expression) || ts.isVoidExpression(expression)) expression = unwrap(expression.expression)
  return ts.isCallExpression(expression) ? expression : null
}

/** Whether a call statement is one this check can see into: a test, suite or hook of Vitest's, or its own `vi`, `vitest` or `expect`; a table written as a tagged template is read by its tag. Any other call may register a hook that skips, and so does a hook hung off the test API (`test.beforeEach`). */
function seesInto(call) {
  const callee = ts.isTaggedTemplateExpression(call.expression) ? call.expression.tag : call.expression
  const name = ts.isIdentifier(callee) ? callee.text : null
  const test = testCall(callee)
  const hooksOffTestApi = test?.modifiers.some(modifier => HOOKS.has(modifier) || OTHER_HOOKS.has(modifier))
  return (!!test && !hooksOffTestApi) || HOOKS.has(name) || OTHER_HOOKS.has(name) || VITEST_API.has(rootName(callee))
}

/** Whether a hook can skip its tests as far as this check can tell: an inline callback that skips, or any callback it cannot read. Only a direct `vi.name` (or `vitest.name`) is taken as safe. */
function hookMaySkip(call) {
  const callback = inlineCallback(call)
  if (callback) return skipsItself(callback, HOOKS.get(call.expression.text))
  const [hook] = call.arguments
  return !(hook && ts.isPropertyAccessExpression(hook) && ts.isIdentifier(hook.expression) && VITEST_OBJECT.has(hook.expression.text))
}

/**
 * Whether a node holds, outside any nested function, setup that can skip the tests of its suite without this check
 * seeing how: a hook that skips through its context or cannot be read, or a call statement it cannot see into, which
 * may register such a hook. A nested suite's callback belongs to that suite, which is walked on its own.
 */
function setupMaySkip(node) {
  const call = callOf(node)
  if (call && !seesInto(call)) return true
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text) && hookMaySkip(node)) {
    return true
  }
  return !ts.isFunctionLike(node) && ts.forEachChild(node, setupMaySkip) === true
}

/**
 * The words of the titles of the tests that run, so a marker in one proves its
 * action. A test counts only when it is a statement written directly in a
 * describe body or at the top of the file, with nothing before it that can end
 * that body early (a return or throw). A describe title proves nothing. Nothing
 * counts that is skipped, conditional or expected to fail, by a modifier or an
 * options object; that sits in a `.each` or `.for` whose table is not a literal
 * array with a row; that skips itself through its context; that has no inline
 * callback; or whose suite, or any suite around it, has a hook that skips or
 * cannot be read, or a call statement that is not a test, suite, hook, `vi` or
 * `expect` call, since a helper may register such a hook.
 */
export function provingTitleWords(text, fileName) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const words = new Set()

  function register(call) {
    const test = testCall(call.expression)
    if (!test || test.modifiers.some(modifier => NOT_PROVING.has(modifier))) return
    if (!test.tables.every(hasRow)) return
    const callback = inlineCallback(call)
    if (!callback || !runsAsWritten(call, callback)) return
    if (SUITES.has(test.name)) {
      if (ts.isBlock(callback.body)) walk(callback.body.statements)
      return
    }
    const [title] = call.arguments
    if (title && ts.isStringLiteralLike(title) && !skipsItself(callback, contextIndex(test))) {
      for (const word of title.text.split(/\s+/)) words.add(word)
    }
  }

  function walk(statements) {
    if (statements.some(setupMaySkip)) return
    for (const statement of statements) {
      if (mayEnd(statement)) return
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        register(statement.expression)
      }
    }
  }

  walk(source.statements)
  return words
}
