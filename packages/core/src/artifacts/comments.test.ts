/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentStore, needsAgentReply } from './comments.js';

describe('CommentStore', () => {
  let dir: string;
  let store: CommentStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifact-comments-'));
    store = new CommentStore(path.join(dir, 'comments.jsonl'));
    await store.load();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('opens threads, activates on Send to agent or a mention, and replays', async () => {
    const activated = vi.fn();
    store.on('activated', activated);

    const quiet = await store.create({
      version: 1,
      author: 'user',
      text: 'The totals look off.',
      anchor: { text: 'Total: 42' },
    });
    expect(quiet).toMatchObject({
      activated: false,
      resolved: false,
      version: 1,
    });
    expect(quiet.messages).toHaveLength(1);
    expect(activated).not.toHaveBeenCalled();

    const sent = await store.create({
      version: 1,
      author: 'user',
      text: 'Please fix the header',
      sendToAgent: true,
    });
    expect(sent.activated).toBe(true);
    const mention = await store.create({
      version: 2,
      author: 'user',
      text: '@claude can you widen this column?',
    });
    expect(mention.activated).toBe(true);
    expect(activated).toHaveBeenCalledTimes(2);

    // Activation by a later reply, and by the explicit gesture.
    await store.reply(quiet.id, {
      author: 'user',
      text: '@agent look',
      sendToAgent: false,
    });
    expect(store.get(quiet.id)?.activated).toBe(true);
    expect(activated).toHaveBeenCalledTimes(3);
    const another = await store.create({
      version: 2,
      author: 'user',
      text: 'later',
    });
    await store.activate(another.id);
    await store.activate(another.id); // idempotent
    expect(activated).toHaveBeenCalledTimes(4);

    const reloaded = new CommentStore(store.file);
    await reloaded.load();
    expect(reloaded.list().map((t) => t.id)).toEqual(
      store.list().map((t) => t.id),
    );
    expect(reloaded.get(quiet.id)?.messages).toHaveLength(2);
    expect(reloaded.get(mention.id)?.activatedAt).toBe(mention.activatedAt);
  });

  it('lets the agent reply and resolve only on activated threads, with the duplicate guard', async () => {
    const thread = await store.create({
      version: 1,
      author: 'user',
      text: 'Typo in the title',
    });
    await expect(
      store.reply(thread.id, { author: 'agent', text: 'Fixed.' }),
    ).rejects.toMatchObject({ code: 'not_activated' });
    await expect(store.resolve(thread.id, 'agent')).rejects.toMatchObject({
      code: 'not_activated',
    });

    await store.activate(thread.id);
    expect(needsAgentReply(store.require(thread.id))).toBe(false); // activated without a request text? still owed:
    // An activation without a sent message counts as nothing owed; the tool's
    // guard therefore asks for acknowledge_duplicate. Send a request first.
    await store.reply(thread.id, {
      author: 'user',
      text: 'Please fix it',
      sendToAgent: true,
    });
    expect(needsAgentReply(store.require(thread.id))).toBe(true);

    const replied = await store.reply(thread.id, {
      author: 'agent',
      text: 'Done: retitled.',
    });
    expect(replied.messages.at(-1)).toMatchObject({
      author: 'agent',
      sentToAgent: false,
    });
    expect(needsAgentReply(replied)).toBe(false);
    await expect(
      store.reply(thread.id, { author: 'agent', text: 'Done again.' }),
    ).rejects.toMatchObject({ code: 'duplicate' });
    await store.reply(thread.id, {
      author: 'agent',
      text: 'One more note.',
      acknowledgeDuplicate: true,
    });

    const resolved = await store.resolve(thread.id, 'agent');
    expect(resolved).toMatchObject({ resolved: true, resolvedBy: 'agent' });
    expect(await store.resolve(thread.id, 'agent')).toBe(resolved); // stays resolved
    const reopened = await store.reopen(thread.id);
    expect(reopened.resolved).toBe(false);
    expect(store.list()[0].id).toBe(thread.id);
  });

  it('validates text and unknown threads', async () => {
    await expect(
      store.create({ version: 1, author: 'user', text: '   ' }),
    ).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      store.create({ version: 1, author: 'user', text: 'x'.repeat(4097) }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      store.reply('th_nope', { author: 'user', text: 'hi' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(store.get('th_nope')).toBeNull();
  });

  it('orders open threads first, newest first', async () => {
    const a = await store.create({ version: 1, author: 'user', text: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ version: 1, author: 'user', text: 'b' });
    await store.resolve(a.id, 'user');
    expect(store.list().map((t) => t.id)).toEqual([b.id, a.id]);
    await store.reopen(a.id);
    expect(store.list().map((t) => t.id)).toEqual([b.id, a.id]);
  });
});
