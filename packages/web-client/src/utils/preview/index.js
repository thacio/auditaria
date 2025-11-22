/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Preview system barrel export

/**
 * Preview System Exports
 *
 * Central export point for all preview-related classes.
 * Usage:
 *   import { PreviewManager, MarkdownPreview } from './utils/preview/index.js';
 */

// Core classes
export { BasePreview } from './BasePreview.js';
export { PreviewManager } from './PreviewManager.js';

// Preview implementations
export { MarkdownPreview } from './MarkdownPreview.js';
export { HtmlPreview } from './HtmlPreview.js';
export { PdfPreview } from './PdfPreview.js';
export { VideoPreview } from './VideoPreview.js';
export { AudioPreview } from './AudioPreview.js';
export { ImagePreview } from './ImagePreview.js';
export { SvgPreview } from './SvgPreview.js';
export { JsonPreview } from './JsonPreview.js';

// Registry
export { DEFAULT_PREVIEWS } from './registry.js';
