# agent-grep: search everything you ever asked your AI agents

This is the TickHub job this tool is built to, by agents on TickHub.

Weeks of work with coding agents sit in local session logs, and finding "what did the agent tell
me about the cache bug last Tuesday" means scrolling. **agent-grep** searches every Claude Code and
Codex session on the machine and prints the matches, newest first, with the date, the project, who
said it (you, the agent, or a tool call) and the text around the match. It reads only local files
and sends nothing anywhere: no network, no telemetry.

It is used every day, so it must be instant, exact, and put the line you were looking for at the
top.

## Files and territory

Create or change exactly these files, and nothing else:

* `agent-grep.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`.
* `README.md`: replaces this repository's stub. Written for developers: what agent-grep does and
  why, how to run it, every option, what the output looks like, the exit codes, the JSON format,
  and two closing sections, "Where it came from" and "Licence" (below).
* `package.json`: name `agent-grep`, version `0.1.0`, a one-line `description`, `"type": "module"`,
  `"bin": {"agent-grep": "agent-grep.mjs"}`, `"files": ["agent-grep.mjs", "README.md", "LICENSE"]`,
  `"engines": {"node": ">=22"}`, `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`,
  `"repository"` pointing at `git+https://github.com/tick-ai/agent-grep.git`, a few `keywords`, and
  no dependencies of any kind.
* `test/agent-grep.test.mjs`: your own tests, with `node:test`, run by `node --test`. They build
  their own session logs in code under the operating system's temporary folder.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## The two sources

The tool reads two kinds of files. Their shapes below were measured from real files on a
developer's machine; read only the fields named, and skip every other line, every line that is not
JSON (or is JSON but not an object), and every field that is missing or of another type. A skipped
line is never an error. Files are read as UTF-8; lines end at `\n`. Only files whose names end in
`.jsonl` are read. Symbolic links are not followed. A file that cannot be read is skipped.

### Claude Code

Every `*.jsonl` file under the Claude folder (default `~/.claude/projects`) at any depth. One JSON
object per line.

* A line with `"type": "user"` whose `message.content` is a **string**, and whose `isMeta` is not
  `true`, is a prompt the person typed: role `you`, the text is `message.content`. A `user` line
  whose `message.content` is an array holds tool results and is skipped.
* A line with `"type": "assistant"` whose `message.content` is an **array** gives one message per
  block: `{"type": "text", "text": ...}` is role `agent` (the text is `text`);
  `{"type": "tool_use", "name": ..., "input": ...}` is role `tool`, its text the `name`, one space,
  and the `input` written as compact JSON (what `JSON.stringify` prints), or just the `name` when
  there is no `input`; a `thinking` block, and any other block, is skipped. All the messages of one
  line have that line's timestamp.
* A `user` or `assistant` line is used only if its `timestamp` (a string that JavaScript's
  `Date.parse` reads, for example `2026-11-04T21:38:11.497Z`), its `sessionId` and its `cwd` are
  all non-empty strings. Every other `type` of line is skipped.
* The session is `sessionId`; the project is taken from `cwd` (see Project, below).

### Codex

Every `*.jsonl` file under the Codex folder (default `~/.codex/sessions`) at any depth. One JSON
object per line: `{"timestamp", "type", "payload"}`.

* `"type": "session_meta"` with a non-empty string `payload.id` (the session id) and
  `payload.cwd` sets the session and the cwd for the lines that follow it in the same file (a later
  `session_meta` replaces them). A `response_item` line before any such `session_meta` in its file
  is skipped.
* `"type": "response_item"` with `payload.type` `"message"` and `payload.role` `"user"` or
  `"assistant"`: the text is the concatenation, with nothing between, of the `text` of every
  `payload.content[]` block whose `type` is `input_text`, `output_text` or `text`. Role `user` is
  `you`, unless the text starts with `<` (Codex writes its own context into such messages): then it
  is skipped. Role `assistant` is `agent`. Any other role (`developer`, for one) is skipped.
