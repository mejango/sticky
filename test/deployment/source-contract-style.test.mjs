import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const sections = [
  'custom errors', 'events', 'public constants', 'internal constants', 'private constants',
  'public immutable stored properties', 'internal immutable stored properties', 'public stored properties',
  'internal stored properties', 'private stored properties', 'transient stored properties', 'constructor',
  'modifiers', 'receive / fallback', 'external transactions', 'external views', 'public views',
  'public transactions', 'internal transactions', 'internal helpers', 'internal views', 'private helpers',
];
const parameters = value => value.trim() ? value.split(',').map(parameter => {
  assert.match(parameter.trim(), /^\w+(?:\[\d*\])*(?:\s+(?:memory|calldata|storage|payable))?\s+\w+$/, `Unsupported parameter: ${parameter}`);
  return parameter.trim().split(/\s+/).at(-1);
}) : [];
const names = ['StickySourceCollector', 'StickySourceFeePayer'];

function sourceNames(directory = new URL('../../src/', import.meta.url), prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return sourceNames(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.isFile() && entry.name.endsWith('.sol') ? [`${prefix}${entry.name.slice(0, -4)}`] : [];
  }).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const allSourceNames = sourceNames();
const contractNames = allSourceNames.filter(name => !name.includes('/'));
const interfaceNames = allSourceNames.filter(name => name.startsWith('interfaces/')).map(name => name.slice(11));
const productionSourceNames = allSourceNames.filter(name => !name.startsWith('interfaces/'));
const read = name => readFileSync(new URL(`../../src/${name}.sol`, import.meta.url), 'utf8');

function checkImports(source) {
  for (const statement of source.match(/^import .*$/gm) ?? []) {
    assert.match(statement, /^import \{\w+\} from "[^"]+";$/, 'Imports must name one type explicitly.');
  }
}

function checkDocumentation(name, docs, args = [], returns = [], keys = []) {
  assert.match(docs, /@notice\s+\S/, `${name} needs a notice.`);
  for (const [tag, expected] of [['param', args], ['return', returns], ['custom:param', keys]]) {
    const actual = [...docs.matchAll(new RegExp(`@${tag} (\\w+)[ \\t]+\\S`, 'g'))].map(match => match[1]);
    assert.deepEqual(actual, expected, `${name}: every ${tag} must be named and documented in order.`);
  }
}

// This bounded declaration check fails closed on syntax it does not understand; compiler and formatter own syntax.
function check(name, source) {
  assert.match(source, /^\/\/ SPDX-License-Identifier: MIT\npragma solidity 0\.8\.28;/);
  const types = [...source.matchAll(/^\s*((?:abstract\s+)?contract|library|interface|enum|struct)\s+(\w+)/gm)];
  assert.deepEqual(types.map(match => [match[1], match[2]]), [['contract', name]]);
  assert.doesNotMatch(source, /@inheritdoc|multi-contract-file/);
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /\/\*/, 'Extend the bounded check before adding block comments.');
  checkImports(source);
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
        const property = declaration.match(/^\w+ (public|internal|private) (immutable|constant|transient) (?:override )?(\w+)(?: = [^;]+)?;$/)
          ?? (transient ? [transient[0], transient[1], 'transient', transient[2]] : null);
        const mapping = declaration.match(/^mapping\s*\(.+\)\s+(public|internal|private)\s+(?:override\s+)?(\w+);$/);
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
        checkDocumentation(memberName, docs, args, returns, keys);
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

// The new public interfaces contain only documented events and functions; every other body form fails closed.
function checkInterface(name, source) {
  assert.match(source, /^\/\/ SPDX-License-Identifier: MIT\npragma solidity \^0\.8\.0;/);
  assert.deepEqual([...source.matchAll(/^\s*((?:abstract\s+)?contract|library|interface|enum|struct)\s+(\w+)/gm)]
    .map(match => [match[1], match[2]]), [['interface', name]]);
  assert.doesNotMatch(source, /@inheritdoc|multi-contract-file|\/\*/);
  checkImports(source);
  const declaration = source.match(new RegExp(`interface ${name}[^\\{]*\\{([\\s\\S]*)\\}\\s*$`));
  assert.ok(declaration, 'Unsupported interface header.');
  assert.match(source.slice(0, declaration.index), /@notice\s+\S/, 'Interface needs a notice.');
  const body = declaration[1];
  let end = 0, group = -1, previous = '';
  for (const member of body.matchAll(/((?:\s*\/\/\/[^\n]*\n)+)\s*((event|function) (\w+)\(([^)]*)\)[^;]*;)/g)) {
    const gap = body.slice(end, member.index).replace(/^\s*\/\/(?!\/).*$/gm, '').trim();
    assert.equal(gap, '', 'Unsupported or undocumented interface member.');
    const [, docs, code, kind, memberName, args] = member;
    const next = kind === 'event' ? 0 : /\b(view|pure)\b/.test(code) ? 1 : 2;
    assert.ok(next >= group, 'Interface order must be events, views, then transactions.');
    if (next !== group) previous = '';
    // Canonical interfaces keep their uppercase immutable getters before camelCase views.
    assert.ok(memberName >= previous, `${memberName} must be alphabetized within its interface group.`);
    checkDocumentation(memberName, docs, parameters(args.replace(/ indexed/g, '')),
      parameters(code.match(/returns\s*\(([^)]*)\)/)?.[1] ?? ''));
    if (kind === 'function') assert.match(code, /\bexternal\b/, 'Interface functions must be external.');
    group = next;
    previous = memberName;
    end = member.index + member[0].length;
  }
  assert.ok(end > 0, 'The interface must contain checked members.');
  assert.equal(body.slice(end).replace(/^\s*\/\/(?!\/).*$/gm, '').trim(), '', 'Unsupported or undocumented interface member.');
}

