/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueueDeferReason } from '../types.js';

export const DEFER_REASON_PREFIX = 'deferred_reason:';

const KNOWN_DEFER_REASONS: QueueDeferReason[] = [
  'raw_text_oversize',
  'raw_markup_oversize',
  'parsed_text_oversize',
  'unknown',
];

export function isKnownDeferReason(value: string): value is QueueDeferReason {
  return (KNOWN_DEFER_REASONS as string[]).includes(value);
}

export function normalizeDeferReason(
  value: string | null | undefined,
): QueueDeferReason {
  if (!value) return 'unknown';
  return isKnownDeferReason(value) ? value : 'unknown';
}

export function encodeDeferReasonInLastError(
  reason: QueueDeferReason | null | undefined,
): string | null {
  if (!reason) return null;
  return `${DEFER_REASON_PREFIX}${normalizeDeferReason(reason)}`;
}

export function parseDeferReasonFromLastError(
  value: string | null | undefined,
): QueueDeferReason | null {
  if (!value || !value.startsWith(DEFER_REASON_PREFIX)) return null;
  return normalizeDeferReason(value.slice(DEFER_REASON_PREFIX.length));
}

export function emptyDeferReasonCounts(): Record<QueueDeferReason, number> {
  return {
    raw_text_oversize: 0,
    raw_markup_oversize: 0,
    parsed_text_oversize: 0,
    unknown: 0,
  };
}

