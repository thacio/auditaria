/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The script-facing hooks — agent / parallel / pipeline /
// phase / log / workflow / budget — with Claude Code's exact semantics
// (research 02 §1, §4-§8; 10 §4-§6):
//   - agent() computes its journal key synchronously at the call site, serves
//     cache hits on resume, journals started/result/failed, resolves null on
//     a terminal provider error or user skip, throws on schema failures;
//   - parallel() maps every rejection to null (logged), keeps input order;
//   - pipeline() runs each item through all stages with no barrier;
//   - one level of workflow() nesting shares journal, counters and budget;
//   - caps: 1000 agent() calls per run, 4096 items per call, a FIFO slot pool.
// Each parallel()/pipeline() branch carries its own forked hash chain through
// AsyncLocalStorage so keys never depend on completion order.

import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';
import type {
  AgentOpts,
  SubagentOutcome,
  WorkflowMeta,
  WorkflowProgressEvent,
} from './types.js';
import {
  chainKey,
  forkChain,
  joinChain,
  newAgentId,
  type WorkflowJournal,
} from './journal.js';
import {
  isFunction,
  isRecord,
  stringField,
  stringArrayField,
} from './guards.js';
import {
  assertBoundaryArray,
  createWorkflowSandbox,
  type SandboxErrorCtor,
  type WorkflowSandbox,
  type WorkflowSandboxHooks,
} from './sandbox.js';

export const AGENT_CALL_CAP = 1000;

export const AGENT_CAP_ERROR =
  'Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.';
export const PARALLEL_NOT_FUNCTIONS_ERROR =
  'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)';
export const PARALLEL_NOT_ARRAY_ERROR =
  'parallel() expects an array of functions';
export const PIPELINE_NOT_ARRAY_ERROR =
  'pipeline() expects an array as the first argument';
export const PIPELINE_STAGES_ERROR =
  'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)';
export const NESTING_ERROR =
  'workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.';

export function budgetExceededMessage(spent: number, total: number): string {
  return `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`;
}

/** Concurrency for local sub-agents: min(16, max(2, cpus - 2)) — Claude's formula. */
export function defaultConcurrency(): number {
  return Math.min(16, Math.max(2, availableParallelism() - 2));
}

/** One agent() call as handed to the sub-agent runner. */
export interface AgentCall {
  index: number;
  key: string;
  agentId: string;
  prompt: string;
  label: string;
  opts: AgentOpts;
  phaseIndex: number;
  phaseTitle: string;
  signal: AbortSignal;
  /** Update the live progress row (model, lastTool, tokens, ...). */
  progress: (patch: Partial<WorkflowAgentPatch>) => void;
}

export type WorkflowAgentPatch = Pick<
  Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>,
  | 'model'
  | 'agentType'
  | 'lastToolName'
  | 'lastToolSummary'
  | 'tokens'
  | 'toolCalls'
  | 'attempt'
  | 'usageUnavailable'
>;

/** What the runner resolves with for one call. */
export type SubagentResult =
  | { kind: 'ok'; outcome: SubagentOutcome }
  /** Terminal provider error after retries → agent() resolves null. */
  | { kind: 'failed'; error: string; outcome?: Partial<SubagentOutcome> }
  /** User skipped the agent mid-run → agent() resolves null. */
  | { kind: 'skipped'; outcome?: Partial<SubagentOutcome> };

export interface ResolvedChildWorkflow {
  meta: WorkflowMeta;
  wrapped: string;
}

export interface BudgetSource {
  total: number | null;
  spent: () => number;
}

export interface HostApiDeps {
  meta: WorkflowMeta;
  args: unknown;
  journal: WorkflowJournal;
  budget: BudgetSource;
  signal: AbortSignal;
  /** Runs one sub-agent turn. Throws only for pre-spawn / schema failures. */
  runAgent: (call: AgentCall) => Promise<SubagentResult>;
  /** Validates opts before anything is journaled; throw to reject the call. */
  validateCall?: (prompt: string, opts: AgentOpts) => void;
  resolveChildWorkflow: (nameOrRef: unknown) => Promise<ResolvedChildWorkflow>;
  onProgress: (event: WorkflowProgressEvent) => void;
  onLog: (message: string) => void;
  onFailure: (message: string) => void;
  concurrency?: number;
  /** Test hook: create the sandbox for a child workflow. */
  createSandbox?: (
    hooks: WorkflowSandboxHooks,
    signal: AbortSignal,
  ) => WorkflowSandbox;
}

