/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { LocalAgentExecutor } from '../agents/local-executor.js';
import {
  AgentTerminateMode,
  type LocalAgentDefinition,
} from '../agents/types.js';
import { Kind } from '../tools/tools.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/tool-names.js';
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
    getAgentRegistry: () => ({
      getDefinition: () => undefined,
      getAllDefinitions: () => [],
    }),
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
  it('does not treat partial text followed by a provider error as success', async () => {
    const { ctx } = makeContext(
      'claude',
      [
        { type: ProviderEventType.Content, text: 'Investigating...' },
        {
          type: ProviderEventType.Error,
          message: 'Rate limit reached',
          status: 429,
        },
      ],
      {},
    );
    await expect(
      runSubagent(ctx, makeCall('task'), () => undefined),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: 'Rate limit reached',
    });
  });

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
      'You are executing one step of an Auditaria workflow',
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
  it('keeps StructuredOutput available for a custom external agent with a restricted tool list', async () => {
    const captured: { spec?: DriverSpec } = {};
    const { ctx } = makeContext('claude', [], captured);
    const custom: LocalAgentDefinition = {
      kind: 'local',
      name: 'evidence-reader',
      description: 'Read project evidence.',
      inputConfig: {
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
        },
      },
      promptConfig: {},
      modelConfig: {},
      runConfig: {},
      toolConfig: { tools: ['read_file'] },
    };
    const originalConfig = ctx.config;
    ctx.config = {
      getAgentSessionManager: () => originalConfig.getAgentSessionManager(),
      buildExternalProviderContext: () =>
        originalConfig.buildExternalProviderContext(),
      getWorkingDir: () => originalConfig.getWorkingDir(),
      getAgentRegistry: () => ({ getDefinition: () => custom }),
      getToolRegistry: () => ({
        getAllTools: () => [
          { name: 'read_file', kind: Kind.Read },
          { name: 'write_file', kind: Kind.Edit },
          { name: STRUCTURED_OUTPUT_TOOL_NAME, kind: Kind.Other },
        ],
      }),
    } as unknown as Config;
    ctx.createDriver = async (spec) => {
      captured.spec = spec;
      return {
        ...fakeDriver([], {}),
        async *sendMessage() {
          if (!spec.toolBridgeExclude?.includes(STRUCTURED_OUTPUT_TOOL_NAME)) {
            submitStructuredOutput(spec.toolBridgeCallId!, { count: 3 });
          }
          yield { type: ProviderEventType.Finished };
        },
      };
    };
    const call = makeCall('Count the evidence items', {
      agentType: custom.name,
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
    });
    try {
      validateAgentCall(ctx, call.prompt, call.opts);
      await expect(
        runSubagent(ctx, call, () => undefined),
      ).resolves.toMatchObject({
        kind: 'ok',
        outcome: { value: { count: 3 } },
      });
      expect(captured.spec?.toolBridgeCallId).toBe(call.agentId);
      expect(captured.spec?.toolBridgeExclude).toContain('write_file');
      expect(captured.spec?.toolBridgeExclude).not.toContain('read_file');
      expect(captured.spec?.toolBridgeExclude).not.toContain(
        STRUCTURED_OUTPUT_TOOL_NAME,
      );
    } finally {
      fs.rmSync(ctx.agentsDir, { recursive: true, force: true });
    }
  });

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
  it('rejects invalid structured-output schemas', () => {
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

  it('rejects unsupported isolation, command clamps and unknown agent types before launch', () => {
    const { ctx } = makeContext('claude', [], {});
    expect(() => validateAgentCall(ctx, 'p', { isolation: 'remote' })).toThrow(
      "agent({isolation:'remote'}) is not supported",
    );
    expect(() =>
      validateAgentCall(ctx, 'p', { isolation: 'worktree' }),
    ).toThrow('not supported');
    expect(() =>
      validateAgentCall(ctx, 'p', { bashCommandClamp: ['git status'] }),
    ).toThrow('not supported');
    expect(() => validateAgentCall(ctx, 'p', { agentType: 'x' })).toThrow(
      'not found',
    );
    expect(() => validateAgentCall(ctx, 'p', { stallMs: -1 })).toThrow(
      'nonnegative',
    );
    expect(() =>
      validateAgentCall(ctx, 'p', {
        schema: { type: 'object' },
        disallowedTools: ['StructuredOutput'],
      }),
    ).toThrow('requires StructuredOutput');
  });
});