for (const name of names) {
  test(`${name} follows the source layout and complete inlined NatSpec rules`, () => check(name, read(name)));
}

for (const name of interfaceNames) {
  test(`${name} documents and orders every declared event and public API`, () => {
    const source = read(`interfaces/${name}`);
    checkInterface(name, source);
    assert.throws(() => checkInterface(name, source.replace(/^\s*\/\/\/ @return .*\n/m, '')));
    assert.throws(() => checkInterface(name, source.replace(/\}\s*$/, '    error Undocumented();\n}\n')));
  });
}

test('every production custom error documents all of its context', () => {
  for (const sourceName of productionSourceNames) {
    const source = read(sourceName);
    const declarations = [...source.matchAll(/^\s*error\s+(\w+)\(([^;]*)\);/gm)];
    const documented = [...source.matchAll(/((?:\s*\/\/\/[^\n]*\n)+)\s*error\s+(\w+)\(([^;]*)\);/g)];
    assert.equal(documented.length, declarations.length, `${sourceName}: every error needs contiguous NatSpec.`);
    for (const [, docs, errorName, args] of documented) {
      checkDocumentation(errorName, docs, parameters(args.replace(/\s+/g, ' ')));
    }
  }
});

test('production implementations keep their NatSpec local', () => {
  for (const sourceName of allSourceNames) {
    assert.doesNotMatch(read(sourceName), /@inheritdoc/, `${sourceName}: inline implementation NatSpec.`);
  }
});

test('every production function documents its named parameters and preserves reviewed unnamed inputs', () => {
  const allowedUnnamed = new Map([
    ['StickyDeployer.onERC721Received', ['0:address', '3:bytes calldata']],
    ['StickyHook.hasMintPermissionFor', ['0:uint256', '1:JBRuleset memory', '2:address']],
    ['StickyToken.delegateBySig', ['1:uint256', '2:uint256', '3:uint8', '4:bytes32', '5:bytes32']],
    ['StickyToken.initialize', ['0:string memory', '1:string memory', '2:address']],
    ['StickyToken.setMetadata', ['0:string memory', '1:string memory']],
  ]);
  const seenUnnamed = new Set();
  for (const sourceName of productionSourceNames) {
    const source = read(sourceName);
    const declarations = [...source.matchAll(/^\s*function\s+(\w+)\s*\(/gm)];
    const documented = [...source.matchAll(
      /((?:\s*\/\/\/[^\n]*\n)+)(?:\s*\/\/(?!\/)[^\n]*\n)*\s*function\s+(\w+)\s*\(([\s\S]*?)\)\s*([^{;]*)\{/g,
    )];
    assert.equal(documented.length, declarations.length, `${sourceName}: every function needs contiguous NatSpec.`);
    for (const [, docs, functionName, args, tail] of documented) {
      const parsed = args.trim() ? args.split(',').map((parameter, index) => {
        const normalized = parameter.trim().replace(/\s+/g, ' ');
        const match = normalized.match(/^(\w+(?:\[\d*\])*(?:\s+(?:memory|calldata|storage|payable))?)(?:\s+(\w+))?$/);
        assert.ok(match, `${sourceName}.${functionName}: unsupported parameter ${normalized}.`);
        return { index, type: match[1], name: match[2] };
      }) : [];
      const named = parsed.filter(parameter => parameter.name).map(parameter => parameter.name);
      const returns = parameters(tail.match(/returns\s*\(([^)]*)\)/)?.[1] ?? '');
      checkDocumentation(functionName, docs, named, returns);
      const unnamed = parsed.filter(parameter => !parameter.name).map(parameter => `${parameter.index}:${parameter.type}`);
      if (unnamed.length) {
        const key = `${sourceName}.${functionName}`;
        assert.deepEqual(unnamed, allowedUnnamed.get(key), `${key}: unnamed inputs are limited to deployed ABI exceptions.`);
        seenUnnamed.add(key);
      }
    }
  }
  assert.deepEqual([...seenUnnamed].sort(), [...allowedUnnamed.keys()].sort(), 'Every deployed ABI exception remains present.');
});

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
