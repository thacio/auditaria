/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import { parse } from 'parse5';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { exportHtml } from './exportHtml.js';
import { saveExport } from './saveExport.js';
import { ArtifactService } from '../artifactService.js';

vi.mock('../../utils/fetch.js', () => ({
  isPrivateIpAsync: vi.fn(async () => false),
  isLoopbackHost: (h: string) => h === 'localhost' || h === '127.0.0.1',
}));

describe('independent artifact export', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'artifact-export-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  const file = async (name: string, data: string | Buffer) => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  };

  it('embeds nested CSS, images and scripts without altering sources', async () => {
    await file(
      'styles/site.css',
      '@import "nested.css" screen; .photo { background:url(../images/foto.png) }',
    );
    await file('styles/nested.css', '.label { color: red }');
    await file('images/foto.png', Buffer.from([1, 2, 3]));
    await file('code.js', 'window.answer = "$& $` 42";');
    const html =
      '<title>Teste</title><link rel="stylesheet" href="styles/site.css"><img src="images/foto.png"><script src="code.js"></script>';
    const result = await exportHtml({ rootDir: root, html });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.html).toContain('@media screen');
    expect(result.html).toContain('data:image/png;base64,AQID');
    expect(result.html).toContain('$& $` 42');
    expect(result.html).not.toContain('src="code.js"');
    expect(await readFile(path.join(root, 'code.js'), 'utf8')).toContain(
      'window.answer',
    );
    expect(
      result.report.resources.filter((r) => r.source.endsWith('foto.png')),
    ).toHaveLength(1);
  });

  it('rewrites static fetch to gzip data in memory with exact decoded bytes', async () => {
    const data = JSON.stringify({
      rows: Array.from({ length: 1000 }, (_, id) => ({
        id,
        title: 'dados fictícios repetidos',
      })),
    });
    await file('data.json', data);
    const result = await exportHtml({
      rootDir: root,
      html: '<script>window.result = fetch("data.json").then(r=>r.json());</script>',
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.report.dataBytesSaved).toBeGreaterThan(1000);
    const context = vm.createContext({
      window: {},
      Uint8Array,
      Blob,
      Response,
      DecompressionStream,
      TextDecoder,
      atob,
    });
    for (const match of result.html.matchAll(/<script>([\s\S]*?)<\/script>/g))
      vm.runInContext(match[1], context);
    expect(
      JSON.stringify(await vm.runInContext('window.result', context)),
    ).toBe(data);
    const noCompression = await exportHtml(
      { rootDir: root, html: '<p>x</p>' },
      { resources: { data: 'data.json' }, compressData: false },
    );
    expect(noCompression.report.dataBytesSaved).toBe(0);
  });

  it('continues above 16 MiB and saves an HTML with visible size warnings', async () => {
    const html = '<p>' + 'x'.repeat(17 * 1024 * 1024) + '</p>';
    const result = await exportHtml({ rootDir: root, html });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.report.diagnostics.map((d) => d.code)).toContain(
      'large_file',
    );
    const saved = await saveExport(result, path.join(root, 'out'));
    expect(saved.htmlFile).toBeTruthy();
    expect((await readFile(saved.htmlFile!, 'utf8')).length).toBeGreaterThan(
      html.length,
    );
  });

  it('reports unresolved dynamic data and writes a report instead of a broken ready file', async () => {
    const result = await exportHtml({
      rootDir: root,
      html: '<script>fetch(window.url)</script>',
    });
    expect(result.report.conversionStatus).toBe('needs_adaptation');
    const saved = await saveExport(result, path.join(root, 'out'));
    expect(saved.htmlFile).toBeUndefined();
    expect(saved.reportFile).toBeTruthy();
  });

  it('rejects outside/hidden files, private HTTPS, missing resources and CSS cycles', async () => {
    await file('.env', 'SECRET');
    await file('cycle.css', '@import "cycle.css";');
    for (const html of [
      '<img src="../outside.png">',
      '<img src=".env">',
      '<script src="https://localhost/a.js"></script>',
      '<img src="absent.png">',
      '<link rel="stylesheet" href="cycle.css">',
    ]) {
      const result = await exportHtml({ rootDir: root, html });
      expect(result.report.conversionStatus).toBe('needs_adaptation');
    }
  });

  it('downloads CDN once, verifies SRI and handles remote CSS-relative images', async () => {
    const fetcher = vi.fn(
      async (url: URL) =>
        new Response(
          url.pathname.endsWith('.css')
            ? 'p{background:url(./image.png)}'
            : 'x',
          {
            headers: {
              'content-type': url.pathname.endsWith('.css')
                ? 'text/css'
                : 'image/png',
            },
          },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await exportHtml({
      rootDir: root,
      html: '<link rel="stylesheet" href="https://cdn.example/styles/a.css"><img src="https://cdn.example/styles/image.png">',
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const bad = await exportHtml({
      rootDir: root,
      html: '<script src="https://cdn.example/a.js" integrity="sha256-AAAA"></script>',
    });
    expect(
      bad.report.diagnostics.some((d) =>
        d.message.includes('integrity mismatch'),
      ),
    ).toBe(true);
  });

  it('bundles static modules without output chunks and preserves deferred globals', async () => {
    await file('dep.js', 'export const answer=42;');
    await file('defer.js', 'var deferredAnswer=42;');
    const result = await exportHtml({
      rootDir: root,
      html: '<script type="module">import {answer} from "./dep.js";window.answer=answer;</script><script src="defer.js" defer></script><p id="ready">ready</p>',
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.html).not.toContain('import {');
    expect(result.html.indexOf('var deferredAnswer')).toBeGreaterThan(
      result.html.indexOf('id="ready"'),
    );
    expect(result.html).not.toContain('DOMContentLoaded');
  });

  it('embeds srcdoc, including its local resources and runtime', async () => {
    await file('child.html', '<p>child</p><script>window.ok=true;</script>');
    const result = await exportHtml({
      rootDir: root,
      html: '<iframe src="child.html"></iframe>',
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.html).toContain('srcdoc=');
    expect(result.html).not.toContain('src="child.html"');
    expect(parse(result.html)).toBeTruthy();
  });

  it('exports a pinned stored version with attached assets, and dry-run writes no output', async () => {
    const service = new ArtifactService(
      path.join(root, '.auditaria'),
      path.join(root, 'global'),
    );
    const store = await service.getStore();
    const published = await store.publish(undefined, {
      body: '<title>v1</title><img src="/__assets/photo.png">',
      format: 'html',
      favicon: '📄',
      source: 'tool',
    });
    const id = published.record.id;
    const assets = await service.getAssets(id);
    await assets.add(await file('photo.png', Buffer.from([1, 2, 3])));
    const result = await service.exportArtifact(
      { id, version: 1 },
      { dryRun: true },
    );
    expect(result.report.version).toBe(1);
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.htmlFile).toBeUndefined();
    expect(await store.readBody(id, 1)).toContain('/__assets/photo.png');
  });

  it('honors cancellation before writing an export', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportHtml(
        { rootDir: root, html: '<p>x</p>' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('resolves fetch in a separate script relative to the document, not the script folder', async () => {
    await file('data.json', '{"answer":42}');
    await file(
      'scripts/app.js',
      'window.result=window.fetch("data.json").then(r=>r.json());',
    );
    const result = await exportHtml({
      rootDir: root,
      html: '<script src="scripts/app.js"></script>',
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(
      result.report.resources.some((r) =>
        r.source.endsWith('/scripts/data.json'),
      ),
    ).toBe(false);
  });

  it('recompresses PNGs without changing pixels, including image strings in JavaScript', async () => {
    const original = await sharp({
      create: { width: 64, height: 64, channels: 4, background: '#123456' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    await file('image.png', original);
    const literal = 'data:image/png;base64,' + original.toString('base64');
    const result = await exportHtml({
      rootDir: root,
      html: `<img srcset="image.png,image.png 2x"><script>window.image=${JSON.stringify(literal)}</script>`,
    });
    expect(result.report.conversionStatus).toBe('ready');
    expect(result.report.imageBytesSaved).toBeGreaterThan(0);
    const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(result.html)!;
    const compressed = Buffer.from(match[1], 'base64');
    expect(compressed.length).toBeLessThan(original.length);
    expect(await sharp(compressed).raw().toBuffer()).toEqual(
      await sharp(original).raw().toBuffer(),
    );
  });
});
