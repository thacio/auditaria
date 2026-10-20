# Workflows

Auditaria workflows run JavaScript orchestration scripts that delegate work to
agents, inspect their results, and produce a combined answer. The engine
supports Gemini, Claude Code, Codex, Copilot, and Antigravity, with the provider
differences described below.

For execution details and current limitations, see the
[workflow architecture](workflow-architecture.md).

## When a workflow runs

Workflows require your opt-in. Ask Auditaria to use a workflow in ordinary
language, request a saved workflow by name, or invoke a skill or command that
explicitly uses the workflow tool. Selecting a reasoning effort does not opt you
into Auditaria workflows.

The first dynamic script in a session opens a review dialog, unless YOLO mode
approves it automatically. Review the script and the work its agents will
perform before running it.

Add `+500k` or `+2m` to your message to set an output-token target. New agent
calls stop when reported usage reaches that target. In-flight work can exceed
it, and providers with missing usage cannot be fully accounted for. This is not
a billing cap.

## Manage runs in the CLI

Run `/workflows` to open the interactive manager. It includes saved run records
from earlier sessions in the same project. Use the following controls:

| Control                      | Action                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| Up and Down                  | Select a run, phase, or agent                                |
| Enter or Right               | Open the selection; Enter expands agent details              |
| Left or Escape               | Return to the previous view; close from the run list         |
| `/` in the run list          | Search runs                                                  |
| `f` in the agent list        | Cycle agent status filters                                   |
| `j` and `k` in agent details | Scroll the prompt, result, and recent tool activity          |
| `x`                          | Stop the run, or skip the selected running agent             |
| `r` on a running agent       | Restart that agent                                           |
| `p`                          | Pause a running workflow, or resume a finished or paused run |
| `s`                          | Save the script; Tab changes project or user scope           |

Wide terminals show navigation and details beside each other. Narrow terminals
show one view at a time. The inline chat card prioritizes running agents and
errors and links to the manager.

Text commands remain available:

```text
/workflows list
/workflows status <id>
/workflows open <id>
/workflows stop <id>
/workflows resume <id>
/workflows save <id> [project|user]
```

`open <id>` prints a summary. Use `/workflows` for the interactive detail view.
Saving uses `meta.name` and refuses to overwrite an existing file. To save a
variant, edit the script's `meta.name`, run it, and save the new run.

## Manage runs on the web

Open **Workflows** in the web interface's navigation rail, enter `/workflows` in
chat, or open a workflow card. The panel provides run search and status filters,
phases, agent details, logs, results, and controls for pause, resume, stop,
restart, skip, and save.

Use **Phases**, **Results**, and **Activity** at the top of a run to jump to the
corresponding section. Status badges show phase and agent progress; arrows
expand their details. Run and agent results have **Copy result** buttons. The
panel uses the web interface's theme and adapts to narrow screens.

Agent details refresh while the agent runs and once more when it finishes. The
panel preserves transcript scroll position and pauses replacement while you
select text. Prompts and results come from the stored transcript rather than
just the short preview in the chat card. Very large transcripts are bounded for
display; the original JSONL remains on disk.

When a run finishes, an info message appears and its result is queued for the
main model at the next idle point. Delivery uses the same mechanism with any
orchestrator provider.

## Script API

Start each script with a literal metadata declaration. The body can use
top-level `await` and return a value:

```js
export const meta = {
  name: 'compare-approaches',
  description: 'Compare two approaches and explain the tradeoffs',
  phases: [{ title: 'Compare' }],
};

phase('Compare');
const answers = await parallel([
  () => agent('Describe a simple approach to: ' + args),
  () => agent('Describe an alternative approach to: ' + args),
]);
return answers.filter((answer) => answer !== null);
```

The main operations are `agent`, `parallel`, `pipeline`, `phase`, `log`, and
`workflow`. The `args` and `budget` globals supply inputs and token accounting.
Use the built-in `workflow-authoring` skill for their complete contract.

Keep values crossing host operations JSON-compatible. Pipeline inputs may be
promises; a `null` item or stage result drops that item, while `undefined` can
continue to the next stage. Parallel branches and pipeline items retain their
deterministic result order.

Agent calls share a FIFO concurrency pool, with a maximum of 16 active agents
and a CPU-based lower limit. A run permits at most 1,000 agent calls.
Collections crossing the workflow boundary have a 4,096-item limit, and a script
can contain at most 512 KiB.

Scripts cannot directly import Node modules or access the filesystem.
`Date.now()`, `Math.random()`, and `new Date()` without arguments are disabled
to help replay. The JavaScript VM is an execution compartment, not an OS
security boundary: run reviewed scripts. It does not provide complete memory or
asynchronous CPU containment. Agents still perform I/O through their configured
tools.

## Providers and agent options

The run records its provider at launch. Changing the main chat's provider does
not silently change a running workflow. Auditaria also supports a per-call
`provider` option.

