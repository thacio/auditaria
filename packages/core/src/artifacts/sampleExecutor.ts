/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { SessionProviderType } from '../providers/agent-session-manager.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../config/models.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { getResponseText } from '../utils/partUtils.js';

/**
 * The `sample` capability's engine: one headless, tool-less, memory-less
 * model call through whatever provider the session runs on. It never
 * touches the chat session — a page asking the model must not pollute the
 * user's conversation — and it never gives the page tools.
 */

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_ANSWER_CHARS = 32 * 1024;

export type ModelTier = 'quick' | 'default' | 'complex';

export interface SampleTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface SampleRequest {
  /**
   * A string, or turns starting and ending on `user` (see {@link SampleTurn});
   * validated by the sampler, so callers may pass the page's raw value.
   */
  readonly input: unknown;
  readonly modelTier?: ModelTier;
  readonly signal: AbortSignal;
  /** Called with the whole answer so far, at least once before resolving. */
  readonly onText?: (text: string, delta: string) => void;
}

export interface SampleResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly modelTierApplied: ModelTier;
}

export class SampleError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'prompt_too_large'
      | 'cancelled'
      | 'sampling_disabled'
      | 'empty_completion'
      | 'upstream_error',
    message: string,
    readonly text?: string,
  ) {
    super(message);
    this.name = 'SampleError';
  }
}

export type Sampler = (request: SampleRequest) => Promise<SampleResult>;

const SYSTEM_INSTRUCTION =
  'You are answering a request from an interactive page the user is viewing. ' +
  'Reply with exactly what the page asked for, in the format it asked for, and nothing else: ' +
  'no preamble, no commentary. You have no tools and no memory of earlier calls.';

