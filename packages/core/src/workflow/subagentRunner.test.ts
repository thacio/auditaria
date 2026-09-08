/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import {
  ProviderEventType,
  type ProviderDriver,
  type ProviderEvent,
} from '../providers/types.js';
import type { DriverSpec } from '../providers/driverFactory.js';
import {
  lintSchema,
  runSubagent,
  validateAgentCall,
  type SubagentRunnerContext,
} from './subagentRunner.js';
import { submitStructuredOutput } from './structuredOutputTool.js';
import type { AgentCall } from './hostApi.js';
import type { WorkflowRunRecord } from './taskRegistry.js';
import { WorkflowTaskRegistry } from './taskRegistry.js';
import type { WorkflowService } from './workflowService.js';

function fakeDriver(
  events: ProviderEvent[],
  captured: { prompt?: string; system?: string },
): ProviderDriver {
  return {
    async *sendMessage(prompt, _signal, systemContext) {
      captured.prompt = prompt;
      captured.system = systemContext;
      for (const e of events) {
        await new Promise((r) => setTimeout(r, 1));
        yield e;
      }
    },
    async interrupt() {},
    getSessionId: () => 'fake-session',
    dispose() {},
    canResume: false,
  };
}

function makeContext(
  family: 'claude' | 'codex' | 'copilot' | 'agy',
  events: ProviderEvent[],
  captured: { prompt?: string; system?: string; spec?: DriverSpec },
): { ctx: SubagentRunnerContext; logs: string[] } {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
  const registry = new WorkflowTaskRegistry();
  const logs: string[] = [];
  const record: WorkflowRunRecord = {
    runId: 'wf_test',
    taskId: 'wtest',
    meta: { name: 't', description: 'd' },
    scriptPath: '',
    status: 'running',
    startTime: Date.now(),
    providerAtLaunch: { family, model: undefined },
    defaultModel: 'x',
    workflowProgress: [],
    logs,
    failures: [],
    leafSessionIds: new Set(),
    abortController: new AbortController(),
    agentControllers: new Map(),
    notified: false,
  };
  registry.register(record);
  const fakeConfig = {
    getAgentSessionManager: () => ({
      getToolBridge: async () => ({ port: 4321, scriptPath: 'bridge.js' }),
    }),
    buildExternalProviderContext: () => 'BASE CONTEXT',
    getWorkingDir: () => agentsDir,
  };
  const ctx: SubagentRunnerContext = {
    // The runner only touches the three members above for external leaves.
    config: fakeConfig as unknown as Config,
    service: { registry } as unknown as WorkflowService,
    record,
    agentsDir,
    childrenPath: path.join(agentsDir, 'children.jsonl'),
    createDriver: async (spec) => {
      captured.spec = spec;
      return fakeDriver(events, captured);
    },
  };
  return { ctx, logs: record.logs };
}

function makeCall(
  prompt: string,
  opts: AgentCall['opts'] = {},
): AgentCall & { patches: unknown[] } {
  const patches: unknown[] = [];
  return {
    index: 1,
    key: 'k',
    agentId: 'a0123456789abcdef',
    prompt,
    label: 'leaf',
    opts,
    phaseIndex: 0,
    phaseTitle: '',
    signal: new AbortController().signal,
    progress: (p) => patches.push(p),
    patches,
  };
}