| Provider    | Agent execution                 | Structured result                         |
| ----------- | ------------------------------- | ----------------------------------------- |
| Gemini      | In-process `LocalAgentExecutor` | Per-agent `StructuredOutput` tool         |
| Claude Code | `claude -p`                     | `StructuredOutput` through the MCP bridge |
| Codex       | `codex exec --json`, serialized | Same bridge                               |
| Copilot     | ACP, serialized                 | Same bridge                               |
| Antigravity | Print driver, serialized        | Same bridge                               |

Model aliases such as `haiku`, `sonnet`, and `opus` map to the selected
provider's small, medium, or large model tier. Exact model and reasoning-effort
support depends on the provider.

With `schema`, the agent returns the captured, validated object. A plain text
completion doesn't replace a missing structured result. External agents use
validated JSON text only when the tool bridge is unavailable. The current retry
setting is checked at settlement; it doesn't immediately stop a leaf after its
last permitted invalid submission.

`agentType` selects a registered local agent definition. Gemini preserves its
prompt, model settings, run settings, tools, and MCP servers. External agents
can use its prompt, model, and registered tool selection; definitions with
inline tool objects or dedicated MCP servers require Gemini.

`disallowedTools` removes exact names from the regular Auditaria tool set.
Claude also receives the list for its native tools. Other providers' native
tools aren't uniformly controlled by this list. A custom agent with dedicated
MCP servers cannot combine them with `disallowedTools`; configure exclusions in
its MCP definitions instead. Gemini workflow agents currently use an auto-allow
message bus. Review scripts with those execution permissions in mind; workflow
options aren't a portable permission sandbox.

`isolation: 'worktree'`, `isolation: 'remote'`, and nonempty `bashCommandClamp`
are rejected before launch because the workflow bridge doesn't yet implement
them. Run from a separately prepared checkout when isolation is needed.

The default stall timeout is 180 seconds without progress outside a running tool
call. `stallMs: 0` disables it. A selected-agent restart or detected stall can
start a fresh attempt, up to six attempts total. Terminal provider errors aren't
reported as successful partial answers.

Usage displays distinguish measured, partial, pending, and unavailable values.
Gemini leaf token usage is currently unavailable, and main-chat usage isn't
included in the workflow budget counter.

## Storage and resume

Workflow data lives under the project's temporary storage directory, normally
`~/.auditaria/tmp/<project>/workflows/`. Auditaria's configuration directory
fallback rules can change the prefix.

| Relative path                         | Content                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `runs/<runId>/journal.jsonl`          | Agent starts, successful results, and failures          |
| `runs/<runId>/state.json`             | Recovery snapshot, source, metadata, logs, and progress |
| `runs/<runId>/agents/<agentId>.jsonl` | Agent transcript                                        |
| `runs/<runId>/lease.json`             | Run ownership                                           |
| `scripts/<name>-<runId>.js`           | Persisted script                                        |
| `tasks/<taskId>.output`               | Completion payload for the main model                   |

Snapshots update during execution. A recovered running record becomes paused
when no live owner holds it. Runs owned by another live process aren't adopted
by this session. A delayed heartbeat alone doesn't make a live owner stale.
Lease acquisition, renewal, and release use a short mutex and an ownership
token; an old owner cannot release a replacement owner's lease.

Resume replays the script. Unchanged successful agent calls reuse journaled
results until the first cache miss; subsequent calls execute again. Branches
have deterministic keys, but a miss invalidates later cache lookups across the
run. Interrupted calls execute again. A damaged final journal fragment is
separated from future appends so new results remain readable.

The `aw1` journal key format and project snapshots support local recovery.
Recovery requires the original journal and doesn't adopt a worker running in
another process.

## Saved workflows

Save scripts in the project or user workflow directory, then invoke them with
`workflow({name: '<meta.name>', args})`. Discovery checks the nearest project
directory first, up to the Git root. Outside Git, it checks the current project
directory. At each level, `.auditaria` precedes the `.gemini` fallback.

Precedence is project, user, active extension, then built-in. Extension
workflows live in the extension's `workflows/` directory. All names share one
namespace, and discovery validates the entire script before accepting it.
Scripts can invoke another named workflow with one level of nesting.

The built-in `deep-research` workflow searches from multiple angles, extracts
claims, obtains independent verification votes, and synthesizes a report. Fewer
than two completed votes leave a claim unverified. If synthesis fails, the
result preserves the verified evidence.

## Settings and switches

The **Workflows** settings category contains `enabled`, `sizeGuideline`, and
`skipUsageWarning`.

Environment settings include:

- `AUDITARIA_DISABLE_WORKFLOW=1`: remove the tool.
- `AUDITARIA_WORKFLOW_NAME_ONLY=1`: allow saved workflows only.
- `AUDITARIA_WORKFLOW_SIZE_GUIDELINE`: override the advisory size setting.
- `MAX_STRUCTURED_OUTPUT_RETRIES`: structured-result retry threshold, default 5.
- `AUDITARIA_WORKFLOW_LEASE_STALENESS_MS`: recovery threshold for malformed
  ownership records, default 30,000 milliseconds; it doesn't override a live
  PID.
