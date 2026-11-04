import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../agent-grep.mjs', import.meta.url));

// ------------------------------------------------------------------ helpers

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-grep-test-')));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const home = join(root, 'home');
  mkdirSync(claude);
  mkdirSync(codex);
  mkdirSync(home);
  return { root, claude, codex, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(dir, rel, lines) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  writeFileSync(file, text);
}

function run(args, { sb, env = {}, cwd } = {}) {
  const e = { ...process.env, ...env };
  delete e.NO_COLOR;
  if (env.NO_COLOR !== undefined) e.NO_COLOR = env.NO_COLOR;
  if (sb) { e.HOME = sb.home; e.USERPROFILE = sb.home; }
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: e, cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function dirs(sb) { return ['--claude-dir', sb.claude, '--codex-dir', sb.codex]; }

const cu = (text, ts, session = 's1', cwd = '/home/p/shop') =>
  ({ type: 'user', message: { role: 'user', content: text }, timestamp: ts, sessionId: session, cwd });
const ca = (blocks, ts, session = 's1', cwd = '/home/p/shop') =>
  ({ type: 'assistant', message: { role: 'assistant', content: blocks }, timestamp: ts, sessionId: session, cwd });
const meta = (id, cwd, ts = '2026-11-01T00:00:00.000Z') =>
  ({ timestamp: ts, type: 'session_meta', payload: { id, cwd } });
const cxMsg = (role, blocks, ts) =>
  ({ timestamp: ts, type: 'response_item', payload: { type: 'message', role, content: blocks } });
const cxText = (type, text) => ({ type, text });

// ------------------------------------------------------------ Claude Code

test('Claude Code: roles, skips, and what each line becomes', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'proj/a.jsonl', [
      cu('needle typed by me', '2026-11-04T10:00:00.000Z'),
      { ...cu('needle meta', '2026-11-04T10:00:01.000Z'), isMeta: true },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'needle result' }] }, timestamp: '2026-11-04T10:00:02.000Z', sessionId: 's1', cwd: '/x/y' },
      ca([
        { type: 'text', text: 'needle from agent' },
        { type: 'thinking', thinking: 'needle thinking' },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo needle' } },
        { type: 'tool_use', name: 'needleTool' },
        { type: 'image', text: 'needle other' },
      ], '2026-11-04T10:00:03.000Z'),
      { type: 'summary', summary: 'needle summary', timestamp: '2026-11-04T10:00:04.000Z', sessionId: 's1', cwd: '/x' },
      cu('needle no cwd', '2026-11-04T10:00:05.000Z', 's1', ''),
      { ...cu('needle bad time', 'not a date'), },
      { ...cu('needle no session', '2026-11-04T10:00:06.000Z'), sessionId: '' },
      { ...cu('needle numeric time', '2026-11-04T10:00:06.000Z'), timestamp: 5 },
      'this is not json needle',
      '[1,2,3]',
      '"needle"',
      '',
    ]);
    const r = run(['needle', '--json', ...dirs(sb)], { sb });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.tool, 'agent-grep');
    assert.equal(j.version, '0.1.0');
    assert.equal(j.query, 'needle');
    assert.equal(j.matches, 4);
    assert.equal(j.sessions, 1);
    assert.equal(j.searched, 1);
    assert.deepEqual(j.results.map((x) => [x.role, x.text]), [
      ['tool', 'Bash {"command":"echo needle"}'],
      ['tool', 'needleTool'],
      ['agent', 'needle from agent'],
      ['you', 'needle typed by me'],
    ]);
    const first = j.results[1];
    assert.deepEqual(first, {
      agent: 'claude', session: 's1', project: 'shop', cwd: '/home/p/shop',
      timestamp: '2026-11-04T10:00:03.000Z', role: 'tool', text: 'needleTool',
      resume: 'claude --resume s1',
    });
  } finally { sb.cleanup(); }
});

test('Claude Code: only .jsonl files, at any depth, symlinks not followed', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a/b/c/deep.jsonl', [cu('needle deep', '2026-11-04T10:00:00.000Z', 'deep')]);
    write(sb.claude, 'a/other.json', [cu('needle json', '2026-11-04T10:00:00.000Z', 'json')]);
    write(sb.claude, 'a/other.jsonl.bak', [cu('needle bak', '2026-11-04T10:00:00.000Z', 'bak')]);
    write(sb.claude, 'a/notes.txt', [cu('needle txt', '2026-11-04T10:00:00.000Z', 'txt')]);
    write(sb.root, 'outside/target.jsonl', [cu('needle linked', '2026-11-04T10:00:00.000Z', 'linked')]);
    try {
      symlinkSync(join(sb.root, 'outside'), join(sb.claude, 'linkdir'));
      symlinkSync(join(sb.root, 'outside', 'target.jsonl'), join(sb.claude, 'linkfile.jsonl'));
    } catch { /* symlinks not available: the rest still holds */ }
    mkdirSync(join(sb.claude, 'folder.jsonl'));
    const j = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => x.session), ['deep']);
    assert.equal(j.searched, 1);
  } finally { sb.cleanup(); }
});

