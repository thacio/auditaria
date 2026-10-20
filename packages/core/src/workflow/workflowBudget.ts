/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Record explicit output-token targets without changing
// the user's request or opting them into workflow execution.

import type { PartListUnion, PartUnion } from '@google/genai';
import type { Config } from '../config/config.js';

const NOTIFICATION_MARKER = '[Auditaria background task event';
const BUDGET_DIRECTIVE = /(^|\s)\+(\d+(?:\.\d+)?)([km])\b/i;

/** Parse a "+500k" / "+2m" directive into output tokens. */
export function parseBudgetDirective(text: string): number | undefined {
  const match = BUDGET_DIRECTIVE.exec(text);
  if (!match) return undefined;
  const amount = Number(match[2]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return Math.round(
    amount * (match[3].toLowerCase() === 'm' ? 1_000_000 : 1_000),
  );
}

export function recordWorkflowBudget(
  config: Config,
  request: PartListUnion,
): void {
  if (
    process.env['AUDITARIA_DISABLE_WORKFLOW'] === '1' ||
    config.getWorkflowSettings().enabled === false
  )
    return;

  const parts: PartUnion[] = Array.isArray(request) ? request : [request];
  const text = parts
    .map((part) => (typeof part === 'string' ? part : (part.text ?? '')))
    .join('\n');
  if (text.includes(NOTIFICATION_MARKER)) return;

  const budget = parseBudgetDirective(text);
  if (budget !== undefined) config.getWorkflowService().setTurnBudget(budget);
}
