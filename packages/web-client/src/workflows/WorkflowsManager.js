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
    this.pending = new Map();
    this.nextRequest = 0;

    wsManager.addEventListener('workflow_list', (event) => {
      this.runs = Array.isArray(event.detail?.runs) ? event.detail.runs : [];
      window.auditariaWorkflowRuns = this.runs;
      this.dispatchEvent(new CustomEvent('list', { detail: this.runs }));
      document.dispatchEvent(
        new CustomEvent('auditaria-workflow-list', { detail: this.runs }),
      );
    });
    wsManager.addEventListener('workflow_event', (event) => {
      const reply = event.detail;
      if (reply?.event === 'action_result') {
        const pending = this.pending.get(reply.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(reply.requestId);
          if (reply.ok) pending.resolve(reply.detail ?? reply.message);
          else pending.reject(new Error(reply.message));
        }
      }
      this.dispatchEvent(new CustomEvent('event', { detail: event.detail }));
    });
    wsManager.addEventListener('disconnected', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error('Connection lost. Reconnect to manage workflows.'),
        );
      }
      this.pending.clear();
    });
    document.addEventListener('auditaria-workflow-update', (event) => {
      const detail = event.detail || {};
      if (!detail.op || !detail.id) return;
      this.update(detail.op, detail.id, detail.index).catch((error) => {
        this.dispatchEvent(new CustomEvent('error', { detail: error.message }));
      });
    });
  }

  /** @returns {object|undefined} */
  get(runId) {
    return this.runs.find((r) => r.runId === runId || r.taskId === runId);
  }

  refresh() {
    this.wsManager.send({ type: 'workflow_list_request' });
  }

  /** Acknowledged controls shared by the panel and transcript cards. */
  update(op, id, index, scope) {
    const requestId = `workflow-${++this.nextRequest}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error('No response yet. Refresh the run before trying again.'),
        );
      }, 60_000);
      this.pending.set(requestId, { resolve, reject, timer });
      const sent = this.wsManager.send({
        type: 'workflow_update_request',
        requestId,
        op,
        id,
        ...(typeof index === 'number' ? { index } : {}),
        ...(scope ? { scope } : {}),
      });
      if (sent === false) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Connect to Auditaria to manage workflows.'));
      }
    });
  }
}