test('Claude Code: an unreadable shape of line never stops the file', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      '{"type":"user","message":null,"timestamp":"2026-11-04T10:00:00.000Z","sessionId":"s","cwd":"/a"}',
      '{"type":"assistant","message":{"content":"string not array"},"timestamp":"2026-11-04T10:00:00.000Z","sessionId":"s","cwd":"/a"}',
      '{"type":"assistant","message":{"content":[null,1,"x",{"type":"text","text":5},{"type":"text","text":"needle ok"}]},"timestamp":"2026-11-04T10:00:00.000Z","sessionId":"s","cwd":"/a"}',
      '{"broken',
    ]);
    const r = run(['needle', ...dirs(sb)], { sb });
    assert.equal(r.code, 0);
    assert.match(r.out, /1 match in 1 session \(1 session searched\)/);
  } finally { sb.cleanup(); }
});

// ----------------------------------------------------------------- Codex

test('Codex: session meta, roles, joins, skips, tool calls', () => {
  const sb = sandbox();
  try {
    write(sb.codex, '2026/11/04/rollout.jsonl', [
      cxMsg('user', [cxText('input_text', 'needle before any meta')], '2026-11-04T09:00:00.000Z'),
      meta('cx-1', '/home/p/shop/'),
      cxMsg('user', [cxText('input_text', '<environment>needle context</environment>')], '2026-11-04T10:00:00.000Z'),
      cxMsg('user', [cxText('input_text', 'need'), cxText('text', 'le typed'), cxText('image', 'zzz')], '2026-11-04T10:00:01.000Z'),
      cxMsg('assistant', [cxText('output_text', 'a needle '), cxText('output_text', 'answer')], '2026-11-04T10:00:02.000Z'),
      cxMsg('developer', [cxText('input_text', 'needle developer')], '2026-11-04T10:00:03.000Z'),
      { timestamp: '2026-11-04T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"needle"}' } },
      { timestamp: '2026-11-04T10:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'needle patch' } },
      { timestamp: '2026-11-04T10:00:06.000Z', type: 'response_item', payload: { type: 'function_call', name: 'needleCall', arguments: null } },
      { timestamp: '2026-11-04T10:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'needleObj', input: { a: 1 } } },
      { timestamp: '2026-11-04T10:00:08.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'needle output' } },
      { timestamp: '2026-11-04T10:00:09.000Z', type: 'response_item', payload: { type: 'reasoning', summary: 'needle' } },
      { timestamp: '2026-11-04T10:00:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'needle event' } },
      { timestamp: 'garbage', type: 'response_item', payload: { type: 'function_call', name: 'needleBadTime' } },
      meta('cx-2', 'C:\\Users\\p\\Other'),
      cxMsg('assistant', [cxText('output_text', 'needle second session')], '2026-11-04T10:00:11.000Z'),
    ]);
    const r = run(['needle', '--json', ...dirs(sb)], { sb });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.searched, 2);
    assert.deepEqual(j.results.map((x) => [x.session, x.project, x.role, x.text]), [
      ['cx-2', 'Other', 'agent', 'needle second session'],
      ['cx-1', 'shop', 'tool', 'needleObj {"a":1}'],
      ['cx-1', 'shop', 'tool', 'needleCall'],
      ['cx-1', 'shop', 'tool', 'apply_patch needle patch'],
      ['cx-1', 'shop', 'tool', 'shell {"cmd":"needle"}'],
      ['cx-1', 'shop', 'agent', 'a needle answer'],
      ['cx-1', 'shop', 'you', 'needle typed'],
    ]);
    assert.ok(j.results.every((x) => x.agent === 'codex' && x.resume === null));
    assert.equal(j.results[0].cwd, 'C:\\Users\\p\\Other');
  } finally { sb.cleanup(); }
});

test('Codex: meta is per file; a later meta replaces the session', () => {
  const sb = sandbox();
  try {
    write(sb.codex, 'one.jsonl', [meta('first', '/a/one'), cxMsg('assistant', [cxText('output_text', 'needle 1')], '2026-11-04T10:00:00.000Z')]);
    write(sb.codex, 'two.jsonl', [cxMsg('assistant', [cxText('output_text', 'needle 2')], '2026-11-04T10:00:01.000Z')]);
    const j = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => x.session), ['first']);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- Project

test('project is the last folder of cwd, with / or \\ and trailing separators', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('needle', '2026-11-04T10:00:01.000Z', 'a', '/home/p/shop/'),
      cu('needle', '2026-11-04T10:00:02.000Z', 'b', 'C:\\Users\\p\\shop'),
      cu('needle', '2026-11-04T10:00:03.000Z', 'c', '/'),
      cu('needle', '2026-11-04T10:00:04.000Z', 'd', '\\\\server\\share\\Odd Name\\'),
    ]);
    const j = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => [x.session, x.project]), [['d', 'Odd Name'], ['c', ''], ['b', 'shop'], ['a', 'shop']]);
    const plain = run(['needle', ...dirs(sb)], { sb }).out;
    assert.match(plain, /^2026-11-04T10:00:03.000Z {2}claude {2}you {2}- {2}c$/m);
  } finally { sb.cleanup(); }
});

