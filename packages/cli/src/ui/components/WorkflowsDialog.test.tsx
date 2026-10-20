/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowAgentRow,
  WorkflowRunRecord,
  WorkflowService,
} from '@google/gemini-cli-core';
import { makeFakeConfig } from '@google/gemini-cli-core';
import {
  renderWithProviders,
  type RenderWithProvidersInstance,
} from '../../test-utils/render.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { WorkflowsDialog } from './WorkflowsDialog.js';
import { WorkflowCardDisplay } from './messages/WorkflowCardDisplay.js';

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 40 })),
}));

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ENTER = '\r';
const ESCAPE = '\u001b[27u';
const DOWN = '\u001b[B';
const UP = '\u001b[A';

function agent(
  index: number,
  overrides: Partial<WorkflowAgentRow> = {},
): WorkflowAgentRow {
  return {
    type: 'workflow_agent',
    index,
    label: `reviewer-${index}`,
    phaseIndex: 1,
    phaseTitle: 'Investigate',
    state: 'progress',
    promptPreview: `Inspect module ${index} and report evidence.`,
    lastProgressAt: NOW,
    startedAt: NOW - 5000,
    model: 'test-model',
    tokens: 1200,
    toolCalls: 3,
    lastToolName: 'Read',
    lastToolSummary: 'src/workflow.ts',
    ...overrides,
  };
}

function run(
  runId: string,
  overrides: Partial<WorkflowRunRecord> = {},
): WorkflowRunRecord {
  return {
    runId,
    taskId: `task-${runId}`,
    meta: {
      name: runId,
      title: `Review ${runId}`,
      description: `Inspect and verify ${runId}.`,
    },
    scriptPath: `/workflows/${runId}.js`,
    status: 'running',
    startTime: NOW - 10_000,
    providerAtLaunch: { family: 'gemini', model: 'test-model' },
    defaultModel: 'test-model',
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Investigate' },
      agent(1),
      agent(2, { state: 'done', resultPreview: 'Second reviewer finished.' }),
      { type: 'workflow_phase', index: 2, title: 'Verify' },
      agent(3, {
        phaseIndex: 2,
        phaseTitle: 'Verify',
        label: 'verifier',
        state: 'done',
        resultPreview: 'All findings verified.',
      }),
    ],
    logs: [],
    failures: [],
    leafSessionIds: new Set(),
    abortController: new AbortController(),
    agentControllers: new Map(),
    notified: false,
    ...overrides,
  };
}

function fakeService(records: WorkflowRunRecord[]) {
  const events = new EventEmitter();
  const registry = {
    list: () => [...records].sort((a, b) => b.startTime - a.startTime),
    running: () => records.filter((record) => record.status === 'running'),
    summaryOf: (record: WorkflowRunRecord) => {
      const agents = record.workflowProgress.filter(
        (row): row is WorkflowAgentRow => row.type === 'workflow_agent',
      );
      return {
        ...record,
        agentCount: agents.length,
        agentsDone: agents.filter((row) => row.state === 'done').length,
        totalTokens: agents.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
      };
    },
    applyProgress: (runId: string, row: WorkflowAgentRow) => {
      const record = records.find((entry) => entry.runId === runId)!;
      record.workflowProgress = record.workflowProgress.map((previous) =>
        previous.type === row.type && previous.index === row.index
          ? row
          : previous,
      );
      events.emit('change', runId);
    },
    settle: (
      runId: string,
      outcome: Pick<WorkflowRunRecord, 'status' | 'result'>,
    ) => {
      Object.assign(records.find((entry) => entry.runId === runId)!, outcome, {
        endTime: NOW,
      });
      events.emit('change', runId);
    },
  };
  const service = Object.assign(events, {
    registry,
    stop: vi.fn(() => ({ ok: true, message: 'Stopped.' })),
    skipAgent: vi.fn(() => true),
    retryAgent: vi.fn(() => true),
    pause: vi.fn(() => true),
    resume: vi.fn(async () => undefined),
    save: vi.fn(() => '/workflows/saved.js'),
    agentDetail: vi.fn<WorkflowService['agentDetail']>(async () => undefined),
  });
  return {
    service: service as unknown as WorkflowService,
    controls: service,
  };
}

const rendered: RenderWithProvidersInstance[] = [];