interface ChainState {
  prev: string;
}

interface PhaseRecord {
  index: number;
  title: string;
}

/** Creates the hooks for a run plus the child-runner used by workflow(). */
export class WorkflowHostApi {
  readonly hooks: WorkflowSandboxHooks;
  private sandbox: WorkflowSandbox | undefined;
  private readonly branch = new AsyncLocalStorage<ChainState>();
  private readonly rootChain: ChainState = { prev: '' };
  private agentCount = 0;
  private readonly phases: PhaseRecord[] = [];
  private currentPhase: PhaseRecord | undefined;
  private inflight = 0;
  private readonly slotQueue: Array<() => void> = [];
  private readonly concurrency: number;
  private budgetTripped = false;
  private capTripped = false;

  constructor(private readonly deps: HostApiDeps) {
    this.concurrency = deps.concurrency ?? defaultConcurrency();
    for (const phase of deps.meta.phases ?? []) this.registerPhase(phase.title);
    this.hooks = this.buildHooks({
      args: cloneJson(deps.args),
      depth: 0,
      logPrefix: '',
      phaseLocked: false,
    });
  }

  /** The sandbox must be attached before the script runs (errors are realm-built). */
  attachSandbox(sandbox: WorkflowSandbox): void {
    this.sandbox = sandbox;
  }

  get agentCallCount(): number {
    return this.agentCount;
  }

  // ---------------------------------------------------------------------
  // Error helpers
  // ---------------------------------------------------------------------

  private err(ctor: SandboxErrorCtor, message: string, name?: string): Error {
    const e = this.sandbox
      ? this.sandbox.makeError(ctor, message)
      : new Error(message);
    if (name) e.name = name;
    return e;
  }

  private checkCaps(): void {
    if (this.agentCount >= AGENT_CALL_CAP) {
      this.capTripped = true;
      throw this.err('Error', AGENT_CAP_ERROR, 'WorkflowAgentCapError');
    }
    const total = this.deps.budget.total;
    if (total != null && total > 0) {
      const spent = this.deps.budget.spent();
      if (spent >= total) {
        this.budgetTripped = true;
        throw this.err(
          'Error',
          budgetExceededMessage(spent, total),
          'WorkflowBudgetExceededError',
        );
      }
    }
  }

  get tripped(): { budget: boolean; cap: boolean } {
    return { budget: this.budgetTripped, cap: this.capTripped };
  }

  // ---------------------------------------------------------------------
  // Slots
  // ---------------------------------------------------------------------

