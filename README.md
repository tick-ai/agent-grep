# agent-grep

**agent-grep searches every Claude Code and Codex session on your machine and prints the matches newest first: the date, the project, who said it (you, the agent, or a tool call) and the text around the match.**

```sh
npx github:tick-ai/agent-grep cache bug
```

Real output, from a few small session logs:

```text
2026-11-03T12:00:09.120Z  claude  agent  winproj  c-win-1
  The cache key is built with path.join, so on Wind…
  claude --resume c-win-1

2026-11-03T12:00:00.000Z  claude  you  winproj  c-win-1
  why does the cache bug only show up on windows?
  claude --resume c-win-1

2026-11-02T10:00:03.000Z  codex  tool  shop  cx-9
  shell {"command":["grep","-rn","cache bug","src/"]}

3 matches in 2 sessions (2 sessions searched)
```

The line after each result is the command that reopens that Claude Code session.

## Why

Weeks of work with coding agents sit in local session logs. Finding "what did the agent tell me about the cache bug last Tuesday" means scrolling. agent-grep reads those logs for you: it is meant to be used every day, so it is quick (tens of thousands of messages in a fraction of a second), exact, and puts the newest match at the top.

It reads only local files and sends nothing anywhere: no network, no telemetry. Plain Node 22, built-in modules only, no dependencies, nothing to build.

## Run it

```sh
npx github:tick-ai/agent-grep <query>   # from GitHub, nothing installed
node agent-grep.mjs <query>             # from a clone of this repository
```

agent-grep is not on npm yet: `npx agent-grep` does not work. Use the `github:` form above.

```text
agent-grep <query> [--role you|agent|tool]... [--project <name>] [--since <date>] [--until <date>]
           [--agent claude|codex] [--limit <n>] [--context <n>] [--json]
           [--claude-dir <dir>] [--codex-dir <dir>]
```

Options may be written `--limit 5` or `--limit=5`, and may come before, between or after the query words. `--help` prints the usage and exits 0.

## The query

All the arguments that are not options, joined with single spaces, are the query: `agent-grep cache bug` and `agent-grep "cache bug"` are the same. After `--` every argument is part of the query (`agent-grep -- --json`). An empty query is a usage error.

* **Words** (the default). A message matches when **every** word appears in it as a plain substring: in any case, in any order, not as a whole word, no wildcards (`. * ? [` mean themselves).
* **Regular expression.** A query of the form `/pattern/flags`, with the flags among `d g i m s u v y`, is a JavaScript regular expression: `agent-grep '/error \d+/i'`. The flags `g` and `y` are ignored. A pattern JavaScript rejects is a usage error. A message matches only if the expression finds a non-empty match. (`/usr/bin` is not that form, because `b` and `n` are not flags: it is searched as words.)

A query is matched against the message's text after every run of whitespace in it has been replaced by one space.

## Options

| Option | Meaning |
| --- | --- |
| `--role <role>` | Only messages of this role: `you`, `agent` or `tool`. May be given many times: any of them is allowed. |
| `--agent <agent>` | Only `claude` or `codex` sessions; only that source's folder is read. |
| `--project <name>` | Only sessions whose project equals the name, ignoring case. The project is the last folder name of the session's working folder. |
| `--since <date>` | Only messages from that moment on. |
| `--until <date>` | Only messages up to that moment. |
| `--limit <n>` | Print at most `n` results (a whole number of 1 or more; default 20). The summary still counts every match. |
| `--context <n>` | Characters shown on each side of the match (a whole number of 0 or more; default 80). Counted as Unicode code points. |
| `--json` | Print the JSON form (below) instead of the plain form. |
| `--claude-dir <dir>` | Claude Code folder to read instead of `~/.claude/projects`. |
| `--codex-dir <dir>` | Codex folder to read instead of `~/.codex/sessions`. |
| `--help` | Print the usage on stdout and exit 0. |

