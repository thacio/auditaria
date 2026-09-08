/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: This entire file is part of the workflow feature —
// `/workflows`: the human's view of background workflow runs (list, status,
// stop, resume, save as a named workflow, open a run's details).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import type { WorkflowRunRecord } from '@google/gemini-cli-core';
import { parseWorkflowMeta, savedWorkflowDir } from '@google/gemini-cli-core';

type Message = {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
};

function info(content: string): Message {
  return { type: 'message', messageType: 'info', content };
}

function fail(content: string): Message {
  return { type: 'message', messageType: 'error', content };
}

function serviceOf(context: CommandContext) {
  const config = context.services.agentContext?.config;
  return config?.getWorkflowService();
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'running':
      return '◐';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'killed':
      return '■';
    case 'paused':
      return '⏸';
    default:
      return '·';
  }
}

function listRuns(context: CommandContext): Message {
  const service = serviceOf(context);
  if (!service) return fail('Workflow service unavailable.');
  const runs = service.registry.list();
  const lines: string[] = [];
  if (runs.length === 0) {
    lines.push('No workflow runs in this session.');
  } else {
    lines.push('Workflow runs (newest first):');
    for (const run of runs) {
      const s = service.registry.summaryOf(run);
      const elapsed = age((run.endTime ?? Date.now()) - run.startTime);
      lines.push(
        `  ${statusGlyph(s.status)} ${s.taskId}  ${s.runId}  "${s.name}"  ${s.status} · ${s.agentsDone}/${s.agentCount} agents · ${s.totalTokens.toLocaleString()} tokens · ${elapsed}${s.lastLog ? ` · ${s.lastLog}` : ''}`,
      );
    }
  }
  const named = service.listNamed();
  lines.push('');
  lines.push(
    named.length
      ? `Saved workflows: ${named.map((w) => `${w.name} (${w.source})`).join(', ')}`
      : 'No saved workflows (built-in: deep-research).',
  );
  lines.push('');
  lines.push(
    'Subcommands: /workflows status <id> · stop <id> · resume <id> · open <id> · save <id> [project|user]',
  );
  return info(lines.join('\n'));
}

function requireRun(
  context: CommandContext,
  id: string | undefined,
): { run: WorkflowRunRecord } | Message {
  const service = serviceOf(context);
  if (!service) return fail('Workflow service unavailable.');
  if (!id) return fail('Usage: give a task id (w…) or run id (wf_…).');
  const run = service.registry.get(id);
  if (!run) return fail(`No workflow with id ${id} in this session.`);
  return { run };
}

const statusSubCommand: SlashCommand = {
  name: 'status',
  description: "Show a run's progress or completion block",
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const service = serviceOf(context);
    const block = service?.statusBlock(args.trim());
    return block ? info(block) : fail(`No workflow with id ${args.trim()}.`);
  },
};

const stopSubCommand: SlashCommand = {
  name: 'stop',
  description:
    'Stop a running workflow (its agents are aborted; the run stays resumable)',
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const service = serviceOf(context);
    if (!service) return fail('Workflow service unavailable.');
    const outcome = service.stop(args.trim());
    return outcome.ok
      ? info(
          `Stopped workflow ${outcome.run.runId} (task ${outcome.run.taskId}).`,
        )
      : fail(outcome.message);
  },
};

const resumeSubCommand: SlashCommand = {
  name: 'resume',
  description:
    'Ask the model to resume a stopped or failed run from its journal',
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const found = requireRun(context, args.trim());
    if ('type' in found) return found;
    const { run } = found;
    if (run.status === 'running')
      return fail(`Workflow ${run.runId} is still running.`);
    const argsPart =
      run.args !== undefined ? `, args: ${JSON.stringify(run.args)}` : '';
    return {
      type: 'submit_prompt',
      content: `Resume the workflow by calling: workflow({scriptPath: '${run.scriptPath}', resumeFromRunId: '${run.runId}'${argsPart}}) — completed agents return cached results.`,
    };
  },
};

