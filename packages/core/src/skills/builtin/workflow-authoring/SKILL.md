---
name: workflow-authoring
description: Reference for writing a workflow script for the `workflow` tool (script API and gotchas, resume, quality patterns, worked examples). Load it before authoring a script for a workflow the user already opted into; loading it does not by itself authorize running one.
---

# Workflow authoring reference

A workflow structures work across many sub-agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context cannot hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

When you do call the tool, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work list, then call `workflow` to pipeline over it. You need to know the shape before the *orchestration step*, not before the *task*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (the review-changes example below)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For larger work, run several in sequence and read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

**Ultracode.** When a system-reminder says ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not the constraint. Multi-phase work (understand → design → implement → review) usually means several workflows in sequence, one per phase, so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits. Lean toward orchestrating with workflows and adversarially verifying your findings unless the work is trivial or already verified. Work solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, the tool's standard opt-in rule applies again.

Pass the script inline via `script` — do not write it to a file first. Every invocation persists its script under the project's workflow directory and returns the path in the tool result. To iterate, edit that file with your edit tool and re-invoke `workflow` with `{scriptPath: "<path>"}` instead of resending the script.

## The `meta` header

Every script must begin with `export const meta = {...}`:

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',   // one line, shown in the review dialog
  phases: [                                            // one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
...
```

`meta` must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required: `name`, `description`. Optional: `whenToUse` (shown in workflow listings), `phases`. Use the same phase titles in `meta.phases` as in `phase()` calls — titles are matched exactly; a `phase()` call with no matching entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model.

## Script body hooks

- **`agent(prompt: string, opts?)`** → `Promise<any>` — spawn one sub-agent. `opts`: `{label?, phase?, schema?, model?, effort?, isolation?: 'worktree', agentType?, provider?}`. Without `schema`, it returns the sub-agent's final text as a string. With `schema` (a JSON Schema whose root is `type: 'object'`), the sub-agent must hand back its answer through the StructuredOutput tool and `agent()` returns the validated object — no parsing needed. It resolves `null` if the user skips the agent mid-run or the sub-agent dies on a terminal provider error after retries (filter with `.filter(Boolean)`). `opts.label` overrides the display label. `opts.phase` assigns this call to a progress group explicitly (use it inside `pipeline()`/`parallel()` stages so branches never race on the ambient `phase()` state; the same string means the same group). `opts.model` overrides the model — default to omitting it: the agent inherits the run's provider and model, which is almost always right; set it only when you are confident another tier fits (`haiku`/`sonnet`/`opus`-style names are mapped to the nearest tier when the run's provider is not Claude). `opts.effort` overrides reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`; clamped to what the provider accepts) — use `'low'` for cheap mechanical stages and higher tiers only for the hardest verify/judge stages. `opts.isolation: 'worktree'` runs the agent in a fresh git worktree — EXPENSIVE, use only when agents mutate files in parallel and would otherwise conflict; the worktree is removed if unchanged, and if it cannot be created the agent runs locally with a warning. `opts.agentType` uses a custom agent definition from the project's agent registry (`.auditaria/agents/*.md`) instead of the default workflow sub-agent. `opts.provider` (Auditaria extension: `'gemini' | 'claude' | 'codex' | 'copilot' | 'agy'`) runs one call on a different provider than the run's own; leave it out for scripts meant to run unchanged elsewhere.
- **`pipeline(items, stage1, stage2, ...)`** → `Promise<any[]>` — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work: wall-clock is the slowest single-item chain, not the sum of the slowest stage per item. Every stage callback receives `(prevResult, originalItem, index)` — use `originalItem`/`index` in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to `null` and skips its remaining stages.
- **`parallel(thunks: Array<() => Promise<any>>)`** → `Promise<any[]>` — run tasks concurrently. This is a BARRIER: it awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to `null` in the result array — the call itself never rejects, so `.filter(Boolean)` before using the results. Use it ONLY when you genuinely need all results together.
- **`log(message: string)`** — emit a progress message to the user (a narrator line above the progress tree).
- **`phase(title: string)`** — start a new phase; subsequent `agent()` calls are grouped under this title in the progress display.
- **`args`** — the value passed as the tool's `args` input, verbatim (`undefined` if not provided). Pass arrays/objects as real JSON values in the tool call, NOT as a JSON-encoded string — `args: ["a.ts", "b.ts"]`, not `args: "[\"a.ts\", ...]"` (a stringified list reaches the script as one string, so `args.filter`/`args.map` throw). Use it to parameterize saved workflows — a research question, a target path, a config object.
- **`budget`** — `{total: number|null, spent(): number, remaining(): number}`: the turn's output-token target, set with the tool's `budgetTokens` input or a `+500k`-style directive in the user's message. `budget.total` is `null` if no target was set. `budget.spent()` returns output tokens spent this turn across the main loop and every workflow (one shared pool). `budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no target. The target is a HARD ceiling, not advisory: once `spent()` reaches `total`, further `agent()` calls throw. Use it for dynamic loops: `while (budget.total && budget.remaining() > 50_000) { ... }`, or static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.
- **`workflow(nameOrRef: string | {scriptPath: string}, args?)`** → `Promise<any>` — run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (the same registry as the tool's `name` input), or `{scriptPath}` to run a script file you wrote earlier. The child shares this run's concurrency cap, agent counter, abort signal, journal and token budget; its agents appear under a `▸ name` group in the progress display. The `args` param becomes the child's `args` global. Nesting is one level only: `workflow()` inside a child throws. It throws on an unknown name / unreadable `scriptPath` / child syntax error; catch to handle gracefully.

Sub-agents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output use the `schema` option — validation happens at the tool-call layer so the model retries on a mismatch. Schemas need `{type: 'object', properties: {...}}` at the root and `required ⊆ properties`; unsatisfiable ones throw at `agent()`.

Workflow sub-agents can reach every tool the session has (Auditaria's tools over the bridge plus the provider CLI's own), except the workflow and sub-agent-spawning tools.

Scripts are plain JavaScript, NOT TypeScript — type annotations (`: string[]`), interfaces and generics fail to parse. The body runs in an async context — use `await` directly. Standard JS built-ins (JSON, Math, Array, …) are available — EXCEPT `Date.now()`, `Math.random()` and argless `new Date()`, which throw (they would break resume); pass timestamps in via `args`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. There is no filesystem or Node.js API access from the script itself — sub-agents do the I/O.

DEFAULT TO `pipeline()`. Reach for a barrier (`parallel` between stages) only when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: `pipeline(items, stageA, r => transform([r]).flat(), stageB)`
- "The stages are conceptually separate" — that is what `pipeline()` models; separate stages ≠ synchronized stages
- "It's cleaner code" — barrier latency is real: if 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time

Smell test: if you wrote
```js
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter — no cross-item dependency
const c = await parallel(b.map(...))
```
that middle transform does not need the barrier. Rewrite it as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent `agent()` calls are capped at min(16, available CPUs − 2) per run — excess calls queue and run as slots free up. You can still pass 100 items to `parallel()`/`pipeline()` and they all complete; only ~10 run at any moment. The total number of `agent()` calls across a run's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow. A single `parallel()`/`pipeline()` call accepts at most 4096 items; more is an explicit error, not a silent truncation.

When a barrier IS correct — dedup across all findings before expensive verification:
```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))
```

Loop-until-count pattern — accumulate to a target:
```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Loop-until-budget pattern — scale depth to the token target. Guard on `budget.total`: with no target set, `remaining()` is `Infinity` and the loop would run straight to the 1000-agent cap.
```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
```

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {                                              // loop-until-dry
  const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
    agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
    parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
// dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.
```

Quality patterns — common shapes; pick by task and compose freely:
- **Adversarial verify**: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if a majority refutes. Prevents plausible-but-wrong findings from surviving.
  ```js
  const votes = await parallel(Array.from({length: 3}, () => () =>
    agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {schema: VERDICT})))
  const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
  ```
- **Perspective-diverse verify**: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy cannot.
- **Judge panel**: generate N independent attempts from different angles (MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry**: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (`while count < N`) miss the tail.
- **Multi-modal sweep**: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle will not find everything.
- **Completeness critic**: a final agent that asks "what is missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- **No silent caps**: if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped — silent truncation reads as "covered everything" when it did not.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → a larger finder pool, a 3–5 vote adversarial pass, a synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns are not exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use the tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

The tool result includes a run ID. To resume after a stop, a crash, or a script edit, relaunch with `workflow({scriptPath, resumeFromRunId})` — the longest unchanged prefix of `agent()` calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Before diagnosing why a completed workflow returned an empty or unexpected result, read `<transcript dir>/journal.jsonl` — it records each agent's actual return value; do not assume cached results are non-empty. `Date.now()`/`Math.random()`/`new Date()` are unavailable in scripts because they would break this replay — stamp results after the workflow returns, or pass timestamps via `args`. Fallback when no journal is available: read the `agents/<id>.jsonl` transcripts in the transcript directory and hand-author a continuation script.

## Managing runs

`workflow({action: 'status', taskId})` returns the live progress of a run, or its completion block once finished. `workflow({action: 'stop', taskId})` stops a running workflow (its in-flight agents are aborted; the run stays resumable). `workflow({action: 'list'})` lists this session's runs and the saved workflows available by name. The human can watch every run with `/workflows`.