A date is `YYYY-MM-DD`, a calendar day in UTC (`--since 2026-10-28` means `2026-10-28T00:00:00.000Z` onward and `--until 2026-10-28` includes the whole day), or a timestamp `YYYY-MM-DDTHH:MM`, `YYYY-MM-DDTHH:MM:SS` or `YYYY-MM-DDTHH:MM:SS.fff` followed by `Z` or an offset like `+01:00`. Both ends are inclusive. Anything else, or a day that does not exist, is a usage error.

A folder that does not exist holds no sessions: that is not an error.

## What it reads

| Source | Files | Messages |
| --- | --- | --- |
| Claude Code | every `*.jsonl` under `~/.claude/projects`, at any depth | what you typed (`you`), the agent's text blocks (`agent`) and its tool calls (`tool`: the tool name, a space, the input as compact JSON). Tool results, meta lines, thinking and every other line are skipped. |
| Codex | every `*.jsonl` under `~/.codex/sessions`, at any depth | your messages (`you`; Codex's own context messages that start with `<` are skipped), the agent's messages (`agent`) and function and custom tool calls (`tool`). Developer messages are skipped. |

Lines that are not JSON, lines of another shape and fields that are missing or of another type are skipped, never an error. Only files whose names end in `.jsonl` are read, as UTF-8; symbolic links are not followed; a file that cannot be read is skipped.

A **session** is one agent and one session id, however many files hold it. A message repeated in another file of the same session (as when a session is resumed into a new file) is one match. The sessions **searched** are the sessions that have at least one message passing the filters, whether or not it matches the query.

## What it prints

Results are **newest first**, by the instant of the timestamp. Ties are broken by agent (`claude` before `codex`), session id, timestamp string, role (`tool`, `agent`, `you`) and text, so the order is the same on every run and every machine.

For each result, the plain form prints:

1. `<timestamp>  <agent>  <role>  <project>  <session id>`: the timestamp as it is in the file, the fields separated by two spaces, the project `-` if there is none.
2. Two spaces and the text: the first match with up to `--context` characters each side, whitespace collapsed, with `…` where the text was cut.
3. For a Claude Code result only: two spaces and `claude --resume <sessionId>`.

then an empty line. The last line is the summary: `<matches> matches in <sessions> sessions (<searched> sessions searched)`, with `, showing <k>` after it when `--limit` printed fewer results than there are matches. With no match only the summary is printed, for example `0 matches in 0 sessions (14 sessions searched)`.

When standard output is a terminal and `NO_COLOR` is not set, the matched words are shown in bold yellow. Piped, the output holds no escape codes.

## JSON

`--json` prints exactly one JSON object on standard output, also when nothing matched:

```json
{
  "tool": "agent-grep",
  "version": "0.1.0",
  "query": "cache bug",
  "matches": 3,
  "sessions": 2,
  "searched": 2,
  "results": [
    {
      "agent": "claude",
      "session": "c-win-1",
      "project": "winproj",
      "cwd": "C:\\Users\\p\\winproj",
      "timestamp": "2026-11-03T12:00:09.120Z",
      "role": "agent",
      "text": "The cache key is built with p…",
      "resume": "claude --resume c-win-1"
    }
  ]
}
```

`matches`, `sessions` and `searched` count everything; `results` holds at most `--limit` results, in the order above. `text` is never marked. `resume` is `null` for a Codex result.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | at least one message matched |
| 1 | nothing matched |
| 2 | usage error: a message on standard error, nothing on standard output |

Nothing is written outside standard output and standard error.

## Test

```sh
node --test
```

## Where it came from

agent-grep was built by agents on TickHub, as TickHub job `38b5b44c-1c8c-4396-b69a-c7b5c236b561`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/38b5b44c-1c8c-4396-b69a-c7b5c236b561. `docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0. Copyright 2026 Parsa Esmaeili. See `LICENSE`.
