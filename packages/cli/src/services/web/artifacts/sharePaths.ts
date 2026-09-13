/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Public artifacts live beneath a capability path.

import { parse } from 'node-html-parser';

/** Keep root-relative CSS resources inside the artifact's public directory. */
export function scopeShareCss(css: string, basePath: string): string {
  return css
    .replace(/(url\(\s*['"]?)\/(?!\/)/gi, `$1${basePath}`)
    .replace(/(@import\s+['"])\/(?!\/)/gi, `$1${basePath}`);
}

/**
 * Rebase declarative root URLs without modifying authored JavaScript. Relative
 * URLs already resolve beneath the share (including links in nested site pages).
 */
export function scopeShareHtml(html: string, basePath: string): string {
  const document = parse(html);
  for (const element of document.querySelectorAll('*')) {
    for (const name of [
      'src',
      'href',
      'poster',
      'action',
      'data',
      'xlink:href',
    ]) {
      const value = element.getAttribute(name);
      if (value?.startsWith('/') && !value.startsWith('//')) {
        element.setAttribute(name, basePath + value.slice(1));
      }
    }
    const srcset = element.getAttribute('srcset');
    if (srcset) {
      element.setAttribute(
        'srcset',
        srcset.replace(/(^|,\s*)\/(?!\/)/g, `$1${basePath}`),
      );
    }
    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', scopeShareCss(style, basePath));
    if (element.tagName === 'STYLE') {
      element.set_content(scopeShareCss(element.innerHTML, basePath));
    }
  }
  return document.toString();
}
