/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { createHash } from 'node:crypto';
import { marked } from 'marked';

/**
 * Pure helpers around the authored document: title extraction, favicon
 * validation, size limits, Markdown rendering, and the serve-time shell
 * that wraps a stored fragment into the page a browser receives.
 *
 * The skeleton reproduces, byte for byte, the one Claude Code's artifact
 * host wraps around a page (verified against a stored artifact), so a page
 * authored for Claude renders identically here.
 */

/** Rendered page limit, data: URIs included. */
export const MAX_RENDERED_BYTES = 16 * 1024 * 1024;
/** Only the first 8 KB is scanned for `<title>`. */
export const TITLE_SCAN_BYTES = 8 * 1024;
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_LABEL_CHARS = 60;
export const MAX_FAVICON_CHARS = 32;

/** The exact reset Claude Code ships in every artifact head. */
export const SKELETON_HEAD =
  '<meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">' +
  '<style>:root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;' +
  'background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found]){display:none!important}</style>';

/**
 * Finds `<title>` in the first 8 KB of an authored fragment, as the host
 * does. Whitespace is collapsed; HTML entities stay as written.
 */
export function extractTitle(body: string): string | null {
  const head = body.slice(0, TITLE_SCAN_BYTES);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!match) return null;
  const title = match[1].replace(/\s+/g, ' ').trim();
  return title || null;
}

/** Title precedence: `<title>` → explicit param → file basename. */
export function resolveTitle(
  body: string,
  format: 'html' | 'markdown',
  explicit: string | undefined,
  basename: string,
): string {
  if (format === 'html') {
    const fromTag = extractTitle(body);
    if (fromTag) return fromTag;
  }
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return basename.replace(/\.(html?|md)$/i, '') || 'Untitled';
}

/**
 * Validates a favicon: one or two emoji grapheme clusters, no markup.
 * Returns an error message or null.
 */
export function validateFavicon(favicon: string): string | null {
  if (typeof favicon !== 'string' || favicon.length === 0) {
    return 'favicon is required on a first publish: one or two emoji';
  }
  if (favicon.length > MAX_FAVICON_CHARS || /[<>&/\\\w\s]/u.test(favicon)) {
    return 'favicon must be one or two emoji — no letters, markup or SVG';
  }
  const clusters = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(favicon),
  ).map((s) => s.segment);
  if (clusters.length < 1 || clusters.length > 2) {
    return 'favicon must be one or two emoji';
  }
  for (const cluster of clusters) {
    // Pictographs, or a flag (a pair of regional indicators).
    if (
      !/\p{Extended_Pictographic}/u.test(cluster) &&
      !/^\p{Regional_Indicator}{2}$/u.test(cluster)
    ) {
      return 'favicon must be one or two emoji';
    }
  }
  return null;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Renders Markdown to an HTML fragment; mermaid fences become `<pre class="mermaid">`. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_m, code: string) => `<pre class="mermaid">${code}</pre>`,
  );
}

/** Stylesheet applied to rendered Markdown pages (theme-aware). */
export const MARKDOWN_STYLE = `<style>
:root{--md-ink:#1f2328;--md-ink-2:#57606a;--md-paper:#faf9f5;--md-line:#d0d7de;--md-code:#f3f4f6;--md-accent:#0969da}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--md-ink:#e6edf3;--md-ink-2:#9aa4ae;--md-paper:#0d1117;--md-line:#30363d;--md-code:#161b22;--md-accent:#58a6ff}}
:root[data-theme="dark"]{--md-ink:#e6edf3;--md-ink-2:#9aa4ae;--md-paper:#0d1117;--md-line:#30363d;--md-code:#161b22;--md-accent:#58a6ff}
body{background:var(--md-paper);color:var(--md-ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:72ch;margin:0 auto;padding:32px 24px}
h1,h2,h3{line-height:1.25;text-wrap:balance}h1{font-size:2em;border-bottom:1px solid var(--md-line);padding-bottom:.3em}
a{color:var(--md-accent)}code{background:var(--md-code);padding:.15em .35em;border-radius:4px;font-size:.9em}
pre{background:var(--md-code);padding:14px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--md-line);padding:6px 12px}
blockquote{border-left:4px solid var(--md-line);margin:0;padding:0 1em;color:var(--md-ink-2)}img{max-width:100%}
</style>`;

export interface ShellOptions {
  /** The authored fragment (HTML) or the rendered Markdown fragment. */
  readonly body: string;
  /** Head-first runtime block, inserted BEFORE the reset skeleton. */
  readonly runtimeHead?: string;
  /** Explicit theme stamp on `<html>`; omitted = the viewer's system setting. */
  readonly theme?: 'light' | 'dark';
  /** Extra head markup after the skeleton (e.g. the Markdown stylesheet). */
  readonly extraHead?: string;
}

/**
 * Wraps a fragment into the full document. The runtime block goes first so
 * `window.claude` exists before any authored script runs, exactly as on
 * Claude's host.
 */
export function wrapDocument(options: ShellOptions): string {
  const themeAttr = options.theme ? ` data-theme="${options.theme}"` : '';
  const runtime = options.runtimeHead
    ? `<!-- frame-runtime -->${options.runtimeHead}<!-- /frame-runtime -->`
    : '';
  return (
    `<!doctype html><html${themeAttr}><head>${runtime}${SKELETON_HEAD}` +
    `${options.extraHead ?? ''}</head><body>\n${options.body}\n</body></html>`
  );
}

/**
 * The page-side `artifact.publish(html)` sends a complete document. Strip
 * our own wrapper (runtime block + skeleton) when present so the stored body
 * is the inner fragment again; a foreign full document is stored as is.
 */
export function unwrapDocument(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyStart === -1 || bodyEnd === -1 || bodyEnd < bodyStart) {
    return html;
  }
  const inner = html.slice(bodyStart + '<body>'.length, bodyEnd);
  return inner.replace(/^\n/, '').replace(/\n$/, '');
}

/** True when the fragment uses a mermaid block and needs the renderer. */
export function usesMermaid(body: string): boolean {
  return /class=["']mermaid["']/i.test(body);
}
