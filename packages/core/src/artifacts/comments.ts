/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { appendJsonl, readJsonl } from './journal.js';

/**
 * Comment threads on an artifact, after Claude Code's model: viewers
 * leave threads on the page; a thread reaches the agent only once a
 * writer activates it ("Send to agent", or an @agent/@claude mention);
 * the agent may reply to or resolve activated threads only; a resolved
 * thread stays resolved until a person reopens it.
 *
 * One append-only journal per artifact (`comments.jsonl`), replayed into
 * memory. Every line is an event; the thread is the fold of its events.
 */

export type CommentAuthor = 'user' | 'agent';

export interface CommentMessage {
  readonly id: string;
  readonly at: string;
  readonly author: CommentAuthor;
  readonly text: string;
  /** A user message that asked the agent to look ("Send to agent"). */
  readonly sentToAgent: boolean;
}

export interface CommentAnchor {
  /** Quoted page text the thread refers to, when the viewer selected some. */
  readonly text?: string;
}

export interface CommentThread {
  readonly id: string;
  readonly createdAt: string;
  /** The artifact version the thread was opened on. */
  readonly version: number;
  readonly anchor: CommentAnchor | null;
  readonly activated: boolean;
  readonly activatedAt: string | null;
  readonly resolved: boolean;
  readonly resolvedAt: string | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly messages: readonly CommentMessage[];
}

export type CommentEvent =
  | {
      readonly op: 'thread';
      readonly id: string;
      readonly at: string;
      readonly version: number;
      readonly anchor: CommentAnchor | null;
      readonly message: CommentMessage;
    }
  | {
      readonly op: 'message';
      readonly threadId: string;
      readonly message: CommentMessage;
    }
  | { readonly op: 'activate'; readonly threadId: string; readonly at: string }
  | {
      readonly op: 'resolve';
      readonly threadId: string;
      readonly at: string;
      readonly by: CommentAuthor;
    }
  | { readonly op: 'reopen'; readonly threadId: string; readonly at: string };

export interface CommentStoreEvents {
  change: [thread: CommentThread];
  /** A thread became activated (the agent should hear about it). */
  activated: [thread: CommentThread];
}

/** Reply/comment text limit, as the Claude tool enforces (UTF-8 bytes). */
export const MAX_COMMENT_BYTES = 4096;

const MENTION_RE = /(^|\s)@(claude|agent)\b/i;

export class CommentError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_argument'
      | 'not_activated'
      | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'CommentError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

function validateText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new CommentError('invalid_argument', 'comment text is required');
  }
  if (Buffer.byteLength(text, 'utf-8') > MAX_COMMENT_BYTES) {
    throw new CommentError(
      'invalid_argument',
      `comment text must be at most ${MAX_COMMENT_BYTES} bytes of UTF-8`,
    );
  }
  return text;
}

/**
 * Whether the agent still owes a reply: a user message sent to the agent
 * with no agent message after it.
 */
export function needsAgentReply(thread: CommentThread): boolean {
  let owed = false;
  for (const message of thread.messages) {
    if (message.author === 'agent') owed = false;
    else if (message.sentToAgent) owed = true;
  }
  return owed;
}

export class CommentStore extends EventEmitter<CommentStoreEvents> {
  private readonly threads = new Map<string, CommentThread>();
  private loaded: Promise<void> | null = null;

  constructor(readonly file: string) {
    super();
  }

