/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The `workflow` tool — Auditaria's clone of Claude Code's
// Workflow tool. Runs a model-authored orchestration script in the background
// (see packages/core/src/workflow/ and .auditaria/workflow-research/12-final-plan.md).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolCallConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { WORKFLOW_TOOL_NAME } from './tool-names.js';
import {
  parseWorkflowScript,
  WorkflowScriptError,
  type ParsedWorkflowScript,
} from '../workflow/scriptParser.js';
import {
  DISABLED_MANAGED,
  MUST_PROVIDE_SOURCE,
  REVIEW_TITLE,
  SKILL_TRAILER,
  launchText,
  nameOnlyRestriction,
  scriptPathNotAllowed,
  scriptPathUnreadable,
  unknownNamedWorkflow,
} from '../workflow/errors.js';
import { RUN_ID_PATTERN } from '../workflow/workflowPaths.js';
import { WorkflowLaunchError } from '../workflow/workflowService.js';
import { buildWorkflowToolDescription } from '../workflow/toolDescription.js';

const ACTIONS = ['run', 'stop', 'list', 'status'] as const;
type WorkflowAction = (typeof ACTIONS)[number];

export interface WorkflowToolParams {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: unknown;
  resumeFromRunId?: string;
  description?: string;
  title?: string;
  /** Auditaria additions — absent from Claude Code's schema, optional here. */
  action?: WorkflowAction;
  taskId?: string;
  budgetTokens?: number;
}

export class WorkflowTool extends BaseDeclarativeTool<
  WorkflowToolParams,
  ToolResult
