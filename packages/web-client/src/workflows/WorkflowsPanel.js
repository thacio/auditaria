/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatDuration } from '../utils/formatters.js';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  workflowUsageLabel as usageLabel,
  workflowRunUsage as runUsage,
} from './workflowDisplay.js';

// WEB_INTERFACE_FEATURE: Interactive workflow management and transcript details.

export function workflowGroups(progress = []) {
  const groups = new Map();
  for (const row of progress) {
    if (row.type === 'workflow_phase') {
      groups.set(row.index, { ...row, agents: [] });
    }
  }
  for (const row of progress) {
    if (row.type !== 'workflow_agent') continue;
    if (!groups.has(row.phaseIndex)) {
      groups.set(row.phaseIndex, {
        index: row.phaseIndex,
        title: row.phaseTitle || 'Agents',
        agents: [],
      });
    }
    groups.get(row.phaseIndex).agents.push(row);
  }
  return [...groups.values()].sort((a, b) => a.index - b.index);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, key, className = 'wf-button') {
  const node = el('button', className, label);
  node.type = 'button';
  if (key) node.dataset.focusKey = key;
  node.addEventListener('click', action);
  return node;
}

function agentStatus(agent, run) {
  if (agent.skipped) return 'skipped';
  if (agent.cached) return 'cached';
  if (agent.state === 'done') return 'completed';
  if (agent.state === 'error') return 'failed';
  return run.status === 'running'
    ? agent.startedAt
      ? 'running'
      : 'queued'
    : 'stopped';
}

function badge(status) {
  const node = el('span', 'wf-status', status);
  node.dataset.status = status;
  return node;
}

