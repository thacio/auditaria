# Workflow architecture

Auditaria workflows coordinate agents through JavaScript scripts. The workflow
service owns execution, progress, persistence, and result delivery; the CLI and
web interface share that service. See [Workflows](workflows.md) for commands,
script examples, and configuration.

Workflow execution requires an explicit request. Provider reasoning effort does
not enable workflow orchestration. The shared turn path records optional
output-token targets without adding instructions to the user's message.

## Execution

The parser validates the script's literal metadata and syntax before launch.
Scripts run in a restricted `node:vm` context with hooks for `agent`,
`parallel`, `pipeline`, `phase`, `log`, nested `workflow` calls, and budget
inspection.

The host API assigns deterministic journal keys, limits concurrency through a
cancellation-aware FIFO queue, and checks cancellation before and after granting
a slot. Parallel branches preserve input order. Pipelines resolve promised
inputs, stop processing a branch when it returns `null`, and retain child phase
context. Empty collections finish without launching an agent.

Values crossing the VM boundary use JSON-compatible serialization. Hooks,
promises, and errors exposed to scripts belong to the script realm. Collection
limits also apply to nested values. These restrictions do not make `node:vm` an
OS security boundary or provide comprehensive CPU and memory containment.

## Providers and structured results

Gemini agents use `LocalAgentExecutor`. External providers use their headless
drivers and the Auditaria tool bridge. Codex, Copilot, and Antigravity leaves
are serialized within each Auditaria process to protect shared provider state.

Each custom Gemini agent retains its supported prompt, model, run, and tool
configuration. Model aliases are unique per leaf so concurrent runs cannot
replace each other's settings. Custom MCP configuration requires Gemini.
Antigravity aliases and display names use the provider's cached model catalog; a
cold start refreshes it before selecting a workflow model. Explicit models
listed by Antigravity or Copilot pass through unchanged.

Concurrent bridge requests share one startup operation. The session manager
closes listeners it owns, including a startup that finishes after disposal, and
leaves borrowed listeners with their owner. Claude leaves use unique MCP
configuration files so simultaneous launches keep their schemas separate. Codex
launches pass MCP configuration as process arguments when the executable can run
directly. Its legacy shell fallback still uses the provider's shared
configuration file.

Schema-mode calls register a per-call `StructuredOutput` schema. Gemini returns
the captured validated object. External providers submit through the MCP bridge,
with a JSON-text fallback. A terminal provider error remains a failure even when
the provider emitted partial text.

The stall watchdog measures absent progress outside running tools. Restart and
stall recovery use up to six attempts. The default stall interval is 180
seconds; zero disables it.

## Persistence and recovery

Each project's temporary directory contains workflow scripts, run snapshots,
agent transcripts, journals, ownership leases, and completion payloads.

Snapshots include original source, metadata, progress, and logs. On startup,
validated abandoned running records become paused. A live owner prevents another
process from adopting the run. Lease acquisition and renewal use a short mutex,
atomic replacement, and an owner token. An old owner cannot release a
replacement owner's lease.

Journal keys use the `aw1` format with provider selection and deterministic
branch chains. Resume replays successful calls until the first cache miss.
Interrupted calls execute again. A miss invalidates later lookups across the
run; branches do not resume independently. Incomplete trailing journal records
are separated from future appends.

Recovery requires local snapshots and journals. It does not reconstruct missing
journals from remote storage or transfer live background workers. PID reuse can
conservatively block recovery; process-start identity checks and orphan-process
cleanup remain follow-up work.

## Discovery and authoring

Named workflow discovery checks the nearest project directories up to the Git
root, then user workflows, active extensions, and built-ins. At each project
level, `.auditaria` precedes the `.gemini` fallback. Outside Git, discovery
stays in the target directory.

Discovery validates complete scripts. Extensions share an unqualified namespace.
Scripts retain their local `meta` binding during execution. Saving uses
`meta.name` and refuses to overwrite an existing file.

The built-in research workflow scopes a question, searches for evidence,
extracts claims, verifies them through a vote panel, and synthesizes a report.
At least two completed votes are required. If synthesis fails, verified evidence
is retained.

## Interfaces

The CLI manager provides run, phase, agent, and detail views with search, status
filters, pause/resume, restart/skip, and save controls. Wide terminals show
navigation beside details; narrow terminals show one view at a time. Inline
cards prioritize active agents and errors.