const openSubCommand: SlashCommand = {
  name: 'open',
  description: "Show a run's phases, agents and narrator log",
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const found = requireRun(context, args.trim());
    if ('type' in found) return found;
    const { run } = found;
    const lines: string[] = [
      `${statusGlyph(run.status)} ${run.meta.name} — ${run.meta.description}`,
      `run ${run.runId} · task ${run.taskId} · ${run.status} · provider ${run.providerAtLaunch.family}${run.providerAtLaunch.model ? `:${run.providerAtLaunch.model}` : ''}`,
      `script: ${run.scriptPath}`,
    ];
    for (const e of run.workflowProgress) {
      if (e.type === 'workflow_phase') {
        lines.push(`${e.kind === 'child' ? '' : '▸ '}${e.title}`);
      } else if (e.type === 'workflow_agent') {
        const bits = [
          e.model,
          e.tokens ? `${e.tokens.toLocaleString()} tok` : undefined,
          e.durationMs ? age(e.durationMs) : undefined,
          e.cached ? 'cached' : undefined,
          e.error ? `error: ${e.error.slice(0, 80)}` : undefined,
        ].filter(Boolean);
        lines.push(
          `    ${e.state === 'done' ? '✓' : e.state === 'error' ? '✗' : '◐'} #${e.index} ${e.label || e.promptPreview}${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
        );
      }
    }
    if (run.logs.length) {
      lines.push('log:');
      for (const l of run.logs.slice(-15)) lines.push(`  › ${l}`);
    }
    if (run.error) lines.push(`error: ${run.error}`);
    if (run.status !== 'running' && run.result !== undefined) {
      const text = JSON.stringify(run.result);
      lines.push(
        `result: ${text.length > 600 ? text.slice(0, 600) + '…' : text}`,
      );
    }
    return info(lines.join('\n'));
  },
};

const saveSubCommand: SlashCommand = {
  name: 'save',
  description:
    "Save a run's script as a named workflow (.auditaria/workflows or ~/.auditaria/workflows)",
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const [id, scopeArg] = args.trim().split(/\s+/);
    const found = requireRun(context, id);
    if ('type' in found) return found;
    const config = context.services.agentContext?.config;
    if (!config) return fail('Config unavailable.');
    const { run } = found;
    let source: string;
    try {
      source = fs.readFileSync(run.scriptPath, 'utf8');
    } catch {
      return fail(`Cannot read the run's script at ${run.scriptPath}.`);
    }
    let meta;
    try {
      meta = parseWorkflowMeta(source);
    } catch (e) {
      return fail(
        `The run's script no longer parses: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const scope = scopeArg === 'user' ? 'user' : 'project';
    const dir = savedWorkflowDir(config, scope);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(
      dir,
      `${meta.name.replace(/[^a-z0-9_-]+/gi, '-')}.js`,
    );
    fs.writeFileSync(target, source, 'utf8');
    return info(
      `Saved "${meta.name}" to ${target} (${scope}). Run it with workflow({name: '${meta.name}'}).`,
    );
  },
};

const ultracodeSubCommand: SlashCommand = {
  name: 'ultracode',
  description:
    'Turn the standing multi-agent opt-in on or off for this session (on | off | auto | status)',
  kind: CommandKind.BUILT_IN,
  action: (context, args) => {
    const service = serviceOf(context);
    if (!service) return fail('Workflow service unavailable.');
    const mode = args.trim().toLowerCase();
    if (mode === 'on') service.ultracodeOverride = true;
    else if (mode === 'off') service.ultracodeOverride = false;
    else if (mode === 'auto') service.ultracodeOverride = undefined;
    else if (mode && mode !== 'status')
      return fail('Usage: /workflows ultracode on | off | auto | status');
    const override = service.ultracodeOverride;
    const state =
      override === undefined
        ? 'auto (follows the Workflows settings and a provider effort of ultra)'
        : override
          ? 'on'
          : 'off';
    return info(
      `Ultracode: ${state}. The model is reminded at its next turn.${override === true ? ' Every substantive task now runs as a workflow.' : ''}`,
    );
  },
};

export const workflowsCommand: SlashCommand = {
  name: 'workflows',
  altNames: ['workflow'],
  description:
    'List and manage background workflow runs (status, stop, resume, open, save)',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    statusSubCommand,
    stopSubCommand,
    resumeSubCommand,
    openSubCommand,
    saveSubCommand,
    ultracodeSubCommand,
  ],
  action: (context) => listRuns(context),
};