test('--project matches the project name ignoring case', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('needle', '2026-11-04T10:00:01.000Z', 'a', '/home/p/Shop'),
      cu('needle', '2026-11-04T10:00:02.000Z', 'b', '/home/p/other'),
      cu('hay', '2026-11-04T10:00:03.000Z', 'c', '/home/p/shop'),
    ]);
    const j = JSON.parse(run(['needle', '--project', 'sHOP', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => x.session), ['a']);
    assert.equal(j.searched, 2); // a and c are shop sessions; c has no match
    const k = JSON.parse(run(['needle', '--project=nothing', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(k.searched, 0);
  } finally { sb.cleanup(); }
});

// ------------------------------------------------------------------ Query

test('words: all in one message, any case, any order, plain substrings', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('The CACHE has a Bug in it', '2026-11-04T10:00:01.000Z', 'a'),
      cu('bugs and cached', '2026-11-04T10:00:02.000Z', 'b'),
      cu('only cache here', '2026-11-04T10:00:03.000Z', 'c'),
      cu('file a.c and a*c and [x]', '2026-11-04T10:00:04.000Z', 'd'),
    ]);
    const sessions = (args) => JSON.parse(run(['--json', ...dirs(sb), ...args], { sb }).out).results.map((x) => x.session);
    assert.deepEqual(sessions(['cache', 'bug']), ['b', 'a']);
    assert.deepEqual(sessions(['bug cache']), ['b', 'a']);
    assert.deepEqual(sessions(['BUG', 'CACHE']), ['b', 'a']);
    assert.deepEqual(sessions(['a*c']), ['d']);
    assert.deepEqual(sessions(['[x]']), ['d']);
    assert.deepEqual(sessions(['a.c']), ['d']);
    assert.deepEqual(sessions(['--', 'cache', 'bug']), ['b', 'a']);
    assert.equal(JSON.parse(run(['cache', 'bug', '--json', ...dirs(sb)], { sb }).out).query, 'cache bug');
    assert.equal(JSON.parse(run(['  cache   bug', '--json', ...dirs(sb)], { sb }).out).matches, 2);
  } finally { sb.cleanup(); }
});

test('whitespace in a message is collapsed before matching and printing', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('  line one\n\n\tline   two  ', '2026-11-04T10:00:01.000Z')]);
    const j = JSON.parse(run(['/one\\s{2}line/', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(j.matches, 0);
    const m = JSON.parse(run(['/one line/', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(m.results[0].text, 'line one line two');
  } finally { sb.cleanup(); }
});

test('regex: /pattern/flags, case sensitive by default, g and y ignored', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('Error 404 in handler', '2026-11-04T10:00:01.000Z', 'a'),
      cu('error 500 in handler', '2026-11-04T10:00:02.000Z', 'b'),
      cu('see /usr/bin/node', '2026-11-04T10:00:03.000Z', 'c'),
    ]);
    const sessions = (args) => JSON.parse(run(['--json', ...dirs(sb), ...args], { sb }).out).results.map((x) => x.session);
    assert.deepEqual(sessions(['/error \\d+/']), ['b']);
    assert.deepEqual(sessions(['/error \\d+/i']), ['b', 'a']);
    assert.deepEqual(sessions(['/error \\d+/gi']), ['b', 'a']);
    assert.deepEqual(sessions(['/ERROR/y']), []);
    assert.deepEqual(sessions(['/^error/i']), ['b', 'a']);
    assert.deepEqual(sessions(['/usr/bin']), ['c']); // not a regex (b, n are no flags): words
  } finally { sb.cleanup(); }
});

