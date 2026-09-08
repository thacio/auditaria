/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Built-in named workflows shipped with Auditaria.

import type { WorkflowMeta } from '../types.js';
import { parseWorkflowMeta } from '../scriptParser.js';
import { DEEP_RESEARCH_SCRIPT } from './deepResearch.js';

export interface BuiltinWorkflow {
  meta: WorkflowMeta;
  script: string;
}

function builtin(script: string): BuiltinWorkflow {
  return { meta: parseWorkflowMeta(script), script };
}

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  builtin(DEEP_RESEARCH_SCRIPT),
];
