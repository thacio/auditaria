/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Turns one agent() call into one headless sub-agent turn.
//
//   gemini  → an ad-hoc LocalAgentDefinition run by LocalAgentExecutor in
//             process, with a fresh auto-allow MessageBus (a detached run has
//             no turn for a confirmation dialog to appear in);
//   claude / codex / copilot / agy → the provider's promptless driver via
//             providers/driverFactory (milestone M2).
//
// Pre-spawn validation (schema lint, agentType, isolation) lives here too so
// hostApi can journal a `failed` line without an agentId for those rejections.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AjvPkg, { type Ajv } from 'ajv';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { LocalAgentExecutor } from '../agents/local-executor.js';
import { getModelConfigAlias } from '../agents/registry.js';
import {
  AgentTerminateMode,
  type LocalAgentDefinition,
  type SubagentActivityEvent,
} from '../agents/types.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { PolicyDecision } from '../policy/types.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { ResourceRegistry } from '../resources/resource-registry.js';
import { Kind } from '../tools/tools.js';
import {
  EXTERNAL_AGENT_SESSION_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from '../tools/tool-names.js';
import type { AgentCall, SubagentResult } from './hostApi.js';
import type { AgentOpts, WorkflowProviderFamily } from './types.js';
import type { WorkflowRunRecord } from './taskRegistry.js';
import type { WorkflowService } from './workflowService.js';
import { isRecord, stringField } from './guards.js';
import { ProviderEventType, type ProviderDriver } from '../providers/types.js';
import {
  createProviderDriver,
  type DriverSpec,
} from '../providers/driverFactory.js';
import { clampEffort, resolveLeafModel } from './modelAliases.js';
import {
  StructuredOutputTool,
  registerStructuredOutput,
  releaseStructuredOutput,
  type StructuredOutputEntry,
} from './structuredOutputTool.js';

export interface SubagentRunnerContext {
  config: Config;
  service: WorkflowService;
  record: WorkflowRunRecord;
  agentsDir: string;
  childrenPath: string;
  /** Test seam: replaces providers/driverFactory for external leaves. */
  createDriver?: (spec: DriverSpec) => Promise<ProviderDriver>;
}

/** Tools a workflow leaf never receives (recursion + the human-only tools). */
export const LEAF_EXCLUDED_TOOLS = new Set([
  WORKFLOW_TOOL_NAME,
  EXTERNAL_AGENT_SESSION_TOOL_NAME,
  'collaborative_writing',
  'context_management',
  'hive_connect',
  'hive_send',
  'hive_status',
  'hive_check',
  'hive_fetch',
  'hive_object',
]);

export const WORKFLOW_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Be concise. The script will parse your output.`;

export const WORKFLOW_SUBAGENT_SCHEMA_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (read files, run commands, search), then call StructuredOutput with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.
- If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.
- After calling StructuredOutput successfully, end your turn. No acknowledgment needed.`;

// -------------------------------------------------------------------------
// Pre-spawn validation
// -------------------------------------------------------------------------

// Ajv's ESM/CJS interop (same pattern as utils/schemaValidator.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-assignment
const AjvClass = (AjvPkg as any).default || AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const ajv: Ajv = new AjvClass({
  allErrors: true,
  validateFormats: false,
  strict: false,
});

export function lintSchema(
  schema: Record<string, unknown>,
): string | undefined {
  if (schema['$async'])
    return 'agent({schema}) received an invalid JSON Schema: $async schemas are not supported';
  if (schema['type'] !== 'object') {
    return "agent({schema}) received an unusable JSON Schema — the API only accepts an object-rooted tool input schema, so every request would be rejected: the root schema must declare type: 'object' (the API rejects any other root type for a tool input schema); wrap arrays or primitives in an object property. The subagent was not started — fix the schema and call agent() again.";
  }
  try {
    ajv.compile(schema);
  } catch (e) {
    return `agent({schema}) received an invalid JSON Schema: ${e instanceof Error ? e.message : String(e)}`;
  }
  const missing = requiredNotDeclared(schema, '');
  if (missing) {
    return `agent({schema}) received an unusable JSON Schema — no output can satisfy this schema, so StructuredOutput validation would fail on every attempt: ${missing}. The subagent was not started — fix the schema and call agent() again.`;
  }
  return undefined;
}

function requiredNotDeclared(
  node: unknown,
  pointer: string,
): string | undefined {
  if (!isRecord(node)) return undefined;
  const s = node;
  const rawRequired = s['required'];
  const required: unknown[] = Array.isArray(rawRequired) ? rawRequired : [];
  const rawProperties = s['properties'];
  const properties: Record<string, unknown> = isRecord(rawProperties)
    ? rawProperties
    : {};
  if (s['additionalProperties'] === false && !s['patternProperties']) {
    for (const r of required) {
      if (typeof r === 'string' && !(r in properties)) {
        return `${pointer ? `the sub-schema at ${pointer}` : 'the root object'} lists "${r}" in required but does not declare it in properties, and additionalProperties is false, so no object can satisfy it — declare the property or drop it from required`;
      }
    }
  }
  for (const [name, child] of Object.entries(properties)) {
    const found = requiredNotDeclared(child, `${pointer}/properties/${name}`);
    if (found) return found;
  }
  const items = s['items'];
  if (isRecord(items)) return requiredNotDeclared(items, `${pointer}/items`);
  return undefined;
}

export function validateAgentCall(
  ctx: SubagentRunnerContext,
  _prompt: string,
  opts: AgentOpts,
): void {
  if (opts.schema) {
    const problem = lintSchema(opts.schema);
    if (problem) throw new Error(problem);
  }
  if (opts.isolation === 'remote') {
    throw new Error(
      "agent({isolation:'remote'}) is not available in this build",
    );
  }
  const family = opts.provider ?? ctx.record.providerAtLaunch.family;
  if (opts.agentType && family === 'gemini') {
    const registry = ctx.config.getAgentRegistry();
    if (!registry.getDefinition(opts.agentType)) {
      const names = registry
        .getAllDefinitions()
        .map((d) => d.name)
        .sort();
      throw new Error(
        `agent({agentType}): agent type '${opts.agentType}' not found. Available agents: ${names.join(', ') || '(none)'}`,
      );
    }
  }
}

// -------------------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------------------

export async function runSubagent(
  ctx: SubagentRunnerContext,
  call: AgentCall,
  abortReason: () => 'user-skip' | 'user-retry' | undefined,
): Promise<SubagentResult> {
  const family: WorkflowProviderFamily =
    call.opts.provider ?? ctx.record.providerAtLaunch.family;
  const started = Date.now();
  writeAgentMeta(ctx, call, family);
  if (family === 'gemini')
    return runGeminiLeaf(ctx, call, abortReason, started);
  return runExternalLeaf(ctx, call, family, abortReason, started);
}

// -------------------------------------------------------------------------
// Gemini leaf
// -------------------------------------------------------------------------

function autoAllowContext(config: Config, promptId: string): AgentLoopContext {
  const policy = new PolicyEngine({
    rules: [{ toolName: '*', decision: PolicyDecision.ALLOW, priority: 100 }],
  });
  return {
    config,
    promptId,
    parentSessionId: config.getSessionId(),
    toolRegistry: config.getToolRegistry(),
    promptRegistry: new PromptRegistry(),
    resourceRegistry: new ResourceRegistry(),
    messageBus: new MessageBus(policy),
    geminiClient: config.getGeminiClient(),
    sandboxManager: config.sandboxManager,
  };
}

function leafToolNames(config: Config, opts: AgentOpts): string[] {
  const deny = new Set([
    ...LEAF_EXCLUDED_TOOLS,
    ...(opts.disallowedTools ?? []),
  ]);
  return config
    .getToolRegistry()
    .getAllTools()
    .filter((t) => t.kind !== Kind.Agent && !deny.has(t.name))
    .map((t) => t.name);
}

async function runGeminiLeaf(
  ctx: SubagentRunnerContext,
  call: AgentCall,
  abortReason: () => 'user-skip' | 'user-retry' | undefined,
  started: number,
): Promise<SubagentResult> {
  const { config } = ctx;
  const opts = call.opts;
  let systemPrompt = opts.schema
    ? WORKFLOW_SUBAGENT_SCHEMA_PROMPT
    : WORKFLOW_SUBAGENT_PROMPT;
  let tools = leafToolNames(config, opts);
  let model =
    opts.model ?? ctx.record.providerAtLaunch.model ?? config.getModel();

  if (opts.agentType) {
    const custom = config.getAgentRegistry().getDefinition(opts.agentType);
    if (custom && custom.kind === 'local') {
      if (custom.promptConfig.systemPrompt) {
        systemPrompt = `${custom.promptConfig.systemPrompt}\n\n---\nNOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`;
      }
      if (custom.toolConfig) {
        tools = custom.toolConfig.tools.filter(
          (t): t is string => typeof t === 'string',
        );
      }
      if (!opts.model && custom.modelConfig.model)
        model = custom.modelConfig.model;
    }
  }

  const structured = opts.schema
    ? registerStructuredOutput(call.agentId, opts.schema)
    : undefined;
  const leafTools: LocalAgentDefinition['toolConfig'] = {
    tools: opts.schema
      ? [
          ...tools,
          new StructuredOutputTool(
            config.getMessageBus(),
            call.agentId,
            opts.schema,
          ),
        ]
      : tools,
  };
  if (opts.schema) {
    systemPrompt +=
      '\n- After StructuredOutput succeeds, call complete_task with a one-line note.';
  }
  const definition: LocalAgentDefinition = {
    kind: 'local',
    name: `workflow-agent-${call.index}`,
    displayName: call.label || `workflow agent ${call.index}`,
    description: 'Sub-agent spawned by a workflow script.',
    inputConfig: {
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task to complete.' },
        },
        required: ['task'],
      },
    },
    promptConfig: { systemPrompt, query: '${task}' },
    modelConfig: { model },
    runConfig: { maxTurns: 200, maxTimeMinutes: 60 },
    toolConfig: leafTools,
    includeExtensionContext: true,
  };
  config.modelConfigService.registerRuntimeModelConfig(
    getModelConfigAlias(definition),
    {
      modelConfig: definition.modelConfig,
    },
  );

  const transcript = fs.createWriteStream(
    path.join(ctx.agentsDir, `${call.agentId}.jsonl`),
    { flags: 'a' },
  );
  const writeLine = (line: unknown) => {
    try {
      transcript.write(JSON.stringify(line) + '\n');
    } catch {
      /* transcript is best-effort */
    }
  };
  writeLine({
    type: 'user',
    agentId: call.agentId,
    message: { role: 'user', content: call.prompt },
    timestamp: new Date().toISOString(),
  });

  let toolCalls = 0;
  const onActivity = (activity: SubagentActivityEvent) => {
    writeLine({
      type: 'activity',
      agentId: call.agentId,
      activity,
      timestamp: new Date().toISOString(),
    });
    if (activity.type === 'TOOL_CALL_START') {
      toolCalls++;
      const name =
        stringField(activity.data, 'name') ??
        stringField(activity.data, 'toolName') ??
        'tool';
      const args = activity.data['args'] ?? activity.data['input'];
      call.progress({
        model,
        lastToolName: name,
        lastToolSummary: summarizeArgs(args),
        toolCalls,
      });
    }
  };

  call.progress({ model, attempt: 1, usageUnavailable: true });
  try {
    const context = autoAllowContext(
      config,
      `workflow-${ctx.record.runId}-${call.agentId}-${randomUUID().slice(0, 8)}`,
    );
    const executor = await LocalAgentExecutor.create(
      definition,
      context,
      onActivity,
    );
    const output = await executor.run({ task: call.prompt }, call.signal);
    writeLine({
      type: 'result',
      agentId: call.agentId,
      output,
      timestamp: new Date().toISOString(),
    });
    const durationMs = Date.now() - started;
    if (output.terminate_reason === AgentTerminateMode.ABORTED) {
      const reason = abortReason();
      if (reason === 'user-skip')
        return { kind: 'skipped', outcome: { toolCalls, durationMs } };
      return {
        kind: 'failed',
        error: 'Workflow aborted',
        outcome: { toolCalls, durationMs },
      };
    }
    if (output.terminate_reason !== AgentTerminateMode.GOAL) {
      return {
        kind: 'failed',
        error: `sub-agent stopped (${output.terminate_reason}): ${output.result}`,
        outcome: { toolCalls, durationMs },
      };
    }
    return {
      kind: 'ok',
      outcome: {
        value: output.result,
        agentId: call.agentId,
        model,
        tokens: 0,
        toolCalls,
        usageUnavailable: true,
        durationMs,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeLine({
      type: 'error',
      agentId: call.agentId,
      message,
      timestamp: new Date().toISOString(),
    });
    if (call.signal.aborted && abortReason() === 'user-skip') {
      return { kind: 'skipped' };
    }
    return {
      kind: 'failed',
      error: message,
      outcome: { toolCalls, durationMs: Date.now() - started },
    };
  } finally {
    if (structured) releaseStructuredOutput(call.agentId);
    transcript.end();
  }
}

function writeAgentMeta(
  ctx: SubagentRunnerContext,
  call: AgentCall,
  family: WorkflowProviderFamily,
): void {
  try {
    fs.mkdirSync(ctx.agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.agentsDir, `${call.agentId}.meta.json`),
      JSON.stringify({
        agentType: call.opts.agentType ?? 'workflow-subagent',
        spawnDepth: 1,
        provider: family,
        ...(call.opts.model ? { model: call.opts.model } : {}),
      }),
    );
  } catch {
    /* best-effort */
  }
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args.slice(0, 80);
  try {
    const first = isRecord(args)
      ? Object.values(args).find((v) => typeof v === 'string')
      : undefined;
    return typeof first === 'string'
      ? first.slice(0, 80)
      : JSON.stringify(args).slice(0, 80);
  } catch {
    return '';
  }
}