test('regex: "/usr/bin" is words, matched as a substring', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('see /usr/bin/node', '2026-11-04T10:00:03.000Z', 'c')]);
    const j = JSON.parse(run(['/usr/bin', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(j.matches, 1);
  } finally { sb.cleanup(); }
});

test('regex: an empty-only match never matches, a later non-empty one does', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('baa', '2026-11-04T10:00:03.000Z', 'a'), cu('xyz', '2026-11-04T10:00:02.000Z', 'b')]);
    const j = JSON.parse(run(['/a*/', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => [x.session, x.text]), [['a', 'baa']]);
    const z = JSON.parse(run(['/a*/', '--context', '0', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(z.results[0].text, '…aa');
    const e = run(['/^$/', ...dirs(sb)], { sb });
    assert.equal(e.code, 1);
  } finally { sb.cleanup(); }
});

// ------------------------------------------------------------------ Order

test('newest first by instant, with the stated tie-breaks', () => {
  const sb = sandbox();
  try {
    const T = '2026-11-04T10:00:00.000Z';
    write(sb.claude, 'a.jsonl', [
      cu('needle b-you', T, 'sB'),
      ca([{ type: 'text', text: 'needle b-agent' }, { type: 'tool_use', name: 'needle', input: {} }], T, 'sB'),
      cu('needle a-you z', T, 'sA'),
      cu('needle a-you a', T, 'sA'),
      cu('needle same instant other string', '2026-11-04T11:00:00.000+01:00', 'sA'),
      cu('needle older', '2026-11-04T09:59:59.999Z', 'sA'),
      cu('needle newest', '2026-11-04T10:00:00.001Z', 'sZ'),
    ]);
    write(sb.codex, 'x.jsonl', [
      meta('sA', '/c/codexproj'),
      cxMsg('assistant', [cxText('output_text', 'needle codex')], T),
    ]);
    const j = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.deepEqual(j.results.map((x) => [x.agent, x.session, x.timestamp, x.role, x.text]), [
      ['claude', 'sZ', '2026-11-04T10:00:00.001Z', 'you', 'needle newest'],
      ['claude', 'sA', '2026-11-04T10:00:00.000Z', 'you', 'needle a-you a'],
      ['claude', 'sA', '2026-11-04T10:00:00.000Z', 'you', 'needle a-you z'],
      ['claude', 'sA', '2026-11-04T11:00:00.000+01:00', 'you', 'needle same instant other string'],
      ['claude', 'sB', '2026-11-04T10:00:00.000Z', 'tool', 'needle {}'],
      ['claude', 'sB', '2026-11-04T10:00:00.000Z', 'agent', 'needle b-agent'],
      ['claude', 'sB', '2026-11-04T10:00:00.000Z', 'you', 'needle b-you'],
      ['codex', 'sA', T, 'agent', 'needle codex'],
      ['claude', 'sA', '2026-11-04T09:59:59.999Z', 'you', 'needle older'],
    ]);
  } finally { sb.cleanup(); }
});

test('the order is the same however the files are laid out', () => {
  const sb = sandbox();
  try {
    const T = '2026-11-04T10:00:00.000Z';
    write(sb.claude, 'z.jsonl', [cu('needle one', T, 's1'), cu('needle two', T, 's2')]);
    write(sb.claude, 'a.jsonl', [cu('needle three', T, 's0')]);
    const a = run(['needle', '--json', ...dirs(sb)], { sb }).out;
    const j = JSON.parse(a);
    assert.deepEqual(j.results.map((x) => x.session), ['s0', 's1', 's2']);
  } finally { sb.cleanup(); }
});

test('--limit cuts the list but the counts stay', () => {
  const sb = sandbox();
  try {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(cu(`needle ${i}`, `2026-11-04T10:00:${String(i).padStart(2, '0')}.000Z`, `s${i % 3}`));
    write(sb.claude, 'a.jsonl', lines);
    const d = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(d.results.length, 20);
    assert.equal(d.matches, 30);
    assert.equal(d.results[0].text, 'needle 29');
    const j = JSON.parse(run(['needle', '--limit', '3', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(j.results.length, 3);
    assert.equal(j.matches, 30);
    assert.equal(j.sessions, 3);
    assert.equal(j.searched, 3);
    const p = run(['needle', '--limit=2', ...dirs(sb)], { sb });
    assert.match(p.out, /^30 matches in 3 sessions \(3 sessions searched\), showing 2\n$/m);
    const all = run(['needle', '--limit', '30', ...dirs(sb)], { sb });
    assert.match(all.out, /^30 matches in 3 sessions \(3 sessions searched\)\n$/m);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- Filters

test('--role (repeatable), --agent, and the sessions searched', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('needle you', '2026-11-04T10:00:01.000Z', 'only-you'),
      ca([{ type: 'text', text: 'needle agent' }], '2026-11-04T10:00:02.000Z', 'only-agent'),
      ca([{ type: 'tool_use', name: 'Run', input: { q: 'needle' } }], '2026-11-04T10:00:03.000Z', 'has-tool'),
      cu('hay', '2026-11-04T10:00:04.000Z', 'has-tool'),
    ]);
    write(sb.codex, 'b.jsonl', [
      meta('cx', '/p/cx'),
      cxMsg('assistant', [cxText('output_text', 'needle codex')], '2026-11-04T10:00:05.000Z'),
    ]);
    const q = (args) => JSON.parse(run(['needle', ...args, '--json', ...dirs(sb)], { sb }).out);
    let j = q(['--role', 'tool']);
    assert.deepEqual([j.matches, j.sessions, j.searched], [1, 1, 1]);
    j = q(['--role', 'tool', '--role=you']);
    assert.deepEqual(j.results.map((x) => x.role), ['tool', 'you']);
    assert.equal(j.searched, 2);
    j = q(['--role', 'you']);
    assert.equal(j.searched, 2); // only-you and has-tool (its prompt "hay")
    assert.equal(j.matches, 1);
    j = q(['--agent', 'codex']);
    assert.deepEqual(j.results.map((x) => x.agent), ['codex']);
    assert.equal(j.searched, 1);
    j = q(['--agent', 'claude']);
    assert.equal(j.matches, 3);
    assert.equal(j.searched, 3);
  } finally { sb.cleanup(); }
});

test('--agent reads only that source folder', () => {
  const sb = sandbox();
  try {
    write(sb.codex, 'b.jsonl', [meta('cx', '/p/cx'), cxMsg('assistant', [cxText('output_text', 'needle')], '2026-11-04T10:00:05.000Z')]);
    const r = run(['needle', '--agent', 'claude', '--claude-dir', sb.claude, '--codex-dir', join(sb.root, 'does-not-exist')], { sb });
    assert.equal(r.code, 1);
    assert.equal(r.out, '0 matches in 0 sessions (0 sessions searched)\n');
  } finally { sb.cleanup(); }
});

test('--since and --until: whole UTC days, timestamps, offsets, inclusive ends', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [
      cu('needle', '2026-10-27T23:59:59.999Z', 'd0'),
      cu('needle', '2026-10-28T00:00:00.000Z', 'd1'),
      cu('needle', '2026-10-28T12:00:00.000Z', 'd2'),
      cu('needle', '2026-10-28T23:59:59.999Z', 'd3'),
      cu('needle', '2026-10-29T00:00:00.000Z', 'd4'),
      cu('needle', '2026-10-28T13:00:00.000+01:00', 'd5'), // 12:00Z
    ]);
    const s = (args) => JSON.parse(run(['needle', ...args, '--json', ...dirs(sb)], { sb }).out);
    const ids = (j) => j.results.map((x) => x.session).sort();
    assert.deepEqual(ids(s(['--since', '2026-10-28'])), ['d1', 'd2', 'd3', 'd4', 'd5']);
    assert.deepEqual(ids(s(['--until', '2026-10-28'])), ['d0', 'd1', 'd2', 'd3', 'd5']);
    assert.deepEqual(ids(s(['--since', '2026-10-28', '--until=2026-10-28'])), ['d1', 'd2', 'd3', 'd5']);
    assert.deepEqual(ids(s(['--since', '2026-10-28T12:00Z', '--until', '2026-10-28T12:00:00Z'])), ['d2', 'd5']);
    assert.deepEqual(ids(s(['--since', '2026-10-28T12:00:00.000Z', '--until', '2026-10-28T12:00:00.000Z'])), ['d2', 'd5']);
    assert.deepEqual(ids(s(['--since', '2026-10-28T13:00:00+01:00', '--until', '2026-10-28T13:00:00.000+01:00'])), ['d2', 'd5']);
    assert.deepEqual(ids(s(['--since', '2026-10-28T12:00:00.001Z', '--until', '2026-10-28T23:59:59.998Z'])), []);
    assert.deepEqual(ids(s(['--until', '2026-10-28T00:00:00.000-02:00'])), ['d0', 'd1']);
    assert.equal(s(['--since', '2026-10-29', '--until', '2026-10-30']).searched, 1);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- Context

test('the text is cut around the first match with … where cut', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('0123456789 Cache 0123456789 cache bug 0123456789', '2026-11-04T10:00:00.000Z')]);
    const t = (args) => JSON.parse(run([...args, '--json', ...dirs(sb)], { sb }).out).results[0].text;
    assert.equal(t(['cache', '--context', '3']), '…89 Cache 01…');
    assert.equal(t(['cache', '--context=0']), '…Cache…');
    assert.equal(t(['cache', '--context', '1000']), '0123456789 Cache 0123456789 cache bug 0123456789');
    assert.equal(t(['bug', 'cache', '--context', '2']), '…9 Cache 0…'); // leftmost of any word
    assert.equal(t(['/c\\w+ b\\w+/', '--context', '4']), '…789 cache bug 012…');
    assert.equal(t(['0123456789', '--context', '2']), '0123456789 C…');
    assert.equal(t(['0123456789 ', '--context', '2']), '0123456789 C…'); // words: the space is only a separator
    assert.equal(t(['cache', '--context', '1000']).includes('…'), false);
  } finally { sb.cleanup(); }
});

