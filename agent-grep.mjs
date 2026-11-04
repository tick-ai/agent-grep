#!/usr/bin/env node
// agent-grep: search everything you ever asked your AI agents.
// Reads local Claude Code and Codex session logs. No network, no telemetry.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.1.0';
const TOOL = 'agent-grep';

const USAGE = `agent-grep ${VERSION}: search everything you ever asked your AI agents

Usage:
  agent-grep <query> [--role you|agent|tool]... [--project <name>] [--since <date>] [--until <date>]
             [--agent claude|codex] [--limit <n>] [--context <n>] [--json]
             [--claude-dir <dir>] [--codex-dir <dir>]

  <query>           words (all must appear in one message, any case, any order)
                    or /regex/flags (a JavaScript regular expression)
  --role <role>     only you, agent or tool messages (may be repeated)
  --agent <agent>   only claude or codex sessions
  --project <name>  only sessions whose project (last folder of cwd) is <name>, ignoring case
  --since <date>    only messages from this moment on (YYYY-MM-DD, or YYYY-MM-DDTHH:MM[:SS[.fff]]Z or +01:00)
  --until <date>    only messages up to this moment (same forms; a bare day includes the whole day)
  --limit <n>       print at most n results (default 20)
  --context <n>     characters shown each side of the match (default 80)
  --json            print one JSON object instead of the plain form
  --claude-dir <d>  Claude Code folder (default ~/.claude/projects)
  --codex-dir <d>   Codex folder (default ~/.codex/sessions)
  --help            print this help

Exit status: 0 something matched, 1 nothing matched, 2 usage error.
`;

class UsageError extends Error {}

// ---------------------------------------------------------------- arguments

const FLAG_OPTIONS = new Set(['--json', '--help']);
const VALUE_OPTIONS = new Set([
  '--role', '--agent', '--project', '--since', '--until',
  '--limit', '--context', '--claude-dir', '--codex-dir',
]);

function parseDate(value, name, isUntil) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = utc(y, mo, d, 0, 0, 0, 0);
    if (t === null) throw new UsageError(`${name}: no such day: ${value}`);
    return isUntil ? t + 86400000 - 1 : t;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) throw new UsageError(`${name}: not a date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]] with Z or an offset): ${value}`);
  const h = +m[4], mi = +m[5], s = m[6] === undefined ? 0 : +m[6], ms = m[7] === undefined ? 0 : +m[7];
  if (h > 23 || mi > 59 || s > 59) throw new UsageError(`${name}: no such time: ${value}`);
  let offset = 0;
  if (m[8] === undefined) {
    const oh = +m[10], om = +m[11];
    if (oh > 23 || om > 59) throw new UsageError(`${name}: no such offset: ${value}`);
    offset = (oh * 60 + om) * 60000 * (m[9] === '-' ? -1 : 1);
  }
  const t = utc(+m[1], +m[2], +m[3], h, mi, s, ms);
  if (t === null) throw new UsageError(`${name}: no such day: ${value}`);
  return t - offset;
}

// Milliseconds since the epoch of a UTC moment, or null when the day does not exist.
function utc(y, mo, d, h, mi, s, ms) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