  private acquireSlot(): Promise<void> {
    if (this.inflight < this.concurrency) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.slotQueue.push(() => {
        this.inflight++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inflight--;
    const next = this.slotQueue.shift();
    if (next) next();
  }

  // ---------------------------------------------------------------------
  // Phases / logs
  // ---------------------------------------------------------------------

  private registerPhase(title: string, kind?: 'child'): PhaseRecord {
    const existing = this.phases.find((p) => p.title === title);
    if (existing && !kind) return existing;
    const record: PhaseRecord = { index: this.phases.length + 1, title };
    this.phases.push(record);
    this.deps.onProgress(
      kind
        ? { type: 'workflow_phase', index: record.index, title, kind }
        : { type: 'workflow_phase', index: record.index, title },
    );
    return record;
  }

  private phaseFor(
    opts: AgentOpts,
    ctxPhase: PhaseRecord | undefined,
  ): PhaseRecord {
    if (opts.phase !== undefined) return this.registerPhase(String(opts.phase));
    return ctxPhase ?? this.currentPhase ?? { index: 0, title: '' };
  }

  private log(message: string): void {
    this.deps.onLog(message);
    this.deps.onProgress({ type: 'workflow_log', message, at: Date.now() });
  }

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------

  private buildHooks(scope: {
    args: unknown;
    depth: number;
    logPrefix: string;
    phaseLocked: boolean;
    childPhase?: PhaseRecord;
  }): WorkflowSandboxHooks {
    const budget = Object.freeze({
      total: this.deps.budget.total,
      spent: () => this.deps.budget.spent(),
      remaining: () =>
        this.deps.budget.total == null
          ? Infinity
          : Math.max(0, this.deps.budget.total - this.deps.budget.spent()),
    });

    return {
      agent: (prompt, opts) => this.agent(prompt, opts, scope.childPhase),
      parallel: (thunks) => this.parallel(thunks),
      pipeline: (items, ...stages) => this.pipeline(items, stages),
      phase: (title) => {
        if (scope.phaseLocked) return; // a child's agents live under its own group
        this.currentPhase = this.registerPhase(String(title));
      },
      log: (message) => {
        this.log(scope.logPrefix + coerceLogMessage(message));
      },
      workflow: (nameOrRef, args) => this.child(nameOrRef, args, scope.depth),
      args: scope.args,
      budget,
    };
  }

  private async agent(
    rawPrompt: unknown,
    rawOpts: unknown,
    ctxPhase: PhaseRecord | undefined,
  ): Promise<unknown> {
    this.checkCaps();
    const prompt = coercePrompt(rawPrompt);
    const opts = normalizeOpts(rawOpts);
    const index = ++this.agentCount;
    const label = opts.label ? opts.label : previewOf(prompt, 60);
    const phase = this.phaseFor(opts, ctxPhase);

    // Chain key: synchronous, in call order, on this branch's chain.
    const chain = this.branch.getStore() ?? this.rootChain;
    const key = chainKey(chain.prev, prompt, opts);
    chain.prev = key;

    const queuedAt = Date.now();
    const base = {
      type: 'workflow_agent' as const,
      index,
      label,
      phaseIndex: phase.index,
      phaseTitle: phase.title,
      promptPreview: previewOf(prompt, 80),
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    };

    // Resume: serve a cached result instantly.
    const lookup = this.deps.journal.lookup(key);
    if (lookup.kind === 'hit') {
      this.deps.onProgress({
        ...base,
        agentId: lookup.agentId,
        state: 'done',
        startedAt: queuedAt,
        lastProgressAt: queuedAt,
        cached: true,
        resultPreview: previewOf(stringifyPreview(lookup.result), 120),
      });
      return lookup.result;
    }

    // Pre-spawn validation (schema lint, agentType, isolation:'remote' ...).
    try {
      this.deps.validateCall?.(prompt, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.deps.journal.appendFailed(key);
      this.deps.onProgress({
        ...base,
        state: 'error',
        queuedAt,
        lastProgressAt: Date.now(),
        error: message,
      });
      throw this.err('Error', message);
    }

    const agentId = newAgentId();
    let progressRow: Extract<
      WorkflowProgressEvent,
      { type: 'workflow_agent' }
    > = {
      ...base,
      agentId,
      state: 'start',
      queuedAt,
      lastProgressAt: queuedAt,
    };
    this.deps.onProgress(progressRow);
    await this.deps.journal.appendStarted(key, agentId);

    await this.acquireSlot();
    const startedAt = Date.now();
    const patchProgress = (patch: Partial<WorkflowAgentPatch>) => {
      progressRow = {
        ...progressRow,
        ...patch,
        state: 'progress',
        startedAt,
        lastProgressAt: Date.now(),
      };
      this.deps.onProgress(progressRow);
    };
    try {
      const result = await this.deps.runAgent({
        index,
        key,
        agentId,
        prompt,
        label,
        opts,
        phaseIndex: phase.index,
        phaseTitle: phase.title,
        signal: this.deps.signal,
        progress: patchProgress,
      });
      const durationMs = Date.now() - startedAt;
      if (result.kind === 'ok') {
        await this.deps.journal.appendResult(
          key,
          agentId,
          result.outcome.value,
        );
        this.deps.onProgress({
          ...progressRow,
          state: 'done',
          startedAt,
          lastProgressAt: Date.now(),
          durationMs,
          tokens: result.outcome.tokens,
          toolCalls: result.outcome.toolCalls,
          ...(result.outcome.model ? { model: result.outcome.model } : {}),
          ...(result.outcome.usageUnavailable
            ? { usageUnavailable: true }
            : {}),
          resultPreview: previewOf(stringifyPreview(result.outcome.value), 120),
        });
        return result.outcome.value;
      }
      if (result.kind === 'skipped') {
        this.deps.onProgress({
          ...progressRow,
          state: 'error',
          startedAt,
          lastProgressAt: Date.now(),
          durationMs,
          skipped: true,
          error: 'skipped by user',
        });
        return null;
      }
      // Terminal provider error → null (journaled as failed unless the run was aborted).
      if (!this.deps.signal.aborted)
        await this.deps.journal.appendFailed(key, agentId);
      const message = `[${label}] failed: ${result.error}`;
      this.deps.onFailure(message);
      this.log(message);
      this.deps.onProgress({
        ...progressRow,
        state: 'error',
        startedAt,
        lastProgressAt: Date.now(),
        durationMs,
        error: result.error,
        ...(result.outcome?.tokens !== undefined
          ? { tokens: result.outcome.tokens }
          : {}),
      });
      return null;
    } catch (e) {
      // Schema failures and internal errors propagate into the script.
      const message = e instanceof Error ? e.message : String(e);
      if (!this.deps.signal.aborted)
        await this.deps.journal.appendFailed(key, agentId);
      this.deps.onProgress({
        ...progressRow,
        state: 'error',
        startedAt,
        lastProgressAt: Date.now(),
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw this.err('Error', message);
    } finally {
      this.releaseSlot();
    }
  }

  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    this.checkCaps();
    if (!Array.isArray(rawThunks))
      throw this.err('TypeError', PARALLEL_NOT_ARRAY_ERROR);
    assertBoundaryArray(rawThunks, (c, m) => this.err(c, m));
    if (rawThunks.length === 0) return [];
    if (!rawThunks.every(isFunction)) {
      throw this.err('TypeError', PARALLEL_NOT_FUNCTIONS_ERROR);
    }
    const thunks = rawThunks;
    const chain = this.branch.getStore() ?? this.rootChain;
    const forkKey = chain.prev;
    chain.prev = joinChain(forkKey, thunks.length);
    const settled = await Promise.allSettled(
      thunks.map((thunk, i) =>
        this.branch.run({ prev: forkChain(forkKey, i) }, async () => thunk()),
      ),
    );
    return this.collectSettled(settled, 'parallel');
  }

  private async pipeline(
    rawItems: unknown,
    rawStages: unknown[],
  ): Promise<unknown[]> {
    this.checkCaps();
    if (!Array.isArray(rawItems))
      throw this.err('TypeError', PIPELINE_NOT_ARRAY_ERROR);
    assertBoundaryArray(rawItems, (c, m) => this.err(c, m));
    if (rawStages.length > 4096)
      assertBoundaryArray(rawStages, (c, m) => this.err(c, m));
    if (!rawStages.every(isFunction)) {
      throw this.err('TypeError', PIPELINE_STAGES_ERROR);
    }
    if (rawItems.length === 0) return [];
    const stages = rawStages;
    const chain = this.branch.getStore() ?? this.rootChain;
    const forkKey = chain.prev;
    chain.prev = joinChain(forkKey, rawItems.length);
    const settled = await Promise.allSettled(
      rawItems.map((item, i) =>
        this.branch.run({ prev: forkChain(forkKey, i) }, async () => {
          let acc: unknown = await item;
          for (const stage of stages) {
            acc = await stage(acc, item, i);
            if (acc === null) break;
          }
          return acc;
        }),
      ),
    );
    return this.collectSettled(settled, 'pipeline');
  }

  private collectSettled(
    settled: Array<PromiseSettledResult<unknown>>,
    kind: 'parallel' | 'pipeline',
  ): unknown[] {
    let budgetDrops = 0;
    const out = settled.map((s, i) => {
      if (s.status === 'fulfilled')
        return s.value === undefined ? null : s.value;
      const reason: unknown = s.reason;
      const reasonName = isRecord(reason)
        ? stringField(reason, 'name')
        : undefined;
      if (reasonName === 'WorkflowBudgetExceededError') {
        budgetDrops++;
        return null;
      }
      const reasonMessage = isRecord(reason)
        ? stringField(reason, 'message')
        : undefined;
      const message = `${kind}[${i}] failed: ${reasonMessage ?? String(reason)}`;
      this.deps.onFailure(message);
      this.log(message);
      return null;
    });
    if (budgetDrops > 0) {
      const message = `${kind}: ${budgetDrops} slot(s) dropped — token budget exceeded`;
      this.deps.onFailure(message);
      this.log(message);
    }
    return out;
  }

  private childCounts = new Map<string, number>();

  private async child(
    nameOrRef: unknown,
    args: unknown,
    depth: number,
  ): Promise<unknown> {
    if (depth > 0) throw this.err('Error', NESTING_ERROR);
    let resolved: ResolvedChildWorkflow;
    try {
      resolved = await this.deps.resolveChildWorkflow(nameOrRef);
    } catch (e) {
      throw this.err('Error', e instanceof Error ? e.message : String(e));
    }
    const name = resolved.meta.name;
    const seen = (this.childCounts.get(name) ?? 0) + 1;
    this.childCounts.set(name, seen);
    const title = `▸ ${name}${seen > 1 ? ` #${seen}` : ''}`;
    const childPhase = this.registerPhase(title, 'child');
    this.log(`▸ running dynamic workflow ${name}`);
    const hooks = this.buildHooks({
      args: cloneJson(args),
      depth: depth + 1,
      logPrefix: `[${name}] `,
      phaseLocked: true,
      childPhase,
    });
    const sandbox = (
      this.deps.createSandbox ??
      ((h, s) => createWorkflowSandbox(h, { signal: s }))
    )(hooks, this.deps.signal);
    const previousSandbox = this.sandbox;
    try {
      this.sandbox = sandbox; // errors thrown while the child runs belong to its realm
      const result = await sandbox.run(resolved.wrapped);
      this.log(`▸ ${name} done`);
      return result;
    } finally {
      this.sandbox = previousSandbox;
      sandbox.dispose();
    }
  }
}

// -------------------------------------------------------------------------
// Coercions (match Claude Code's lenient handling)
// -------------------------------------------------------------------------

export function coercePrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (prompt === null || prompt === undefined) return '';
  if (typeof prompt === 'object') return '[object]';
  return String(prompt);
}

export function coerceLogMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message === null) return 'null';
  if (message === undefined) return 'undefined';
  if (typeof message === 'object') return '[object]';
  return String(message);
}

const PROVIDER_FAMILIES = new Set([
  'gemini',
  'claude',
  'codex',
  'copilot',
  'agy',
]);

function providerFamily(value: string | undefined): AgentOpts['provider'] {
  switch (value) {
    case 'gemini':
    case 'claude':
    case 'codex':
    case 'copilot':
    case 'agy':
      return value;
    default:
      return undefined;
  }
}

function isolationMode(value: string | undefined): AgentOpts['isolation'] {
  return value === 'worktree' || value === 'remote' ? value : undefined;
}

export function normalizeOpts(raw: unknown): AgentOpts {
  if (!isRecord(raw)) return {};
  const opts: AgentOpts = {};
  const label = raw['label'];
  if (label !== undefined)
    opts.label = String(label).replace(/\s+/g, ' ').trim();
  const phase = raw['phase'];
  if (phase !== undefined) opts.phase = String(phase);
  const schema = raw['schema'];
  if (isRecord(schema)) opts.schema = schema;
  const model = stringField(raw, 'model');
  if (model !== undefined) opts.model = model;
  const provider = stringField(raw, 'provider');
  if (provider !== undefined && PROVIDER_FAMILIES.has(provider))
    opts.provider = providerFamily(provider);
  const effort = stringField(raw, 'effort');
  if (effort !== undefined) opts.effort = effort;
  const isolation = isolationMode(stringField(raw, 'isolation'));
  if (isolation !== undefined) opts.isolation = isolation;
  const agentType = stringField(raw, 'agentType');
  if (agentType !== undefined) opts.agentType = agentType;
  const disallowedTools = stringArrayField(raw, 'disallowedTools');
  if (disallowedTools) opts.disallowedTools = [...disallowedTools].sort();
  const bashCommandClamp = stringArrayField(raw, 'bashCommandClamp');
  if (bashCommandClamp) opts.bashCommandClamp = [...bashCommandClamp].sort();
  const stallMs = raw['stallMs'];
  if (typeof stallMs === 'number' && Number.isFinite(stallMs))
    opts.stallMs = stallMs;
  return opts;
}

export function previewOf(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}