test('the longest word wins when two start at the same place', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('xx cacheable yy', '2026-11-04T10:00:00.000Z')]);
    const t = JSON.parse(run(['cache', 'cacheable', '--context', '0', '--json', ...dirs(sb)], { sb }).out).results[0].text;
    assert.equal(t, '…cacheable…');
  } finally { sb.cleanup(); }
});

test('context counts code points, a surrogate pair is one', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('😀😀😀 needle 😀😀😀', '2026-11-04T10:00:00.000Z')]);
    const t = (c) => JSON.parse(run(['needle', '--context', String(c), '--json', ...dirs(sb)], { sb }).out).results[0].text;
    assert.equal(t(2), '…😀 needle 😀…');
    assert.equal(t(1), '… needle …');
    assert.equal(t(3), '…😀😀 needle 😀😀…');
    assert.equal(t(4), '😀😀😀 needle 😀😀😀');
  } finally { sb.cleanup(); }
});

test('words and text are matched in any case, also beyond ASCII', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('Ünïcode ÇA va', '2026-11-04T10:00:00.000Z')]);
    const j = JSON.parse(run(['ÜNÏCODE', 'ça', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(j.matches, 1);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- Plain form

test('plain form: header, text, resume line for Claude only, summary', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('cache BUG on windows', '2026-11-03T12:00:00.000Z', 'c-win-1', 'C:\\Users\\p\\winproj')]);
    write(sb.codex, 'b.jsonl', [meta('cx-7', ''), cxMsg('assistant', [cxText('output_text', 'the cache bug is gone')], '2026-11-04T08:00:00+00:00')]);
    const r = run(['cache', 'bug', ...dirs(sb)], { sb });
    assert.equal(r.code, 0);
    assert.equal(r.err, '');
    assert.equal(r.out, [
      '2026-11-04T08:00:00+00:00  codex  agent  -  cx-7',
      '  the cache bug is gone',
      '',
      '2026-11-03T12:00:00.000Z  claude  you  winproj  c-win-1',
      '  cache BUG on windows',
      '  claude --resume c-win-1',
      '',
      '2 matches in 2 sessions (2 sessions searched)',
      '',
    ].join('\n'));
  } finally { sb.cleanup(); }
});

