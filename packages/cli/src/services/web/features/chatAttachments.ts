/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import {
  createPartFromBase64,
  type Part,
  type PartListUnion,
} from '@google/genai';
import type { WebLogger } from '../core/types.js';
import { isRecord } from '../protocol.js';

/** Display metadata for an attachment the web client uploaded. */
export interface AttachmentMetadata {
  type: string;
  mimeType: string;
  name: string;
  size: number;
  thumbnail?: string;
  icon?: string;
  displaySize?: string;
}

/**
 * Metadata for uploaded attachments, keyed by the `Part` sent to the model.
 * A WeakMap keeps the Part objects themselves clean (the API rejects unknown
 * fields) while letting the UI recover the original file name, size and
 * thumbnail when it renders the user's message.
 */
export const attachmentMetadataMap = new WeakMap<object, AttachmentMetadata>();

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Converts a web `user_message` (text + base64 attachments) into the query
 * handed to the model. Returns null when there is nothing to send.
 */
export function buildQueryFromUserMessage(
  text: string,
  attachments: unknown,
  logger: WebLogger,
): PartListUnion | null {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return text || null;
  }

  const parts: Part[] = [];
  if (text) {
    parts.push({ text });
  }

  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const data = attachment['data'];
    const mimeType = attachment['mimeType'];
    if (typeof data !== 'string' || typeof mimeType !== 'string') continue;

    const size = attachment['size'];
    try {
      const part = createPartFromBase64(data, mimeType);
      attachmentMetadataMap.set(part, {
        type: optionalString(attachment['type']) ?? '',
        mimeType,
        name: optionalString(attachment['name']) ?? '',
        size: typeof size === 'number' ? size : 0,
        thumbnail: optionalString(attachment['thumbnail']),
        icon: optionalString(attachment['icon']),
        displaySize: optionalString(attachment['displaySize']),
      });
      parts.push(part);
    } catch (error) {
      logger.error('Failed to create part from attachment:', error);
    }
  }

  return parts.length > 0 ? parts : null;
}
