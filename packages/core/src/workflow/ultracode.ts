/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The ultracode opt-in reminders (research 03 §3.3,
// rephrased) and the `+Nk` token-budget directive, applied to every user
// turn before it reaches the model — Gemini or an external provider alike.
//
//   - the keyword "ultracode" in the user's message opts THIS turn in;
//   - session mode (settings.workflows.ultracode, /workflows ultracode on,
//     or a provider effort of `ultra`) is a standing opt-in: one full
//     reminder, then a short one per turn, and an "off" reminder once when
//     it ends;
//   - "+500k" / "+2m" sets the output-token target the next workflow launch
//     uses as budget.total.

import type { PartListUnion, PartUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import { isRecord, stringField } from './guards.js';

export const ULTRACODE_KEYWORD_REMINDER =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.';

export const ULTRACODE_ON_REMINDER =
  'Ultracode is on: optimize for the most exhaustive, correct answer you can produce — token cost is not the constraint. Author and run a workflow with the workflow tool for every substantive task (understand → design → implement → review as separate workflows when the work has phases), adversarially verify your findings, and work solo only on conversational turns or trivial mechanical edits. Load the `workflow-authoring` skill before writing a script.';

export const ULTRACODE_STILL_ON_REMINDER =
  'Ultracode is still on — orchestrate substantive work with the workflow tool and verify findings adversarially.';

export const ULTRACODE_OFF_REMINDER =
  "Ultracode is off — the workflow tool's standard opt-in rule applies again.";

/** Marker of our own injected notification turns — never keyword-scanned. */
const NOTIFICATION_MARKER = '[Auditaria background task event';

const BUDGET_DIRECTIVE = /(^|\s)\+(\d+(?:\.\d+)?)([km])\b/i;

export function isUltracodeSessionOn(config: Config): boolean {
  const service = config.getWorkflowService();
  if (service.ultracodeOverride !== undefined) return service.ultracodeOverride;
  if (config.getWorkflowSettings().ultracode === true) return true;
  const options = config.getProviderConfig()?.options;
  return (
    isRecord(options) && stringField(options, 'reasoningEffort') === 'ultra'
  );
}

function userTextOf(request: PartListUnion): string {
  if (typeof request === 'string') return request;
  const parts: PartUnion[] = Array.isArray(request) ? request : [request];
  return parts
    .map((p) => (typeof p === 'string' ? p : (p.text ?? '')))
    .join('\n');
}

/** Parse a "+500k" / "+2m" directive into output tokens. */
export function parseBudgetDirective(text: string): number | undefined {
  const m = BUDGET_DIRECTIVE.exec(text);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * (m[3].toLowerCase() === 'm' ? 1_000_000 : 1_000));
}

function appendReminder(
  request: PartListUnion,
  reminder: string,
): PartListUnion {
  const block = `<system-reminder>\n${reminder}\n</system-reminder>`;
  if (typeof request === 'string') return `${request}\n\n${block}`;
  const parts: PartUnion[] = Array.isArray(request) ? [...request] : [request];
  parts.push({ text: block });
  return parts;
}

/**
 * Decorate a user turn with the ultracode reminders it earns and record a
 * budget directive. Returns the request unchanged when the workflow tool is
 * disabled or nothing applies.
 */
export function applyUltracodeReminders(
  config: Config,
  request: PartListUnion,
): PartListUnion {
  if (process.env['AUDITARIA_DISABLE_WORKFLOW'] === '1') return request;
  const settings = config.getWorkflowSettings();
  if (settings.enabled === false) return request;
  const service = config.getWorkflowService();
  const text = userTextOf(request);
  if (text.includes(NOTIFICATION_MARKER)) return request;

  const reminders: string[] = [];
  const sessionOn = isUltracodeSessionOn(config);
  if (sessionOn) {
    reminders.push(
      service.ultracodeAnnounced
        ? ULTRACODE_STILL_ON_REMINDER
        : ULTRACODE_ON_REMINDER,
    );
    service.ultracodeAnnounced = true;
  } else if (service.ultracodeAnnounced) {
    reminders.push(ULTRACODE_OFF_REMINDER);
    service.ultracodeAnnounced = false;
  }
  if (
    !sessionOn &&
    settings.keywordTriggerEnabled !== false &&
    /\bultracode\b/i.test(text)
  ) {
    reminders.push(ULTRACODE_KEYWORD_REMINDER);
  }

  const budget = parseBudgetDirective(text);
  if (budget !== undefined) service.setTurnBudget(budget);

  return reminders.reduce(appendReminder, request);
}