test('plain form: singular summary and the no-match line', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('needle', '2026-11-03T12:00:00.000Z', 's')]);
    assert.equal(run(['needle', ...dirs(sb)], { sb }).out.split('\n').slice(-2)[0], '1 match in 1 session (1 session searched)');
    const none = run(['absent', ...dirs(sb)], { sb });
    assert.equal(none.code, 1);
    assert.equal(none.out, '0 matches in 0 sessions (1 session searched)\n');
  } finally { sb.cleanup(); }
});

test('no colour codes when piped, with or without NO_COLOR', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('needle', '2026-11-03T12:00:00.000Z', 's')]);
    for (const env of [{}, { NO_COLOR: '1' }, { FORCE_COLOR: '1' }]) {
      const r = run(['needle', ...dirs(sb)], { sb, env });
      assert.equal(r.out.includes('\x1b'), false);
    }
    const j = run(['needle', '--json', ...dirs(sb)], { sb });
    assert.equal(j.out.includes('\x1b'), false);
  } finally { sb.cleanup(); }
});

// ------------------------------------------------------------------- JSON

test('--json prints exactly one object, also when nothing matched', () => {
  const sb = sandbox();
  try {
    const r = run(['nothing here', '--json', ...dirs(sb)], { sb });
    assert.equal(r.code, 1);
    assert.deepEqual(JSON.parse(r.out), { tool: 'agent-grep', version: '0.1.0', query: 'nothing here', matches: 0, sessions: 0, searched: 0, results: [] });
    assert.ok(r.out.endsWith('\n'));
  } finally { sb.cleanup(); }
});