function parseWhole(value, name, min) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} needs a whole number of ${min} or more, got "${value}"`);
  const n = Number(value);
  if (n < min) throw new UsageError(`${name} needs a whole number of ${min} or more, got "${value}"`);
  return n;
}

function parseArgs(argv) {
  const opts = {
    help: false, json: false, roles: [], agent: null, project: null,
    since: null, until: null, limit: 20, context: 80, claudeDir: null, codexDir: null,
    words: [],
  };
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest || arg === '-' || !arg.startsWith('-')) { opts.words.push(arg); continue; }
    if (arg === '--') { rest = true; continue; }
    let name = arg, value = null;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq !== -1) { name = arg.slice(0, eq); value = arg.slice(eq + 1); }
    if (FLAG_OPTIONS.has(name)) {
      if (value !== null) throw new UsageError(`${name} takes no value`);
      if (name === '--help') { opts.help = true; return opts; }
      opts.json = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option: ${arg}`);
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${name} needs a value`);
      const stringy = name === '--project' || name === '--claude-dir' || name === '--codex-dir';
      if (stringy && next.startsWith('--')) throw new UsageError(`${name} needs a value`);
      value = next;
      i++;
    }
    switch (name) {
      case '--role':
        if (value !== 'you' && value !== 'agent' && value !== 'tool') throw new UsageError(`--role must be you, agent or tool, got "${value}"`);
        opts.roles.push(value);
        break;
      case '--agent':
        if (value !== 'claude' && value !== 'codex') throw new UsageError(`--agent must be claude or codex, got "${value}"`);
        opts.agent = value;
        break;
      case '--project': opts.project = value; break;
      case '--since': opts.since = parseDate(value, '--since', false); break;
      case '--until': opts.until = parseDate(value, '--until', true); break;
      case '--limit': opts.limit = parseWhole(value, '--limit', 1); break;
      case '--context': opts.context = parseWhole(value, '--context', 0); break;
      case '--claude-dir': opts.claudeDir = value; break;
      case '--codex-dir': opts.codexDir = value; break;
    }
  }
  return opts;
}

// ------------------------------------------------------------------- query

const REGEX_QUERY = /^\/([\s\S]+)\/([dgimsuvy]*)$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Returns { query, test(text) -> bool, find(text) -> {index,length}|null, mark(text) -> string }.
function buildMatcher(query) {
  const rm = REGEX_QUERY.exec(query);
  if (rm) {
    const pattern = rm[1], flags = rm[2];
    try { new RegExp(pattern, flags); } catch (e) {
      throw new UsageError(`bad regular expression ${query}: ${e.message}`);
    }
    const kept = [...flags].filter((f) => f !== 'g' && f !== 'y').join('');
    const re = new RegExp(pattern, kept + 'g');
    const unicode = kept.includes('u') || kept.includes('v');
    const find = (text) => {
      let found = null;
      eachMatch(re, text, unicode, (index, length) => { found = { index, length }; return false; });
      return found;
    };
    return {
      find,
      test: (text) => find(text) !== null,
      mark: (text) => markWith(re, text, unicode),
    };
  }
  const words = [...new Set(query.split(/\s+/).filter((w) => w !== ''))];
  const tests = words.map((w) => new RegExp(escapeRegExp(w), 'iu'));
  const any = new RegExp(
    [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'giu');
  const find = (text) => {
    any.lastIndex = 0;
    const m = any.exec(text);
    return m === null ? null : { index: m.index, length: m[0].length };
  };
  return {
    find,
    test: (text) => {
      for (let i = 0; i < tests.length; i++) if (!tests[i].test(text)) return false;
      return true;
    },
    mark: (text) => markWith(any, text, true),
  };
}

// Calls fn(index, length) for every non-empty match; fn returns false to stop.
function eachMatch(re, text, unicode, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      let next = re.lastIndex + 1;
      if (unicode && next < text.length && isLow(text.charCodeAt(next)) && isHigh(text.charCodeAt(next - 1))) next++;
      if (next > text.length) break;
      re.lastIndex = next;
      continue;
    }
    if (fn(m.index, m[0].length) === false) break;
  }
}

function markWith(re, text, unicode) {
  let out = '', last = 0;
  eachMatch(re, text, unicode, (index, length) => {
    out += text.slice(last, index) + '\x1b[1;33m' + text.slice(index, index + length) + '\x1b[0m';
    last = index + length;
  });
  return out + text.slice(last);
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

// The match with up to `context` code points each side; returns the pieces.
function cut(text, index, length, context) {
  let start = index;
  for (let n = 0; n < context && start > 0; n++) {
    start--;
    if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start--;
  }
  let end = index + length;
  for (let n = 0; n < context && end < text.length; n++) {
    if (isHigh(text.charCodeAt(end)) && end + 1 < text.length && isLow(text.charCodeAt(end + 1))) end++;
    end++;
  }
  return { core: text.slice(start, end), before: start > 0, after: end < text.length };
}

// ------------------------------------------------------------------ reading

function listJsonl(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  files.sort();
  return files;
}

function readLines(file) {
  let data;
  try { data = readFileSync(file, 'utf8'); } catch { return []; }
  return data.split('\n');
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v !== '';

function parseLine(line) {
  if (line.length < 2) return null;
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  return isObject(v) ? v : null;
}

// emit(session, cwd, timestamp, instant, role, rawText)
function readClaude(file, emit) {
  for (const line of readLines(file)) {
    const o = parseLine(line);
    if (o === null) continue;
    const type = o.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = o.message;
    if (!isObject(message)) continue;
    const content = message.content;
    if (type === 'user') {
      if (typeof content !== 'string' || o.isMeta === true) continue;
    } else if (!Array.isArray(content)) continue;
    if (!nonEmpty(o.timestamp) || !nonEmpty(o.sessionId) || !nonEmpty(o.cwd)) continue;
    const instant = Date.parse(o.timestamp);
    if (Number.isNaN(instant)) continue;
    if (type === 'user') {
      emit(o.sessionId, o.cwd, o.timestamp, instant, 'you', content);
      continue;
    }
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text') {
        if (typeof block.text === 'string') emit(o.sessionId, o.cwd, o.timestamp, instant, 'agent', block.text);
      } else if (block.type === 'tool_use') {
        if (typeof block.name !== 'string') continue;
        const input = block.input;
        const text = input === undefined || input === null ? block.name : block.name + ' ' + JSON.stringify(input);
        emit(o.sessionId, o.cwd, o.timestamp, instant, 'tool', text);
      }
    }
  }
}

function readCodex(file, emit) {
  let session = null, cwd = '';
  for (const line of readLines(file)) {
    const o = parseLine(line);
    if (o === null) continue;
    const payload = o.payload;
    if (!isObject(payload)) continue;
    if (o.type === 'session_meta') {
      if (nonEmpty(payload.id)) {
        session = payload.id;
        cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      }
      continue;
    }
    if (o.type !== 'response_item' || session === null) continue;
    if (typeof o.timestamp !== 'string') continue;
    const pt = payload.type;
    if (pt === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (!Array.isArray(payload.content)) continue;
      let text = '';
      for (const b of payload.content) {
        if (isObject(b) && (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') text += b.text;
      }
      if (role === 'user' && text.startsWith('<')) continue;
      const instant = Date.parse(o.timestamp);
      if (Number.isNaN(instant)) continue;
      emit(session, cwd, o.timestamp, instant, role === 'user' ? 'you' : 'agent', text);
    } else if (pt === 'function_call' || pt === 'custom_tool_call') {
      if (typeof payload.name !== 'string') continue;
      const arg = pt === 'function_call' ? payload.arguments : payload.input;
      let text;
      if (arg === undefined || arg === null) text = payload.name;
      else text = payload.name + ' ' + (typeof arg === 'string' ? arg : JSON.stringify(arg));
      const instant = Date.parse(o.timestamp);
      if (Number.isNaN(instant)) continue;
      emit(session, cwd, o.timestamp, instant, 'tool', text);
    }
  }
}

function projectOf(cwd) {
  const parts = cwd.split(/[/\\]/).filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

// ------------------------------------------------------------------ search

const ROLE_ORDER = { tool: 0, agent: 1, you: 2 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function search(opts, matcher) {
  const roles = opts.roles.length ? new Set(opts.roles) : null;
  const projectFilter = opts.project === null ? null : opts.project.toLowerCase();
  const searched = new Set();
  const matched = new Set();
  const seen = new Set();
  const found = [];
  const projectCache = new Map();

  const sources = [];
  if (opts.agent !== 'codex') sources.push(['claude', opts.claudeDir ?? join(homedir(), '.claude', 'projects'), readClaude]);
  if (opts.agent !== 'claude') sources.push(['codex', opts.codexDir ?? join(homedir(), '.codex', 'sessions'), readCodex]);

  for (const [agent, dir, reader] of sources) {
    const emit = (session, cwd, timestamp, instant, role, raw) => {
      if (raw === '') return;
      if (roles !== null && !roles.has(role)) return;
      if (opts.since !== null && instant < opts.since) return;
      if (opts.until !== null && instant > opts.until) return;
      let project = projectCache.get(cwd);
      if (project === undefined) { project = projectOf(cwd); projectCache.set(cwd, project); }
      if (projectFilter !== null && project.toLowerCase() !== projectFilter) return;
      const sessionKey = agent + '\0' + session;
      searched.add(sessionKey);
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!matcher.test(text)) return;
      const key = sessionKey + '\0' + timestamp + '\0' + role + '\0' + text;
      if (seen.has(key)) return;
      seen.add(key);
      matched.add(sessionKey);
      found.push({ agent, session, project, cwd, timestamp, instant, role, text });
    };
    for (const file of listJsonl(dir)) reader(file, emit);
  }

  found.sort((a, b) =>
    (b.instant - a.instant) ||
    cmp(a.agent, b.agent) ||
    cmp(a.session, b.session) ||
    cmp(a.timestamp, b.timestamp) ||
    (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) ||
    cmp(a.text, b.text));

  return { found, sessions: matched.size, searched: searched.size };
}

// ------------------------------------------------------------------ output

function plural(n, word, many = word + 's') { return `${n} ${n === 1 ? word : many}`; }

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(USAGE); return 0; }
    const query = opts.words.join(' ');
    if (query.trim() === '') throw new UsageError('a query is needed');
    const matcher = buildMatcher(query);

    const { found, sessions, searched } = search(opts, matcher);
    const shown = found.slice(0, opts.limit);
    const results = shown.map((r) => {
      const hit = matcher.find(r.text);
      let core = r.text, before = false, after = false;
      if (hit !== null) ({ core, before, after } = cut(r.text, hit.index, hit.length, opts.context));
      return { r, core, before, after };
    });

    let out;
    if (opts.json) {
      out = JSON.stringify({
        tool: TOOL,
        version: VERSION,
        query,
        matches: found.length,
        sessions,
        searched,
        results: results.map(({ r, core, before, after }) => ({
          agent: r.agent,
          session: r.session,
          project: r.project,
          cwd: r.cwd,
          timestamp: r.timestamp,
          role: r.role,
          text: (before ? '…' : '') + core + (after ? '…' : ''),
          resume: r.agent === 'claude' ? `claude --resume ${r.session}` : null,
        })),
      }, null, 2) + '\n';
    } else {
      const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
      const lines = [];
      for (const { r, core, before, after } of results) {
        lines.push(`${r.timestamp}  ${r.agent}  ${r.role}  ${r.project === '' ? '-' : r.project}  ${r.session}`);
        const body = color ? matcher.mark(core) : core;
        lines.push(`  ${before ? '…' : ''}${body}${after ? '…' : ''}`);
        if (r.agent === 'claude') lines.push(`  claude --resume ${r.session}`);
        lines.push('');
      }
      let summary = `${plural(found.length, 'match', 'matches')} in ${plural(sessions, 'session')} (${plural(searched, 'session')} searched)`;
      if (shown.length < found.length) summary += `, showing ${shown.length}`;
      lines.push(summary);
      out = lines.join('\n') + '\n';
    }
    process.stdout.write(out);
    return found.length > 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`agent-grep: ${e.message}\nTry: agent-grep --help\n`);
      return 2;
    }
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
