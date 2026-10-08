import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sections = [
  'custom errors', 'events', 'public constants', 'internal constants', 'private constants',
  'public immutable stored properties', 'internal immutable stored properties', 'public stored properties',
  'internal stored properties', 'private stored properties', 'transient stored properties', 'constructor',
  'modifiers', 'receive / fallback', 'external transactions', 'external views', 'public views',
  'public transactions', 'internal transactions', 'internal helpers', 'internal views', 'private helpers',
];
const parameters = value => value.trim() ? value.split(',').map(parameter => {
  assert.match(parameter.trim(), /^\w+(?:\s+(?:memory|calldata|storage|payable))?\s+\w+$/, `Unsupported parameter: ${parameter}`);
  return parameter.trim().split(/\s+/).at(-1);
}) : [];

for (const name of ['StickySourceCollector', 'StickySourceFeePayer']) {
  test(`${name} follows the source layout and complete inlined NatSpec rules`, () => {
    const source = readFileSync(new URL(`../../src/${name}.sol`, import.meta.url), 'utf8');
    assert.match(source, /^\/\/ SPDX-License-Identifier: MIT\npragma solidity 0\.8\.28;/);
    const types = [...source.matchAll(/^\s*((?:abstract\s+)?contract|library|interface|enum|struct)\s+(\w+)/gm)];
    assert.deepEqual(types.map(match => [match[1], match[2]]), [['contract', name]]);
    assert.doesNotMatch(source, /@inheritdoc|multi-contract-file/);
    assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /\/\*/, 'This bounded check requires line comments; extend it before adding block comments.');
    for (const statement of source.match(/^import .*$/gm) ?? []) {
      assert.match(statement, /^import \{\w+\} from "[^"]+";$/, 'Imports must name one type explicitly.');
    }

    let depth = 0;
    let documentation = [];
    let header = '';
    let section = -1;
    let previous = '';
    let declarations = 0;
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      const banner = trimmed.match(/^\/\/ -+ (.*?) -+ \/\/$/);
      if (depth === 1 && banner) {
        const next = sections.indexOf(banner[1]);
        assert.ok(next > section, `Unknown, duplicate or misplaced section: ${banner[1]}`);
        section = next;
        previous = '';
        documentation = [];
      }
      if (depth <= 1 && trimmed.startsWith('///')) documentation.push(trimmed);
      const code = line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '').trim();
      if (depth === 0 && code && !code.startsWith('contract ')) assert.match(code, /^(pragma |import )/, 'Unsupported top-level declaration.');
      if (depth === 1 && code.startsWith('using ')) assert.match(code, /^using \w+ for \w+;$/);
      if (depth === 0 && code.startsWith('contract ')) {
        assert.match(documentation.join('\n'), /@notice\s+\S/, 'Contract needs a notice.');
        documentation = [];
      } else if (depth === 1 && code && code !== '}' && !code.startsWith('using ')) {
        header += ` ${code}`;
        if (/[{;]/.test(code)) {
          const declaration = header.trim();
          assert.ok((declaration.match(/;/g) ?? []).length <= 1 && !declaration.includes('}'), 'Declarations must be separate.');
          const member = declaration.match(/^(error|event|function) (\w+)\(([^)]*)\)/)
            ?? declaration.match(/^(constructor)\(([^)]*)\)/)
            ?? declaration.match(/^\w+ public immutable (\w+);$/);
          assert.ok(member, `Unsupported declaration; extend the check explicitly: ${declaration}`);
          const constructor = member[1] === 'constructor';
          const property = !['error', 'event', 'function', 'constructor'].includes(member[1]);
          const memberName = property ? member[1] : constructor ? 'constructor' : member[2];
          const docs = documentation.join('\n');
          assert.match(docs, /@notice\s+\S/, `${memberName} needs a notice.`);
          assert.ok(memberName.toLowerCase() >= previous.toLowerCase(), `${memberName} must be alphabetized.`);
          previous = memberName;
          const args = property ? [] : parameters((constructor ? member[2] : member[3]).replace(/ indexed/g, ''));
          const returns = parameters(declaration.match(/returns\s*\(([^)]*)\)/)?.[1] ?? '');
          for (const [tag, expected] of [['param', args], ['return', returns]]) {
            const actual = [...docs.matchAll(new RegExp(`@${tag} (\\w+)\\s+\\S`, 'g'))].map(match => match[1]);
            assert.deepEqual(actual, expected, `${memberName}: every ${tag} must be named and documented in order.`);
          }
          if (member[1] === 'error') assert.ok(args.length, `${memberName} needs relevant error context.`);
          const expectedSection = property ? 'public immutable stored properties' : member[1] === 'error' ? 'custom errors'
            : member[1] === 'event' ? 'events' : constructor ? 'constructor'
              : /\binternal view\b/.test(declaration) ? 'internal views' : 'external transactions';
          assert.equal(sections[section], expectedSection, `${memberName} belongs in ${expectedSection}.`);
          header = '';
          documentation = [];
          declarations++;
        }
      }
      depth += [...code.matchAll(/\{/g)].length - [...code.matchAll(/\}/g)].length;
      assert.ok(depth >= 0, 'Unexpected closing brace.');
    }
    assert.equal(depth, 0, 'Unclosed declaration.');
    assert.equal(header, '', 'Unrecognized partial declaration.');
    assert.ok(declarations > 0, 'The contract body must be checked.');
  });
}