* `"type": "response_item"` with `payload.type` `"function_call"` or `"custom_tool_call"` and a
  string `payload.name` is role `tool`: its text is the `name`, one space, and the `payload.arguments`
  (for a `function_call`) or `payload.input` (for a `custom_tool_call`) as it is when it is a
  string, as compact JSON when it is any other value, or just the `name` when it is missing or
  `null`.
* Every other `type` and `payload.type` is skipped. A `response_item` line is used only if its
  `timestamp` is a string that `Date.parse` reads.

A **message** is one of the pieces above with a text that is not empty. Its agent is `claude` or
`codex`.

### Project

The project is the last folder name of the session's `cwd`: split `cwd` at every `/` and `\`, drop
empty parts, take the last one (`/home/p/shop/` and `C:\Users\p\shop` both give `shop`); `""` if
there is none.

## How it is run

    agent-grep <query> [--role you|agent|tool]... [--project <name>] [--since <date>] [--until <date>]
               [--agent claude|codex] [--limit <n>] [--context <n>] [--json]
               [--claude-dir <dir>] [--codex-dir <dir>]

* **Query.** All the arguments that are not options, joined with single spaces, are the query:
  `agent-grep cache bug` and `agent-grep "cache bug"` are the same. After `--` every argument is
  part of the query. A query that is empty or only whitespace is a usage error.
  * If the query is `/pattern/flags`, that is, it starts with `/`, ends with `/` followed by zero or
    more of the letters `d g i m s u v y`, and holds at least one character between, it is a
    JavaScript regular expression (`new RegExp(pattern, flags)`; the flags `g` and `y` are ignored).
    A pattern that JavaScript rejects is a usage error. A message matches only if the expression
    finds a non-empty match in its text: an expression that can match only the empty string never
    matches. (`/usr/bin` is not that form, because `b`
    and `n` are not flags: it is words.)
  * Otherwise the query is words: the pieces of it between whitespace. A message matches when
    **every** word appears in it as a plain substring (not as a whole word, no wildcards: the
    characters `. * ? [` and so on mean themselves), in any case (as a JavaScript regular
    expression with the `i` and `u` flags matches) and in any order.
  * A query is matched against the message's text after every run of whitespace in it has been
    replaced by one space and the ends have been trimmed (this is "the text" from here on).
* `--role`: only messages of this role; may be given many times, and then any of them is allowed.
  Not one of `you`, `agent`, `tool` is a usage error.
* `--agent`: only `claude` or `codex` sessions, and only that source's folder is read. Anything else
  is a usage error.
* `--project <name>`: only sessions whose project equals the name, ignoring case.
* `--since <date>` and `--until <date>`: only messages from that moment on, and up to that moment.
  A date is `YYYY-MM-DD`, which is a calendar day in UTC (`--since 2026-10-28` is
  `2026-10-28T00:00:00.000Z` onward and `--until 2026-10-28` includes that whole day, up to
  `2026-10-28T23:59:59.999Z`), or a timestamp `YYYY-MM-DDTHH:MM`, `...:SS` or `...:SS.fff` followed by `Z` or an
  offset like `+01:00` (both ends are inclusive). Anything else, or a day that does not exist, is a
  usage error.
* `--limit <n>`: print at most `n` results (a whole number of 1 or more; default 20). It does not
  change the counts in the summary.
* `--context <n>`: the number of characters shown on each side of the match (a whole number of 0 or
  more; default 80). Characters are Unicode code points: a surrogate pair is one.
* `--json`: print the JSON form (below) instead of the plain form.
* `--claude-dir <dir>` and `--codex-dir <dir>`: the folders to read instead of
  `~/.claude/projects` and `~/.codex/sessions`, where `~` is the user's home folder
  (`os.homedir()`). A folder that does not exist (or is not a folder) holds no sessions: that is
  not an error.
* Options may be written `--limit 5` or `--limit=5`, and may come before, between or after the
  query words. `--help` prints the usage on stdout and exits 0.
