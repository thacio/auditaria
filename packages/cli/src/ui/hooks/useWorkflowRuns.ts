/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Cards and the picker share one event subscription pattern.
import { useEffect, useReducer } from 'react';
import type { WorkflowService } from '@google/gemini-cli-core';

export function useWorkflowRuns(service: WorkflowService) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    service.on('change', refresh);
    // Refresh elapsed time even when no provider event arrives.
    const timer = setInterval(() => {
      if (service.registry.running().length) refresh();
    }, 1000);
    return () => {
      service.off('change', refresh);
      clearInterval(timer);
    };
  }, [service]);
  return service.registry.list();
}
