/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Per-Config facade of the Workflow tool: launches and
// resumes runs in the background, owns the registry / lease / journal /
// notification lifecycle, the turn token budget, and the seams the CLI and
// web UIs subscribe to. Everything the tool needs beyond parsing goes here.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter, setMaxListeners } from 'node:events';
import { debugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import type {
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowProviderFamily,
  WorkflowRunState,
} from './types.js';
import {
  parseWorkflowScript,
  type ParsedWorkflowScript,
} from './scriptParser.js';
import { createWorkflowSandbox, marshalResult } from './sandbox.js';
import {
  WorkflowHostApi,
  type AgentCall,
  type SubagentResult,
} from './hostApi.js';
import { WorkflowJournal } from './journal.js';
import {
  acquireLease,
  readLease,
  isLeaseLive,
  type AcquiredLease,
} from './leaseFile.js';
import {
  WorkflowTaskRegistry,
  type WorkflowRunRecord,
} from './taskRegistry.js';
import { readRunState, totalsOf, writeRunState } from './stateFile.js';
import {
  buildTaskNotification,
  usageFromProgress,
  wrapNotificationForTurn,
  writeOutputFile,
} from './notification.js';
import {
  newRunId,
  newTaskId,
  workflowPathsFor,
  RUN_ID_PATTERN,
  type WorkflowPaths,
} from './workflowPaths.js';
import { WORKFLOW_ABORTED, stillRunning } from './errors.js';
import { isRecord, stringField } from './guards.js';
import { WorkflowStallWatchdog } from './stallWatchdog.js';
import {
  readAgentTranscript,
  type WorkflowAgentDetail,
} from './agentTranscript.js';
import {
  runSubagent,
  validateAgentCall,
  type SubagentRunnerContext,
} from './subagentRunner.js';
import {
  resolveNamedWorkflow,
  listNamedWorkflows,
  type NamedWorkflow,
  savedWorkflowDir,
} from './namedWorkflows.js';

export interface LaunchRequest {
  parsed: ParsedWorkflowScript;
  /** Persisted (or user-supplied) script path echoed to the model. */
  scriptPath: string;
  args?: unknown;
  resumeFromRunId?: string;
  budgetTokens?: number;
  toolUseId?: string;
  /** Test seam: replaces providers/driverFactory for external leaves. */
  createDriver?: SubagentRunnerContext['createDriver'];
}

export interface LaunchResult {
  runId: string;
  taskId: string;
  transcriptDir: string;
  scriptPath: string;
  resumed: boolean;
}

export class WorkflowLaunchError extends Error {}

/** Display-only notice for the human (CLI history INFO item / web transcript). */
export interface WorkflowNotice {
  runId: string;
  taskId: string;
  kind: 'completed' | 'failed' | 'killed' | 'paused';
  text: string;
}

export interface WorkflowServiceEvents {
  /** Registry state changed (progress, status) — UIs re-render. */
  change: [runId: string];
  /** A human-facing notice. */
  notice: [notice: WorkflowNotice];
  /** A model-facing notification is ready for delivery at the next idle boundary. */
  notification: [runId: string];
}

export class WorkflowService extends EventEmitter<WorkflowServiceEvents> {
  readonly registry = new WorkflowTaskRegistry();
  readonly paths: WorkflowPaths;
  private readonly leases = new Map<string, AcquiredLease>();
  private readonly runPromises = new Map<string, Promise<void>>();
  /** Model-facing notifications waiting for an idle turn boundary. */
  private readonly pendingNotifications: Array<{
    runId: string;
    text: string;
  }> = [];
  private holdCount = 0;
  /** Reported workflow leaf output tokens; main-chat usage is not wired here. */
  private outputTokenCounter = 0;
  private turnBaseline = 0;
  /** Output-token target from the user's "+Nk" directive (next launch consumes it). */
  private turnBudgetTokens: number | undefined = undefined;

  constructor(private readonly config: Config) {
    super();
    this.paths = workflowPathsFor(config.storage.getProjectTempWorkflowsDir());
    this.registry.on('change', (runId) => this.emit('change', runId));
    this.restoreRuns();
  }

  /** Recover finished/interrupted runs without claiming another process's work. */
  private restoreRuns(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.runsDir);
    } catch {
      return;
    }
    for (const runId of names) {
      if (!RUN_ID_PATTERN.test(runId) || this.registry.get(runId)) continue;
      if (isLeaseLive(readLease(this.paths.leasePath(runId)))) continue;
      const state = readRunState(this.paths.statePath(runId));
      if (!state || state.runId !== runId) continue;
      const meta: WorkflowMeta = {
        name: state.workflowName,
        description: state.summary,
        phases: state.phases,
        ...(typeof state.meta?.title === 'string'
          ? { title: state.meta.title }
          : {}),
      };
      this.registry.register({
        runId,
        taskId: state.taskId,
        meta,
        scriptPath: state.scriptPath,
        args: state.args,
        status: state.status === 'running' ? 'paused' : state.status,
        startTime: state.startTime,
        endTime: state.startTime + state.durationMs,
        providerAtLaunch: state.providerAtLaunch ?? {
          family: 'gemini',
          model: state.defaultModel,
        },
        defaultModel: state.defaultModel,
        workflowProgress: state.workflowProgress,
        logs: state.logs,
        failures: [],
        result: state.result,
        error: state.error,
        leafSessionIds: new Set(),
        abortController: new AbortController(),
        agentControllers: new Map(),
        notified: true,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Budget accounting (shared pool, relative to the turn's starting usage)
  // ---------------------------------------------------------------------

  /** Called when a user turn starts so `budget.spent()` is turn-relative. */
  markTurnStart(): void {
    this.turnBaseline = this.outputTokenCounter;
    this.turnBudgetTokens = undefined;
  }

  setTurnBudget(tokens: number | undefined): void {
    this.turnBudgetTokens = tokens;
  }

  /** The pending "+Nk" budget, if any (kept until the turn's launches ran). */
  get turnBudget(): number | undefined {
    return this.turnBudgetTokens;
  }

  addOutputTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.outputTokenCounter += n;
  }

  private spentThisTurn(baseline: number): number {
    return Math.max(0, this.outputTokenCounter - baseline);
  }

  // ---------------------------------------------------------------------
  // Named workflows
  // ---------------------------------------------------------------------

  listNamed(): Array<{ name: string; meta: WorkflowMeta; source: string }> {
    return listNamedWorkflows(this.config);
  }

  resolveNamed(name: string): NamedWorkflow | undefined {
    return resolveNamedWorkflow(this.config, name);
  }

  // ---------------------------------------------------------------------
  // Launch / resume
  // ---------------------------------------------------------------------

  /**
   * Register, lease and start a run. Everything that can reject does so
   * synchronously here; the script itself runs detached.
   */
  launch(request: LaunchRequest): LaunchResult {
    const resumed = request.resumeFromRunId !== undefined;
    const runId = request.resumeFromRunId ?? newRunId();
    const taskId = newTaskId();

    const existing = this.registry.get(runId);
    if (
      existing &&
      (existing.status === 'running' || this.runPromises.has(runId))
    ) {
      throw new WorkflowLaunchError(stillRunning(runId, existing.taskId));
    }
    const lease = acquireLease(this.paths.leasePath(runId), taskId);
    if (!lease.ok) {
      throw new WorkflowLaunchError(
        stillRunning(runId, lease.existing.taskId || 'unknown'),
      );
    }
    this.leases.set(runId, lease.lease);

    const providerAtLaunch = this.currentProvider();
    const record: WorkflowRunRecord = {
      runId,
      taskId,
      toolUseId: request.toolUseId,
      meta: request.parsed.meta,
      scriptPath: request.scriptPath,
      args: request.args,
      status: 'running',
      startTime: Date.now(),
      providerAtLaunch,
      defaultModel: this.config.getModel(),
      workflowProgress: [],
      logs: [],
      failures: [],
      leafSessionIds: new Set(),
      abortController: new AbortController(),
      agentControllers: new Map(),
      notified: false,
    };
    // A run deliberately fans its cancellation signal out to many leaves.
    setMaxListeners(0, record.abortController.signal);
    this.registry.register(record);

    const promise = this.run(record, request)
      .catch((e: unknown) => {
        // run() settles every path itself; this only guards against a bug.
        this.registry.settle(runId, {
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(async () => {
        try {
          await this.leases.get(runId)?.release();
        } catch (error) {
          debugLogger.warn(
            `Workflow ${runId} lease cleanup failed: ${String(error)}`,
          );
        } finally {
          this.leases.delete(runId);
          this.runPromises.delete(runId);
        }
      });
    this.runPromises.set(runId, promise);

    return {
      runId,
      taskId,
      transcriptDir: this.paths.runDir(runId),
      scriptPath: request.scriptPath,
      resumed,
    };
  }

  private currentProvider(): {
    family: WorkflowProviderFamily;
    model?: string;
  } {
    // The active external provider (Claude / Codex / Copilot / agy) is the
    // provider manager's config; config.getModel() is only the Gemini model.
    const manager = this.config.getProviderManager?.();
    if (manager?.isExternalProviderActive()) {
      const pc = manager.getConfig();
      const model = pc.model || undefined;
      switch (pc.type) {
        case 'claude-cli':
          return { family: 'claude', model };
        case 'codex-cli':
          return { family: 'codex', model };
        case 'copilot-cli':
          return { family: 'copilot', model };
        case 'agy-cli':
          return { family: 'agy', model };
        default:
          break;
      }
    }
    const raw = this.config.getModel();
    const prefix = raw.split(':')[0];
    const rest = raw.slice(prefix.length + 1) || undefined;
    switch (prefix) {
      case 'claude-code':
        return { family: 'claude', model: rest };
      case 'codex-code':
        return { family: 'codex', model: rest };
      case 'copilot-code':
        return { family: 'copilot', model: rest };
      case 'agy-code':
        return { family: 'agy', model: rest };
      default:
        return { family: 'gemini', model: raw };
    }
  }

  private async run(
    record: WorkflowRunRecord,
    request: LaunchRequest,
  ): Promise<void> {
    const { runId } = record;
    const signal = record.abortController.signal;
    const startedAt = Date.now();
    const budgetBaseline = this.turnBaseline;
    const requestedBudget = request.budgetTokens ?? this.turnBudgetTokens;
    const budgetTotal =
      typeof requestedBudget === 'number' && requestedBudget > 0
        ? Math.floor(requestedBudget)
        : null;

    let journal: WorkflowJournal | undefined;
    let host: WorkflowHostApi | undefined;
    let sandbox: ReturnType<typeof createWorkflowSandbox> | undefined;
    let onAbort: (() => void) | undefined;
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
    let checkpointWrite = Promise.resolve();
    const scheduleCheckpoint = (id: string) => {
      if (id !== runId || checkpointTimer) return;
      checkpointTimer = setTimeout(() => {
        checkpointTimer = undefined;
        checkpointWrite = checkpointWrite
          .then(() =>
            this.persistState(record, request, Date.now() - startedAt),
          )
          .catch(() => undefined);
      }, 1000);
      checkpointTimer.unref();
    };
    let status: WorkflowRunRecord['status'] = 'completed';
    let result: unknown;
    let error: string | undefined;
    try {
      journal = await WorkflowJournal.open(this.paths.journalPath(runId));
      await fsp.mkdir(this.paths.agentsDir(runId), { recursive: true });

      const runnerContext: SubagentRunnerContext = {
        config: this.config,
        service: this,
        record,
        agentsDir: this.paths.agentsDir(runId),
        childrenPath: this.paths.childrenPath(runId),
        createDriver: request.createDriver,
      };

      host = new WorkflowHostApi({
        meta: request.parsed.meta,
        args: request.args,
        journal,
        budget: {
          total: budgetTotal,
          spent: () => this.spentThisTurn(budgetBaseline),
        },
        signal,
        runAgent: (call: AgentCall): Promise<SubagentResult> =>
          this.runLeaf(runnerContext, call),
        validateCall: (prompt, opts) =>
          validateAgentCall(runnerContext, prompt, opts),
        resolveChildWorkflow: async (ref) => this.resolveChild(ref),
        onProgress: (event: WorkflowProgressEvent) =>
          this.registry.applyProgress(runId, event),
        onLog: (message) => this.registry.addLog(runId, message),
        onFailure: (message) => this.registry.addFailure(runId, message),
      });
      sandbox = createWorkflowSandbox(host.hooks, { signal });
      host.attachSandbox(sandbox);
      await this.persistState(record, request, 0);
      this.on('change', scheduleCheckpoint);
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(WORKFLOW_ABORTED));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const raw = await Promise.race([
        sandbox.run(request.parsed.wrapped),
        abortPromise,
      ]);
      result = marshalResult(raw);
    } catch (e) {
      if (signal.aborted) {
        status = record.status === 'paused' ? 'paused' : 'killed';
        error = `Error: ${WORKFLOW_ABORTED}`;
      } else {
        status = 'failed';
        error = formatScriptError(e);
      }
    } finally {
      this.off('change', scheduleCheckpoint);
      if (checkpointTimer) clearTimeout(checkpointTimer);
      await checkpointWrite;
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // A script can throw or return with unawaited agent calls. Cancel and
      // drain them before publishing final state or making the lease reusable.
      record.abortController.abort(new Error('Workflow finished'));
      await host?.waitForAgents();
      sandbox?.dispose();
      try {
        await journal?.flush();
      } catch (e) {
        status = 'failed';
        error = formatScriptError(e);
      }
    }

    this.registry.settle(runId, { status, result, error });
    const durationMs = Date.now() - startedAt;
    await this.persistState(record, request, durationMs).catch(() => undefined);
    await this.notify(record, durationMs).catch(() => undefined);
  }

  private async runLeaf(
    ctx: SubagentRunnerContext,
    call: AgentCall,
  ): Promise<SubagentResult> {
    let attempt = 0;
    let tokens = 0;
    let toolCalls = 0;
    const startedAt = Date.now();
    for (;;) {
      call.signal.throwIfAborted();
      const controller = new AbortController();
      const entry = {
        controller,
        reason: undefined as 'user-skip' | 'user-retry' | undefined,
      };
      attempt++;
      ctx.record.agentControllers.set(call.index, entry);
      const onRunAbort = () => controller.abort(call.signal.reason);
      call.signal.addEventListener('abort', onRunAbort, { once: true });
      let stalled = false;
      const watchdog = new WorkflowStallWatchdog(
        call.opts.stallMs ?? 180_000,
        () => {
          stalled = true;
          controller.abort(new Error('Agent stopped making progress'));
        },
      );
      try {
        const result = await runSubagent(
          ctx,
          {
            ...call,
            signal: controller.signal,
            activity: (kind, id) => watchdog.activity(kind, id),
            progress: (patch) =>
              call.progress({
                ...patch,
                attempt,
                ...(patch.tokens === undefined
                  ? {}
                  : { tokens: tokens + patch.tokens }),
                ...(patch.toolCalls === undefined
                  ? {}
                  : { toolCalls: toolCalls + patch.toolCalls }),
              }),
          },
          () => entry.reason,
        );
        this.addOutputTokens(result.outcome?.tokens ?? 0);
        tokens += result.outcome?.tokens ?? 0;
        toolCalls += result.outcome?.toolCalls ?? 0;
        if (
          (entry.reason === 'user-retry' || stalled) &&
          !call.signal.aborted
        ) {
          if (attempt > 5) {
            throw new Error('Agent could not finish after six attempts.');
          }
          this.registry.addLog(
            ctx.record.runId,
            `${stalled ? 'No model progress; restarting' : 'Restarting'} ${call.label} (attempt ${attempt + 1} of 6).`,
          );
          continue;
        }
        const totals = {
          tokens,
          toolCalls,
          durationMs: Date.now() - startedAt,
        };
        if (result.kind === 'ok') {
          await fsp
            .appendFile(
              path.join(ctx.agentsDir, `${call.agentId}.jsonl`),
              `${JSON.stringify({ type: 'workflow_result', value: result.outcome.value })}\n`,
            )
            .catch(() => undefined);
          return { ...result, outcome: { ...result.outcome, ...totals } };
        }
        return { ...result, outcome: { ...result.outcome, ...totals } };
      } finally {
        watchdog.dispose();
        call.signal.removeEventListener('abort', onRunAbort);
        ctx.record.agentControllers.delete(call.index);
      }
    }
  }

  private async resolveChild(
    ref: unknown,
  ): Promise<{ meta: WorkflowMeta; wrapped: string }> {
    if (typeof ref === 'string') {
      const named = this.resolveNamed(ref);
      if (!named) {
        const available = this.listNamed().map((w) => w.name);
        throw new Error(
          `workflow('${ref}'): no workflow with that name. Available: ${available.length ? available.join(', ') : '(none)'}`,
        );
      }
      const parsed = parseWorkflowScript(named.script);
      return { meta: parsed.meta, wrapped: parsed.wrapped };
    }
    const scriptPath = isRecord(ref)
      ? stringField(ref, 'scriptPath')
      : undefined;
    if (scriptPath !== undefined) {
      let source: string;
      try {
        source = fs.readFileSync(scriptPath, 'utf8');
      } catch {
        throw new Error(
          `workflow({scriptPath: '${scriptPath}'}): Workflow script file not found: ${scriptPath}`,
        );
      }
      const parsed = parseWorkflowScript(source);
      return { meta: parsed.meta, wrapped: parsed.wrapped };
    }
    throw new Error('workflow() expects a workflow name or {scriptPath}');
  }

  // ---------------------------------------------------------------------
  // Persistence + notification
  // ---------------------------------------------------------------------

  private async persistState(
    record: WorkflowRunRecord,
    request: LaunchRequest,
    durationMs: number,
  ): Promise<void> {
    const totals = totalsOf(record.workflowProgress);
    const state: WorkflowRunState = {
      runId: record.runId,
      meta: record.meta,
      timestamp: new Date().toISOString(),
      taskId: record.taskId,
      script: request.parsed.body,
      source: request.parsed.source,
      scriptPath: record.scriptPath,
      ...(record.args !== undefined ? { args: record.args } : {}),
      result: record.result ?? null,
      agentCount: totals.agentCount,
      logs: record.logs,
      durationMs,
      ...(record.error ? { error: record.error } : {}),
      summary: record.meta.description,
      workflowName: record.meta.name,
      status: record.status,
      startTime: record.startTime,
      phases: record.meta.phases ?? [],
      defaultModel: record.defaultModel,
      providerAtLaunch: record.providerAtLaunch,
      workflowProgress: record.workflowProgress,
      totalTokens: totals.totalTokens,
      totalToolCalls: totals.totalToolCalls,
    };
    await writeRunState(this.paths.statePath(record.runId), state);
  }

  private async notify(
    record: WorkflowRunRecord,
    durationMs: number,
  ): Promise<void> {
    const totals = totalsOf(record.workflowProgress);
    const outputPath = this.paths.outputPath(record.taskId);
    const summaryBits = `${totals.agentCount} agent(s) · ${totals.totalTokens.toLocaleString()} tokens · ${Math.round(durationMs / 1000)}s`;

    if (record.status === 'killed' || record.status === 'paused') {
      // User-stopped runs do not send completion notifications to the model.
      this.emit('notice', {
        runId: record.runId,
        taskId: record.taskId,
        kind: record.status,
        text: `Workflow "${record.meta.name}" ${record.status} · ${summaryBits} · resume with workflow({scriptPath, resumeFromRunId: '${record.runId}'})`,
      });
      return;
    }

    await writeOutputFile(outputPath, {
      summary: record.meta.description,
      agentCount: totals.agentCount,
      logs: record.logs,
      result: record.result ?? null,
      workflowProgress: record.workflowProgress,
      totalTokens: totals.totalTokens,
      totalToolCalls: totals.totalToolCalls,
      ...(record.error ? { error: record.error } : {}),
    });

    const text = buildTaskNotification({
      taskId: record.taskId,
      toolUseId: record.toolUseId,
      runId: record.runId,
      status: record.status,
      summary: record.meta.description,
      result: record.result ?? null,
      error: record.error,
      outputFile: outputPath,
      journalPath: this.paths.journalPath(record.runId),
      transcriptDir: this.paths.runDir(record.runId),
      scriptPath: record.scriptPath,
      args: record.args,
      failures: record.failures,
      usage: usageFromProgress(record.workflowProgress, durationMs),
    });
    record.notified = true;
    this.pendingNotifications.push({ runId: record.runId, text });
    this.emit('notice', {
      runId: record.runId,
      taskId: record.taskId,
      kind: record.status === 'completed' ? 'completed' : 'failed',
      text: `Workflow "${record.meta.name}" ${record.status} · ${summaryBits} · /workflows`,
    });
    this.emit('notification', record.runId);
    this.config.injectionService.addInjection(
      wrapNotificationForTurn(text),
      'workflow_notification',
    );
  }

  // ---------------------------------------------------------------------
  // Delivery helpers
  // ---------------------------------------------------------------------

  /** True while a context-management operation (compress / forget) is in flight. */
  hold(): () => void {
    this.holdCount++;
    return () => {
      this.holdCount = Math.max(0, this.holdCount - 1);
    };
  }

  get isHeld(): boolean {
    return this.holdCount > 0;
  }

  hasPendingNotifications(): boolean {
    return this.pendingNotifications.length > 0;
  }

  /** Take every pending model-facing notification (used by pull-style consumers). */
  drainNotifications(): string[] {
    const out = this.pendingNotifications.map((n) => n.text);
    this.pendingNotifications.length = 0;
    return out;
  }

  /** The block for `workflow({action:'status'})` — the same text the notification carries. */
  statusBlock(id: string): string | undefined {
    const run = this.registry.get(id);
    if (!run) return undefined;
    const totals = totalsOf(run.workflowProgress);
    const durationMs = (run.endTime ?? Date.now()) - run.startTime;
    if (run.status === 'running') {
      const done = run.workflowProgress.filter(
        (e) => e.type === 'workflow_agent' && e.state === 'done',
      ).length;
      return `Workflow ${run.runId} (task ${run.taskId}) is running: ${done}/${totals.agentCount} agent(s) done, ${totals.totalTokens.toLocaleString()} tokens, ${Math.round(durationMs / 1000)}s elapsed. Last log: ${run.logs[run.logs.length - 1] ?? '(none)'}`;
    }
    return buildTaskNotification({
      taskId: run.taskId,
      toolUseId: run.toolUseId,
      runId: run.runId,
      status: run.status,
      summary: run.meta.description,
      result: run.result ?? null,
      error: run.error,
      outputFile: this.paths.outputPath(run.taskId),
      journalPath: this.paths.journalPath(run.runId),
      transcriptDir: this.paths.runDir(run.runId),
      scriptPath: run.scriptPath,
      args: run.args,
      failures: run.failures,
      usage: usageFromProgress(run.workflowProgress, durationMs),
    });
  }

  // ---------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------

  /** Stop a run by task id or run id. */
  stop(
    id: string,
  ): { ok: true; run: WorkflowRunRecord } | { ok: false; message: string } {
    const run = this.registry.get(id);
    if (!run) return { ok: false, message: `No workflow with id ${id}.` };
    if (run.status !== 'running') {
      return {
        ok: false,
        message: `Workflow ${run.runId} (task ${run.taskId}) is not running (status: ${run.status}).`,
      };
    }
    this.registry.stop(run.runId, 'user-stop');
    return { ok: true, run };
  }

  skipAgent(id: string, index: number): boolean {
    return this.registry.skipAgent(id, index);
  }

  retryAgent(id: string, index: number): boolean {
    return this.registry.retryAgent(id, index);
  }

  async agentDetail(
    id: string,
    index: number,
  ): Promise<WorkflowAgentDetail | undefined> {
    const run = this.registry.get(id);
    const agent = run?.workflowProgress.find(
      (row) => row.type === 'workflow_agent' && row.index === index,
    );
    if (
      !run ||
      agent?.type !== 'workflow_agent' ||
      !agent.agentId ||
      !/^[a-zA-Z0-9_-]+$/.test(agent.agentId)
    )
      return undefined;
    return readAgentTranscript(
      path.join(this.paths.agentsDir(run.runId), `${agent.agentId}.jsonl`),
    ).catch(() => undefined);
  }

  /** Pause preserves the journal; a later resume replays completed calls. */
  pause(id: string): boolean {
    return this.registry.stop(id, 'pause') !== undefined;
  }

  async resume(id: string): Promise<LaunchResult> {
    const run = this.registry.get(id);
    if (!run) throw new WorkflowLaunchError(`No workflow with id ${id}.`);
    if (run.status === 'running') {
      throw new WorkflowLaunchError(stillRunning(run.runId, run.taskId));
    }
    // Stop changes the display state immediately, but the previous leaves
    // still own their lease until they have finished shutting down.
    await this.runPromises.get(run.runId);
    const source = this.readScript(run);
    return this.launch({
      parsed: parseWorkflowScript(source),
      scriptPath: run.scriptPath,
      args: run.args,
      resumeFromRunId: run.runId,
    });
  }

  save(id: string, scope: 'project' | 'user' = 'project'): string {
    const run = this.registry.get(id);
    if (!run) throw new Error(`No workflow with id ${id}.`);
    const source = this.readScript(run);
    const { meta } = parseWorkflowScript(source);
    const dir = savedWorkflowDir(this.config, scope);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(
      dir,
      `${meta.name.replace(/[^a-z0-9_-]+/gi, '-')}.js`,
    );
    // Saving from either interface must not silently replace another script.
    try {
      fs.writeFileSync(target, source, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (isRecord(error) && error['code'] === 'EEXIST')
        throw new Error(
          `A saved workflow already exists at ${target}. Change meta.name in the script to save another workflow.`,
        );
      throw error;
    }
    return target;
  }

  private readScript(run: WorkflowRunRecord): string {
    try {
      return fs.readFileSync(run.scriptPath, 'utf8');
    } catch (error) {
      const saved = readRunState(this.paths.statePath(run.runId))?.source;
      if (typeof saved === 'string') return saved;
      throw error;
    }
  }

  /** Session exit: quietly pause every running workflow. */
  async pauseAllRunning(): Promise<void> {
    for (const run of this.registry.running())
      this.registry.stop(run.runId, 'pause');
    await Promise.allSettled([...this.runPromises.values()]);
  }

  /** Wait for a run to settle (tests, e2e). */
  async waitFor(id: string): Promise<WorkflowRunRecord | undefined> {
    const run = this.registry.get(id);
    if (!run) return undefined;
    await this.runPromises.get(run.runId);
    return run;
  }

  /** Persist a script the model sent inline; returns the path echoed back. */
  persistScript(name: string, runId: string, source: string): string {
    const target = this.paths.scriptPath(name, runId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, { encoding: 'utf8', mode: 0o600 });
    return target;
  }
}

function formatScriptError(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name && e.name !== 'Error' ? e.name : 'Error';
    return `${name}: ${e.message}`;
  }
  return String(e);
}
