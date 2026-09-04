/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHostname,
  artifactIdFromHostname,
  artifactUrl,
  isArtifactId,
  parseArtifactReference,
} from './artifactPaths.js';
import {
  ArtifactStore,
  ArtifactStoreError,
  validateCapabilities,
} from './artifactStore.js';
import {
  extractTitle,
  renderMarkdown,
  resolveTitle,
  unwrapDocument,
  validateFavicon,
  wrapDocument,
  SKELETON_HEAD,
} from './htmlShell.js';
import { loadOwnerIdentity } from './identity.js';
import type { PublishInput } from './types.js';

const fragment = (title: string) =>
  `<title>${title}</title>\n<style>body{color:red}</style>\n<h1>${title}</h1>`;

const publishInput = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  body: fragment('Deploy Failures'),
  format: 'html',
  source: 'tool',
  title: 'Deploy Failures',
  favicon: '📊',
  description: 'Failures by service',
  ...overrides,
});

describe('artifact ids and hosts', () => {
  it('round-trips ids through host names, urls and references', () => {
    const id = 'abcdef0123456789';
    expect(isArtifactId(id)).toBe(true);
    expect(isArtifactId('ABCDEF0123456789')).toBe(false);
    expect(artifactHostname(id)).toBe('art-abcdef0123456789.localhost');
    expect(artifactIdFromHostname('ART-abcdef0123456789.LOCALHOST')).toBe(id);
    expect(artifactIdFromHostname('art-nope.localhost')).toBeNull();
    expect(artifactIdFromHostname('localhost')).toBeNull();
    expect(artifactUrl(id, 8629)).toBe(
      'http://art-abcdef0123456789.localhost:8629/',
    );
    expect(parseArtifactReference(id)).toBe(id);
    expect(parseArtifactReference(`artifact:${id}`)).toBe(id);
    expect(parseArtifactReference(artifactUrl(id, 9000) + 'v/2/')).toBe(id);
    expect(
      parseArtifactReference('https://claude.ai/code/artifact/x'),
    ).toBeNull();
  });
});

