/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { t } from './index.js';

export interface I18nTextProps {
  /** Translation key (the original English text with named tags) */
  i18nKey: string;
  /** Map of tag names to React elements (optional - if not provided, tags render as plain text) */
  components?: Record<string, React.ReactElement>;
  /** Parameters for variable interpolation (e.g., {count}, {name}) */
  params?: Record<string, string | number>;
  /** Children to use as fallback (not typically used) */
  children?: React.ReactNode;
}

/**
 * Parse a template string with named tags and render with provided components.
 * Handles nested tags and plain text segments.
 *
 * @example
 * parseAndRender(
 *   "<bold>Hello</bold> world <accent>!</accent>",
 *   { bold: <Text bold />, accent: <Text color="blue" /> }
 * )
 * // Returns: [<Text bold>Hello</Text>, " world ", <Text color="blue">!</Text>]
 */
function parseAndRender(
  template: string,
  components: Record<string, React.ReactElement>,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let remaining = template;
  let key = 0;

  // Pattern matches <tagName>content</tagName> - non-greedy content match
  // Using a while loop to process tags one at a time to handle edge cases
  while (remaining.length > 0) {
    // Find the next opening tag
    const openTagMatch = remaining.match(/<([a-zA-Z][a-zA-Z0-9]*)>/);

    if (!openTagMatch) {
      // No more tags, add remaining text
      if (remaining) {
        result.push(remaining);
      }
      break;
    }

    const tagName = openTagMatch[1];
    const openTagIndex = openTagMatch.index!;
    const openTagFull = openTagMatch[0];

    // Add text before the tag
    if (openTagIndex > 0) {
      result.push(remaining.slice(0, openTagIndex));
    }

    // Find the matching closing tag
    const closeTag = `</${tagName}>`;
    const afterOpenTag = remaining.slice(openTagIndex + openTagFull.length);
    const closeTagIndex = afterOpenTag.indexOf(closeTag);

    if (closeTagIndex === -1) {
      // No closing tag found, treat as plain text
      result.push(remaining.slice(openTagIndex));
      break;
    }

    // Extract content between tags
    const content = afterOpenTag.slice(0, closeTagIndex);
    const component = components[tagName];

    if (component) {
      // Clone the component with the translated content
      // Use type assertion since we know Text components accept children
      result.push(
        React.cloneElement(
          component,
          { key: key++ } as React.Attributes,
          content,
        ),
      );
    } else {
      // Fallback: just render the content without the component wrapper
      result.push(content);
    }

    // Move past the closing tag
    remaining = afterOpenTag.slice(closeTagIndex + closeTag.length);
  }

  return result;
}

/**
 * I18nText component for rendering translated text with rich formatting.
 *
 * This component is used by the build-time i18n transformer to handle
 * nested Text components with styling (bold, colors, etc.).
 *
 * @example
 * // Transformed from:
 * // <Text><Text bold>Hello</Text> world</Text>
 * //
 * // To:
 * <I18nText
 *   i18nKey="<bold>Hello</bold> world"
 *   components={{ bold: <Text bold /> }}
 * />
 */
export const I18nText: React.FC<I18nTextProps> = ({
  i18nKey,
  components = {},
  params,
}) => {
  // Get the translated string with variable interpolation (falls back to key if no translation)
  const translated = t(i18nKey, undefined, params);

  // Parse the template and render with components
  const rendered = parseAndRender(translated, components);

  // Return as fragment - the parent wrapper is handled by the transformer
  return <>{rendered}</>;
};