// -------------------------------------------------------------------------
// External leaves (claude -p · codex exec · copilot --acp · agy --print)
// -------------------------------------------------------------------------

/**
 * Providers whose per-spawn state is a shared file (agy's global
 * mcp_config.json, Codex's config.toml marker block) or whose session
 * discovery races under concurrency (agy) run one leaf at a time.
 */
const FAMILY_CONCURRENCY: Partial<Record<WorkflowProviderFamily, number>> = {
  agy: 1,
  codex: 1,
};
const familyInflight = new Map<WorkflowProviderFamily, number>();
const familyQueues = new Map<WorkflowProviderFamily, Array<() => void>>();

async function acquireFamilySlot(
  family: WorkflowProviderFamily,
): Promise<() => void> {
  const limit = FAMILY_CONCURRENCY[family];
  if (!limit) return () => {};
  const inflight = familyInflight.get(family) ?? 0;
  const release = () => {
    familyInflight.set(family, (familyInflight.get(family) ?? 1) - 1);
    const next = familyQueues.get(family)?.shift();
    if (next) next();
  };
  if (inflight < limit) {
    familyInflight.set(family, inflight + 1);
    return release;
  }
  await new Promise<void>((resolve) => {
    const queue = familyQueues.get(family) ?? [];
    queue.push(() => {
      familyInflight.set(family, (familyInflight.get(family) ?? 0) + 1);
      resolve();
    });
    familyQueues.set(family, queue);
  });
  return release;
}

