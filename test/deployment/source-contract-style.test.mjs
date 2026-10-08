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
const names = ['StickySourceCollector', 'StickySourceFeePayer'];
const read = name => readFileSync(new URL(`../../src/${name}.sol`, import.meta.url), 'utf8');

// This bounded declaration check fails closed on syntax it does not understand; compiler and formatter own syntax.
function check(name, source) {
  assert.match(source, /^\/\/ SPDX-License-Identifier: MIT\npragma solidity 0\.8\.28;/);
  const types = [...source.matchAll(/^\s*((?:abstract\s+)?contract|library|interface|enum|struct)\s+(\w+)/gm)];
  assert.deepEqual(types.map(match => [match[1], match[2]]), [['contract', name]]);
  assert.doesNotMatch(source, /@inheritdoc|multi-contract-file/);
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /\/\*/, 'Extend the bounded check before adding block comments.');
  for (const statement of source.match(/^import .*$/gm) ?? []) {
    assert.match(statement, /^import \{\w+\} from "[^"]+";$/, 'Imports must name one type explicitly.');
  }
  const openzeppelin = [...source.matchAll(/^import .* from "(@openzeppelin\/[^"]+)";$/gm)].map(match => match[1]);
  assert.deepEqual(openzeppelin, [...openzeppelin].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    'OpenZeppelin imports must follow source-path order within their package group.');
  let depth = 0, header = '', section = -1, previous = '', declarations = 0;
  let documentation = [];
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
        const callable = declaration.match(/^(error|event|function) (\w+)\(([^)]*)\)/);
        const constructor = declaration.match(/^constructor\(([^)]*)\)/);
        const transient = declaration.match(/^\w+ transient (public|internal|private) (\w+);$/);
        const property = declaration.match(/^\w+ (public|internal|private) (immutable|constant|transient) (\w+)(?: = [^;]+)?;$/)
          ?? (transient ? [transient[0], transient[1], 'transient', transient[2]] : null);
        const mapping = declaration.match(/^mapping\s*\(.+\)\s+(public|internal|private)\s+(\w+);$/);
        assert.ok(callable || constructor || property || mapping, `Unsupported declaration: ${declaration}`);
        const memberName = callable?.[2] ?? (constructor ? 'constructor' : property?.[3] ?? mapping[2]);
        const docs = documentation.join('\n');
        assert.match(docs, /@notice\s+\S/, `${memberName} needs a notice.`);
        assert.ok(memberName.toLowerCase() >= previous.toLowerCase(), `${memberName} must be alphabetized.`);
        previous = memberName;
        const args = parameters((callable?.[3] ?? constructor?.[1] ?? '').replace(/ indexed/g, ''));
        const returns = parameters(declaration.match(/returns\s*\(([^)]*)\)/)?.[1] ?? '');
        const keys = mapping ? [...declaration.matchAll(/mapping\s*\(\s*\w+\s+(\w+)\s*=>/g)].map(match => match[1]) : [];
        if (mapping) assert.equal(keys.length, (declaration.match(/mapping\s*\(/g) ?? []).length, 'Every mapping key must be named.');
        for (const [tag, expected] of [['param', args], ['return', returns], ['custom:param', keys]]) {
          const actual = [...docs.matchAll(new RegExp(`@${tag} (\\w+)[ \\t]+\\S`, 'g'))].map(match => match[1]);
          assert.deepEqual(actual, expected, `${memberName}: every ${tag} must be named and documented in order.`);
        }
        if (callable?.[1] === 'error') assert.ok(args.length, `${memberName} needs relevant error context.`);
        let expectedSection;
        if (property) expectedSection = property[2] === 'transient' ? 'transient stored properties'
          : `${property[1]} ${property[2] === 'constant' ? 'constants' : 'immutable stored properties'}`;
        else if (mapping) expectedSection = `${mapping[1]} stored properties`;
        else if (constructor) expectedSection = 'constructor';
        else if (callable[1] !== 'function') expectedSection = callable[1] === 'error' ? 'custom errors' : 'events';
        else {
          const visibility = declaration.match(/\b(external|public|internal|private)\b/)?.[1];
          assert.ok(visibility, 'Every function must declare its visibility.');
          expectedSection = visibility === 'private' ? 'private helpers' : /\bview\b/.test(declaration) ? `${visibility} views`
            : /\bpure\b/.test(declaration) ? visibility === 'internal' ? 'internal helpers' : `${visibility} views`
              : `${visibility} transactions`;
        }
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
}

for (const name of names) {
  test(`${name} follows the source layout and complete inlined NatSpec rules`, () => check(name, read(name)));
}

test('the declaration gate rejects missing documentation, layout drift and unsupported syntax', () => {
  const source = read('StickySourceCollector');
  const mutations = [
    source.replace(/^\s*\/\/\/ @param .*\n/m, ''),
    source.replace(/^\s*\/\/\/ @custom:param .*\n/m, ''),
    source.replace('public immutable', 'internal immutable'),
    source.replace(/^(import .*IERC20\.sol";)\n(import .*SafeERC20\.sol";)$/m, '$2\n$1'),
    ...['contract Extra {}', 'abstract contract Extra {}', 'interface Extra {}', 'library Extra {}',
      'enum Extra { One }', 'struct Extra { uint256 value; }', 'function extra() pure {}'].map(value => `${source}\n${value}\n`),
    source.replace('    using SafeERC20 for IERC20;', '    using SafeERC20 for IERC20;\n    uint256 private extra;'),
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutation, source, 'The intended mutation must actually change the fixture.');
    assert.throws(() => check('StickySourceCollector', mutation));
  }
});
