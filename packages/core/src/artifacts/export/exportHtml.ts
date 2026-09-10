/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: compile finite page dependencies into one HTML document.
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap,
} from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parse as parseJs, type Node as JsNode } from 'acorn';
import { transform, build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SKELETON_HEAD } from '../htmlShell.js';
import { ResourceLoader, hashBytes, type Resource } from './resources.js';
import { optimizePng } from './optimizeImage.js';
import type {
  ExportInput,
  ExportOptions,
  ExportResult,
  ExportDiagnostic,
} from './types.js';

type Element = DefaultTreeAdapterMap['element'];
type HtmlNode = DefaultTreeAdapterMap['node'];
const elements = (node: HtmlNode): Element[] => {
  const children = 'childNodes' in node ? node.childNodes : [];
  return [
    ...('tagName' in node ? [node] : []),
    ...children.flatMap(elements),
    ...('content' in node ? elements(node.content) : []),
  ];
};
const attr = (el: Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;
const removeAttr = (el: Element, name: string): void => {
  el.attrs = el.attrs.filter((a) => a.name !== name);
};
const setAttr = (el: Element, name: string, value: string): void => {
  removeAttr(el, name);
  el.attrs.push({ name, value });
};
const content = (el: Element): string =>
  el.childNodes.map((n) => ('value' in n ? n.value : '')).join('');
function setText(el: Element, value: string): void {
  el.childNodes = [{ nodeName: '#text', value, parentNode: el }];
}
function detach(el: Element): void {
  if (el.parentNode)
    el.parentNode.childNodes = el.parentNode.childNodes.filter((n) => n !== el);
}
function changeTag(el: Element, tag: string): void {
  el.tagName = tag;
  el.nodeName = tag;
}
function insertHead(
  doc: DefaultTreeAdapterMap['document'],
  html: string,
): void {
  const head = elements(doc).find((e) => e.tagName === 'head')!;
  const fragment = parseFragment(html);
  for (const node of fragment.childNodes) node.parentNode = head;
  head.childNodes.unshift(...fragment.childNodes);
}
type Ast = JsNode & {
  type: string;
  name?: string;
  value?: unknown;
  callee?: Ast;
  arguments?: Ast[];
  source?: Ast;
  property?: Ast;
  object?: Ast;
  meta?: Ast;
};
function isAst(value: unknown): value is Ast {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'start' in value &&
    typeof value.start === 'number' &&
    'end' in value &&
    typeof value.end === 'number'
  );
}
function walk(node: unknown, callback: (node: Ast) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, callback);
    return;
  }
  if (isAst(node)) callback(node);
  for (const value of Object.values(node))
    if (value && typeof value === 'object') walk(value, callback);
}

/** Each srcset URL is followed by optional descriptors; data URLs may contain commas. */
function srcsetParts(
  value: string,
): Array<{ url: string; descriptor: string }> {
  const parts: Array<{ url: string; descriptor: string }> = [];
  let rest = value.trim();
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '');
    const token = (rest.startsWith('data:') ? /^\S+/ : /^[^\s,]+/).exec(
      rest,
    )?.[0];
    if (!token) break;
    let url = token;
    rest = rest.slice(token.length);
    if (rest.startsWith(',')) {
      rest = rest.slice(1);
      parts.push({ url, descriptor: '' });
      continue;
    }
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      parts.push({ url, descriptor: '' });
      continue;
    }
    const boundary = rest.indexOf(',');
    const descriptor = (boundary < 0 ? rest : rest.slice(0, boundary)).trim();
    rest = boundary < 0 ? '' : rest.slice(boundary + 1);
    parts.push({ url, descriptor });
  }
  return parts;
}