  async load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const event of await readJsonl<CommentEvent>(this.file)) {
        this.apply(event);
      }
    })();
    return this.loaded;
  }

  private apply(event: CommentEvent): CommentThread | null {
    switch (event.op) {
      case 'thread': {
        const thread: CommentThread = {
          id: event.id,
          createdAt: event.at,
          version: event.version,
          anchor: event.anchor,
          activated: event.message.sentToAgent,
          activatedAt: event.message.sentToAgent ? event.at : null,
          resolved: false,
          resolvedAt: null,
          resolvedBy: null,
          messages: [event.message],
        };
        this.threads.set(thread.id, thread);
        return thread;
      }
      case 'message': {
        const thread = this.threads.get(event.threadId);
        if (!thread) return null;
        const activates = event.message.sentToAgent && !thread.activated;
        const next: CommentThread = {
          ...thread,
          activated: thread.activated || event.message.sentToAgent,
          activatedAt: activates ? event.message.at : thread.activatedAt,
          messages: [...thread.messages, event.message],
        };
        this.threads.set(next.id, next);
        return next;
      }
      case 'activate': {
        const thread = this.threads.get(event.threadId);
        if (!thread) return null;
        const next: CommentThread = {
          ...thread,
          activated: true,
          activatedAt: thread.activatedAt ?? event.at,
        };
        this.threads.set(next.id, next);
        return next;
      }
      case 'resolve': {
        const thread = this.threads.get(event.threadId);
        if (!thread) return null;
        const next: CommentThread = {
          ...thread,
          resolved: true,
          resolvedAt: event.at,
          resolvedBy: event.by,
        };
        this.threads.set(next.id, next);
        return next;
      }
      case 'reopen': {
        const thread = this.threads.get(event.threadId);
        if (!thread) return null;
        const next: CommentThread = {
          ...thread,
          resolved: false,
          resolvedAt: null,
          resolvedBy: null,
        };
        this.threads.set(next.id, next);
        return next;
      }
      default:
        return null;
    }
  }

  private async commit(event: CommentEvent): Promise<CommentThread> {
    await appendJsonl(this.file, event);
    const thread = this.apply(event);
    if (!thread) {
      throw new CommentError('not_found', 'no such thread');
    }
    this.emit('change', thread);
    return thread;
  }

  /** Open threads first, newest first; resolved after. */
  list(): CommentThread[] {
    return Array.from(this.threads.values()).sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  get(id: string): CommentThread | null {
    return this.threads.get(id) ?? null;
  }

  require(id: string): CommentThread {
    const thread = this.threads.get(id);
    if (!thread) throw new CommentError('not_found', `no thread ${id}`);
    return thread;
  }

  /** A viewer opens a thread; a mention or `sendToAgent` activates it. */
  async create(input: {
    version: number;
    author: CommentAuthor;
    text: string;
    anchor?: CommentAnchor | null;
    sendToAgent?: boolean;
  }): Promise<CommentThread> {
    const text = validateText(input.text);
    const at = nowIso();
    const sentToAgent =
      input.author === 'user' &&
      (input.sendToAgent === true || MENTION_RE.test(text));
    const thread = await this.commit({
      op: 'thread',
      id: newId('th'),
      at,
      version: input.version,
      anchor: input.anchor ?? null,
      message: { id: newId('m'), at, author: input.author, text, sentToAgent },
    });
    if (thread.activated) this.emit('activated', thread);
    return thread;
  }

  /**
   * Adds a message. The agent may reply only on an activated thread; an
   * agent reply that answers nothing new needs `acknowledgeDuplicate`.
   */
  async reply(
    threadId: string,
    input: {
      author: CommentAuthor;
      text: string;
      sendToAgent?: boolean;
      acknowledgeDuplicate?: boolean;
    },
  ): Promise<CommentThread> {
    const thread = this.require(threadId);
    const text = validateText(input.text);
    if (input.author === 'agent') {
      if (!thread.activated) {
        throw new CommentError(
          'not_activated',
          'this thread has not been sent to the agent; ask the user to send it (Send to agent) rather than retrying',
        );
      }
      if (!needsAgentReply(thread) && !input.acknowledgeDuplicate) {
        throw new CommentError(
          'duplicate',
          'an agent reply already stands after every request on this thread; pass acknowledge_duplicate:true only for a deliberate follow-up that adds something new',
        );
      }
    }
    const wasActivated = thread.activated;
    const sentToAgent =
      input.author === 'user' &&
      (input.sendToAgent === true || MENTION_RE.test(text));
    const next = await this.commit({
      op: 'message',
      threadId,
      message: {
        id: newId('m'),
        at: nowIso(),
        author: input.author,
        text,
        sentToAgent,
      },
    });
    if (!wasActivated && next.activated) this.emit('activated', next);
    return next;
  }

  /** A person sends the thread to the agent without adding text. */
  async activate(threadId: string): Promise<CommentThread> {
    const thread = this.require(threadId);
    if (thread.activated) return thread;
    const next = await this.commit({
      op: 'activate',
      threadId,
      at: nowIso(),
    });
    this.emit('activated', next);
    return next;
  }

  /** The agent may resolve activated threads only; a person any thread. */
  async resolve(threadId: string, by: CommentAuthor): Promise<CommentThread> {
    const thread = this.require(threadId);
    if (by === 'agent' && !thread.activated) {
      throw new CommentError(
        'not_activated',
        'only threads sent to the agent can be resolved by it',
      );
    }
    if (thread.resolved) return thread;
    return this.commit({ op: 'resolve', threadId, at: nowIso(), by });
  }

  async reopen(threadId: string): Promise<CommentThread> {
    const thread = this.require(threadId);
    if (!thread.resolved) return thread;
    return this.commit({ op: 'reopen', threadId, at: nowIso() });
  }
}