test('--json text is never marked and carries the … cuts', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('aaaa needle bbbb', '2026-11-03T12:00:00.000Z', 's')]);
    const j = JSON.parse(run(['needle', '--context', '2', '--json', ...dirs(sb)], { sb, env: { FORCE_COLOR: '1' } }).out);
    assert.equal(j.results[0].text, '…a needle b…');
  } finally { sb.cleanup(); }
});

// ----------------------------------------------------------- Repeated message

test('a message repeated in a second file of the same session is one match', () => {
  const sb = sandbox();
  try {
    const line = cu('needle repeated', '2026-11-03T12:00:00.000Z', 'same');
    write(sb.claude, 'one.jsonl', [line, line]);
    write(sb.claude, 'sub/two.jsonl', [line, cu('needle other', '2026-11-03T12:00:01.000Z', 'same')]);
    write(sb.claude, 'three.jsonl', [cu('needle repeated', '2026-11-03T12:00:00.000Z', 'different-session')]);
    const j = JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out);
    assert.equal(j.matches, 3);
    assert.equal(j.sessions, 2);
    assert.equal(j.searched, 2);
    // same text, another timestamp string: not the same message
    write(sb.claude, 'four.jsonl', [cu('needle repeated', '2026-11-03T12:00:00Z', 'same')]);
    assert.equal(JSON.parse(run(['needle', '--json', ...dirs(sb)], { sb }).out).matches, 4);
  } finally { sb.cleanup(); }
});

// ------------------------------------------------------------ Folders & HOME

test('a missing folder is no sessions, not an error', () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.root, 'file'), 'not a folder');
    const r = run(['x', '--claude-dir', join(sb.root, 'nope'), '--codex-dir', join(sb.root, 'file')], { sb });
    assert.equal(r.code, 1);
    assert.equal(r.out, '0 matches in 0 sessions (0 sessions searched)\n');
    const r2 = run(['x', '--claude-dir', join(sb.root, 'file'), '--codex-dir', join(sb.root, 'file')], { sb });
    assert.equal(r2.code, 1);
  } finally { sb.cleanup(); }
});

test('without --claude-dir and --codex-dir the logs are read from the home folder', () => {
  const sb = sandbox();
  try {
    write(sb.home, '.claude/projects/p1/a.jsonl', [cu('needle in claude home', '2026-11-03T12:00:00.000Z', 'hc')]);
    write(sb.home, '.codex/sessions/2026/11/b.jsonl', [meta('hx', '/p/q'), cxMsg('assistant', [cxText('output_text', 'needle in codex home')], '2026-11-03T12:00:01.000Z')]);
    const j = JSON.parse(run(['needle', '--json'], { sb }).out);
    assert.deepEqual(j.results.map((x) => x.session), ['hx', 'hc']);
    // one of them given: the other still comes from home
    const k = JSON.parse(run(['needle', '--json', '--claude-dir', sb.claude], { sb }).out);
    assert.deepEqual(k.results.map((x) => x.session), ['hx']);
  } finally { sb.cleanup(); }
});

// ----------------------------------------------------------- Usage & exits