describe('runSubagent — Gemini structured results', () => {
  it('preserves a registered custom Gemini definition while selecting permitted leaf tools', async () => {
    const rawTool = {
      name: 'summarize_evidence',
      description: 'Summarize collected evidence.',
      parametersJsonSchema: { type: 'object' },
    };
    const custom: LocalAgentDefinition = {
      kind: 'local',
      name: 'custom-auditor',
      description: 'Audit project evidence.',
      inputConfig: {
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
        },
      },
      promptConfig: {
        systemPrompt: 'Cite the evidence supporting each finding.',
        query: 'Original query: ${task}',
        initialMessages: [
          { role: 'user', parts: [{ text: 'Use the audit rubric.' }] },
          { role: 'model', parts: [{ text: 'I will apply the rubric.' }] },
        ],
      },
      modelConfig: {
        model: 'gemini-2.5-flash',
        generateContentConfig: {
          temperature: 0.25,
          maxOutputTokens: 4096,
          topP: 0.8,
          thinkingConfig: { thinkingBudget: 1024 },
        },
      },
      runConfig: { maxTurns: 7, maxTimeMinutes: 2 },
      toolConfig: {
        tools: ['read_file', 'mcp_evidence_*', 'workflow', rawTool],
      },
      mcpServers: {
        audit: {
          command: 'node',
          args: ['audit-server.js'],
          includeTools: ['lookup'],
          excludeTools: ['erase'],
        },
      },
    };
    const { ctx } = makeContext('claude', [], {});
    ctx.record.providerAtLaunch.family = 'gemini';
    const registerRuntimeModelConfig = vi.fn();
    const getDefinition = vi.fn((name: string) =>
      name === custom.name ? custom : undefined,
    );
    ctx.config = {
      getModel: () => 'gemini-default',
      getAgentRegistry: () => ({ getDefinition }),
      getToolRegistry: () => ({
        getAllTools: () => [
          { name: 'read_file', kind: Kind.Read },
          { name: 'write_file', kind: Kind.Edit },
          { name: 'mcp_evidence_lookup', kind: Kind.Read },
          { name: 'mcp_other_lookup', kind: Kind.Read },
          { name: 'workflow', kind: Kind.Other },
        ],
      }),
      getSessionId: () => 'test-session',
      getGeminiClient: () => undefined,
      modelConfigService: { registerRuntimeModelConfig },
    } as unknown as Config;
    const call = makeCall('Audit the collected evidence', {
      agentType: custom.name,
    });
    const executor = {
      run: vi.fn().mockResolvedValue({
        result: 'Evidence audited.',
        terminate_reason: AgentTerminateMode.GOAL,
      }),
    };
    const create = vi
      .spyOn(LocalAgentExecutor, 'create')
      .mockResolvedValue(
        executor as unknown as Awaited<
          ReturnType<typeof LocalAgentExecutor.create>
        >,
      );
    try {
      expect(() =>
        validateAgentCall(ctx, call.prompt, {
          ...call.opts,
          disallowedTools: ['mcp_audit_lookup'],
        }),
      ).toThrow('cannot yet be filtered by disallowedTools');
      expect(create).not.toHaveBeenCalled();
      validateAgentCall(ctx, call.prompt, call.opts);
      await expect(
        runSubagent(ctx, call, () => undefined),
      ).resolves.toMatchObject({
        kind: 'ok',
        outcome: { value: 'Evidence audited.' },
      });
      expect(getDefinition).toHaveBeenCalledWith(custom.name);
      expect(create).toHaveBeenCalledOnce();
      const [definition] = create.mock.calls[0];
      expect(definition.modelConfig).toEqual(custom.modelConfig);
      expect(definition.mcpServers).toEqual(custom.mcpServers);
      expect(definition.promptConfig).toEqual({
        ...custom.promptConfig,
        systemPrompt: expect.stringContaining(
          custom.promptConfig.systemPrompt!,
        ),
        query: '${task}',
      });
      expect(definition.promptConfig.systemPrompt).toContain(
        'You are executing one step of an Auditaria workflow',
      );
      expect(definition.toolConfig?.tools).toEqual([
        'read_file',
        'mcp_evidence_lookup',
        rawTool,
      ]);
      expect(definition.runConfig).toEqual(custom.runConfig);
      expect(registerRuntimeModelConfig).toHaveBeenCalledWith(
        `${definition.name}-config`,
        { modelConfig: custom.modelConfig },
      );
      expect(executor.run).toHaveBeenCalledWith(
        { task: call.prompt },
        call.signal,
      );
      await runSubagent(
        { ...ctx, record: { ...ctx.record, runId: 'wf_another_run' } },
        call,
        () => undefined,
      );
      expect(create).toHaveBeenCalledTimes(2);
      const [otherDefinition] = create.mock.calls[1];
      expect(otherDefinition.name).not.toBe(definition.name);
      expect(registerRuntimeModelConfig).toHaveBeenNthCalledWith(
        2,
        `${otherDefinition.name}-config`,
        { modelConfig: custom.modelConfig },
      );
    } finally {
      create.mockRestore();
      fs.rmSync(ctx.agentsDir, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    'returns the captured object or rejects a missing submission (submitted=%s)',
    async (submit) => {
      const { ctx } = makeContext('claude', [], {});
      ctx.record.providerAtLaunch.family = 'gemini';
      ctx.config = {
        getModel: () => 'gemini-test',
        getMessageBus: () => ({}),
        getToolRegistry: () => ({ getAllTools: () => [] }),
        getSessionId: () => 'test-session',
        getGeminiClient: () => undefined,
        modelConfigService: { registerRuntimeModelConfig: () => {} },
      } as unknown as Config;
      const call = makeCall('Return a count', {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      });
      const executor = {
        run: async () => {
          if (submit) submitStructuredOutput(call.agentId, { count: 42 });
          return {
            result: 'Finished the task.',
            terminate_reason: AgentTerminateMode.GOAL,
          };
        },
      };
      const create = vi
        .spyOn(LocalAgentExecutor, 'create')
        .mockResolvedValue(
          executor as unknown as Awaited<
            ReturnType<typeof LocalAgentExecutor.create>
          >,
        );
      try {
        if (submit) {
          await expect(
            runSubagent(ctx, call, () => undefined),
          ).resolves.toMatchObject({
            kind: 'ok',
            outcome: { value: { count: 42 } },
          });
        } else {
          await expect(runSubagent(ctx, call, () => undefined)).rejects.toThrow(
            'without calling StructuredOutput',
          );
        }
      } finally {
        create.mockRestore();
      }
    },
  );
});
