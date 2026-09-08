/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The `StructuredOutput` tool — how a schema-mode agent()
// hands its answer back, exactly like Claude Code's internal mechanism (a
// forced tool call, validated at the tool layer so the model retries on a
// mismatch). One call = one schema:
//   - external leaves reach it over the MCP bridge; the bridge is spawned with
//     `--call-id <id>` and the executor serves THIS call's schema for the
//     tool (and omits the tool entirely when no schema is registered);
//   - Gemini leaves get a per-leaf instance registered in their own tool set.
// The registry below correlates a call id with its schema and the runner's
// resolver.

import AjvPkg, { type Ajv, type ValidateFunction } from 'ajv';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '../tools/tools.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/tool-names.js';
import { isRecord, stringField } from './guards.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-assignment
const AjvClass = (AjvPkg as any).default || AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const ajv: Ajv = new AjvClass({
  allErrors: true,
  validateFormats: false,
  strict: false,
});

export const STRUCTURED_OUTPUT_OK = 'Structured output provided successfully';

/** The hidden parameter the bridge executor injects so a call finds its entry. */
export const CALL_ID_PARAM = '__callId';

export interface StructuredOutputEntry {
  schema: Record<string, unknown>;
  validate: ValidateFunction;
  /** Failed (invalid) submissions so far. */
  failures: number;
  /** First valid value, once captured. */
  value?: unknown;
  lastError?: string;
  onCaptured: (value: unknown) => void;
}

const registry = new Map<string, StructuredOutputEntry>();

/** Register the schema for one call; returns a promise that resolves on the first valid submission. */
export function registerStructuredOutput(
  callId: string,
  schema: Record<string, unknown>,
): { captured: Promise<unknown>; entry: StructuredOutputEntry } {
  let onCaptured: (value: unknown) => void = () => {};
  const captured = new Promise<unknown>((resolve) => {
    onCaptured = resolve;
  });
  const entry: StructuredOutputEntry = {
    schema,
    validate: ajv.compile(schema),
    failures: 0,
    onCaptured,
  };
  registry.set(callId, entry);
  return { captured, entry };
}

export function releaseStructuredOutput(callId: string): void {
  registry.delete(callId);
}

export function structuredOutputSchemaFor(
  callId: string,
): Record<string, unknown> | undefined {
  return registry.get(callId)?.schema;
}

export function structuredOutputEntryFor(
  callId: string,
): StructuredOutputEntry | undefined {
  return registry.get(callId);
}

/**
 * Validate and record one submission for `callId`. Returns the tool result
 * text and whether it is an error (the model reads the error and retries).
 */
export function submitStructuredOutput(
  callId: string,
  params: Record<string, unknown>,
): { text: string; isError: boolean } {
  const entry = registry.get(callId);
  if (!entry) {
    return {
      text: 'StructuredOutput: no schema is registered for this call (the workflow step has already settled).',
      isError: true,
    };
  }
  const { [CALL_ID_PARAM]: _ignored, ...value } = params;
  if (!entry.validate(value)) {
    entry.failures++;
    entry.lastError = ajv.errorsText(entry.validate.errors);
    return {
      text: `Output does not match required schema: ${entry.lastError}. Read the error and call StructuredOutput again with a corrected shape.`,
      isError: true,
    };
  }
  if (entry.value === undefined) {
    entry.value = value;
    entry.onCaptured(value);
  }
  return { text: STRUCTURED_OUTPUT_OK, isError: false };
}

/** Bridge-facing schema: the call's own schema plus the hidden call-id field. */
export function bridgeSchemaFor(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  return {
    ...schema,
    properties: {
      ...properties,
      [CALL_ID_PARAM]: {
        type: 'string',
        description:
          'Internal correlation id — leave it out, the bridge fills it in.',
      },
    },
  };
}

class StructuredOutputInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    params: Record<string, unknown>,
    messageBus: MessageBus,
    private readonly fixedCallId: string | undefined,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const keys = Object.keys(this.params).filter((k) => k !== CALL_ID_PARAM);
    return `Structured output (${keys.join(', ') || 'empty'})`;
  }

  async execute(): Promise<ToolResult> {
    const callId = this.fixedCallId ?? stringField(this.params, CALL_ID_PARAM);
    if (!callId) {
      const text =
        'StructuredOutput: this tool is only available inside a workflow agent() call with a schema.';
      return {
        llmContent: text,
        returnDisplay: text,
        error: { message: text },
      };
    }
    const { text, isError } = submitStructuredOutput(callId, this.params);
    return isError
      ? { llmContent: text, returnDisplay: text, error: { message: text } }
      : { llmContent: text, returnDisplay: text };
  }
}

/**
 * The tool. The registry-backed instance (`callId` undefined) is registered
 * once in the session's ToolRegistry and only ever reached over the bridge,
 * which injects `__callId`; per-leaf instances (Gemini) carry a fixed call id
 * and the call's own schema.
 */
export class StructuredOutputTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  static readonly Name = STRUCTURED_OUTPUT_TOOL_NAME;
  static readonly Bridgeable = true;

  constructor(
    messageBus: MessageBus,
    private readonly fixedCallId?: string,
    schema?: Record<string, unknown>,
  ) {
    super(
      StructuredOutputTool.Name,
      'StructuredOutput',
      'Return your final answer for the current workflow step. Call it exactly once with an object matching the input schema; if validation fails, read the error and call it again with a corrected shape. After it succeeds, end your turn.',
      Kind.Other,
      schema
        ? schema
        : {
            type: 'object',
            properties: {
              [CALL_ID_PARAM]: { type: 'string' },
            },
            additionalProperties: true,
          },
      messageBus,
      false,
      false,
    );
  }

  /** Per-leaf instances validate against their own schema; the bridge instance validates in execute(). */
  protected override validateToolParamValues(): string | null {
    return null;
  }

  protected createInvocation(
    params: Record<string, unknown>,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new StructuredOutputInvocation(
      params,
      messageBus,
      this.fixedCallId,
      toolName,
      toolDisplayName,
    );
  }
}
