/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { WebHttpServer } from '../core/httpServer.js';
import {
  createPreviewFileRouter,
  parseByteRange,
  previewUrlFor,
  rewriteHtmlLinks,
} from './previewFile.js';

describe('parseByteRange', () => {
  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 1000)).toEqual({
      start: 500,
      end: 999,
    });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseByteRange('items=0-1', 10)).toBeNull();
    expect(parseByteRange('bytes=-', 10)).toBeNull();
    expect(parseByteRange('bytes=10-', 10)).toBeNull();
    expect(parseByteRange('bytes=5-2', 10)).toBeNull();
    expect(parseByteRange('bytes=0-10', 10)).toBeNull();
    expect(parseByteRange('bytes=-0', 10)).toBeNull();
  });
});

describe('previewUrlFor', () => {
  it('normalizes separators and encodes the absolute path', () => {
    expect(previewUrlFor('C:\\docs\\a b.html')).toBe(
      '/preview-file/C%3A%2Fdocs%2Fa%20b.html',
    );
  });
});

describe('rewriteHtmlLinks', () => {
  const base = path.resolve('/site/pages/index.html');
  const dir = path.dirname(base);

  it('rewrites relative URLs to preview URLs and leaves the rest alone', () => {
    const html = [
      '<a href="../about.html">about</a>',
      '<img src="pic.png">',
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<script src="//cdn.example.com/x.js"></script>',
      '<a href="#top">top</a>',
      '<a href="mailto:a@b.c">mail</a>',
      '<img src="data:image/png;base64,AAAA">',
      '<form action="submit.php"></form>',
    ].join('');

    const out = rewriteHtmlLinks(html, base);

    expect(out).toContain(
      `href="${previewUrlFor(path.resolve(dir, '../about.html'))}"`,
    );
    expect(out).toContain(
      `src="${previewUrlFor(path.resolve(dir, 'pic.png'))}"`,
    );
    expect(out).toContain(
      `action="${previewUrlFor(path.resolve(dir, 'submit.php'))}"`,
    );
    expect(out).toContain('href="https://cdn.example.com/x.css"');
    expect(out).toContain('src="//cdn.example.com/x.js"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });
});

describe('preview-file route', () => {
  let dir: string;
  let baseUrl: string;
  const http = new WebHttpServer(createTestLogger());

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'auditaria-preview-'));
    await writeFile(path.join(dir, 'note.txt'), 'hello world');
    await writeFile(
      path.join(dir, 'page.html'),
      '<html><body><img src="pic.png"></body></html>',
    );
    await writeFile(path.join(dir, 'clip.mp3'), Buffer.from('0123456789'));
    http.mount(createPreviewFileRouter(createTestLogger()));
    const { port } = await http.listen({
      port: 0,
      host: '127.0.0.1',
      sequentialAttempts: 0,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await http.close();
    await rm(dir, { recursive: true, force: true });
  });

  const urlFor = (name: string) =>
    baseUrl + previewUrlFor(path.join(dir, name));

  it('serves text with an explicit charset', async () => {
    const response = await fetch(urlFor('note.txt'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(await response.text()).toBe('hello world');
  });

  it('rewrites relative links inside HTML', async () => {
    const response = await fetch(urlFor('page.html'));
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain(
      `src="${previewUrlFor(path.join(dir, 'pic.png'))}"`,
    );
  });

  it('honours byte ranges for media and rejects bad ones', async () => {
    const partial = await fetch(urlFor('clip.mp3'), {
      headers: { Range: 'bytes=2-5' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(partial.headers.get('accept-ranges')).toBe('bytes');
    expect(await partial.text()).toBe('2345');

    const whole = await fetch(urlFor('clip.mp3'));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('10');
    expect(whole.headers.get('content-type')).toBe('audio/mpeg');

    const bad = await fetch(urlFor('clip.mp3'), {
      headers: { Range: 'bytes=50-60' },
    });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers 404 for a missing file', async () => {
    const response = await fetch(urlFor('missing.txt'));
    expect(response.status).toBe(404);
  });
});