The web panel uses the application's theme, navigation rail, and responsive
layout. Users can expand phase groups and agents, inspect status badges, jump to
results or activity, copy results, and manage runs. Controls use correlated
requests and show server errors. Agent details refresh during execution and once
more on completion.

Refresh preserves nested scroll positions and defers replacement while text is
selected. Copying restores focus inside the modal. Opening the CLI workflow
dialog leaves the native web controls usable; other CLI dialogs retain their
terminal mirror.

Transcripts display bounded prompts, results, and recent tool calls. They do not
render every provider event. Missing token usage is labeled pending,
unavailable, or partial rather than displayed as a measured zero.

## Current limitations

- Antigravity uses MCP configuration and transcript discovery shared within its
  provider home. The in-process queue doesn't isolate separate Auditaria
  instances using that same home.
- Worktree and remote isolation are rejected because provider processes and
  bridged tools do not yet share a per-leaf execution directory.
- Nonempty shell-command clamps are rejected until all native and bridged shell
  paths can enforce them.
- Exact-name exclusions filter regular Auditaria tools. Claude also receives
  native exclusions; other providers' native tools are not uniformly filtered.
  Custom MCP servers cannot be combined with per-call exclusions; use their
  server configuration instead. Gemini leaves use an auto-allow message bus.
- Structured-output retry limits are evaluated when a leaf settles. Missing
  submissions have no dedicated corrective prompt, and exhaustion does not
  immediately stop a running leaf.
- Restart and stall handling do not provide a uniform cross-provider policy for
  rate-limit waits, fallback models, or session recovery.
- Gemini leaf usage is unavailable, and main-chat usage is not connected to the
  workflow counter. In-flight work can exceed the output-token target. It is not
  a billing cap.
- Prompts distinguish script-generated tasks from user approval. Complete
  original-request provenance and automated-trigger classification are not yet
  available for every agent.
- The save dialog has no rename or overwrite flow.
- Research verification candidates are selected in extraction order. Source
  labels normalize hostnames and can lose detail; keep source URLs as evidence
  identifiers. Handling untrusted fetched text and reporting an empty verified
  set can be improved.
- Cloud handoff, remote artifact storage, cross-process worker adoption, and
  exit-time worker transfer are not implemented.

## Validation

Regression tests cover the parser, VM boundary, host API, cancellation, replay,
recovery, leases, discovery, structured results, and research voting. Provider
fakes test orchestration without making paid model requests. Additional
regressions cover bridge startup and disposal races, per-call MCP configuration,
model catalog changes, terminal paste handling, completion delivery, and
subprocess failures after partial output.

| Check                                   | Result                                     |
| --------------------------------------- | ------------------------------------------ |
| Core workflow and provider regressions  | Passed                                     |
| CLI interaction suite                   | 23 tests passed                            |
| Web feature and manager protocol suites | 9 tests passed                             |
| Browser interaction fixtures            | 17 checks passed                           |
| Integrated web app                      | 9 grouped checks passed                    |
| TypeScript                              | `tsc -b packages/core packages/cli` passed |
| Build                                   | Bundle generation and asset copying passed |

Interface checks used isolated project records and transcripts. They verified
desktop and mobile layouts, native clipboard access, full transcript display,
save-collision handling, and coexistence with CLI dialogs.

Live provider checks on October 20, 2026, used separate test projects and
provider profiles:

- Claude Haiku returned two distinct parallel structured results. A cached
  resume verified completion delivery without rerunning the agents.
- Codex GPT-6 Luna completed a two-stage structured pipeline and a fresh
  `StructuredOutput` bridge call. A cached resume verified completion delivery
  without rerunning the agent.
- Antigravity Gemini 3.8 Flash Low read a local proof file and completed a
  separate `StructuredOutput` bridge call. The file read used native tools; the
  structured-result check verified an actual Auditaria MCP invocation.

Final checks used the rebuilt executable and verified automatic completion
summaries, return to idle, live web status transitions, and result details
without browser errors. Completion checks continued beyond the prompt-acceptance
timeout to catch delayed failures. Provider tests don't yet include live Gemini
or Copilot calls. Antigravity's missing usage and partially reported
interrupted-leaf usage remain labeled unavailable or partial.
