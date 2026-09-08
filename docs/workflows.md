# Workflows — multi-agent orchestration scripts

Auditaria's `workflow` tool is a clone of Claude Code's Workflow tool: the model
writes a small JavaScript script that fans work out to sub-agents, verifies
results, and synthesizes an answer; Auditaria runs it in the background and
tells the model when it is done. A script written for Claude Code runs here
unchanged, and it runs on **every** provider Auditaria supports — Gemini, Claude
Code, OpenAI Codex, GitHub Copilot and Google Antigravity — with the sub-agents
spawned through each provider's own promptless CLI form.

## When a workflow runs

The tool is opt-in. The model calls it only when you:

- type the word **`ultracode`** in a message (that turn only),
- turn the standing mode on with **`/workflows ultracode on`** (or the
  `workflows.ultracode` setting, or a Claude reasoning effort of `ultra`),
- ask for one in your own words ("use a workflow", "fan out agents", "run a
  workflow"), or
- ask for a saved workflow by name (built-in: `deep-research`).

A review dialog shows the script before the first run of a session
(auto-approved in YOLO mode). Add `+500k` or `+2m` to a message to give the run
an output-token ceiling (`budget.total` in the script).

## What you see

- The tool result is a live card: phases, one row per agent (label, model,
  tokens, last tool), narrator lines from `log()`, and the final status.
- `/workflows` lists this session's runs; `/workflows open <id>` shows a run in
  detail; `stop`, `status`, `resume`, `save <id> [project|user]` and
  `ultracode on|off|auto` are the subcommands. The web interface shows the same
  card and updates it live.
- When a run finishes, an info line appears immediately and the model receives a
  `<task-notification>` block at its next idle moment (on any provider), so it
  continues with the result without you typing anything.

## Where things live

Per project, under `~/.auditaria/tmp/<project>/workflows/`:

| Path                                  | Content                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `runs/<runId>/journal.jsonl`          | one line per agent call: `started`, then `result` or `failed`     |
| `runs/<runId>/state.json`             | the run record (status, result, logs, per-agent progress, tokens) |
| `runs/<runId>/agents/<agentId>.jsonl` | each sub-agent's transcript (`.meta.json` beside it)              |
| `runs/<runId>/lease.json`             | liveness lease while a run is active (guards double resumes)      |
| `scripts/<name>-<runId>.js`           | the script text the run executed                                  |
| `tasks/<taskId>.output`               | the completion payload the model was pointed at                   |

The directory is project-scoped, not session-scoped: a run started in one CLI
session can be resumed from another.

## Resume

Every run has a run id. `workflow({scriptPath, resumeFromRunId})` re-executes
the script; agent calls whose prompt and options are unchanged return their
cached results instantly, and only the first edited call and everything after it
run again. Keys are hash-chained (Claude Code's recipe), and every `parallel()`
/ `pipeline()` branch has its own deterministic sub-chain, so completion order
never affects the cache. A killed run leaves an unfinished `started` line and
resumes cleanly. Because of this replay, `Date.now()`, `Math.random()` and
argless `new Date()` are unavailable inside scripts.

## Sub-agents per provider

| Provider    | Leaf                                                               | Structured output (`schema`)                                   |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Gemini      | in-process agent executor (auto-approved tools)                    | `StructuredOutput` tool registered per leaf                    |
| Claude Code | `claude -p` (headless; Claude's own Workflow/Agent tools disabled) | `StructuredOutput` over the MCP bridge with that call's schema |
| Codex       | `codex exec --json` (one at a time)                                | same                                                           |
| Copilot     | `copilot --acp`                                                    | same                                                           |
| Antigravity | `agy --print` (one at a time)                                      | same                                                           |

`model: 'haiku' | 'sonnet' | 'opus'` in a Claude-authored script maps to the
nearest small / medium / large tier of the run's provider, so scripts stay
portable. Sub-agents reach Auditaria's tools through the bridge (minus
`workflow` and `external_agent_session`) plus the provider CLI's own tools.

## Saved workflows

`/workflows save <id>` stores a run's script under `.auditaria/workflows/`
(project) or `~/.auditaria/workflows/` (user); the model then runs it with
`workflow({name: '<meta.name>', args})`. Precedence: project > user > built-in.
Scripts can call `workflow('<name>')` inline (one nesting level).

## Settings and switches

Settings (`/settings`, category Workflows): `workflows.enabled`,
`workflows.sizeGuideline` (`small` / `medium` / `large` / `unrestricted`; the
advisory agent count in the tool description),
`workflows.keywordTriggerEnabled`, `workflows.ultracode`,
`workflows.skipUsageWarning`.

Environment: `AUDITARIA_DISABLE_WORKFLOW=1` removes the tool;
`AUDITARIA_WORKFLOW_NAME_ONLY=1` restricts it to saved workflows;
`MAX_STRUCTURED_OUTPUT_RETRIES` (default 5);
`AUDITARIA_WORKFLOW_LEASE_STALENESS_MS` (default 30000);
`AUDITARIA_WORKFLOW_SIZE_GUIDELINE` overrides the setting.

## Writing scripts

The model loads the built-in `workflow-authoring` skill before writing a script;
it documents `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`,
`workflow()`, `args`, `budget`, the caps (16 concurrent agents, 1000 per run,
4096 items per call, 512 KiB scripts) and the quality patterns (adversarial
verify, judge panel, loop-until-dry, multi-modal sweep).