test('usage errors: exit 2, a message on stderr, nothing on stdout', () => {
  const sb = sandbox();
  try {
    const cases = [
      [],
      ['   '],
      [''],
      ['--json'],
      ['--', ''],
      ['x', '--bogus'],
      ['x', '-z'],
      ['x', '--role', 'robot'],
      ['x', '--role'],
      ['x', '--agent', 'gemini'],
      ['x', '--agent'],
      ['x', '--limit', '0'],
      ['x', '--limit', '-1'],
      ['x', '--limit', '1.5'],
      ['x', '--limit', 'many'],
      ['x', '--limit'],
      ['x', '--context', '-1'],
      ['x', '--context', 'abc'],
      ['x', '--context=1.5'],
      ['x', '--since', 'yesterday'],
      ['x', '--since', '2026-02-30'],
      ['x', '--since', '2026-13-01'],
      ['x', '--until', '2026-1-1'],
      ['x', '--since', '2026-10-28T10:00'],
      ['x', '--since', '2026-10-28T25:00Z'],
      ['x', '--since', '2026-10-28T10:00:00.5Z'],
      ['x', '--since', '2026-10-28 10:00Z'],
      ['x', '--since'],
      ['x', '--project'],
      ['x', '--claude-dir'],
      ['x', '--codex-dir'],
      ['x', '--json=yes'],
      ['/(/'],
      ['/a/gg'],
      ['/a/uv'],
      ['/[/i'],
    ];
    for (const args of cases) {
      const r = run([...dirs(sb), ...args], { sb });
      assert.equal(r.code, 2, `exit for ${JSON.stringify(args)}`);
      assert.equal(r.out, '', `stdout for ${JSON.stringify(args)}`);
      assert.notEqual(r.err, '', `stderr for ${JSON.stringify(args)}`);
    }
  } finally { sb.cleanup(); }
});

test('options may come before, between or after the query, with = or a space', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('cache bug', '2026-11-03T12:00:00.000Z', 's', '/p/Shop')]);
    for (const args of [
      ['cache', 'bug', '--role', 'you', '--project=shop'],
      ['--role=you', 'cache', '--project', 'shop', 'bug'],
      ['--project', 'shop', '--role', 'you', '--', 'cache', 'bug'],
      ['--limit=5', '--context=3', 'cache bug'],
    ]) {
      const r = run(['--json', ...dirs(sb), ...args], { sb });
      assert.equal(r.code, 0, JSON.stringify(args));
      assert.equal(JSON.parse(r.out).query, 'cache bug');
    }
  } finally { sb.cleanup(); }
});

test('after -- every argument is part of the query', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('use --json and --role here', '2026-11-03T12:00:00.000Z', 's')]);
    const r = run(['--json', ...dirs(sb), '--', '--json', '--role'], { sb });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.query, '--json --role');
    assert.equal(j.matches, 1);
  } finally { sb.cleanup(); }
});

test('--help prints the usage on stdout and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage:/);
  assert.match(r.out, /--claude-dir/);
  assert.equal(r.err, '');
});

test('exit codes: 0 matched, 1 nothing matched', () => {
  const sb = sandbox();
  try {
    write(sb.claude, 'a.jsonl', [cu('needle', '2026-11-03T12:00:00.000Z', 's')]);
    assert.equal(run(['needle', ...dirs(sb)], { sb }).code, 0);
    assert.equal(run(['needle', '--json', ...dirs(sb)], { sb }).code, 0);
    assert.equal(run(['absent', ...dirs(sb)], { sb }).code, 1);
    assert.equal(run(['absent', '--json', ...dirs(sb)], { sb }).code, 1);
    assert.equal(run(['needle', '--role', 'tool', ...dirs(sb)], { sb }).code, 1);
  } finally { sb.cleanup(); }
});

test('the file starts with the node shebang and the package.json is as the job says', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TOOL, 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env node\n'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'agent-grep');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { 'agent-grep': 'agent-grep.mjs' });
  assert.deepEqual(pkg.files, ['agent-grep.mjs', 'README.md', 'LICENSE']);
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.repository.url, 'git+https://github.com/tick-ai/agent-grep.git');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

// -------------------------------------------------------------------- Speed

test('stays quick on tens of thousands of messages', () => {
  const sb = sandbox();
  try {
    const lines = [];
    for (let i = 0; i < 40000; i++) {
      const ts = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
      lines.push(i % 2
        ? ca([{ type: 'text', text: `answer ${i} about the loader and the cache layer ${'x'.repeat(100)}` }], ts, `s${i % 40}`)
        : cu(`prompt ${i} cache bug`, ts, `s${i % 40}`));
    }
    write(sb.claude, 'big.jsonl', lines);
    const t0 = Date.now();
    const r = run(['cache', 'bug', '--json', ...dirs(sb)], { sb });
    const ms = Date.now() - t0;
    assert.equal(JSON.parse(r.out).matches, 20000);
    assert.ok(ms < 5000, `took ${ms} ms`);
  } finally { sb.cleanup(); }
});
