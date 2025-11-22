/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Preview registry for auto-discovery

import { MarkdownPreview } from './MarkdownPreview.js';
import { HtmlPreview } from './HtmlPreview.js';
import { ImagePreview } from './ImagePreview.js';
import { SvgPreview } from './SvgPreview.js';
import { JsonPreview } from './JsonPreview.js';
import { PdfPreview } from './PdfPreview.js';
import { AudioPreview } from './AudioPreview.js';
import { VideoPreview } from './VideoPreview.js';

/**
 * Default Preview Types Registry
 *
 * Central registry of all available preview types.
 * Order matters - previewers are registered in this order.
 * Priority (getPriority()) determines selection when multiple can handle same file.
 *
 * Adding a new preview type:
 * 1. Create new preview class extending BasePreview
 * 2. Import it above
 * 3. Add to DEFAULT_PREVIEWS array below
 * 4. Done! No other changes needed.
 *
 * Disabling a preview:
 * Set enabled: false in the preview object
 */
export const DEFAULT_PREVIEWS = [
  {
    name: 'Markdown',
    class: MarkdownPreview,
    enabled: true,
    description: 'Markdown preview with syntax highlighting'
  },
  {
    name: 'HTML',
    class: HtmlPreview,
    enabled: true,
    description: 'HTML preview in sandboxed iframe'
  },
  {
    name: 'PDF',
    class: PdfPreview,
    enabled: true,
    description: 'PDF document viewer'
  },
  {
    name: 'Video',
    class: VideoPreview,
    enabled: true,
    description: 'Video player for MP4, WebM, AVI, etc.'
  },
  {
    name: 'Audio',
    class: AudioPreview,
    enabled: true,
    description: 'Audio player for MP3, WAV, OGG, etc.'
  },
  {
    name: 'Image',
    class: ImagePreview,
    enabled: true,
    description: 'Image viewer for PNG, JPG, GIF, etc.'
  },
  {
    name: 'SVG',
    class: SvgPreview,
    enabled: true,
    description: 'SVG vector graphics preview'
  },
  {
    name: 'JSON',
    class: JsonPreview,
    enabled: true,
    description: 'Formatted JSON preview with syntax highlighting'
  }
];