const runtime = (
  data: Record<string, { base64: string; gzip: boolean; type: string }>,
): string => `
(()=>{const entries=JSON.parse(${JSON.stringify(JSON.stringify(data)).replace(/</g, '\\u003c')});const cache=new Map();
async function bytes(key){if(!Object.hasOwn(entries,key))throw Error('Resource was not included: '+key);if(!cache.has(key)){cache.set(key,(async()=>{const e=entries[key];let b=Uint8Array.from(atob(e.base64),c=>c.charCodeAt(0));if(e.gzip){if(typeof DecompressionStream==='undefined')throw Error('This browser cannot decompress this export. Export again with compress_data:false.');b=new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());}return b;})());}return (await cache.get(key)).slice();}
const api=Object.freeze({bytes,text:async key=>new TextDecoder().decode(await bytes(key)),json:async key=>JSON.parse(new TextDecoder().decode(await bytes(key))),fetch:async key=>new Response(await bytes(key),{headers:{'Content-Type':entries[key].type}})});
window.__auditariaExport=api;window.claude=window.auditaria=Object.freeze({use:async()=>null});})();`;

export async function exportHtml(
  input: ExportInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const loader = new ResourceLoader(input, options);
  const diagnostics: ExportDiagnostic[] = [];
  const target = options.target ?? 'sharepoint';
  const compression = options.compression ?? 'lossless';
  const data = new Map<
    string,
    { base64: string; gzip: boolean; type: string }
  >();
  const diagnostic = (
    severity: 'warning' | 'error',
    code: string,
    message: string,
    source?: string,
  ): void => {
    if (
      !diagnostics.some(
        (d) => d.code === code && d.message === message && d.source === source,
      )
    )
      diagnostics.push({ severity, code, message, source });
  };
  let dataBytesSaved = 0;
  let imageBytesSaved = 0;
  const optimizedImages = new Map<string, Promise<Buffer>>();
  const addData = async (
    key: string,
    ref: string,
    base: string,
  ): Promise<void> => {
    if (data.has(key)) return;
    const resource = await loader.get(ref, base);
    const compressed =
      compression === 'lossless' && options.compressData !== false
        ? gzipSync(resource.data, { level: 9 })
        : resource.data;
    const useGzip = compressed.length + 64 < resource.data.length;
    data.set(key, {
      base64: (useGzip ? compressed : resource.data).toString('base64'),
      gzip: useGzip,
      type: resource.type,
    });
    if (useGzip) dataBytesSaved += resource.data.length - compressed.length;
    if (resource.data.subarray(0, 16).toString() === 'SQLite format 3\0') {
      diagnostic(
        'warning',
        'sqlite_snapshot',
        'SQLite is an embedded snapshot; changes are in memory, not shared. Export a consistent checkpointed database, including committed WAL changes.',
        ref,
      );
    }
  };
  for (const [key, ref] of Object.entries(options.resources ?? {})) {
    try {
      await addData(key, ref, loader.entry);
    } catch (error) {
      diagnostic('error', 'resource', String(error), ref);
    }
  }

  async function binary(ref: string, base: string): Promise<string> {
    if (ref.startsWith('#')) return ref;
    if (ref.startsWith('data:')) {
      if (compression === 'lossless' && /^data:image\/png;base64,/i.test(ref)) {
        const original = Buffer.from(ref.slice(ref.indexOf(',') + 1), 'base64');
        const optimized = await optimize(original);
        return 'data:image/png;base64,' + optimized.toString('base64');
      }
      return ref;
    }
    const resource = await loader.get(ref, base);
    if (resource.type === 'image/svg+xml') {
      const svg = await document(
        resource.data.toString('utf8'),
        resource.url,
        true,
      );
      return (
        'data:image/svg+xml;base64,' +
        Buffer.from(svg).toString('base64') +
        (new URL(loader.resolve(ref, base)).hash || '')
      );
    }
    const bytes =
      compression === 'lossless' && resource.type === 'image/png'
        ? await optimize(resource.data)
        : resource.data;
    return `data:${resource.type};base64,${bytes.toString('base64')}${new URL(loader.resolve(ref, base)).hash}`;
  }

  async function optimize(bytes: Buffer): Promise<Buffer> {
    const key = hashBytes(bytes);
    if (!optimizedImages.has(key))
      optimizedImages.set(
        key,
        optimizePng(bytes).then((output) => {
          imageBytesSaved += bytes.length - output.length;
          return output;
        }),
      );
    return optimizedImages.get(key)!;
  }

  async function css(
    text: string,
    base: string,
    chain: string[] = [],
  ): Promise<string> {
    const root = postcss.parse(text, { from: base });
    const imports: postcss.AtRule[] = [];
    root.walkAtRules('import', (rule) => {
      imports.push(rule);
    });
    for (const rule of imports) {
      const parsed = valueParser(rule.params);
      const first = parsed.nodes.find(
        (n) => n.type !== 'space' && n.type !== 'comment',
      );
      const ref =
        first?.type === 'string'
          ? first.value
          : first?.type === 'function' && first.value.toLowerCase() === 'url'
            ? valueParser.stringify(first.nodes).replace(/^['"]|['"]$/g, '')
            : undefined;
      if (!ref) throw new Error('Cannot resolve CSS @import.');
      const resolved = loader.resolve(ref, base);
      if (chain.includes(resolved) || chain.length > 20)
        throw new Error('Cyclic or excessively deep CSS @import.');
      const resource = await loader.get(ref, base);
      const child = postcss.parse(
        await css(resource.data.toString('utf8'), resource.url, [
          ...chain,
          resolved,
        ]),
      );
      const suffix = rule.params.slice(first!.sourceEndIndex).trim();
      // Preserve media qualifiers; complex layer/supports imports require an explicit adaptation.
      if (/\b(layer|supports)\b/.test(suffix))
        throw new Error(
          'CSS @import layer/supports must be expanded by the author before export.',
        );
      if (suffix) {
        const media = postcss.atRule({ name: 'media', params: suffix });
        media.append(child.nodes);
        rule.replaceWith(media);
      } else rule.replaceWith(...child.nodes);
    }
    const declarations: postcss.Declaration[] = [];
    root.walkDecls((decl) => {
      declarations.push(decl);
    });
    for (const decl of declarations) {
      const parsed = valueParser(decl.value);
      const refs: Array<{
        node: valueParser.FunctionNode | valueParser.StringNode;
        ref: string;
      }> = [];
      parsed.walk((node) => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          refs.push({
            node,
            ref: valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g, ''),
          });
          return false;
        }
        if (
          node.type === 'function' &&
          /^(?:-webkit-)?image-set$/.test(node.value)
        ) {
          for (const child of node.nodes)
            if (child.type === 'string')
              refs.push({ node: child, ref: child.value });
        }
        return undefined;
      });
      for (const { node, ref } of refs) {
        if (!ref || ref.startsWith('#')) continue;
        const value = await binary(ref, base);
        if (node.type === 'function')
          node.nodes = [
            {
              type: 'string',
              quote: '"',
              value,
              sourceIndex: 0,
              sourceEndIndex: 0,
            },
          ];
        else node.value = value;
      }
      decl.value = parsed.toString();
    }
    const result = root.toString();
    if (compression === 'none') return result;
    return (
      await transform(result, {
        loader: 'css',
        minifyWhitespace: true,
        legalComments: 'inline',
      })
    ).code;
  }

  async function javascript(
    text: string,
    base: string,
    module = false,
    documentBase = loader.entry,
  ): Promise<string> {
    // The tested asm build retains unused WASM loader scaffolding. Its runtime
    // uses embedded JS; do not mistake that dead fallback for a page fetch.
    const knownAsm =
      hashBytes(text) ===
      'dd6bccb127181487a7179e79a93adf3d95247ea0f582d69861fea2e72a9dde41';
    const ast = parseJs(text, {
      ecmaVersion: 'latest',
      sourceType: module ? 'module' : 'script',
      allowHashBang: true,
    });
    const calls: Ast[] = [];
    const pngLiterals: Ast[] = [];
    walk(ast, (node) => {
      if (
        !knownAsm &&
        node.type === 'CallExpression' &&
        (node.callee?.name === 'fetch' ||
          (node.callee?.property?.name === 'fetch' &&
            ['window', 'globalThis'].includes(node.callee.object?.name ?? '')))
      )
        calls.push(node);
      if (
        compression === 'lossless' &&
        node.type === 'Literal' &&
        typeof node.value === 'string' &&
        (node.value.startsWith('data:image/png;base64,') ||
          node.value.startsWith('iVBORw0KGgo'))
      )
        pngLiterals.push(node);
      if (
        node.type === 'NewExpression' &&
        [
          'Worker',
          'SharedWorker',
          'WebSocket',
          'EventSource',
          'XMLHttpRequest',
        ].includes(node.callee?.name ?? '')
      ) {
        diagnostic(
          'error',
          'runtime_network',
          `${node.callee!.name} needs adaptation for an independent export.`,
          base,
        );
      }
      if (
        node.type === 'Identifier' &&
        ['localStorage', 'indexedDB', 'sessionStorage'].includes(
          node.name ?? '',
        ) &&
        target === 'sharepoint'
      )
        diagnostic(
          'warning',
          'browser_storage',
          `${node.name} is unavailable in the tested SharePoint sandbox; provide a memory fallback.`,
          base,
        );
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'use' &&
        ['claude', 'auditaria'].includes(node.callee.object?.name ?? '')
      )
        diagnostic(
          'warning',
          'host_runtime',
          'Auditaria capabilities resolve null in this export; verify the page renders its fallback.',
          base,
        );
      if (node.type === 'ImportExpression' && node.source?.type !== 'Literal')
        diagnostic(
          'error',
          'dynamic_import',
          'Computed import requires an explicit static dependency mapping.',
          base,
        );
      if (node.type === 'MetaProperty' && node.meta?.name === 'import')
        diagnostic(
          'error',
          'module_location',
          'import.meta requires adaptation because the exported module has no separate URL.',
          base,
        );
    });
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const literal of pngLiterals) {
      if (typeof literal.value !== 'string') continue;
      const rawBase64 = literal.value.startsWith('iVBORw0KGgo');
      const converted = await binary(
        rawBase64 ? 'data:image/png;base64,' + literal.value : literal.value,
        base,
      );
      const value = rawBase64
        ? converted.slice('data:image/png;base64,'.length)
        : converted;
      if (value !== literal.value)
        edits.push({
          start: literal.start,
          end: literal.end,
          text: JSON.stringify(value),
        });
    }
    for (const call of calls) {
      const arg = call.arguments?.[0];
      const ref = typeof arg?.value === 'string' ? arg.value : undefined;
      if (
        !ref ||
        call.arguments?.length !== 1 ||
        !/\.(json|csv|txt|sqlite3?|db)(?:[?#]|$)/i.test(ref)
      ) {
        diagnostic(
          'error',
          'dynamic_fetch',
          'Only one-argument fetch of a static JSON/CSV/text/SQLite file is converted automatically. Use __auditariaExport.bytes/text/json with an explicit resources mapping for other data.',
          base,
        );
        continue;
      }
      if (
        /\b(?:const|let|var|function)\s+fetch\b|\([^)]*\bfetch\b[^)]*\)\s*(?:=>|\{)/.test(
          text,
        )
      ) {
        diagnostic(
          'error',
          'shadowed_fetch',
          'A local fetch binding requires explicit adaptation.',
          base,
        );
        continue;
      }
      const key = loader.resolve(ref, documentBase);
      await addData(key, ref, documentBase);
      edits.push({
        start: call.start,
        end: call.end,
        text: `window.__auditariaExport.fetch(${JSON.stringify(key)})`,
      });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    if (compression === 'none')
      return text.replace(/<\/script/gi, '<\\/script');
    return (
      await transform(text, {
        loader: 'js',
        minifyWhitespace: true,
        legalComments: 'inline',
        supported: { 'inline-script': false },
      })
    ).code;
  }

  async function bundle(
    text: string,
    base: string,
    documentBase: string,
  ): Promise<string> {
    const result = await build({
      stdin: {
        contents: await javascript(text, base, true, documentBase),
        sourcefile: base,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      minifyWhitespace: compression === 'lossless',
      legalComments: 'inline',
      logLevel: 'silent',
      supported: { 'inline-script': false },
      plugins: [
        {
          name: 'artifact-resources',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (!/^(?:\.{1,2}\/|\/|https:)/.test(args.path))
                return {
                  errors: [
                    {
                      text: `Unresolved package import ${args.path}; use a pinned URL or relative module.`,
                    },
                  ],
                };
              return {
                path: loader.resolve(args.path, args.importer || base),
                namespace: 'artifact',
              };
            });
            builder.onLoad(
              { filter: /.*/, namespace: 'artifact' },
              async (args) => {
                const resource = await loader.get(args.path);
                if (/\.json(?:\?|$)/.test(resource.url))
                  return { contents: resource.data, loader: 'json' };
                return {
                  contents: await javascript(
                    resource.data.toString('utf8'),
                    resource.url,
                    true,
                    documentBase,
                  ),
                  loader: 'js',
                };
              },
            );
          },
        },
      ],
    });
    return result.outputFiles[0].text;
  }

  function integrity(el: Element, resource: Resource): void {
    const value = attr(el, 'integrity');
    if (!value) return;
    const candidates = value
      .split(/\s+/)
      .map((s) => /^(sha(?:256|384|512))-([A-Za-z0-9+/=]+)$/.exec(s))
      .filter((s) => s !== null);
    const strongest = candidates
      .map((m) => m[1])
      .sort()
      .at(-1);
    if (
      !strongest ||
      !candidates.some(
        (m) =>
          m[1] === strongest &&
          createHash(m[1]).update(resource.data).digest('base64') === m[2],
      )
    )
      throw new Error('Dependency integrity mismatch.');
    removeAttr(el, 'integrity');
    removeAttr(el, 'crossorigin');
  }

  const activeDocuments = new Set<string>();
  async function document(
    html: string,
    base: string,
    svg = false,
  ): Promise<string> {
    if (activeDocuments.has(base) || activeDocuments.size > 12)
      throw new Error('Cyclic or excessively deep embedded documents.');
    activeDocuments.add(base);
    const doc = svg ? parseFragment(html) : parse(html);
    const nodes = elements(doc);
    const deferred: Element[] = [];
    try {
      for (const el of nodes) {
        options.signal?.throwIfAborted();
        try {
          if (el.tagName === 'base')
            throw new Error(
              'Resolve/remove the document base element before export.',
            );
          if (
            el.tagName === 'meta' &&
            /^(?:content-security-policy|refresh)$/i.test(
              attr(el, 'http-equiv') ?? '',
            )
          )
            diagnostic(
              'warning',
              'document_policy',
              'Existing CSP/refresh may prevent this export from working; review it.',
              base,
            );
          const rel = attr(el, 'rel') ?? '';
          if (
            el.tagName === 'link' &&
            /^(?:preconnect|dns-prefetch|preload|modulepreload|prefetch)$/.test(
              rel,
            )
          ) {
            detach(el);
            continue;
          }
          if (el.tagName === 'link' && rel === 'stylesheet') {
            const resource = await loader.get(attr(el, 'href')!, base);
            integrity(el, resource);
            const transformed = await css(
              resource.data.toString('utf8'),
              resource.url,
            );
            changeTag(el, 'style');
            removeAttr(el, 'href');
            removeAttr(el, 'rel');
            setText(el, transformed.replace(/<\/style/gi, '<\\/style'));
            continue;
          }
          if (el.tagName === 'style')
            setText(
              el,
              (await css(content(el), base)).replace(/<\/style/gi, '<\\/style'),
            );
          if (el.tagName === 'script') {
            const type = attr(el, 'type') ?? '';
            if (
              type &&
              !['module', 'text/javascript', 'application/javascript'].includes(
                type,
              )
            ) {
              if (type === 'importmap')
                diagnostic(
                  'error',
                  'importmap',
                  'Resolve import maps into explicit module URLs before export.',
                  base,
                );
              continue;
            }
            let src = attr(el, 'src');
            if (src?.startsWith('/__rt/claude.js')) {
              detach(el);
              continue;
            }
            if (attr(el, 'async') !== undefined)
              throw new Error(
                'Async script loading needs author adaptation to preserve execution order.',
              );
            if (
              src &&
              /\/npm\/sql\.js@[\d.]+\/dist\/sql-wasm\.js/.test(src) &&
              target === 'sharepoint'
            ) {
              src = src.replace('/sql-wasm.js', '/sql-asm-memory-growth.js');
              if (attr(el, 'integrity'))
                throw new Error(
                  'sql.js asm adaptation changes SRI; supply the verified asm build directly.',
                );
              diagnostic(
                'warning',
                'sqlite_engine',
                'Adapted pinned sql.js WASM loader to its JavaScript build for SharePoint.',
                base,
              );
            }
            const resource = src ? await loader.get(src, base) : undefined;
            if (resource) integrity(el, resource);
            const js = resource?.data.toString('utf8') ?? content(el);
            const isModule = type === 'module';
            const transformed = isModule
              ? await bundle(js, resource?.url ?? base, base)
              : await javascript(js, resource?.url ?? base, false, base);
            setText(el, transformed);
            if (
              resource &&
              /^https:\/\/cdn\.jsdelivr\.net\/npm\/sql\.js@[\d.]+\/dist\//.test(
                resource.url,
              )
            ) {
              const license = await loader.get('../LICENSE', resource.url);
              setText(
                el,
                '/*! sql.js license\n' +
                  license.data
                    .toString('utf8')
                    .replace(/\*\//g, '* /')
                    .replace(/<\/script/gi, '<\\/script') +
                  '\n*/\n' +
                  transformed,
              );
            }
            removeAttr(el, 'src');
            removeAttr(el, 'type');
            if (isModule || attr(el, 'defer') !== undefined) {
              removeAttr(el, 'defer');
              deferred.push(el);
            }
          }
          if (attr(el, 'style')) {
            const styled = await css(`a{${attr(el, 'style')}}`, base);
            const rule = postcss.parse(styled).first;
            if (rule?.type === 'rule')
              setAttr(
                el,
                'style',
                rule.nodes.map((n) => n.toString()).join(';'),
              );
          }
          for (const name of ['src', 'poster', 'href', 'xlink:href']) {
            const ref = attr(el, name);
            if (!ref) continue;
            const loadable =
              (name === 'src' &&
                ['img', 'source', 'audio', 'video', 'track', 'input'].includes(
                  el.tagName,
                )) ||
              name === 'poster' ||
              (['image', 'use', 'feImage'].includes(el.tagName) &&
                /href/.test(name)) ||
              (el.tagName === 'link' && rel.includes('icon'));
            if (loadable) setAttr(el, name, await binary(ref, base));
          }
          if (attr(el, 'srcset')) {
            const parts = srcsetParts(attr(el, 'srcset')!);
            for (const part of parts) part.url = await binary(part.url, base);
            setAttr(
              el,
              'srcset',
              parts
                .map((p) => p.url + (p.descriptor ? ' ' + p.descriptor : ''))
                .join(', '),
            );
          }
          if (el.tagName === 'iframe') {
            const src = attr(el, 'src');
            if (src && !src.startsWith('about:')) {
              if (/^https?:|^\/\//.test(src))
                throw new Error(
                  'An external iframe is an application, not a static dependency. Provide a local HTML file to inline.',
                );
              const resource = await loader.get(src, base);
              setAttr(
                el,
                'srcdoc',
                await document(resource.data.toString('utf8'), resource.url),
              );
              removeAttr(el, 'src');
              diagnostic(
                'warning',
                'nested_frame',
                'Local iframe converted to srcdoc; verify interactive behavior in the destination.',
                base,
              );
            } else if (attr(el, 'srcdoc'))
              setAttr(
                el,
                'srcdoc',
                await document(
                  attr(el, 'srcdoc')!,
                  base + '#srcdoc-' + nodes.indexOf(el),
                ),
              );
          }
          if (['object', 'embed'].includes(el.tagName))
            diagnostic(
              'error',
              'embedded_viewer',
              'PDF/object/embed viewers require adaptation. Use selected PDF pages rendered as embedded images or an online reference link.',
              base,
            );
          if (
            target === 'sharepoint' &&
            ['audio', 'video'].includes(el.tagName)
          )
            diagnostic(
              'warning',
              'media_policy',
              'Media bytes are included, but playback is not verified in the SharePoint sandbox.',
              base,
            );
          if (el.tagName === 'form' && attr(el, 'action'))
            diagnostic(
              'error',
              'form_service',
              'Submitting this form requires a server; provide an in-memory alternative.',
              base,
            );
          if (
            el.tagName === 'a' &&
            attr(el, 'href') &&
            !/^(?:#|https?:|mailto:|tel:|data:)/.test(attr(el, 'href')!)
          )
            diagnostic(
              'warning',
              'separate_document',
              'Link points to a separate local document; it is not included as navigation in this export.',
              attr(el, 'href'),
            );
        } catch (error) {
          options.signal?.throwIfAborted();
          diagnostic(
            'error',
            'dependency',
            error instanceof Error ? error.message : String(error),
            attr(el, 'src') ?? attr(el, 'href') ?? base,
          );
        }
      }
      const body = elements(doc).find((e) => e.tagName === 'body');
      for (const el of deferred) {
        if (body) {
          detach(el);
          el.parentNode = body;
          body.childNodes.push(el);
        }
      }
      return serialize(doc);
    } finally {
      activeDocuments.delete(base);
    }
  }

  options.onProgress?.('Converting dependencies');
  const html = await document(input.html, loader.entry);
  function withRuntime(source: string): string {
    const doc = parse(source);
    for (const el of elements(doc))
      if (el.tagName === 'iframe' && attr(el, 'srcdoc'))
        setAttr(el, 'srcdoc', withRuntime(attr(el, 'srcdoc')!));
    insertHead(
      doc,
      SKELETON_HEAD +
        '<script>' +
        runtime(Object.fromEntries(data)) +
        '</script>',
    );
    return serialize(doc);
  }
  const output =
    '<!doctype html>\n' + withRuntime(html).replace(/^<!DOCTYPE html>/i, '');
  const resources = await loader.manifest();
  const outputBytes = Buffer.byteLength(output);
  const outputMiB = outputBytes / 1024 / 1024;
  if (outputMiB > (options.warnMiB ?? 5))
    diagnostic(
      'warning',
      'file_size',
      `Export is ${outputMiB.toFixed(2)} MiB. Large files may load slowly or exceed destination limits. Export is allowed; consider fewer font variants or images.`,
    );
  if (outputMiB > 16)
    diagnostic(
      'warning',
      'large_file',
      'Export exceeds 16 MiB. This does not block export, but exceeds the current Auditaria publish limit and needs destination testing.',
    );
  if (dataBytesSaved)
    diagnostic(
      'warning',
      'decompression',
      'Data is compressed without loss. Requires browser DecompressionStream; use compress_data:false for older browsers.',
    );
  options.signal?.throwIfAborted();
  return {
    html: output,
    report: {
      formatVersion: 1,
      target,
      artifactId: input.artifactId,
      version: input.version,
      sourceSha256: hashBytes(input.html),
      outputSha256: hashBytes(output),
      inputBytes:
        Buffer.byteLength(input.html) +
        resources.reduce((sum, r) => sum + r.bytes, 0),
      outputBytes,
      outputMiB,
      compression,
      dataBytesSaved,
      imageBytesSaved,
      resources,
      largestResources: [...resources]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5),
      diagnostics,
      conversionStatus: diagnostics.some((d) => d.severity === 'error')
        ? 'needs_adaptation'
        : 'ready',
      validationStatus: 'not_run',
    },
  };
}