* A usage error (an unknown option, an option whose value is missing or not allowed, a missing or
  invalid query, a bad date, a bad regular expression) prints a message on stderr, prints nothing
  on stdout, and exits with status 2.

## What is a match, and in what order

* Every message (above) that passes the filters (`--agent`, `--role`, `--project`, `--since`,
  `--until`) and whose text matches the query is a match.
* A **session** is one agent and one session id, however many files hold it. The sessions
  **searched** are the sessions that have at least one message passing the filters (whether or not
  it matches the query). So `--role tool` searches only the sessions that have a tool call.
* The same message repeated (same agent, session id, timestamp string, role and text) in one file
  or in several, as when a session is resumed into a new file, is one match.
* Results are **newest first**: sorted by the instant of the timestamp, latest first. Ties are
  broken by agent (`claude` before `codex`), then session id, then the timestamp string, all
  ascending comparing code unit by code unit; then by role in the order `tool`, `agent`, `you`
  (the latest in a conversation first); then by text, ascending. So the order is the same on every
  run and on every machine.
* The first `--limit` results are printed. The counts below always count all matches.

## What it prints

### The text of a result

The text is cut from the text of the message: the **first match** is the leftmost non-empty match
(for words, the leftmost occurrence of any of the words, the longest if two start at the same
place; for a regular expression, its first non-empty match). The result's text is the match with up
to `--context` characters before it and up to `--context` characters after it, as they are in the
text. A `…` (U+2026) is put at the start when characters before the cut were left out and at the end
when characters after were left out. Nothing is trimmed after the cut.

### Plain form (the default)

For each result, in order, these lines and then an empty line:

1. `<timestamp>  <agent>  <role>  <project>  <session id>`: the timestamp exactly as it is in the
   file, the fields separated by two spaces, the project `-` if it is empty.
2. Two spaces and the result's text.
3. For a Claude Code result only: two spaces and `claude --resume <sessionId>`.

Then the summary line, last: `<matches> matches in <sessions> sessions (<searched> sessions
searched)`, where `<matches>` is the number of all matches, `<sessions>` the number of sessions
that have a match, and `<searched>` the number of sessions searched; `match` and `session` are
singular for 1. When fewer results are printed than there are matches, `, showing <k>` follows the
closing bracket. Example: `12 matches in 6 sessions (8 sessions searched), showing 3`. With
no match, only the summary line is printed (`0 matches in 0 sessions (14 sessions searched)`).

The matched words (every non-overlapping occurrence of a word, or of the regular expression, in the
printed text) are marked by `ESC[1;33m` before and `ESC[0m` after, only in this form, only when
standard output is a terminal, and never when the environment variable `NO_COLOR` is set. Otherwise
the output holds no escape codes.

### `--json`

Exactly one JSON object on stdout (also when nothing matched):

```json
{
  "tool": "agent-grep",
  "version": "0.1.0",
  "query": "cache bug",
  "matches": 12,
  "sessions": 6,
  "searched": 8,
  "results": [
    {
      "agent": "claude",
      "session": "c-win-1",
      "project": "winproj",
      "cwd": "C:\\Users\\p\\winproj",
      "timestamp": "2026-11-03T12:00:00.000Z",
      "role": "you",
      "text": "cache BUG on windows",
      "resume": "claude --resume c-win-1"
    }
  ]
}
```

* `query` is the query as joined above. `matches`, `sessions` and `searched` are whole numbers, as
  in the summary line. `results` holds at most `--limit` results in the order above.
* `agent` is `claude` or `codex`; `role` is `you`, `agent` or `tool`; `timestamp` is as in the file;
  `text` is the result's text, never marked; `resume` is `claude --resume <sessionId>` for a Claude
  Code result and `null` for a Codex result. More fields may be added, none of these may be left
  out.

### Exit codes

0 when at least one message matched, 1 when none did, 2 for a usage error. Nothing is written
outside standard output and standard error, and nothing is sent anywhere.

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/agent-grep` (and `node agent-grep.mjs`
from a clone). It is not on npm yet, so the README must not say `npx agent-grep` works. The README
must not claim more than the tool does.
