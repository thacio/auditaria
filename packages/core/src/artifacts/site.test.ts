/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectSite,
  listSiteFiles,
  resolveSiteFile,
  stripDocumentShell,
  validateSitePath,
} from './site.js';

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf-8');
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-site-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('collectSite', () => {
  it('collects regular files under relative forward-slash paths', async () => {
    await write('index.html', '<title>Home</title>');
    await write('about.html', '<h1>About</h1>');
    await write('css/site.css', 'body{}');
    await write('.hidden', 'x');
    await write('node_modules/pkg/index.js', 'x');
    await write('.git/HEAD', 'x');
    const site = await collectSite(root);
    expect(site.files.map((f) => f.path)).toEqual([
      'about.html',
      'css/site.css',
      'index.html',
    ]);
    expect(site.bytes).toBe(site.files.reduce((sum, f) => sum + f.bytes, 0));
    expect(site.files.every((f) => path.isAbsolute(f.source))).toBe(true);
  });

  it('requires an index.html at the root', async () => {
    await write('pages/index.html', '<h1>nested</h1>');
    await expect(collectSite(root)).rejects.toMatchObject({
      code: 'no_entry',
    });
  });

  it('refuses reserved top-level names and non-directories', async () => {
    await write('index.html', 'x');
    await write('__assets/a.png', 'x');
    await expect(collectSite(root)).rejects.toMatchObject({
      code: 'reserved_path',
    });
    await expect(
      collectSite(path.join(root, 'index.html')),
    ).rejects.toMatchObject({ code: 'not_a_directory' });
  });

  it('never follows symbolic links', async () => {
    await write('index.html', 'x');
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
    try {
      await fsp.symlink(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // no symlink privilege on this box: nothing to prove
    }
    try {
      const site = await collectSite(root);
      expect(site.files.map((f) => f.path)).toEqual(['index.html']);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('validateSitePath', () => {
  it('rejects dot segments, backslashes, controls and empty segments', () => {
    for (const bad of ['../x', 'a/../b', 'a\\b', 'a//b', '', 'a/\u0001']) {
      expect(() => validateSitePath(bad)).toThrow(/not a valid site path/);
    }
    expect(() => validateSitePath('docs/guide.html')).not.toThrow();
  });
});

describe('resolveSiteFile', () => {
  beforeEach(async () => {
    await write('index.html', '<title>Home</title>');
    await write('docs/index.html', '<h1>Docs</h1>');
    await write('docs/guide.html', '<h1>Guide</h1>');
    await write('css/site.css', 'body{}');
    await write('.env', 'SECRET=1');
  });

  it('resolves files, directories to their index, and reports html-ness', async () => {
    expect((await resolveSiteFile(root, '/docs/guide.html'))?.html).toBe(true);
    expect((await resolveSiteFile(root, 'css/site.css'))?.html).toBe(false);
    expect((await resolveSiteFile(root, '/docs/'))?.file).toBe(
      path.join(root, 'docs', 'index.html'),
    );
    expect((await resolveSiteFile(root, ''))?.file).toBe(
      path.join(root, 'index.html'),
    );
    expect((await resolveSiteFile(root, 'docs%2Fguide.html'))?.html).toBe(true);
  });

  it('refuses traversal, dotfiles, drive letters, controls and missing files', async () => {
    for (const bad of [
      '../index.html',
      '/docs/../../x',
      '%2e%2e/index.html',
      '/.env',
      'docs/.hidden',
      'C:/Windows/win.ini',
      'docs\\guide.html',
      '/docs/nope.html',
      '/css/',
      '/index.html/',
      'css/site.css/',
      'a%00b',
      '%E0%A4%A',
    ]) {
      expect([bad, await resolveSiteFile(root, bad)]).toEqual([bad, null]);
    }
  });
});

describe('listSiteFiles / stripDocumentShell', () => {
  it('lists sorted relative paths', async () => {
    await write('index.html', 'x');
    await write('b/c.txt', 'x');
    await write('a.txt', 'x');
    expect(await listSiteFiles(root)).toEqual([
      'a.txt',
      'b/c.txt',
      'index.html',
    ]);
  });

  it('strips the document shell and keeps head content', () => {
    const page =
      '<!DOCTYPE html>\n<html lang="en"><head><title>T</title><link rel="stylesheet" href="css/site.css"></head>\n<body class="x"><h1>Hi</h1></body></html>';
    expect(stripDocumentShell(page)).toBe(
      '<title>T</title><link rel="stylesheet" href="css/site.css">\n<h1>Hi</h1>',
    );
    expect(stripDocumentShell('<h1>fragment</h1>')).toBe('<h1>fragment</h1>');
  });
});
