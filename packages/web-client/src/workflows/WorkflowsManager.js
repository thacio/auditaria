/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// Keeps the live list of background workflow runs the server broadcasts and
// re-publishes it to the document so tool cards (rendered long before the run
// settles) can keep updating in place.

export class WorkflowsManager extends EventTarget {
  constructor(wsManager) {
    super();
    this.wsManager = wsManager;
    /** @type {Array<object>} */
    this.runs = [];

    wsManager.addEventListener('workflow_list', (event) => {
      this.runs = Array.isArray(event.detail?.runs) ? event.detail.runs : [];
      this.dispatchEvent(new CustomEvent('list', { detail: this.runs }));
      document.dispatchEvent(
        new CustomEvent('auditaria-workflow-list', { detail: this.runs }),
      );
    });
    wsManager.addEventListener('workflow_event', (event) => {
      this.dispatchEvent(new CustomEvent('event', { detail: event.detail }));
    });
    document.addEventListener('auditaria-workflow-update', (event) => {
      const detail = event.detail || {};
      if (!detail.op || !detail.id) return;
      this.update(detail.op, detail.id, detail.index);
    });
  }

  /** @returns {object|undefined} */
  get(runId) {
    return this.runs.find((r) => r.runId === runId || r.taskId === runId);
  }

  refresh() {
    this.wsManager.send({ type: 'workflow_list_request' });
  }

  /** op: 'stop' | 'skip_agent' | 'retry_agent' */
  update(op, id, index) {
    this.wsManager.send({
      type: 'workflow_update_request',
      op,
      id,
      ...(typeof index === 'number' ? { index } : {}),
    });
  }
}