async function mount(
  records: WorkflowRunRecord[],
  options: { width?: number; initialRunId?: string } = {},
) {
  const { service, controls } = fakeService(records);
  const onClose = vi.fn();
  const ui = await renderWithProviders(
    <WorkflowsDialog
      service={service}
      onClose={onClose}
      initialRunId={options.initialRunId}
    />,
    { width: options.width ?? 120 },
  );
  const result = { ...ui, controls, onClose };
  rendered.push(result);
  return result;
}

async function press(ui: RenderWithProvidersInstance, key: string) {
  await act(async () => {
    ui.stdin.write(key);
    await vi.advanceTimersByTimeAsync(75);
  });
  await ui.waitUntilReady();
}

/** Optional local visual evidence; ordinary test runs write no artifacts. */
function capture(ui: RenderWithProvidersInstance, name: string) {
  const directory = process.env['WORKFLOW_UI_SNAPSHOTS'];
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.txt`), ui.lastFrame());
  writeFileSync(path.join(directory, `${name}.svg`), ui.generateSvg());
}

describe('WorkflowsDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 120, rows: 40 });
  });

  afterEach(() => {
    for (const ui of rendered.splice(0)) ui.unmount();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders an empty state and closes on Escape', async () => {
    const ui = await mount([]);
    expect(ui.lastFrame()).toContain('No workflows yet.');
    capture(ui, 'empty-120');
    await press(ui, ESCAPE);
    expect(ui.onClose).toHaveBeenCalledOnce();
    expect(ui.controls.stop).not.toHaveBeenCalled();
  });

  it('navigates runs, phases and agent details with real keypresses', async () => {
    const ui = await mount([
      run('alpha'),
      run('older', { startTime: NOW - 20_000 }),
    ]);
    expect(ui.lastFrame()).toContain('2 runs');
    capture(ui, 'runs-120');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Phases');
    expect(ui.lastFrame()).toContain('Investigate');
    capture(ui, 'phases-120');
    await press(ui, DOWN);
    expect(ui.lastFrame()).toContain('verifier');
    expect(ui.lastFrame()).not.toContain('reviewer-1');
    await press(ui, ENTER);
    capture(ui, 'agents-120');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Prompt preview');
    expect(ui.lastFrame()).toContain('Inspect module 3');
    capture(ui, 'agent-detail-120');
    await press(ui, ESCAPE);
    expect(ui.lastFrame()).not.toContain('Prompt preview');
    await press(ui, ESCAPE);
    expect(ui.lastFrame()).toContain('Phases');
    await press(ui, ESCAPE);
    expect(ui.lastFrame()).toContain('2 runs');
    expect(ui.onClose).not.toHaveBeenCalled();
    await press(ui, ESCAPE);
    expect(ui.onClose).toHaveBeenCalledOnce();
  });

  it('keeps agents without phase events visible and inspectable', async () => {
    const ui = await mount([
      run('ungrouped', {
        workflowProgress: [
          agent(1, { phaseIndex: 0, phaseTitle: '', label: 'ungrouped-agent' }),
        ],
      }),
    ]);
    expect(ui.lastFrame()).toContain('Agents');
    expect(ui.lastFrame()).toContain('ungrouped-agent');
    await press(ui, ENTER);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect module 1');
  });

  it('routes stop and retry to the selected agent without stopping its run', async () => {
    const ui = await mount([run('alpha')]);
    await press(ui, ENTER);
    await press(ui, DOWN);
    await press(ui, 'r');
    expect(ui.controls.retryAgent).toHaveBeenCalledExactlyOnceWith('alpha', 2);
    expect(ui.lastFrame()).toContain('Restarting agent');
    await press(ui, 'x');
    expect(ui.controls.skipAgent).toHaveBeenCalledExactlyOnceWith('alpha', 2);
    expect(ui.controls.stop).not.toHaveBeenCalled();
    await press(ui, ESCAPE);
    await press(ui, 'x');
    expect(ui.controls.stop).toHaveBeenCalledExactlyOnceWith('alpha');
  });

  it('updates progress and status from service events and removes its listener', async () => {
    const ui = await mount([run('alpha')]);
    expect(ui.controls.listenerCount('change')).toBe(1);
    await act(async () => {
      ui.controls.registry.applyProgress(
        'alpha',
        agent(1, {
          state: 'done',
          tokens: 7300,
          resultPreview: 'Fresh result.',
        }),
      );
      ui.controls.registry.settle('alpha', {
        status: 'completed',
        result: 'Finished',
      });
    });
    await ui.waitUntilReady();
    expect(ui.lastFrame()).toContain('3/3 agents');
    expect(ui.lastFrame()).toContain('9,700 tokens');
    expect(ui.lastFrame()).toContain('completed');
    ui.unmount();
    rendered.splice(rendered.indexOf(ui), 1);
    expect(ui.controls.listenerCount('change')).toBe(0);
  });

  it('pauses active runs and resumes paused runs', async () => {
    const ui = await mount([run('alpha')]);
    await press(ui, 'p');
    expect(ui.controls.pause).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(ui.controls.resume).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('Pausing workflow');
    await act(async () => {
      ui.controls.registry.settle('alpha', { status: 'paused' });
    });
    await ui.waitUntilReady();
    await press(ui, 'p');
    expect(ui.controls.resume).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(ui.lastFrame()).toContain('Workflow resumed.');
  });

  it('shows only matching agents when cycling activity filters', async () => {
    const ui = await mount([run('alpha')]);
    await press(ui, ENTER);
    await press(ui, 'f');
    expect(ui.lastFrame()).toContain('Investigate · running');
    expect(ui.lastFrame()).toContain('reviewer-1');
    expect(ui.lastFrame()).not.toContain('reviewer-2');
    await press(ui, 'f');
    expect(ui.lastFrame()).toContain('Investigate · completed');
    expect(ui.lastFrame()).not.toContain('reviewer-1');
    expect(ui.lastFrame()).toContain('reviewer-2');
    await press(ui, 'f');
    expect(ui.lastFrame()).toContain('No agents in this view.');
  });

  it('keeps a filtered agent selected and shows its result when it completes', async () => {
    const ui = await mount([
      run('alpha', {
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Investigate' },
          agent(1, {
            state: 'done',
            resultPreview: 'An earlier reviewer finished.',
          }),
          agent(2, { state: 'progress' }),
        ],
      }),
    ]);
    await press(ui, ENTER);
    await press(ui, 'f');
    expect(ui.lastFrame()).toContain('reviewer-2');
    expect(ui.lastFrame()).not.toContain('reviewer-1');
    await press(ui, ENTER);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect module 2');

    await act(async () => {
      ui.controls.registry.applyProgress(
        'alpha',
        agent(2, {
          state: 'done',
          resultPreview: 'Selected reviewer final evidence.',
        }),
      );
      ui.controls.registry.settle('alpha', { status: 'completed' });
    });
    await ui.waitUntilReady();
    expect(ui.lastFrame()).toContain('Selected reviewer final evidence.');
    expect(ui.lastFrame()).toContain('Inspect module 2');
    capture(ui, 'filtered-agent-completed-120');
  });

  it.each([
    {
      status: 'completed' as const,
      row: { state: 'done' as const },
      outcome: 'The agent returned no text.',
    },
    {
      status: 'killed' as const,
      row: { state: 'progress' as const },
      outcome: 'The workflow has stopped.',
    },
    {
      status: 'running' as const,
      row: { state: 'error' as const, skipped: true },
      outcome: 'Skipped by the user.',
    },
    {
      status: 'running' as const,
      row: { state: 'start' as const, startedAt: undefined },
      outcome: 'Waiting for an execution slot.',
    },
  ])(
    'explains an empty outcome for $status / $row.state',
    async ({ status, row, outcome }) => {
      const ui = await mount([
        run('alpha', {
          status,
          workflowProgress: [agent(1, row)],
        }),
      ]);
      await press(ui, ENTER);
      await press(ui, ENTER);
      await press(ui, ENTER);
      expect(ui.lastFrame()).toContain(outcome);
    },
  );

  it('captures search input without invoking action shortcuts', async () => {
    const ui = await mount([run('alpha'), run('pxrs-target')]);
    await press(ui, '/');
    await press(ui, 'pxrs');
    expect(ui.lastFrame()).toContain('Search: pxrs');
    expect(ui.lastFrame()).toContain('Review pxrs-target');
    expect(ui.lastFrame()).not.toContain('Review alpha');
    expect(ui.controls.pause).not.toHaveBeenCalled();
    expect(ui.controls.stop).not.toHaveBeenCalled();
    expect(ui.controls.save).not.toHaveBeenCalled();
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Search: pxrs');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect and verify pxrs-target.');
  });

  it('labels unavailable usage and partial totals without inventing zero usage', async () => {
    const ui = await mount([
      run('alpha', {
        workflowProgress: [
          agent(1, { tokens: undefined, usageUnavailable: true }),
          agent(2, { state: 'done', tokens: 400 }),
        ],
      }),
    ]);
    expect(ui.lastFrame()).toContain('400 tokens (partial)');
    await press(ui, ENTER);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Usage unavailable');
    expect(ui.lastFrame()).not.toMatch(/\b0 tokens\b/);
    capture(ui, 'agent-unavailable-usage-120');
  });

  it('retains early active and failed agents when the inline card reaches its row cap', async () => {
    const record = run('alpha', {
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Investigate' },
        agent(1, { label: 'Early active reviewer' }),
        agent(2, { label: 'Early failed reviewer', state: 'error' }),
        ...Array.from({ length: 13 }, (_, index) =>
          agent(index + 3, { state: 'done' }),
        ),
      ],
    });
    const { service } = fakeService([record]);
    const config = makeFakeConfig({});
    vi.spyOn(config, 'getWorkflowService').mockReturnValue(service);
    const ui = await renderWithProviders(
      <WorkflowCardDisplay
        data={{
          workflow: {
            runId: record.runId,
            taskId: record.taskId,
            name: record.meta.name,
            description: record.meta.description,
            scriptPath: record.scriptPath,
            resumed: false,
          },
        }}
      />,
      { config, width: 120 },
    );
    rendered.push(ui);
    expect(ui.lastFrame()).toContain('Early active reviewer');
    expect(ui.lastFrame()).toContain('Early failed reviewer');
    expect(ui.lastFrame()).toContain('3 other agent(s)');
    capture(ui, 'inline-active-priority-120');
  });

  it('keeps save-dialog focus, changes scope, and saves only on Enter', async () => {
    const ui = await mount([run('alpha')]);
    await press(ui, 's');
    expect(ui.lastFrame()).toContain('Save workflow: alpha');
    await press(ui, 'x');
    expect(ui.controls.stop).not.toHaveBeenCalled();
    await press(ui, '\t');
    expect(ui.lastFrame()).toContain('Your user workflows');
    capture(ui, 'save-120');
    await press(ui, ESCAPE);
    expect(ui.controls.save).not.toHaveBeenCalled();
    expect(ui.onClose).not.toHaveBeenCalled();
    await press(ui, 's');
    await press(ui, ENTER);
    expect(ui.controls.save).toHaveBeenCalledExactlyOnceWith('alpha', 'user');
    expect(ui.lastFrame()).toContain('Saved to /workflows/saved.js');
  });

  it('renders a narrow terminal and switches agents from detail view', async () => {
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 52, rows: 24 });
    const ui = await mount([run('alpha')], { width: 52 });
    capture(ui, 'phases-52');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('reviewer-1');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect module 1');
    await press(ui, DOWN);
    expect(ui.lastFrame()).toContain('Inspect module 2');
    await press(ui, UP);
    expect(ui.lastFrame()).toContain('Inspect module 1');
    capture(ui, 'agent-detail-52');
    for (const line of ui.lastFrame().split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(52);
    }
    expect(ui.lastFrame().trimEnd().split('\n').length).toBeLessThanOrEqual(24);
  });

  it('allows long detail content to expand and scroll to the result', async () => {
    const ui = await mount([
      run('alpha', {
        workflowProgress: [
          agent(1, {
            promptPreview: Array.from(
              { length: 25 },
              (_, i) => `Task line ${i + 1}`,
            ).join('\n'),
            state: 'done',
            resultPreview: 'Final evidence reached.',
          }),
        ],
      }),
    ]);
    await press(ui, ENTER);
    await press(ui, ENTER);
    expect(ui.lastFrame()).not.toContain('Final evidence reached.');
    await press(ui, ENTER);
    for (let i = 0; i < 30; i++) await press(ui, 'j');
    expect(ui.lastFrame()).toContain('Final evidence reached.');
  });

  it('loads full agent details and stops polling when returning to the agent list', async () => {
    const ui = await mount([run('alpha')]);
    ui.controls.agentDetail.mockResolvedValue({
      prompt: 'Full transcript prompt beyond the progress preview.',
      result: 'Full verified outcome beyond the result preview.',
      tools: [
        { name: 'Read', summary: 'src/first.ts' },
        { name: 'Search', summary: 'matching declarations' },
      ],
      truncated: false,
    });
    expect(ui.controls.agentDetail).not.toHaveBeenCalled();
    await press(ui, ENTER);
    expect(ui.controls.agentDetail).not.toHaveBeenCalled();
    await press(ui, ENTER);
    expect(ui.controls.agentDetail).toHaveBeenCalledExactlyOnceWith('alpha', 1);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Full transcript prompt beyond');
    expect(ui.lastFrame()).toContain('Full verified outcome beyond');
    expect(ui.lastFrame()).toContain('Read: src/first.ts');
    expect(ui.lastFrame()).toContain('Search: matching declarations');
    expect(ui.lastFrame()).not.toContain('Inspect module 1');
    capture(ui, 'agent-full-transcript-120');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await ui.waitUntilReady();
    expect(ui.controls.agentDetail).toHaveBeenCalledTimes(2);
    await press(ui, ESCAPE);
    expect(ui.lastFrame()).not.toContain('Full transcript prompt beyond');
    const callsAfterNavigation = ui.controls.agentDetail.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await ui.waitUntilReady();
    expect(ui.controls.agentDetail).toHaveBeenCalledTimes(callsAfterNavigation);
  });

  it('explains a completed transcript containing an empty string result', async () => {
    const ui = await mount([
      run('alpha', {
        status: 'completed',
        workflowProgress: [agent(1, { state: 'done' })],
      }),
    ]);
    ui.controls.agentDetail.mockResolvedValue({
      prompt: 'Full prompt for the empty successful result.',
      result: '',
      tools: [],
      truncated: false,
    });
    await press(ui, ENTER);
    await press(ui, ENTER);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('The agent returned no text.');
    expect(ui.lastFrame()).not.toContain('Result preview');
  });

  it('keeps the entire footer visible with a save notice in a narrow expanded view', async () => {
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 52, rows: 24 });
    const ui = await mount(
      [
        run('alpha', {
          status: 'completed',
          workflowProgress: Array.from({ length: 6 }, (_, index) =>
            agent(index + 1, {
              state: 'done',
              tokens: 1200 * (index + 1),
              usageUnavailable: index === 5,
              promptPreview: Array.from(
                { length: 35 },
                (_, line) => `Prompt line ${line + 1}: inspect this evidence.`,
              ).join('\n'),
            }),
          ),
        }),
      ],
      { width: 52 },
    );
    ui.controls.save.mockImplementation(() => {
      throw new Error('A saved workflow already exists at this destination.');
    });
    await press(ui, ENTER);
    await press(ui, ENTER);
    await press(ui, ENTER);
    await press(ui, 's');
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('A saved workflow already exists');
    expect(ui.lastFrame()).toContain('Esc back');
    expect(ui.lastFrame().trimEnd().split('\n').length).toBeLessThanOrEqual(24);
    capture(ui, 'expanded-save-notice-52');
  });

  it('allows the last result line to be reached while details are collapsed', async () => {
    const ui = await mount([
      run('alpha', {
        workflowProgress: [
          agent(1, {
            promptPreview: Array.from(
              { length: 25 },
              (_, i) => `Task line ${i + 1}`,
            ).join('\n'),
            state: 'done',
            resultPreview: 'Final evidence reached.',
          }),
        ],
      }),
    ]);
    await press(ui, ENTER);
    await press(ui, ENTER);
    for (let i = 0; i < 40; i++) await press(ui, 'j');
    expect(ui.lastFrame()).toContain('Final evidence reached.');
  });

  it('preserves the selected agent when returning from its details', async () => {
    const ui = await mount([run('alpha')]);
    await press(ui, ENTER);
    await press(ui, DOWN);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect module 2');
    await press(ui, ESCAPE);
    await press(ui, ENTER);
    expect(ui.lastFrame()).toContain('Inspect module 2');
  });
});