describe('runSubagent — external leaves', () => {
  it('spawns a headless driver, returns the final text, counts tools and tokens', async () => {
    const captured: { prompt?: string; system?: string; spec?: DriverSpec } =
      {};
    const { ctx } = makeContext(
      'claude',
      [
        { type: ProviderEventType.ModelInfo, model: 'claude-haiku-4-5' },
        {
          type: ProviderEventType.ToolUse,
          toolName: 'Bash',
          toolId: 't1',
          input: { command: 'echo hi' },
        },
        { type: ProviderEventType.ToolResult, toolId: 't1', output: 'hi' },
        { type: ProviderEventType.Content, text: 'PO' },
        { type: ProviderEventType.Content, text: 'NG' },
        {
          type: ProviderEventType.Finished,
          usage: { inputTokens: 10, outputTokens: 42 },
        },
      ],
      captured,
    );
    const call = makeCall('Reply PONG', {
      model: 'haiku',
      effort: 'low',
      disallowedTools: ['Write', 'Workflow', 'Agent', 'Task'],
    });
    const result = await runSubagent(ctx, call, () => undefined);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.outcome.value).toBe('PONG');
    expect(result.outcome.tokens).toBe(42);
    expect(result.outcome.toolCalls).toBe(1);
    expect(result.outcome.usageUnavailable).toBe(false);
    expect(captured.spec).toMatchObject({
      family: 'claude',
      interactionStyle: 'headless',
      model: 'haiku',
      reasoningEffort: 'low',
      toolBridgePort: 4321,
      disallowedTools: ['Write', 'Workflow', 'Agent', 'Task'],
    });
    expect(captured.spec?.toolBridgeExclude).toEqual(
      expect.arrayContaining(['workflow', 'external_agent_session', 'Write']),
    );
    expect(captured.system).toContain(
      'You are a subagent spawned by a workflow orchestration script',
    );
    expect(captured.system).toContain('BASE CONTEXT');
    expect(
      call.patches.some(
        (p) => (p as { lastToolName?: string }).lastToolName === 'Bash',
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(ctx.agentsDir, 'a0123456789abcdef.jsonl')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(ctx.agentsDir, 'a0123456789abcdef.meta.json')),
    ).toBe(true);
  });

  it('maps a foreign alias onto the pinned provider and logs it', async () => {
    const captured: { spec?: DriverSpec } = {};
    const { ctx, logs } = makeContext(
      'codex',
      [
        { type: ProviderEventType.Content, text: 'ok' },
        { type: ProviderEventType.Finished },
      ],
      captured,
    );
    const result = await runSubagent(
      ctx,
      makeCall('x', { model: 'haiku' }),
      () => undefined,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.outcome.usageUnavailable).toBe(true);
    expect(captured.spec?.model).not.toBe('haiku');
    expect(logs.some((l) => l.includes("model 'haiku' mapped to"))).toBe(true);
  });

  it('parses and validates JSON output in schema mode (text fallback), throwing on a mismatch', async () => {
    const captured = {};
    const ok = makeContext(
      'copilot',
      [
        {
          type: ProviderEventType.Content,
          text: '```json\n{"n": 3, "word": "three"}\n```',
        },
        { type: ProviderEventType.Finished },
      ],
      captured,
    );
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer' }, word: { type: 'string' } },
      required: ['n', 'word'],
    };
    const good = await runSubagent(
      ok.ctx,
      makeCall('x', { schema }),
      () => undefined,
    );
    expect(good.kind).toBe('ok');
    if (good.kind === 'ok')
      expect(good.outcome.value).toEqual({ n: 3, word: 'three' });

    const bad = makeContext(
      'copilot',
      [
        { type: ProviderEventType.Content, text: 'Sure! {"n": "three"}' },
        { type: ProviderEventType.Finished },
      ],
      captured,
    );
    await expect(
      runSubagent(bad.ctx, makeCall('x', { schema }), () => undefined),
    ).rejects.toThrow(
      /subagent completed without (a valid structured output|calling StructuredOutput)/,
    );
  });

  it('reports a provider error as a failed leaf and an abort as skipped/failed', async () => {
    const captured = {};
    const errCtx = makeContext(
      'agy',
      [{ type: ProviderEventType.Error, message: 'quota exhausted' }],
      captured,
    );
    const failed = await runSubagent(
      errCtx.ctx,
      makeCall('x'),
      () => undefined,
    );
    expect(failed).toMatchObject({ kind: 'failed', error: 'quota exhausted' });

    const skipCtx = makeContext(
      'claude',
      [{ type: ProviderEventType.Content, text: 'partial' }],
      captured,
    );
    const call = makeCall('x');
    const ac = new AbortController();
    ac.abort(new Error('user-skip'));
    const skipped = await runSubagent(
      skipCtx.ctx,
      { ...call, signal: ac.signal },
      () => 'user-skip',
    );
    expect(skipped.kind).toBe('skipped');
  });
});

describe('runSubagent — StructuredOutput over the bridge', () => {
  it('captures a StructuredOutput submission mid-stream, interrupts the leaf and returns the object', async () => {
    const captured: { spec?: DriverSpec } = {};
    let interrupted = false;
    const { ctx } = makeContext('claude', [], captured);
    ctx.createDriver = async (spec) => {
      captured.spec = spec;
      return {
        async *sendMessage() {
          yield { type: ProviderEventType.Content, text: 'working…' };
          await new Promise((r) => setTimeout(r, 5));
          // The leaf calls the bridged tool; the executor routes it here.
          submitStructuredOutput(spec.toolBridgeCallId!, { n: 'bad' });
          submitStructuredOutput(spec.toolBridgeCallId!, {
            n: 7,
            word: 'seven',
          });
          await new Promise((r) => setTimeout(r, 200));
          yield { type: ProviderEventType.Content, text: 'still going' };
        },
        async interrupt() {
          interrupted = true;
        },
        getSessionId: () => undefined,
        dispose() {},
        canResume: false,
      };
    };
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer' }, word: { type: 'string' } },
      required: ['n', 'word'],
    };
    const call = makeCall('x', { schema });
    const result = await runSubagent(ctx, call, () => undefined);
    expect(captured.spec?.toolBridgeCallId).toBe(call.agentId);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok')
      expect(result.outcome.value).toEqual({ n: 7, word: 'seven' });
    expect(interrupted).toBe(true);
  });
});

describe('pre-spawn validation', () => {
  it('lints schemas like Claude Code', () => {
    expect(lintSchema({ type: 'string' })).toContain(
      "the root schema must declare type: 'object'",
    );
    expect(
      lintSchema({
        type: 'object',
        properties: {},
        required: ['b'],
        additionalProperties: false,
      }),
    ).toContain('lists "b" in required');
    expect(
      lintSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['b'],
      }),
    ).toBeUndefined();
    expect(
      lintSchema({ type: 'object', properties: { a: { type: 'nope' } } }),
    ).toContain('invalid JSON Schema');
  });

  it('rejects isolation:remote and unknown Gemini agent types', () => {
    const { ctx } = makeContext('claude', [], {});
    expect(() => validateAgentCall(ctx, 'p', { isolation: 'remote' })).toThrow(
      "agent({isolation:'remote'}) is not available in this build",
    );
    expect(() => validateAgentCall(ctx, 'p', { agentType: 'x' })).not.toThrow(); // external family: folded into context
  });
});