function chevron() {
  const node = el('span', 'wf-chevron', '›');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function phaseStatus(group, run) {
  if (!group.agents.length) return 'planned';
  const states = group.agents.map((agent) => agentStatus(agent, run));
  if (states.includes('running')) return 'running';
  if (states.includes('queued')) return 'queued';
  if (states.includes('failed')) return 'failed';
  if (states.includes('stopped'))
    return run.status === 'paused' ? 'paused' : 'stopped';
  return 'completed';
}

function copyButton(label, text, key) {
  const node = button(
    '',
    () => void copyToClipboard(text, 'formatted', node),
    key,
    'wf-button wf-copy',
  );
  node.title = label;
  node.append(el('span', 'copy-label', label));
  return node;
}

/** Native dialog supplies focus containment and Escape; state comes from the manager. */
export class WorkflowsPanel {
  constructor(manager) {
    this.manager = manager;
    this.runId = null;
    this.agentIndex = null;
    this.query = '';
    this.filter = 'all';
    this.agentFilter = 'all';
    this.collapsed = new Set();
    this.busy = false;
    this.saveScope = 'project';
    this.agentDetails = new Map();
    this.loadingDetails = new Set();
    document.addEventListener('selectionchange', () => {
      if (this.renderDeferred && document.getSelection()?.isCollapsed) {
        this.renderDeferred = false;
        this.render();
      }
    });
    manager.addEventListener('list', () => this.render());
    manager.addEventListener('error', (event) =>
      this.message(event.detail, true),
    );
    document.addEventListener('auditaria-workflow-open', (event) =>
      this.open(event.detail?.id),
    );
  }

  mount() {
    if (this.dialog) return;
    this.dialog = el('dialog', 'workflows-dialog');
    this.dialog.setAttribute('aria-labelledby', 'workflows-title');
    const header = el('header', 'wf-header');
    const heading = el('div');
    heading.append(el('div', 'wf-eyebrow', 'AUDITARIA'));
    const title = el('h2', '', 'Workflows');
    title.id = 'workflows-title';
    heading.append(title);
    header.append(heading);
    this.count = el('span', 'wf-muted');
    header.append(this.count);
    header.append(
      button('Close', () => this.hide(), 'close', 'wf-button wf-close'),
    );
    this.dialog.append(header);
    const toolbar = el('div', 'wf-toolbar');
    const search = el('input', 'wf-search');
    search.type = 'search';
    search.placeholder = 'Find a workflow…';
    search.setAttribute('aria-label', 'Search workflows');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
    });
    const filter = el('select', 'wf-select');
    filter.setAttribute('aria-label', 'Filter workflow status');
    for (const status of [
      'all',
      'running',
      'completed',
      'paused',
      'failed',
      'killed',
    ]) {
      const option = el(
        'option',
        '',
        status === 'all'
          ? 'All runs'
          : status[0].toUpperCase() + status.slice(1),
      );
      option.value = status;
      filter.append(option);
    }
    filter.addEventListener('change', () => {
      this.filter = filter.value;
      this.render();
    });
    toolbar.append(
      search,
      filter,
      button('Refresh', () => this.manager.refresh(), 'refresh'),
    );
    this.dialog.append(toolbar);
    const body = el('div', 'wf-body');
    this.list = el('nav', 'wf-runs');
    this.list.setAttribute('aria-label', 'Workflow runs');
    this.content = el('main', 'wf-content');
    body.append(this.list, this.content);
    this.dialog.append(body);
    this.feedback = el('div', 'wf-feedback');
    this.feedback.setAttribute('role', 'status');
    this.dialog.append(this.feedback);
    document.body.append(this.dialog);
    this.dialog.addEventListener('click', (event) => {
      if (event.target !== this.dialog) return;
      const bounds = this.dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        this.hide();
    });
    this.dialog.addEventListener('close', () => {
      clearInterval(this.timer);
      this.opener?.focus();
    });
  }

  open(id) {
    this.mount();
    if (id) {
      this.runId = this.manager.get(id)?.runId ?? id;
      this.query = '';
      this.filter = 'all';
      this.dialog.querySelector('.wf-search').value = '';
      this.dialog.querySelector('[aria-label="Filter workflow status"]').value =
        'all';
    }
    if (!this.dialog.open) {
      this.opener = document.activeElement;
      this.dialog.showModal();
      this.timer = setInterval(() => {
        this.updateElapsed();
        void this.loadAgentDetail();
      }, 1000);
    }
    this.manager.refresh();
    this.render();
  }

  hide() {
    this.dialog?.close();
  }
  toggle() {
    if (this.dialog?.open) this.hide();
    else this.open();
  }

  message(text, error = false) {
    if (!this.feedback) return;
    this.feedback.textContent = text || '';
    this.feedback.dataset.error = String(error);
  }

  async action(op, run, index, scope) {
    if (this.busy) return;
    this.busy = true;
    this.message('Updating workflow…');
    this.render();
    try {
      this.message(await this.manager.update(op, run.runId, index, scope));
    } catch (error) {
      this.message(error.message, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  updateElapsed() {
    const run = this.manager.get(this.runId);
    const node = this.content?.querySelector('[data-elapsed]');
    if (run && node)
      node.textContent = formatDuration(
        Math.max(0, (run.endTime ?? Date.now()) - run.startTime),
      );
  }

  render() {
    if (!this.dialog?.open) return;
    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      this.content.contains(selection.anchorNode)
    ) {
      this.renderDeferred = true;
      return;
    }
    const focused = document.activeElement?.dataset.focusKey;
    const contentScroll = this.content.scrollTop;
    const listScroll = this.list.scrollTop;
    const sectionScroll = new Map(
      [...this.content.querySelectorAll('[data-scroll-key]')].map((node) => [
        node.dataset.scrollKey,
        [node.scrollTop, node.scrollLeft],
      ]),
    );
    const all = this.manager.runs;
    const visible = all.filter(
      (run) =>
        (this.filter === 'all' || run.status === this.filter) &&
        `${run.title ?? ''} ${run.name} ${run.description} ${run.provider}`
          .toLowerCase()
          .includes(this.query.toLowerCase()),
    );
    const run = visible.find((r) => r.runId === this.runId) ?? visible[0];
    this.runId = run?.runId ?? null;
    this.count.textContent = `${all.filter((r) => r.status === 'running').length} active · ${all.length} total`;
    this.list.replaceChildren();
    this.content.replaceChildren();
    for (const row of visible) {
      const item = button(
        '',
        () => {
          this.runId = row.runId;
          this.agentIndex = null;
          this.render();
          this.content.scrollTop = 0;
        },
        row.runId,
        'wf-run',
      );
      item.setAttribute('aria-pressed', String(row.runId === this.runId));
      item.append(
        badge(row.status),
        el('strong', '', row.title || row.name),
        el('span', 'wf-muted', row.description),
      );
      item.append(
        el(
          'span',
          'wf-run-meta',
          `${row.agentsDone}/${row.agentCount} agents · ${runUsage(row)}`,
        ),
      );
      this.list.append(item);
    }
    if (!run) {
      this.content.append(
        el('div', 'wf-empty-symbol', '⧉'),
        el(
          'h3',
          '',
          all.length ? 'No matching workflows' : 'Your workflows start here',
        ),
      );
      this.content.append(
        el(
          'p',
          'wf-muted',
          all.length
            ? 'Change the search or status filter to find a run.'
            : 'Ask Auditaria to run a workflow. Follow its phases, inspect each agent, and reuse the script here.',
        ),
      );
    } else {
      this.renderRun(run);
    }
    this.content.scrollTop = contentScroll;
    this.list.scrollTop = listScroll;
    for (const node of this.content.querySelectorAll('[data-scroll-key]')) {
      const position = sectionScroll.get(node.dataset.scrollKey);
      if (position) [node.scrollTop, node.scrollLeft] = position;
    }
    if (focused)
      [...this.dialog.querySelectorAll('[data-focus-key]')]
        .find((node) => node.dataset.focusKey === focused)
        ?.focus({ preventScroll: true });
  }

  renderRun(run) {
    const navigation = el('nav', 'wf-run-navigation');
    navigation.setAttribute('aria-label', 'Run sections');
    for (const [key, label, available] of [
      ['phases', 'Phases', true],
      ['result', 'Results', run.result !== undefined],
      ['activity', 'Activity', Boolean(run.logs?.length)],
    ]) {
      const jump = button(
        label,
        () => {
          const section = this.content.querySelector(`[data-section="${key}"]`);
          section?.scrollIntoView({ block: 'start' });
          section?.focus({ preventScroll: true });
        },
        `jump-${key}`,
        'wf-button wf-section-link',
      );
      jump.disabled = !available;
      if (!available && key === 'result')
        jump.title = 'The result appears when the workflow finishes.';
      navigation.append(jump);
    }
    this.content.append(navigation);
    const heading = el('div', 'wf-run-heading');
    const identity = el('div');
    const eyebrow = el('div', 'wf-identity');
    eyebrow.append(badge(run.status), el('span', 'wf-muted', run.provider));
    identity.append(
      eyebrow,
      el('h3', '', run.title || run.name),
      el('p', 'wf-muted', run.description),
    );
    heading.append(identity);
    this.content.append(heading);
    const metrics = el('div', 'wf-metrics');
    for (const [label, value] of [
      ['Agents complete', `${run.agentsDone} / ${run.agentCount}`],
      ['Output usage', runUsage(run)],
      ['Tool calls', run.totalToolCalls.toLocaleString()],
      ['Elapsed', ''],
    ]) {
      const cell = el('div');
      const number = el('strong', '', value);
      if (label === 'Elapsed') number.dataset.elapsed = '';
      cell.append(number, el('span', 'wf-muted', label));
      metrics.append(cell);
    }
    this.content.append(metrics);
    const progress = el('progress', 'wf-progress');
    progress.max = Math.max(1, run.agentCount);
    progress.value = run.agentsDone;
    progress.setAttribute('aria-label', 'Completed agents');
    this.content.append(progress);
    const actions = el('div', 'wf-actions');
    const control = (label, op) => {
      const node = button(label, () => this.action(op, run), `run-${op}`);
      node.disabled = this.busy;
      if (op === 'stop') node.classList.add('wf-danger');
      return node;
    };
    if (run.status === 'running')
      actions.append(
        control('Pause', 'pause'),
        control('Stop workflow', 'stop'),
      );
    else
      actions.append(
        control(
          run.status === 'completed' ? 'Run again' : 'Resume workflow',
          'resume',
        ),
      );
    const scope = el('select', 'wf-select');
    scope.setAttribute('aria-label', 'Save workflow location');
    scope.dataset.focusKey = 'save-scope';
    for (const value of ['project', 'user']) {
      const option = el(
        'option',
        '',
        value === 'project' ? 'Save in project' : 'Save for your user',
      );
      option.value = value;
      scope.append(option);
    }
    scope.value = this.saveScope;
    scope.addEventListener('change', () => {
      this.saveScope = scope.value;
    });
    const save = button(
      'Save script',
      () => this.action('save', run, undefined, scope.value),
      'save',
    );
    save.disabled = this.busy;
    actions.append(scope, save);
    this.content.append(actions);
    const phaseHeading = el('div', 'wf-section-heading');
    phaseHeading.dataset.section = 'phases';
    phaseHeading.dataset.focusKey = `section-${run.runId}-phases`;
    phaseHeading.tabIndex = -1;
    phaseHeading.append(el('h4', '', 'Phases'));
    const filter = el('select', 'wf-select');
    filter.setAttribute('aria-label', 'Filter agents');
    filter.dataset.focusKey = 'agent-filter';
    for (const state of [
      'all',
      'running',
      'queued',
      'completed',
      'failed',
      'cached',
      'skipped',
      'stopped',
    ]) {
      const option = el('option', '', state === 'all' ? 'All agents' : state);
      option.value = state;
      filter.append(option);
    }
    filter.value = this.agentFilter;
    filter.addEventListener('change', () => {
      this.agentFilter = filter.value;
      this.render();
    });
    phaseHeading.append(filter);
    this.content.append(phaseHeading);
    const groups = workflowGroups(run.progress);
    if (!groups.length)
      this.content.append(
        el('p', 'wf-muted', 'The workflow is preparing its first agents.'),
      );
    for (const group of groups) {
      const section = el('details', 'wf-phase');
      const phaseKey = `${run.runId}:${group.index}`;
      section.open = !this.collapsed.has(phaseKey);
      section.addEventListener('toggle', () => {
        if (section.open) this.collapsed.delete(phaseKey);
        else this.collapsed.add(phaseKey);
      });
      const title = el('summary');
      title.dataset.focusKey = phaseKey;
      const state = phaseStatus(group, run);
      section.dataset.status = state;
      title.append(
        chevron(),
        el('strong', '', group.title),
        badge(state),
        el(
          'span',
          'wf-muted',
          `${group.agents.filter((a) => a.state === 'done').length}/${group.agents.length}`,
        ),
      );
      section.append(title);
      const agents = group.agents.filter(
        (agent) =>
          this.agentFilter === 'all' ||
          agentStatus(agent, run) === this.agentFilter,
      );
      for (const agent of agents) {
        const row = button(
          '',
          () => {
            this.agentIndex =
              this.agentIndex === agent.index ? null : agent.index;
            this.render();
            void this.loadAgentDetail();
          },
          `agent-${agent.index}`,
          'wf-agent',
        );
        row.setAttribute(
          'aria-expanded',
          String(this.agentIndex === agent.index),
        );
        row.append(
          chevron(),
          badge(agentStatus(agent, run)),
          el('span', 'wf-agent-label', agent.label || agent.promptPreview),
          el(
            'span',
            'wf-muted',
            `${agent.model ?? 'default'} · ${usageLabel(agent.tokens, agent.usageUnavailable)}`,
          ),
        );
        section.append(row);
        if (this.agentIndex === agent.index)
          section.append(this.renderAgent(run, agent));
      }
      if (!agents.length)
        section.append(
          el(
            'p',
            'wf-muted wf-phase-empty',
            group.agents.length
              ? 'No agents match this filter.'
              : 'Waiting for this phase.',
          ),
        );
      this.content.append(section);
    }
    if (run.error) this.content.append(el('pre', 'wf-error', run.error));
    if (run.logs?.length) {
      const logs = el('section', 'wf-logs');
      logs.dataset.section = 'activity';
      logs.dataset.focusKey = `section-${run.runId}-activity`;
      logs.tabIndex = -1;
      logs.append(el('h4', '', 'Activity log'));
      for (const message of run.logs) logs.append(el('p', '', message));
      this.content.append(logs);
    }
    if (run.result !== undefined) {
      const result = el('section', 'wf-result');
      result.dataset.section = 'result';
      result.dataset.focusKey = `section-${run.runId}-result`;
      result.tabIndex = -1;
      const text =
        typeof run.result === 'string'
          ? run.result
          : JSON.stringify(run.result, null, 2);
      const resultHeading = el('div', 'wf-detail-heading');
      resultHeading.append(
        el('h4', '', 'Result'),
        copyButton('Copy result', text, 'copy-run-result'),
      );
      const output = el('pre', '', text || 'The workflow returned no text.');
      output.dataset.scrollKey = `${run.runId}:result`;
      result.append(resultHeading, output);
      this.content.append(result);
    }
    this.content.append(el('p', 'wf-run-id', `${run.taskId} · ${run.runId}`));
    this.updateElapsed();
  }

  renderAgent(run, agent) {
    const transcript = this.agentDetails.get(
      `${run.runId}:${agent.index}:${agent.agentId}`,
    )?.detail;
    const detail = el('section', 'wf-agent-detail');
    detail.append(
      el(
        'p',
        'wf-muted',
        `${agent.agentType ?? 'General agent'} · ${agent.toolCalls ?? 0} tool calls${agent.attempt ? ` · attempt ${agent.attempt}` : ''}${agent.durationMs !== undefined ? ` · ${formatDuration(agent.durationMs)}` : ''}`,
      ),
    );
    for (const [label, value] of [
      [
        transcript ? 'Prompt' : 'Prompt preview',
        transcript?.prompt || agent.promptPreview,
      ],
      [
        'Recent tool calls',
        transcript?.tools?.length
          ? transcript.tools
              .map((tool) => `${tool.name}: ${tool.summary}`)
              .join('\n\n')
          : agent.lastToolName
            ? `${agent.lastToolName}: ${agent.lastToolSummary ?? ''}`
            : undefined,
      ],
      [
        transcript?.result !== undefined ? 'Result' : 'Result preview',
        transcript?.result ||
          agent.resultPreview ||
          (agent.error
            ? undefined
            : agent.skipped
              ? 'Skipped by the user.'
              : agent.state === 'done'
                ? 'The agent returned no text.'
                : run.status !== 'running'
                  ? 'The workflow has stopped.'
                  : agent.startedAt
                    ? 'Waiting for the agent to finish.'
                    : 'Waiting for an execution slot.'),
      ],
      ['Error', agent.error],
    ]) {
      if (value) {
        const text = el('pre', '', value);
        text.dataset.scrollKey = `${run.runId}:${agent.index}:${label.replace(' preview', '')}`;
        const heading = el('div', 'wf-detail-heading');
        heading.append(el('h5', '', label));
        if (
          label.startsWith('Result') &&
          (transcript?.result || agent.resultPreview)
        )
          heading.append(
            copyButton(
              'Copy result',
              value,
              `copy-agent-result-${agent.index}`,
            ),
          );
        detail.append(heading, text);
      }
    }
    if (transcript?.truncated)
      detail.append(
        el('p', 'wf-muted', 'Large transcript: showing a limited excerpt.'),
      );
    if (
      run.status === 'running' &&
      (agent.state === 'start' || agent.state === 'progress')
    ) {
      const actions = el('div', 'wf-actions');
      for (const [label, op] of [
        ['Restart agent', 'retry_agent'],
        ['Stop agent', 'skip_agent'],
      ]) {
        const node = button(
          label,
          () => this.action(op, run, agent.index),
          `${op}-${agent.index}`,
        );
        node.disabled = this.busy;
        if (op === 'skip_agent') node.classList.add('wf-danger');
        actions.append(node);
      }
      detail.append(actions);
    }
    return detail;
  }

  async loadAgentDetail() {
    if (!this.dialog?.open || this.agentIndex === null) return;
    const run = this.manager.get(this.runId);
    const agent = run?.progress.find(
      (row) => row.type === 'workflow_agent' && row.index === this.agentIndex,
    );
    if (!agent?.agentId) return;
    const key = `${run.runId}:${agent.index}:${agent.agentId}`;
    if (
      this.loadingDetails.has(key) ||
      (this.agentDetails.get(key)?.status === run.status &&
        run.status !== 'running')
    )
      return;
    this.loadingDetails.add(key);
    try {
      const detail = await this.manager.update(
        'agent_detail',
        run.runId,
        agent.index,
      );
      const previous = this.agentDetails.get(key);
      this.agentDetails.set(key, { detail, status: run.status });
      if (
        JSON.stringify(previous?.detail) !== JSON.stringify(detail) ||
        previous?.status !== run.status
      )
        this.render();
    } catch {
      // A queued agent may not have created its transcript yet. Keep the preview.
    } finally {
      this.loadingDetails.delete(key);
    }
  }
}