describe('htmlShell', () => {
  it('extracts the title from the first 8 KB only', () => {
    expect(extractTitle('<title>  Deploy\n Failures </title>')).toBe(
      'Deploy Failures',
    );
    expect(extractTitle('<p>no title</p>')).toBeNull();
    const late = 'x'.repeat(9000) + '<title>Late</title>';
    expect(extractTitle(late)).toBeNull();
  });

  it('resolves the title by precedence', () => {
    expect(
      resolveTitle('<title>Tag</title>', 'html', 'Param', 'file.html'),
    ).toBe('Tag');
    expect(resolveTitle('<p>x</p>', 'html', 'Param', 'file.html')).toBe(
      'Param',
    );
    expect(resolveTitle('<p>x</p>', 'html', undefined, 'my-page.html')).toBe(
      'my-page',
    );
    expect(
      resolveTitle('<title>Ignored</title>', 'markdown', undefined, 'notes.md'),
    ).toBe('notes');
  });

  it('validates favicons as one or two emoji', () => {
    expect(validateFavicon('📊')).toBeNull();
    expect(validateFavicon('⚡🔥')).toBeNull();
    expect(validateFavicon('🇧🇷')).toBeNull();
    expect(validateFavicon('')).toMatch(/required/);
    expect(validateFavicon('ab')).toMatch(/emoji/);
    expect(validateFavicon('<svg/>')).toMatch(/emoji/);
    expect(validateFavicon('📊📈📉')).toMatch(/one or two/);
  });

  it('wraps and unwraps with the exact skeleton', () => {
    const doc = wrapDocument({
      body: '<h1>Hi</h1>',
      runtimeHead: '<script>window.x=1</script>',
      theme: 'dark',
    });
    expect(
      doc.startsWith(
        '<!doctype html><html data-theme="dark"><head><!-- frame-runtime -->',
      ),
    ).toBe(true);
    expect(doc).toContain(
      `<!-- /frame-runtime -->${SKELETON_HEAD}</head><body>\n<h1>Hi</h1>\n</body></html>`,
    );
    expect(unwrapDocument(doc)).toBe('<h1>Hi</h1>');
    expect(unwrapDocument('<p>not a document</p>')).toBe(
      '<p>not a document</p>',
    );
  });

  it('renders markdown with mermaid fences as pre.mermaid', () => {
    const html = renderMarkdown(
      '# Title\n\n```mermaid\ngraph TD; A-->B\n```\n',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B\n</pre>');
  });
});

describe('validateCapabilities', () => {
  it('accepts known names, reports unserved ones, rejects unknown ones', () => {
    expect(validateCapabilities({ db: {}, downloads: true, room: {} })).toEqual(
      {
        unserved: ['room'],
      },
    );
    expect(() => validateCapabilities({ magic: {} })).toThrow(
      /Unknown capability/,
    );
    expect(() => validateCapabilities({ db: 'yes' })).toThrow(/object/);
  });
});

describe('ArtifactStore', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifacts-store-'));
    store = new ArtifactStore(path.join(dir, 'artifacts'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('creates an artifact, mints versions, and survives a reload', async () => {
    const onVersion = vi.fn();
    store.on('version', onVersion);

    const first = await store.publish(undefined, publishInput());
    expect(first.created).toBe(true);
    expect(first.version.n).toBe(1);
    expect(first.record.title).toBe('Deploy Failures');
    expect(first.record.favicon).toBe('📊');
    expect(onVersion).toHaveBeenCalledTimes(1);

    const second = await store.publish(
      first.record.id,
      publishInput({
        body: fragment('Deploy Failures v2'),
        title: 'Deploy Failures v2',
        label: 'Draft to legal',
      }),
      1,
    );
    expect(second.created).toBe(false);
    expect(second.version).toMatchObject({
      n: 2,
      label: 'Draft to legal',
      source: 'tool',
    });
    expect(second.record.latestVersion).toBe(2);
    expect(second.record.favicon).toBe('📊'); // kept across redeploys

    const body1 = await store.readBody(first.record.id, 1);
    expect(body1).toBe(fragment('Deploy Failures'));
    const versionsDir = path.join(store.rootDir, first.record.id, 'versions');
    expect((await stat(path.join(versionsDir, '1.html'))).isFile()).toBe(true);
    expect((await stat(path.join(versionsDir, '2.html'))).isFile()).toBe(true);

    // Reload from disk into a fresh store.
    const reloaded = new ArtifactStore(store.rootDir);
    const record = await reloaded.get(first.record.id);
    expect(record).toMatchObject({
      latestVersion: 2,
      title: 'Deploy Failures v2',
    });
    expect((await reloaded.versions(first.record.id)).map((v) => v.n)).toEqual([
      1, 2,
    ]);
    expect((await reloaded.list())[0].id).toBe(first.record.id);
  });

  it('refuses a stale base version and reports the live one', async () => {
    const { record } = await store.publish(undefined, publishInput());
    await store.publish(record.id, publishInput(), 1);
    await expect(
      store.publish(record.id, publishInput(), 1),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    // Without a base the publish is unconditional.
    const third = await store.publish(record.id, publishInput());
    expect(third.version.n).toBe(3);
  });

  it('requires a favicon on first publish and validates sizes', async () => {
    await expect(
      store.publish(undefined, publishInput({ favicon: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      store.publish(undefined, publishInput({ favicon: 'ab' })),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      store.publish(undefined, publishInput({ description: 'x'.repeat(1001) })),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      store.publish(
        undefined,
        publishInput({ body: 'y'.repeat(16 * 1024 * 1024 + 1) }),
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('applies the three capability gestures', async () => {
    const { record } = await store.publish(
      undefined,
      publishInput({ capabilities: { db: {}, downloads: true } }),
    );
    expect(record.capabilities).toEqual({ db: {}, downloads: true });
    const kept = await store.publish(record.id, publishInput());
    expect(kept.record.capabilities).toEqual({ db: {}, downloads: true });
    const replaced = await store.publish(
      record.id,
      publishInput({ capabilities: { sample: {} } }),
    );
    expect(replaced.record.capabilities).toEqual({ sample: {} });
    const cleared = await store.publish(
      record.id,
      publishInput({ capabilities: {} }),
    );
    expect(cleared.record.capabilities).toEqual({});
    await expect(
      store.publish(record.id, publishInput({ capabilities: { nope: {} } })),
    ).rejects.toThrow(/Unknown capability/);
  });

  it('serves the pinned version, and metadata edits are journaled', async () => {
    const { record } = await store.publish(undefined, publishInput());
    await store.publish(record.id, publishInput({ body: fragment('Two') }));
    await store.publish(record.id, publishInput({ body: fragment('Three') }));
    expect((await store.servedVersion(record.id))?.n).toBe(3);
    await store.setPinnedVersion(record.id, 2);
    expect((await store.servedVersion(record.id))?.n).toBe(2);
    await expect(store.setPinnedVersion(record.id, 9)).rejects.toMatchObject({
      code: 'not_found',
    });

    await store.rename(record.id, 'Renamed');
    await store.setPinned(record.id, true);
    await store.setSampleConsent(record.id, true);
    await store.noteShare(record.id, 'https://x.trycloudflare.com/s/t');
    await store.noteShare(record.id, null);

    const reloaded = new ArtifactStore(store.rootDir);
    expect(await reloaded.get(record.id)).toMatchObject({
      title: 'Renamed',
      pinned: true,
      pinnedVersion: 2,
      sampleConsent: true,
    });
    const journal = await readFile(
      path.join(store.rootDir, record.id, 'artifact.jsonl'),
      'utf-8',
    );
    expect(journal).toContain('"type":"shared"');
    expect(journal).toContain('"type":"unshared"');
  });

  it('lists pinned first then newest, hiding deleted ones', async () => {
    const a = await store.publish(
      undefined,
      publishInput({ title: 'A', body: fragment('A') }),
    );
    const b = await store.publish(
      undefined,
      publishInput({ title: 'B', body: fragment('B') }),
    );
    const c = await store.publish(
      undefined,
      publishInput({ title: 'C', body: fragment('C') }),
    );
    await store.setPinned(a.record.id, true);
    await store.delete(b.record.id);
    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual([a.record.id, c.record.id]);
    expect(
      (await store.list({ includeDeleted: true })).map((r) => r.id),
    ).toContain(b.record.id);
  });

  it('soft-deletes, restores, and purges after the retention period', async () => {
    const onDeleted = vi.fn();
    store.on('deleted', onDeleted);
    const { record } = await store.publish(undefined, publishInput());
    await store.delete(record.id);
    expect(onDeleted).toHaveBeenCalledWith(record.id);
    await expect(store.require(record.id)).rejects.toMatchObject({
      code: 'deleted',
    });
    await expect(store.delete(record.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    const restored = await store.restore(record.id);
    expect(restored.deletedAt).toBeUndefined();
    expect(await store.require(record.id)).toBeTruthy();

    await store.delete(record.id);
    expect(await store.purgeExpired(new Date())).toEqual([]);
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(await store.purgeExpired(later)).toEqual([record.id]);
    expect(await store.get(record.id)).toBeNull();
    await expect(
      stat(path.join(store.rootDir, record.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws typed errors for unknown artifacts and versions', async () => {
    await expect(store.require('0000000000000000')).rejects.toBeInstanceOf(
      ArtifactStoreError,
    );
    await expect(store.readBody('0000000000000000', 1)).rejects.toMatchObject({
      code: 'not_found',
    });
    const { record } = await store.publish(undefined, publishInput());
    await expect(store.readBody(record.id, 5)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('loadOwnerIdentity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifacts-owner-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('mints once and returns the same id afterwards', async () => {
    const first = await loadOwnerIdentity(dir);
    expect(first.ownerId).toMatch(/^u_[0-9a-f]{16}$/);
    const second = await loadOwnerIdentity(dir);
    expect(second.ownerId).toBe(first.ownerId);
  });
});