> {
  static readonly Name = WORKFLOW_TOOL_NAME;
  static readonly Bridgeable = true;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      WorkflowTool.Name,
      'Workflow',
      buildWorkflowToolDescription(config),
      Kind.Other,
      {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (a pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase(). Plain JavaScript, not TypeScript.',
          },
          name: {
            type: 'string',
            description:
              'Name of a saved workflow (built-in, project .auditaria/workflows/, or user ~/.auditaria/workflows/). Resolves to a self-contained script.',
          },
          scriptPath: {
            type: 'string',
            description:
              'Path to a workflow script file on disk. Every invocation persists its script and returns the path in the tool result; edit that file and pass it back here to iterate without resending the script. Takes precedence over `script` and `name`.',
          },
          args: {
            description:
              'Optional value exposed to the script as the global `args`, verbatim. Pass arrays and objects as real JSON values, not as a JSON-encoded string (a stringified list breaks args.map/args.filter in the script).',
          },
          resumeFromRunId: {
            type: 'string',
            description:
              'Run ID of a prior invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Stop the prior run first (action "stop") before resuming.',
          },
          description: {
            type: 'string',
            description:
              "Ignored — set the workflow description in the script's `meta` block.",
          },
          title: {
            type: 'string',
            description:
              "Ignored — set the workflow title in the script's `meta` block.",
          },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description:
              'Omit (or "run") to launch/resume a workflow. "stop": stop the running workflow named by taskId (the TaskStop equivalent). "status": the current progress of taskId, or the completion block once it has finished. "list": the workflows this session knows about.',
          },
          taskId: {
            type: 'string',
            description:
              'The task ID (or run ID) that "stop" and "status" act on.',
          },
          budgetTokens: {
            type: 'number',
            description:
              'Optional output-token ceiling for this run: sets budget.total in the script so budget.remaining() is finite and further agent() calls throw once it is exhausted (in-flight agents complete). Omit for no ceiling.',
          },
        },
      },
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: WorkflowToolParams,
  ): string | null {
    const action = params.action ?? 'run';
    if (action !== 'run') {
      if ((action === 'stop' || action === 'status') && !params.taskId) {
        return `action "${action}" requires taskId`;
      }
      return null;
    }
    if (
      params.resumeFromRunId !== undefined &&
      !RUN_ID_PATTERN.test(params.resumeFromRunId)
    ) {
      return `resumeFromRunId must look like wf_xxxxxxxx-xxx (got ${params.resumeFromRunId})`;
    }
    if (!params.script && !params.name && !params.scriptPath)
      return MUST_PROVIDE_SOURCE;
    return null;
  }

  protected createInvocation(
    params: WorkflowToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<WorkflowToolParams, ToolResult> {
    return new WorkflowInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}

interface ResolvedScript {
  source: string;
  parsed: ParsedWorkflowScript;
  /** Where the script lives on disk (already persisted, or to be persisted). */
  scriptPath?: string;
  fromName?: string;
}

class WorkflowInvocation extends BaseToolInvocation<
  WorkflowToolParams,
  ToolResult
> {
  private resolved: ResolvedScript | undefined;
  private resolveError: string | undefined;

  constructor(
    private readonly config: Config,
    params: WorkflowToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  private get action(): WorkflowAction {
    return this.params.action ?? 'run';
  }

  getDescription(): string {
    switch (this.action) {
      case 'stop':
        return `Stop workflow ${this.params.taskId}`;
      case 'status':
        return `Workflow status ${this.params.taskId}`;
      case 'list':
        return 'List workflows';
      default: {
        const r = this.resolve();
        if (r.ok) {
          return this.params.resumeFromRunId
            ? `Resume workflow "${r.value.parsed.meta.name}" (${this.params.resumeFromRunId})`
            : `Run workflow "${r.value.parsed.meta.name}"`;
        }
        return 'Run workflow';
      }
    }
  }

  /** Resolve script text (scriptPath > script > name), parse and cache — pre-flight. */
  private resolve():
    | { ok: true; value: ResolvedScript }
    | { ok: false; error: string } {
    if (this.resolved) return { ok: true, value: this.resolved };
    if (this.resolveError) return { ok: false, error: this.resolveError };
    try {
      this.resolved = this.doResolve();
      return { ok: true, value: this.resolved };
    } catch (e) {
      this.resolveError = e instanceof Error ? e.message : String(e);
      return { ok: false, error: this.resolveError };
    }
  }

  private doResolve(): ResolvedScript {
    const p = this.params;
    const service = this.config.getWorkflowService();
    if (process.env['AUDITARIA_DISABLE_WORKFLOW'] === '1')
      throw new Error(DISABLED_MANAGED);
    if (process.env['AUDITARIA_WORKFLOW_NAME_ONLY'] === '1') {
      const offending = (
        ['script', 'scriptPath', 'resumeFromRunId'] as const
      ).filter((k) => p[k] !== undefined);
      if (offending.length) throw new Error(nameOnlyRestriction(offending));
    }
    if (p.scriptPath !== undefined) {
      const scriptPath = p.scriptPath;
      if (/^\\\\|^\/\/|^\\\\\?\\/.test(scriptPath))
        throw new Error(scriptPathNotAllowed(scriptPath));
      if (p.script !== undefined) {
        // Literal script text wins; scriptPath is only the save target.
        return {
          source: p.script,
          parsed: parseWorkflowScript(p.script),
          scriptPath: path.resolve(scriptPath),
        };
      }
      let source: string;
      try {
        source = fs.readFileSync(scriptPath, 'utf8');
      } catch {
        throw new Error(scriptPathUnreadable(scriptPath));
      }
      return {
        source,
        parsed: parseWorkflowScript(source),
        scriptPath: path.resolve(scriptPath),
      };
    }
    if (p.script !== undefined) {
      return { source: p.script, parsed: parseWorkflowScript(p.script) };
    }
    if (p.name !== undefined) {
      const named = service.resolveNamed(p.name);
      if (!named) {
        throw new Error(
          unknownNamedWorkflow(
            p.name,
            service.listNamed().map((w) => w.name),
          ),
        );
      }
      return {
        source: named.script,
        parsed: parseWorkflowScript(named.script),
        scriptPath: named.filePath,
        fromName: p.name,
      };
    }
    throw new Error(MUST_PROVIDE_SOURCE);
  }

  protected override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.action !== 'run') return false;
    const r = this.resolve();
    if (!r.ok) return false; // execute() reports the error
    const { meta } = r.value.parsed;
    const preview = r.value.source.split('\n').slice(0, 40).join('\n');
    const more = r.value.source.split('\n').length > 40 ? '\n…' : '';
    void abortSignal;
    return {
      type: 'info',
      title: REVIEW_TITLE,
      prompt: [
        `Workflow: ${meta.name}`,
        `Description: ${meta.description}`,
        this.params.resumeFromRunId
          ? `Resuming run ${this.params.resumeFromRunId}`
          : undefined,
        meta.phases?.length
          ? `Phases: ${meta.phases.map((ph) => ph.title).join(' → ')}`
          : undefined,
        '',
        preview + more,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
      onConfirm: async () => {},
    };
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    void options;
    const service = this.config.getWorkflowService();
    switch (this.action) {
      case 'stop': {
        const outcome = service.stop(this.params.taskId!);
        const message = outcome.ok
          ? `Successfully stopped task: ${outcome.run.taskId} (${outcome.run.meta.description})`
          : outcome.message;
        return { llmContent: message, returnDisplay: message };
      }
      case 'status': {
        const block = service.statusBlock(this.params.taskId!);
        const message = block ?? `No workflow with id ${this.params.taskId}.`;
        return { llmContent: message, returnDisplay: message };
      }
      case 'list': {
        const runs = service.registry
          .list()
          .map((run) => service.registry.summaryOf(run));
        const named = service.listNamed();
        const lines = [
          runs.length ? 'Runs this session:' : 'No workflow runs this session.',
          ...runs.map(
            (r) =>
              `- ${r.taskId} ${r.runId} "${r.name}" ${r.status} · ${r.agentsDone}/${r.agentCount} agents · ${r.totalTokens.toLocaleString()} tokens`,
          ),
          '',
          named.length ? 'Saved workflows:' : 'No saved workflows.',
          ...named.map(
            (w) => `- ${w.name} (${w.source}): ${w.meta.description}`,
          ),
        ];
        const message = lines.join('\n');
        return { llmContent: message, returnDisplay: message };
      }
      default:
        return this.launch();
    }
  }

  private launch(): ToolResult {
    const r = this.resolve();
    if (!r.ok) {
      const message = `${r.error}\n${SKILL_TRAILER}`;
      return {
        llmContent: message,
        returnDisplay: `Error: ${r.error}`,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    const service = this.config.getWorkflowService();
    const resumeFromRunId = this.params.resumeFromRunId;
    let scriptPath = r.value.scriptPath;
    try {
      // Persist inline scripts so the model can iterate on a file.
      const runIdForFile = resumeFromRunId ?? undefined;
      const result = service.launch({
        parsed: r.value.parsed,
        scriptPath: scriptPath ?? '', // filled below once the run id is known
        args: this.params.args,
        resumeFromRunId,
        budgetTokens: this.params.budgetTokens,
      });
      if (!scriptPath) {
        scriptPath = service.persistScript(
          r.value.parsed.meta.name,
          result.runId,
          r.value.source,
        );
        const run = service.registry.get(result.runId);
        if (run) run.scriptPath = scriptPath;
      }
      void runIdForFile;
      const text = launchText({
        taskId: result.taskId,
        summary: r.value.parsed.meta.description,
        transcriptDir: result.transcriptDir,
        scriptPath,
        runId: result.runId,
        resumed: result.resumed,
      });
      const display = {
        workflow: {
          taskId: result.taskId,
          runId: result.runId,
          name: r.value.parsed.meta.name,
          description: r.value.parsed.meta.description,
          scriptPath,
          resumed: result.resumed,
        },
      };
      return { llmContent: text, returnDisplay: JSON.stringify(display) };
    } catch (e) {
      const message =
        e instanceof WorkflowLaunchError || e instanceof WorkflowScriptError
          ? e.message
          : `Workflow could not be launched: ${e instanceof Error ? e.message : String(e)}`;
      return {
        llmContent: `${message}\n${SKILL_TRAILER}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}