/** Validates the page's `input` and turns it into model contents. */
export function toContents(input: unknown): Content[] {
  if (typeof input === 'string') {
    if (!input.trim()) {
      throw new SampleError('invalid_request', 'input must not be empty');
    }
    assertSize(input);
    return [{ role: 'user', parts: [{ text: input }] }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new SampleError(
      'invalid_request',
      'input must be a string or an array of {role, content} turns',
    );
  }
  const turns: unknown[] = input;
  const contents: Content[] = [];
  let total = 0;
  for (const [index, turn] of turns.entries()) {
    if (
      typeof turn !== 'object' ||
      turn === null ||
      !('role' in turn) ||
      !('content' in turn)
    ) {
      throw new SampleError(
        'invalid_request',
        `turn ${index} needs role and content`,
      );
    }
    const role = turn.role;
    const content = turn.content;
    if (
      (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string'
    ) {
      throw new SampleError(
        'invalid_request',
        `turn ${index}: role must be "user" or "assistant" and content a string`,
      );
    }
    total += Buffer.byteLength(content, 'utf-8');
    contents.push({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    });
  }
  if (
    contents[0].role !== 'user' ||
    contents[contents.length - 1].role !== 'user'
  ) {
    throw new SampleError(
      'invalid_request',
      'turns must start and end with a user turn',
    );
  }
  if (total > MAX_PROMPT_BYTES) {
    throw new SampleError(
      'prompt_too_large',
      `input is ${total} bytes; at most ${MAX_PROMPT_BYTES} are allowed`,
    );
  }
  return contents;
}

function assertSize(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > MAX_PROMPT_BYTES) {
    throw new SampleError(
      'prompt_too_large',
      `input is ${bytes} bytes; at most ${MAX_PROMPT_BYTES} are allowed`,
    );
  }
}

/** The Gemini model for a tier: quick = flash, default = the session's, complex = pro. */
export function geminiModelFor(tier: ModelTier, sessionModel: string): string {
  switch (tier) {
    case 'quick':
      return DEFAULT_GEMINI_FLASH_MODEL;
    case 'complex':
      return DEFAULT_GEMINI_MODEL;
    default:
      return sessionModel;
  }
}

/** Turns the turns back into one prompt for providers that take text. */
export function flattenTurns(contents: readonly Content[]): string {
  if (contents.length === 1) {
    return contents[0].parts?.map((p) => p.text ?? '').join('') ?? '';
  }
  return contents
    .map((c) => {
      const text = c.parts?.map((p) => p.text ?? '').join('') ?? '';
      return `${c.role === 'model' ? 'Assistant' : 'User'}: ${text}`;
    })
    .join('\n\n');
}

const SESSION_PROVIDERS: ReadonlySet<string> = new Set<SessionProviderType>([
  'claude-cli',
  'codex-cli',
  'copilot-cli',
  'agy-cli',
  'auditaria-cli',
]);

function isSessionProvider(value: string): value is SessionProviderType {
  return SESSION_PROVIDERS.has(value);
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

/** Builds the sampler for a Config: Gemini directly, other providers headless. */
export function createSampler(config: Config): Sampler {
  return async (request) => {
    if (process.env['AUDITARIA_ARTIFACT_SAMPLE'] === '0') {
      throw new SampleError(
        'sampling_disabled',
        'pages may not ask the model on this host (AUDITARIA_ARTIFACT_SAMPLE=0)',
      );
    }
    const contents = toContents(request.input);
    const tier: ModelTier = request.modelTier ?? 'default';
    if (request.signal.aborted) {
      throw new SampleError('cancelled', 'cancelled before it started');
    }
    const external = config.getProviderManager()?.isExternalProviderActive();
    return external
      ? sampleThroughProvider(config, contents, tier, request)
      : sampleThroughGemini(config, contents, tier, request);
  };
}

async function sampleThroughGemini(
  config: Config,
  contents: Content[],
  tier: ModelTier,
  request: SampleRequest,
): Promise<SampleResult> {
  const model = geminiModelFor(tier, config.getModel());
  let text = '';
  let delivered = false;
  try {
    const stream = await config.getContentGenerator().generateContentStream(
      {
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          abortSignal: request.signal,
        },
      },
      `artifact-sample-${Date.now().toString(36)}`,
      LlmRole.UTILITY_TOOL,
    );
    for await (const chunk of stream) {
      if (request.signal.aborted) {
        throw new SampleError('cancelled', 'cancelled by the page', text);
      }
      const delta = getResponseText(chunk) ?? '';
      if (!delta) continue;
      text += delta;
      delivered = true;
      request.onText?.(text, delta);
      if (text.length >= MAX_ANSWER_CHARS) break;
    }
  } catch (error) {
    if (error instanceof SampleError) throw error;
    if (isAbort(error) || request.signal.aborted) {
      throw new SampleError('cancelled', 'cancelled by the page', text);
    }
    throw new SampleError(
      'upstream_error',
      error instanceof Error ? error.message : String(error),
      text || undefined,
    );
  }
  return finish(text, delivered, tier, request);
}

async function sampleThroughProvider(
  config: Config,
  contents: Content[],
  tier: ModelTier,
  request: SampleRequest,
): Promise<SampleResult> {
  const providerType = config.getProviderManager()?.getConfig().type;
  if (!providerType || providerType === 'gemini') {
    return sampleThroughGemini(config, contents, tier, request);
  }
  if (!isSessionProvider(providerType)) {
    throw new SampleError(
      'sampling_disabled',
      `pages cannot ask the model through the ${providerType} provider on this host`,
    );
  }
  const sessions = config.getAgentSessionManager();
  let sessionId: string | null = null;
  let text = '';
  let delivered = false;
  try {
    const session = await sessions.createSession({
      provider: providerType,
      mode: 'consult',
      allowSubAgents: false,
      systemContext: SYSTEM_INSTRUCTION,
    });
    sessionId = session.id;
    text = await sessions.sendMessage(
      sessionId,
      flattenTurns(contents),
      request.signal,
      (partial) => {
        if (partial && partial !== text) {
          const delta = partial.startsWith(text)
            ? partial.slice(text.length)
            : partial;
          text = partial;
          delivered = true;
          request.onText?.(text, delta);
        }
      },
    );
  } catch (error) {
    if (isAbort(error) || request.signal.aborted) {
      throw new SampleError('cancelled', 'cancelled by the page', text);
    }
    throw new SampleError(
      'upstream_error',
      error instanceof Error ? error.message : String(error),
      text || undefined,
    );
  } finally {
    if (sessionId) {
      try {
        sessions.killSession(sessionId);
      } catch {
        /* already gone */
      }
    }
  }
  // The session manager reports a driver failure as a bracketed message
  // in place of an answer; a page must never receive that as text.
  if (/^\s*\[Error:/i.test(text)) {
    throw new SampleError('upstream_error', text.trim());
  }
  // Headless providers answer in one piece; the tier is whatever the
  // session runs on.
  return finish(text, delivered, 'default', request);
}

function finish(
  text: string,
  delivered: boolean,
  tier: ModelTier,
  request: SampleRequest,
): SampleResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new SampleError('empty_completion', 'the model returned nothing');
  }
  const truncated = trimmed.length > MAX_ANSWER_CHARS;
  const finalText = truncated ? trimmed.slice(0, MAX_ANSWER_CHARS) : trimmed;
  // The contract: onText fires at least once, and its last call equals
  // the result.
  if (!delivered || finalText !== text) {
    request.onText?.(finalText, delivered ? '' : finalText);
  }
  return { text: finalText, truncated, modelTierApplied: tier };
}
