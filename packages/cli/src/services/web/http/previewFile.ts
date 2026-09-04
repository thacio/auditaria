/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { Router, type Request, type Response } from 'express';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseHtml } from 'node-html-parser';
import type { WebLogger } from '../core/types.js';
import {
  contentTypeFor,
  isBinaryExtension,
  isHtmlExtension,
  isMediaExtension,
} from './mimeTypes.js';

/** URL prefix under which local files are served for in-browser previews. */
export const PREVIEW_FILE_ROUTE = '/preview-file';

/** Builds the preview URL for an absolute local path (mirrors the client). */
export function previewUrlFor(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  return `${PREVIEW_FILE_ROUTE}/${encodeURIComponent(normalized)}`;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parses a single-range `Range: bytes=start-end` header against a file
 * size. Returns null when the header is malformed or unsatisfiable.
 */
export function parseByteRange(
  header: string,
  fileSize: number,
): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;

  let start: number;
  let end: number;
  if (startText === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number.parseInt(endText, 10);
    if (suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText === '' ? fileSize - 1 : Number.parseInt(endText, 10);
  }

  if (start >= fileSize || end >= fileSize || start > end) return null;
  return { start, end };
}

/** Attributes whose URL values are rewritten to preview URLs. */
const URL_ATTRIBUTES: ReadonlyArray<{ selector: string; attr: string }> = [
  { selector: 'a[href]', attr: 'href' },
  { selector: 'img[src]', attr: 'src' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'script[src]', attr: 'src' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'audio[src]', attr: 'src' },
  { selector: 'iframe[src]', attr: 'src' },
  { selector: 'embed[src]', attr: 'src' },
  { selector: 'object[data]', attr: 'data' },
  { selector: 'form[action]', attr: 'action' },
];

/** URLs that must be left untouched by the rewriter. */
function isNonRelativeUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('//') ||
    value.startsWith('data:') ||
    value.startsWith('#') ||
    value.startsWith('mailto:') ||
    value.startsWith('tel:') ||
    value.startsWith('javascript:')
  );
}

/**
 * Rewrites every relative URL in an HTML document to an absolute preview
 * URL so navigation (including back/forward) keeps working inside the
 * preview iframe without `<base>` tag encoding problems. Returns the input
 * unchanged if the document cannot be parsed.
 */
export function rewriteHtmlLinks(
  content: string,
  absolutePath: string,
  logger?: WebLogger,
): string {
  try {
    const root = parseHtml(content);
    const baseDir = path.dirname(absolutePath);

    for (const { selector, attr } of URL_ATTRIBUTES) {
      for (const element of root.querySelectorAll(selector)) {
        const value = element.getAttribute(attr);
        if (!value || isNonRelativeUrl(value)) continue;
        element.setAttribute(attr, previewUrlFor(path.resolve(baseDir, value)));
      }
    }
    return root.toString();
  } catch (error) {
    logger?.error('Error rewriting HTML links:', error);
    return content;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function pipeFile(
  absolutePath: string,
  res: Response,
  logger: WebLogger,
  range?: ByteRange,
): void {
  const stream = createReadStream(absolutePath, range);
  stream.on('error', (error) => {
    logger.error('Stream error:', error);
    if (!res.headersSent) {
      res.status(500).send('Error streaming file');
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

async function handlePreviewRequest(
  req: Request,
  res: Response,
  logger: WebLogger,
): Promise<void> {
  // Express 4 exposes the wildcard capture as params[0].
  const requestedPath = (req.params as Record<string, string | undefined>)[0];
  if (!requestedPath) {
    res.status(400).send('Missing file path');
    return;
  }

  try {
    const decodedPath = decodeURIComponent(requestedPath);
    const absolutePath = path.isAbsolute(decodedPath)
      ? path.normalize(decodedPath)
      : path.resolve(decodedPath);

    const stats = await stat(absolutePath);
    const fileSize = stats.size;
    const ext = path.extname(absolutePath).toLowerCase();

    res.setHeader('Content-Type', contentTypeFor(ext));

    if (isMediaExtension(ext)) {
      res.setHeader('Accept-Ranges', 'bytes');
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, fileSize);
        if (!range) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
          res.send('Range Not Satisfiable');
          return;
        }
        res.status(206);
        res.setHeader(
          'Content-Range',
          `bytes ${range.start}-${range.end}/${fileSize}`,
        );
        res.setHeader('Content-Length', range.end - range.start + 1);
        pipeFile(absolutePath, res, logger, range);
        return;
      }
      res.setHeader('Content-Length', fileSize);
      pipeFile(absolutePath, res, logger);
      return;
    }

    if (isBinaryExtension(ext)) {
      res.send(await readFile(absolutePath));
      return;
    }

    const text = await readFile(absolutePath, 'utf-8');
    res.send(
      isHtmlExtension(ext)
        ? rewriteHtmlLinks(text, absolutePath, logger)
        : text,
    );
  } catch (error) {
    logger.error('Preview file error:', error);
    if (res.headersSent) return;
    if (errorCode(error) === 'ENOENT') {
      res.status(404).send('File not found');
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      res.status(500).send(`Error: ${reason}`);
    }
  }
}

/**
 * `GET /preview-file/<url-encoded absolute path>` — serves a local file
 * with the right content type, HTTP Range support for media, and relative
 * link rewriting for HTML. Any local path is reachable by design: this is
 * the file browser's preview backend on a localhost-bound server.
 */
export function createPreviewFileRouter(logger: WebLogger): Router {
  const router = Router();
  router.get(`${PREVIEW_FILE_ROUTE}/*`, (req, res) => {
    void handlePreviewRequest(req, res, logger);
  });
  return router;
}
