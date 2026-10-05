import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** What the gates on the site's source share: its files, and where a call is written. */

/** Every TypeScript source under `dir`. */
export function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** The calls of the function `name` under `node`. */
export function callsOf(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (at: ts.Node) => {
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === name) found.push(at)
    ts.forEachChild(at, visit)
  }
  visit(node)
  return found
}

/** The function a call is written in: the nearest function declaration or method, or function bound to a variable,
 * past any function written inline as an argument, as the read handed to `tailOrNull` is. */
export function writtenIn(node: ts.Node): ts.Node | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) return at
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at
  }
  return undefined
}