const JSON_FALLBACK_PROMPT =
  'Return ONLY a single JSON object matching this JSON Schema — no code fences, no prose before or after it:';

/** Pull the first JSON object out of a leaf's final text. */
function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

async function runExternalLeaf(
  ctx: SubagentRunnerContext,
  call: AgentCall,
  family: WorkflowProviderFamily,
  abortReason: () => 'user-skip' | 'user-retry' | undefined,
  started: number,
): Promise<SubagentResult> {
  if (family === 'gemini') throw new Error('unreachable');
  const { config } = ctx;
  const opts = call.opts;
  const resolved = resolveLeafModel(
    family,
    opts.model ?? ctx.record.providerAtLaunch.model,
  );
  if (resolved.mappedFrom) {
    ctx.service.registry.addLog(
      ctx.record.runId,
      `[${call.label}] model '${resolved.mappedFrom}' mapped to ${resolved.model} on ${family}`,
    );
  }
  const effort = clampEffort(family, opts.effort);
  const bridge = await config.getAgentSessionManager().getToolBridge();
  const exclude = [...LEAF_EXCLUDED_TOOLS, ...(opts.disallowedTools ?? [])];
  // Schema mode: the bridge serves a StructuredOutput tool with this call's
  // schema; without a bridge the leaf falls back to JSON-in-text.
  const useTool = Boolean(opts.schema && bridge);
  const structured =
    opts.schema && useTool
      ? registerStructuredOutput(call.agentId, opts.schema)
      : undefined;
  const spec: DriverSpec = {
    family,
    interactionStyle: 'headless',
    cwd: config.getWorkingDir(),
    model: resolved.model,
    reasoningEffort: effort,
    toolBridgePort: bridge?.port,
    toolBridgeScript: bridge?.scriptPath,
    toolBridgeExclude: exclude,
    promptFileId: `workflow-${ctx.record.runId}-${call.agentId}`,
    // A Claude leaf must use Auditaria's tools, never Claude Code's own
    // Workflow/Agent orchestration (parity: Claude's leaves lack them too).
    disallowedTools:
      family === 'claude'
        ? [
            ...new Set([
              ...(opts.disallowedTools ?? []),
              'Workflow',
              'Agent',
              'Task',
            ]),
          ]
        : undefined,
    toolBridgeCallId: structured ? call.agentId : undefined,
  };

  const baseContext = config.buildExternalProviderContext();
  const schemaNote =
    opts.schema && !useTool
      ? `\n\n${JSON_FALLBACK_PROMPT}\n${JSON.stringify(opts.schema)}`
      : '';
  const systemContext = [
    opts.schema
      ? useTool
        ? WORKFLOW_SUBAGENT_SCHEMA_PROMPT
        : WORKFLOW_SUBAGENT_JSON_PROMPT
      : WORKFLOW_SUBAGENT_PROMPT,
    baseContext,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const transcript = fs.createWriteStream(
    path.join(ctx.agentsDir, `${call.agentId}.jsonl`),
    { flags: 'a' },
  );
  const writeLine = (line: unknown) => {
    try {
      transcript.write(JSON.stringify(line) + '\n');
    } catch {
      /* best-effort */
    }
  };
  writeLine({
    type: 'user',
    agentId: call.agentId,
    provider: family,
    model: resolved.model,
    message: { role: 'user', content: call.prompt + schemaNote },
    timestamp: new Date().toISOString(),
  });

  const releaseFamily = await acquireFamilySlot(family);
  let driver: ProviderDriver | undefined;
  let toolCalls = 0;
  let outputTokens: number | undefined;
  const text: string[] = [];
  let providerError: string | undefined;
  call.progress({ model: resolved.model ?? `${family}:auto`, attempt: 1 });
  try {
    driver = await (ctx.createDriver ?? createProviderDriver)(spec);
    const events = driver.sendMessage(
      call.prompt + schemaNote,
      call.signal,
      systemContext,
    );
    const consume = async () => {
      for await (const event of events) {
        writeLine({
          type: 'event',
          agentId: call.agentId,
          event,
          timestamp: new Date().toISOString(),
        });
        switch (event.type) {
          case ProviderEventType.Content:
            text.push(event.text);
            break;
          case ProviderEventType.ToolUse:
            toolCalls++;
            call.progress({
              lastToolName: event.toolName,
              lastToolSummary: summarizeArgs(event.input),
              toolCalls,
            });
            break;
          case ProviderEventType.ModelInfo:
            call.progress({ model: event.model });
            break;
          case ProviderEventType.Finished:
            if (event.usage?.outputTokens !== undefined)
              outputTokens = event.usage.outputTokens;
            break;
          case ProviderEventType.Error:
            providerError = event.message;
            break;
          default:
            break;
        }
      }
    };
    const streaming = consume();
    if (structured) {
      // The first valid StructuredOutput call settles the step; the leaf is
      // interrupted so it stops spending tokens on acknowledgements.
      const winner = await Promise.race([
        structured.captured.then(() => 'structured' as const),
        streaming.then(() => 'stream' as const),
      ]);
      if (winner === 'structured') {
        await driver.interrupt().catch(() => undefined);
        await streaming.catch(() => undefined);
      }
    } else {
      await streaming;
    }
  } catch (e) {
    providerError = e instanceof Error ? e.message : String(e);
  } finally {
    if (structured) releaseStructuredOutput(call.agentId);
    releaseFamily();
    try {
      driver?.dispose();
    } catch {
      /* ignore */
    }
    transcript.end();
  }

  const durationMs = Date.now() - started;
  const partial = {
    toolCalls,
    durationMs,
    ...(outputTokens !== undefined ? { tokens: outputTokens } : {}),
  };
  if (call.signal.aborted) {
    if (abortReason() === 'user-skip')
      return { kind: 'skipped', outcome: partial };
    return { kind: 'failed', error: 'Workflow aborted', outcome: partial };
  }
  const finalText = text.join('').trim();
  if (providerError && !finalText) {
    return { kind: 'failed', error: providerError, outcome: partial };
  }

  let value: unknown = finalText;
  if (structured) {
    value = settleStructured(structured.entry, finalText);
  } else if (opts.schema) {
    const parsed = extractJson(finalText);
    const validate = ajv.compile(opts.schema);
    if (parsed === undefined || !validate(parsed)) {
      const detail =
        parsed === undefined
          ? 'the final text was not JSON'
          : ajv.errorsText(validate.errors);
      throw new Error(
        `agent({schema}): subagent completed without a valid structured output (${detail}). Final text: ${finalText.slice(0, 300)}`,
      );
    }
    value = parsed;
  }
  return {
    kind: 'ok',
    outcome: {
      value,
      agentId: call.agentId,
      model: resolved.model,
      tokens: outputTokens ?? 0,
      toolCalls,
      usageUnavailable: outputTokens === undefined,
      durationMs,
    },
  };
}

export const WORKFLOW_SUBAGENT_JSON_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is parsed by the calling script as JSON — it is your return value, not a message to a human.
- Do your work (read files, run commands, search), then answer with ONE JSON object that matches the schema given in the task.
- Output ONLY the raw JSON — no code fences, no prose before or after it, no markdown.
- If you cannot complete the task, still return a JSON object of the requested shape with your best answer.`;

/** Retry cap for invalid StructuredOutput submissions (Claude's default is 5). */
export function structuredOutputRetryCap(): number {
  const raw = Number(process.env['MAX_STRUCTURED_OUTPUT_RETRIES']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/**
 * Resolve a schema-mode leaf's value from the registry entry: the captured
 * object, else the JSON-in-text fallback, else the parity errors.
 */
function settleStructured(
  entry: StructuredOutputEntry,
  finalText: string,
): unknown {
  if (entry.value !== undefined) return entry.value;
  const cap = structuredOutputRetryCap();
  if (entry.failures >= cap) {
    throw new Error(
      `agent({schema}): StructuredOutput retry cap (${cap}) exceeded — ${entry.failures} failed call(s) with no valid output${entry.lastError ? ` — last StructuredOutput error: ${entry.lastError}` : ''}`,
    );
  }
  const parsed = extractJson(finalText);
  if (parsed !== undefined && entry.validate(parsed)) return parsed;
  throw new Error(
    'agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)',
  );
}
