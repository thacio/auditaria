/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: ContentGenerator that routes to any OpenAI-compatible API
// This enables full agent capabilities (tools, file editing, context management)
// with any OpenAI-compatible LLM endpoint.

import {
  GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
  type Part,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
} from '@google/genai';
import type { ContentGenerator } from '../../core/contentGenerator.js';
import type { UserTierId, GeminiUserTier } from '../../code_assist/types.js';
import type { LlmRole } from '../../telemetry/llmRole.js';
import type { OpenAICompatDriverConfig, OpenAISSEChunk } from './types.js';
import { MAX_RETRIES } from './types.js';

// ---------------------------------------------------------------------------
// Gemini → OpenAI format translation
// ---------------------------------------------------------------------------

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function geminiContentsToOpenAIMessages(
  contents: Content[],
  systemInstruction?: string,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';

    if (!content.parts || content.parts.length === 0) continue;

    // Check for function calls (model response with tool calls)
    const functionCalls = content.parts.filter(
      (p) => p.functionCall?.name,
    );
    const functionResponses = content.parts.filter(
      (p) => p.functionResponse?.name,
    );

    if (functionCalls.length > 0) {
      // Model made tool calls
      const textParts = content.parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text || '')
        .join('');

      messages.push({
        role: 'assistant',
        content: textParts || null,
        tool_calls: functionCalls.map((p) => ({
          id: p.functionCall!.id || `call_${p.functionCall!.name}`,
          type: 'function' as const,
          function: {
            name: p.functionCall!.name!,
            arguments: JSON.stringify(p.functionCall!.args || {}),
          },
        })),
      });
    } else if (functionResponses.length > 0) {
      // User providing tool results
      for (const p of functionResponses) {
        messages.push({
          role: 'tool',
          tool_call_id:
            p.functionResponse!.id ||
            `call_${p.functionResponse!.name}`,
          content: typeof p.functionResponse!.response === 'string'
            ? p.functionResponse!.response
            : JSON.stringify(p.functionResponse!.response),
        });
      }
    } else {
      // Regular text message
      // Check for inline images (Gemini inlineData → OpenAI image_url)
      const textParts = content.parts.filter((p) => p.text && !p.thought);
      const imageParts = content.parts.filter((p) => p.inlineData?.data);

      if (imageParts.length > 0) {
        const contentParts: OpenAIContentPart[] = [];
        for (const p of textParts) {
          contentParts.push({ type: 'text', text: p.text || '' });
        }
        for (const p of imageParts) {
          const mime = p.inlineData!.mimeType || 'image/png';
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${p.inlineData!.data}` },
          });
        }
        if (contentParts.length > 0) {
          messages.push({ role, content: contentParts });
        }
      } else {
        const text = textParts.map((p) => p.text || '').join('');
        if (text) {
          messages.push({ role, content: text });
        }
      }
    }
  }

  return messages;
}

function geminiFunctionDeclsToOpenAITools(
  tools?: unknown[],
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const openaiTools: OpenAITool[] = [];
  for (const tool of tools) {
    const t = tool as { functionDeclarations?: FunctionDeclaration[] };
    if (!t.functionDeclarations) continue;
    for (const fn of t.functionDeclarations) {
      openaiTools.push({
        type: 'function',
        function: {
          name: fn.name || '',
          description: fn.description,
          parameters: fn.parameters as Record<string, unknown>,
        },
      });
    }
  }

  return openaiTools.length > 0 ? openaiTools : undefined;
}

// ---------------------------------------------------------------------------
// OpenAI → Gemini format translation
// ---------------------------------------------------------------------------

interface OpenAINonStreamResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function openaiResponseToGemini(
  data: OpenAINonStreamResponse,
): GenerateContentResponse {
  const choice = data.choices?.[0];
  const parts: Part[] = [];

  if (choice?.message?.content) {
    parts.push({ text: choice.message.content });
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch { /* malformed args */ }

      parts.push({
        functionCall: {
          id: tc.id,
          name: tc.function.name,
          args,
        },
      });
    }
  }

  const usageMetadata: GenerateContentResponseUsageMetadata = {
    promptTokenCount: data.usage?.prompt_tokens,
    candidatesTokenCount: data.usage?.completion_tokens,
    totalTokenCount: data.usage?.total_tokens,
  };

  return makeGeminiResponse(
    parts,
    usageMetadata,
    choice?.finish_reason === 'tool_calls' ? 'TOOL_CALLS' : 'STOP',
  );
}

// ---------------------------------------------------------------------------
// Helper to create proper GenerateContentResponse instances with getters
// ---------------------------------------------------------------------------

function makeGeminiResponse(
  parts: Part[],
  usageMetadata?: GenerateContentResponseUsageMetadata,
  finishReason?: string,
): GenerateContentResponse {
  const resp = new GenerateContentResponse();
  if (parts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Candidate construction
    resp.candidates = [{
      content: { role: 'model', parts },
      ...(finishReason && { finishReason }),
    }] as unknown as import('@google/genai').Candidate[];
  }
  resp.usageMetadata = usageMetadata;
  return resp;
}

// ---------------------------------------------------------------------------
// ContentGenerator implementation
// ---------------------------------------------------------------------------

/**
 * A ContentGenerator that routes Gemini-format requests to any OpenAI-compatible
 * API endpoint. This enables Gemini's full agent pipeline (tools, scheduler,
 * hooks, context management) to work with any OpenAI-compatible LLM.
 */
export class OpenAICompatContentGenerator implements ContentGenerator {
  userTier?: UserTierId;
  userTierName?: string;
  paidTier?: GeminiUserTier;

  constructor(private readonly config: OpenAICompatDriverConfig) {}

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const { messages, tools } = this.translateRequest(request);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
    };
    if (tools) body.tools = tools;

    const response = await this.fetchWithRetry(
      `${this.config.baseUrl}${this.config.completionsPath}`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.config?.abortSignal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `${this.config.providerName} API error ${response.status}: ${errorText}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenAI response
    const data = (await response.json()) as OpenAINonStreamResponse;
    return openaiResponseToGemini(data);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const { messages, tools } = this.translateRequest(request);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }, // Request usage in final chunk
    };
    if (tools) body.tools = tools;

    const response = await this.fetchWithRetry(
      `${this.config.baseUrl}${this.config.completionsPath}`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.config?.abortSignal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `${this.config.providerName} API error ${response.status}: ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const config = this.config;
    return this.streamSSEToGemini(response.body, request.config?.abortSignal);
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // OpenAI doesn't have a separate token counting endpoint
    // Return estimate based on character count
    return { totalTokens: 0 };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Embeddings not supported for OpenAI-compatible providers');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private translateRequest(request: GenerateContentParameters): {
    messages: OpenAIMessage[];
    tools: OpenAITool[] | undefined;
  } {
    // Extract system instruction
    let systemInstruction: string | undefined;
    const sysInstr = request.config?.systemInstruction;
    if (sysInstr) {
      if (typeof sysInstr === 'string') {
        systemInstruction = sysInstr;
      } else if (Array.isArray(sysInstr)) {
        // ContentUnion can be string | Part | Content | array
        systemInstruction = sysInstr
          .map((p) => {
            if (typeof p === 'string') return p;
            if ('text' in p) return (p as Part).text || '';
            return '';
          })
          .join('\n');
      } else if (typeof sysInstr === 'object' && 'parts' in sysInstr) {
        systemInstruction = ((sysInstr as Content).parts || [])
          .map((p) => p.text || '')
          .join('\n');
      }
    }

    // Convert contents
    const contents = Array.isArray(request.contents)
      ? request.contents
      : typeof request.contents === 'string'
        ? [{ role: 'user', parts: [{ text: request.contents }] }]
        : [request.contents as Content];

    const messages = geminiContentsToOpenAIMessages(
      contents as Content[],
      systemInstruction,
    );

    // Convert tools
    const tools = geminiFunctionDeclsToOpenAITools(
      request.config?.tools,
    );

    return { messages, tools };
  }

  private async *streamSSEToGemini(
    body: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track accumulated tool calls across chunks
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      while (true) {
        if (abortSignal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          let data: string;
          if (trimmed.startsWith('data: ')) {
            data = trimmed.slice(6);
          } else if (trimmed.startsWith('data:')) {
            data = trimmed.slice(5);
          } else {
            continue;
          }

          if (data.trim() === '[DONE]') return;

          let chunk: OpenAISSEChunk;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenAI SSE
            chunk = JSON.parse(data) as OpenAISSEChunk;
          } catch {
            continue;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta && !chunk.usage) continue;

          const parts: Part[] = [];

          // Text content
          if (delta?.content) {
            parts.push({ text: delta.content });
          }

          // Reasoning/thinking content
          if (delta?.reasoning_content) {
            parts.push({ text: delta.reasoning_content, thought: true });
          }

          // Tool calls (streamed incrementally)
          const deltaToolCalls = (delta as Record<string, unknown>)
            ?.tool_calls as
            | Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;

          if (deltaToolCalls) {
            for (const tc of deltaToolCalls) {
              const existing = pendingToolCalls.get(tc.index);
              if (existing) {
                // Append to existing tool call
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                // New tool call
                pendingToolCalls.set(tc.index, {
                  id: tc.id || `call_${tc.index}`,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                });
              }
            }
          }

          // Emit tool calls when finish_reason is tool_calls or stop
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (
            finishReason === 'tool_calls' &&
            pendingToolCalls.size > 0
          ) {
            for (const [, tc] of pendingToolCalls) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.arguments) as Record<string, unknown>;
              } catch { /* malformed */ }

              parts.push({
                functionCall: {
                  id: tc.id,
                  name: tc.name,
                  args,
                },
              });
            }
            pendingToolCalls.clear();
          }

          if (parts.length === 0 && !chunk.usage) continue;

          const usageMetadata: GenerateContentResponseUsageMetadata | undefined =
            chunk.usage
              ? {
                  promptTokenCount: chunk.usage.prompt_tokens,
                  candidatesTokenCount: chunk.usage.completion_tokens,
                  totalTokenCount: chunk.usage.total_tokens,
                }
              : undefined;

          yield makeGeminiResponse(parts, usageMetadata);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (this.config.auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${this.config.auth.token}`;
        break;
      case 'header':
        headers[this.config.auth.name] = this.config.auth.value;
        break;
      case 'none':
        break;
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, options);

        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : 1000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt)),
          );
          continue;
        }

        return response;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (
          options.signal &&
          (options.signal as AbortSignal).aborted
        ) {
          throw lastError;
        }
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt)),
          );
        }
      }
    }

    throw lastError || new Error(`Failed after ${MAX_RETRIES} attempts`);
  }
}
