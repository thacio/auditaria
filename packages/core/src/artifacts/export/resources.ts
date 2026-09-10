/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: bounded resource resolution; no browser credentials.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mime from 'mime';
import { isPrivateIpAsync, isLoopbackHost } from '../../utils/fetch.js';
import type { ExportInput, ExportOptions, ExportResource } from './types.js';

export const hashBytes = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export interface Resource extends ExportResource {
  url: string;
  data: Buffer;
}

export class ResourceLoader {
  readonly loaded = new Map<string, Promise<Resource>>();
  readonly entry: string;
  private total = 0;
  constructor(
    readonly input: ExportInput,
    readonly options: ExportOptions,
  ) {
    this.entry = pathToFileURL(
      path.resolve(input.rootDir, input.entry ?? 'index.html'),
    ).href;
  }

  resolve(ref: string, base = this.entry): string {
    if (ref.startsWith('/__assets/')) return new URL(ref, this.entry).href;
    if (ref.startsWith('/') && base.startsWith('file:')) {
      return new URL(
        '.' + ref,
        pathToFileURL(path.resolve(this.input.rootDir) + path.sep),
      ).href;
    }
    return new URL(ref, base).href;
  }

  async get(ref: string, base = this.entry): Promise<Resource> {
    this.options.signal?.throwIfAborted();
    const resolved = new URL(this.resolve(ref, base));
    resolved.hash = '';
    const key = resolved.href;
    let pending = this.loaded.get(key);
    if (!pending) {
      if (this.loaded.size >= 2000)
        throw new Error('Dependency graph exceeds 2000 resources.');
      pending = this.read(resolved);
      this.loaded.set(key, pending);
    }
    return pending;
  }

  private async read(url: URL): Promise<Resource> {
    this.options.onProgress?.(
      `Reading ${url.protocol === 'file:' ? path.basename(url.pathname) : url.hostname + url.pathname}`,
    );
    let data: Buffer;
    let type: string;
    const source = url.href;
    if (url.protocol === 'file:') {
      const assetName = decodeURIComponent(
        url.pathname.split('/__assets/')[1] ?? '',
      );
      const assetPath = this.input.assets?.get(assetName);
      if (url.pathname.includes('/__assets/') && !assetPath)
        throw new Error(`Missing attached asset: ${assetName}`);
      const clean = new URL(url);
      clean.search = '';
      const candidate = assetPath ?? fileURLToPath(clean);
      const actual = await fs.realpath(candidate);
      if (!assetPath) {
        const root = await fs.realpath(this.input.rootDir);
        const relative = path.relative(root, actual);
        if (
          path.isAbsolute(relative) ||
          relative.split(path.sep).some((p) => p.startsWith('.')) ||
          relative === '..'
        ) {
          throw new Error(
            'Resource is outside the export root or is a hidden file.',
          );
        }
      }
      this.options.signal?.throwIfAborted();
      data = await fs.readFile(actual, { signal: this.options.signal });
      type = mime.getType(actual) ?? 'application/octet-stream';
    } else if (url.protocol === 'https:') {
      if (this.options.allowRemote === false)
        throw new Error('Remote dependencies disabled; supply a local copy.');
      let response: Response | undefined;
      for (let hop = 0; hop < 6; hop++) {
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          isLoopbackHost(url.hostname) ||
          url.hostname.endsWith('.localhost') ||
          (await isPrivateIpAsync(url.href))
        ) {
          throw new Error(
            'Remote dependencies must use public HTTPS without credentials.',
          );
        }
        response = await fetch(url, {
          redirect: 'manual',
          credentials: 'omit',
          // Ask Google Fonts for modern WOFF2 variants instead of its larger
          // legacy TTF response to Node's default user agent. All unicode ranges
          // in the returned stylesheet are still incorporated.
          headers:
            url.hostname === 'fonts.googleapis.com'
              ? {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                }
              : undefined,
          signal: AbortSignal.any([
            AbortSignal.timeout(30000),
            ...(this.options.signal ? [this.options.signal] : []),
          ]),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error('Redirect has no location.');
          url = new URL(location, url);
          response = undefined;
          continue;
        }
        break;
      }
      if (!response?.ok)
        throw new Error(
          `Dependency download failed (${response?.status ?? 'too many redirects'}).`,
        );
      type =
        response.headers.get('content-type')?.split(';')[0] ??
        mime.getType(url.pathname) ??
        'application/octet-stream';
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      let size = 0;
      try {
        while (reader) {
          this.options.signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          // Resource processing safeguard, independent of the output-size warnings.
          if (this.total + size > 512 * 1024 * 1024)
            throw new Error(
              'Dependency processing exceeds 512 MiB of memory input.',
            );
          chunks.push(chunk.value);
        }
      } finally {
        await reader?.cancel();
      }
      data = Buffer.concat(chunks);
    } else {
      throw new Error(`Unsupported resource protocol: ${url.protocol}`);
    }
    this.total += data.length;
    return {
      source,
      url: url.href,
      type,
      bytes: data.length,
      data,
      sha256: hashBytes(data),
    };
  }

  async manifest(): Promise<ExportResource[]> {
    const entries = await Promise.allSettled(this.loaded.values());
    return entries.flatMap((r) =>
      r.status === 'fulfilled'
        ? [
            {
              source: r.value.source,
              type: r.value.type,
              bytes: r.value.bytes,
              sha256: r.value.sha256,
            },
          ]
        : [],
    );
  }
}
