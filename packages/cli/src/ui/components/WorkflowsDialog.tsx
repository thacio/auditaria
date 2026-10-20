/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Interactive run → phase → agent navigation.
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import {
  workflowPhaseGroups,
  workflowUsageLabel,
  type WorkflowAgentRow,
  type WorkflowService,
  type WorkflowAgentDetail,
} from '@google/gemini-cli-core';
import { useWorkflowRuns } from '../hooks/useWorkflowRuns.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { BaseSelectionList } from './shared/BaseSelectionList.js';
import { DialogFooter } from './shared/DialogFooter.js';
import { formatDuration } from '../utils/formatters.js';
import { theme } from '../semantic-colors.js';

type View = 'runs' | 'phases' | 'agents' | 'agent';
const FILTERS = ['all', 'running', 'completed', 'failed'] as const;

function agentStatus(agent: WorkflowAgentRow, running: boolean) {
  if (agent.skipped) return 'skipped';
  if (agent.cached) return 'cached';
  if (agent.state === 'done') return 'completed';
  if (agent.state === 'error') return 'failed';
  return running ? (agent.startedAt ? 'running' : 'queued') : 'stopped';
}

function glyph(status: string) {
  if (status === 'completed' || status === 'cached') return '✔';
  if (status === 'failed') return '✗';
  if (status === 'running') return '●';
  if (status === 'paused') return 'Ⅱ';
  return '○';
}

export function WorkflowsDialog({
  service,
  onClose,
  initialRunId,
}: {
  service: WorkflowService;
  onClose: () => void;
  initialRunId?: string;
}) {
  const runs = useWorkflowRuns(service);
  const initial =
    initialRunId ?? (runs.length === 1 ? runs[0].runId : undefined);
  const [view, setView] = useState<View>(initial ? 'phases' : 'runs');
  const [runId, setRunId] = useState(initial ?? runs[0]?.runId);
  const [phaseIndex, setPhaseIndex] = useState<number>();
  const [agentIndex, setAgentIndex] = useState<number>();
  const [filter, setFilter] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveScope, setSaveScope] = useState<'project' | 'user'>('project');
  const [transcript, setTranscript] = useState<WorkflowAgentDetail>();
  const { columns, rows } = useTerminalSize();
  const width = Math.max(20, columns - 4);
  const height = Math.max(3, Math.min(22, rows - 12 - (notice ? 1 : 0)));
  const split = width >= 68 && view !== 'runs';
  const visibleRuns = runs.filter((r) =>
    `${r.meta.name} ${r.meta.description} ${r.runId}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const run =
    (view === 'runs' ? visibleRuns : runs).find((r) => r.runId === runId) ??
    (view === 'runs' ? visibleRuns[0] : undefined);
  const groups = workflowPhaseGroups(run?.workflowProgress ?? []);
  const phase = groups.find((p) => p.index === phaseIndex) ?? groups[0];
  const agents = (phase?.agents ?? []).filter((a) => {
    const selected = view === 'agents' ? FILTERS[filter] : 'all';
    const state = agentStatus(a, run?.status === 'running');
    return (
      selected === 'all' ||
      state === selected ||
      (selected === 'completed' && state === 'cached') ||
      (selected === 'running' && state === 'queued')
    );
  });
  const agent = agents.find((a) => a.index === agentIndex) ?? agents[0];
  const summary = run ? service.registry.summaryOf(run) : undefined;
  const selectedRunId = run?.runId;
  const selectedAgentIndex = agent?.index;
  useEffect(() => {
    setTranscript(undefined);
    if (view !== 'agent' || !selectedRunId || selectedAgentIndex === undefined)
      return;
    let disposed = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      const detail = await service.agentDetail(
        selectedRunId,
        selectedAgentIndex,
      );
      if (!disposed) setTranscript(detail);
      loading = false;
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [service, selectedRunId, selectedAgentIndex, view]);

  const act = async (action: () => string | Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try {
      setNotice(await action());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    setNotice('');
    setScroll(0);
    if (view === 'agent') setView('agents');
    else if (view === 'agents') setView('phases');
    else if (view === 'phases' && runs.length > 1) setView('runs');
    else onClose();
  };
  const enter = () => {
    setScroll(0);
    if (view === 'runs' && run) {
      setRunId(run.runId);
      setView('phases');
    } else if (view === 'phases' && phase) setView('agents');
    else if (view === 'agents' && agent) setView('agent');
  };
  const detailWidth = Math.max(16, split ? width - 34 : width - 2);
  const detail = agent
    ? [
        `${agentStatus(agent, run?.status === 'running')} · ${agent.model ?? 'default model'}`,
        `${workflowUsageLabel(agent.tokens, agent.usageUnavailable)} · ${agent.toolCalls ?? 0} tool calls${agent.attempt ? ` · attempt ${agent.attempt}` : ''}`,
        `${agent.agentType ?? 'General agent'} · ${agent.durationMs !== undefined ? formatDuration(agent.durationMs) : agent.startedAt ? formatDuration(Date.now() - agent.startedAt) : 'Queued'}`,
        '',
        transcript ? 'Prompt' : 'Prompt preview',
        transcript?.prompt || agent.promptPreview,
        '',
        'Recent tool calls',
        transcript?.tools.length
          ? transcript.tools
              .map((tool) => `${tool.name}: ${tool.summary}`)
              .join('\n')
          : agent.lastToolName
            ? `${agent.lastToolName}: ${agent.lastToolSummary ?? ''}`
            : 'No tool calls recorded.',
        '',
        agent.error
          ? 'Error'
          : transcript?.result !== undefined
            ? 'Result'
            : 'Result preview',
        agent.error ||
          transcript?.result ||
          agent.resultPreview ||
          (agent.skipped
            ? 'Skipped by the user.'
            : agent.state === 'done'
              ? 'The agent returned no text.'
              : run?.status !== 'running'
                ? 'The workflow has stopped.'
                : agent.startedAt
                  ? 'Waiting for the agent to finish.'
                  : 'Waiting for an execution slot.'),
        ...(transcript?.truncated
          ? ['', 'Large transcript: showing a limited excerpt.']
          : []),
      ].join('\n')
    : 'No agents in this phase.';
  const lines = wrapAnsi(stripAnsi(detail), detailWidth, {
    hard: true,
    trim: false,
  }).split('\n');
  const detailHeight = expanded ? height : Math.min(height, 10);
  const maxScroll = Math.max(0, lines.length - detailHeight);
  const offset = Math.min(scroll, maxScroll);

  useKeypress(
    (key) => {
      if (key.ctrl || key.alt || key.cmd) return false;
      const submit = key.name === 'enter' || key.name === 'return';
      if (saving) {
        if (key.name === 'escape') setSaving(false);
        else if (key.name === 'tab')
          setSaveScope((s) => (s === 'project' ? 'user' : 'project'));
        else if (submit && run) {
          setSaving(false);
          void act(() => `Saved to ${service.save(run.runId, saveScope)}`);
        }
        return true;
      }
      if (searching) {
        if (key.name === 'escape') {
          setSearching(false);
          setQuery('');
        } else if (submit) setSearching(false);
        else if (key.name === 'backspace') setQuery((q) => q.slice(0, -1));
        else if (key.insertable) setQuery((q) => q + key.sequence);
        return true;
      }
      if (key.name === 'escape' || key.name === 'left') {
        back();
        return true;
      }
      if (key.name === 'right') {
        enter();
        return true;
      }
      if (key.name === '/' && view === 'runs') {
        setSearching(true);
        return true;
      }
      if (key.name === 'f' && (view === 'agents' || view === 'agent')) {
        setFilter((f) => (f + 1) % FILTERS.length);
        setScroll(0);
        return true;
      }
      if (submit && view === 'agent') {
        setExpanded((e) => !e);
        setScroll(0);
        return true;
      }
      if ((key.name === 'j' || key.name === 'k') && view === 'agent') {
        setScroll((s) =>
          Math.max(0, Math.min(maxScroll, s + (key.name === 'j' ? 1 : -1))),
        );
        return true;
      }
      if (
        !split &&
        view === 'agent' &&
        (key.name === 'up' || key.name === 'down')
      ) {
        const current = agents.findIndex((a) => a.index === agent?.index);
        const next = Math.max(
          0,
          Math.min(agents.length - 1, current + (key.name === 'down' ? 1 : -1)),
        );
        setAgentIndex(agents[next]?.index);
        setScroll(0);
        return true;
      }
      if (!run || busy) return false;
      if (key.name === 's') {
        setSaving(true);
        return true;
      }
      if (key.name === 'p') {
        void act(async () => {
          if (run.status === 'running')
            return service.pause(run.runId)
              ? 'Pausing workflow…'
              : 'This run has already stopped.';
          await service.resume(run.runId);
          return 'Workflow resumed.';
        });
        return true;
      }
      if (key.name === 'x') {
        void act(() => {
          if ((view === 'agents' || view === 'agent') && agent) {
            return service.skipAgent(run.runId, agent.index)
              ? 'Stopping agent…'
              : 'This agent is no longer running.';
          }
          const result = service.stop(run.runId);
          return result.ok ? 'Stopping workflow…' : result.message;
        });
        return true;
      }
      if (
        key.name === 'r' &&
        (view === 'agents' || view === 'agent') &&
        agent
      ) {
        void act(() =>
          service.retryAgent(run.runId, agent.index)
            ? 'Restarting agent…'
            : 'Only an active agent can restart.',
        );
        return true;
      }
      return false;
    },
    { isActive: true, priority: true },
  );

  const phaseList = (
    <BaseSelectionList<number>
      key={`${run?.runId}:phases`}
      items={groups.map((p) => ({ key: String(p.index), value: p.index }))}
      initialIndex={Math.max(
        0,
        groups.findIndex((p) => p.index === phase?.index),
      )}
      selectedIndicator="❯"
      onHighlight={setPhaseIndex}
      onSelect={(index) => {
        setPhaseIndex(index);
        setView('agents');
      }}
      isFocused={view === 'phases' && !saving}
      showNumbers={false}
      maxItemsToShow={height}
      renderItem={(item, context) => {
        const p = groups.find((g) => g.index === item.value)!;
        return (
          <Text color={context.titleColor} wrap="truncate-end">
            {p.title}{' '}
            {`${p.agents.filter((a) => a.state === 'done').length}/${p.agents.length}`}
          </Text>
        );
      }}
    />
  );
  const agentList = (
    <BaseSelectionList<number>
      key={`${run?.runId}:${phase?.index}:${filter}`}
      items={agents.map((a) => ({ key: String(a.index), value: a.index }))}
      initialIndex={Math.max(
        0,
        agents.findIndex((a) => a.index === agent?.index),
      )}
      selectedIndicator="❯"
      onHighlight={(index) => {
        setAgentIndex(index);
        setScroll(0);
      }}
      onSelect={(index) => {
        setAgentIndex(index);
        setView('agent');
      }}
      isFocused={(view === 'agents' || view === 'agent') && !saving}
      showNumbers={false}
      maxItemsToShow={height}
      renderItem={(item, context) => {
        const a = agents.find((entry) => entry.index === item.value)!;
        const state = agentStatus(a, run?.status === 'running');
        return (
          <Text color={context.titleColor} wrap="truncate-end">
            {glyph(state)} {a.label || a.promptPreview}
            {view !== 'agent'
              ? ` · ${a.model ?? 'default'} · ${workflowUsageLabel(a.tokens, a.usageUnavailable)}`
              : ''}
          </Text>
        );
      }}
    />
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.border.default}
      paddingX={1}
    >
      <Text bold color={theme.text.primary}>
        {view === 'runs'
          ? 'Workflows'
          : (run?.meta.title ?? run?.meta.name ?? 'Workflow')}
      </Text>
      <Text color={theme.text.secondary} wrap="truncate-end">
        {view === 'runs'
          ? `${runs.length} runs · ${runs.filter((r) => r.status === 'running').length} active`
          : run?.meta.description}
      </Text>
      {summary && view !== 'runs' && (
        <Text color={theme.text.secondary}>
          {`${summary.agentsDone}/${summary.agentCount} agents · ${workflowUsageLabel(
            summary.totalTokens,
            groups.some((g) => g.agents.some((a) => a.usageUnavailable)),
          )} · ${formatDuration((run?.endTime ?? Date.now()) - summary.startTime)} · ${summary.status}`}
        </Text>
      )}
      {saving ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{`Save workflow: ${run?.meta.name ?? ''}`}</Text>
          <Text color={theme.text.accent}>
            Location:{' '}
            {saveScope === 'project' ? 'This project' : 'Your user workflows'}
          </Text>
          <Text color={theme.text.secondary}>
            Enter save · Tab change location · Esc cancel
          </Text>
        </Box>
      ) : view === 'runs' ? (
        <>
          {(searching || query) && (
            <Text color={theme.text.accent}>
              {`Search: ${query}${searching ? '▏' : ''}`}
            </Text>
          )}
          {visibleRuns.length ? (
            <BaseSelectionList<string>
              items={visibleRuns.map((r) => ({ key: r.runId, value: r.runId }))}
              initialIndex={Math.max(
                0,
                visibleRuns.findIndex((r) => r.runId === run?.runId),
              )}
              selectedIndicator="❯"
              onHighlight={setRunId}
              onSelect={(id) => {
                setRunId(id);
                setView('phases');
              }}
              isFocused={!searching}
              showNumbers={false}
              maxItemsToShow={height}
              renderItem={(item, context) => {
                const r = visibleRuns.find(
                  (entry) => entry.runId === item.value,
                )!;
                const s = service.registry.summaryOf(r);
                return (
                  <Text color={context.titleColor} wrap="truncate-end">
                    {`${glyph(r.status)} ${r.meta.title ?? r.meta.name} · ${s.agentsDone}/${s.agentCount} agents · ${r.status} · ${formatDuration((r.endTime ?? Date.now()) - r.startTime)}`}
                  </Text>
                );
              }}
            />
          ) : (
            <Text color={theme.text.secondary}>
              {query
                ? 'No matching runs.'
                : 'No workflows yet. Ask the agent to run a workflow.'}
            </Text>
          )}
        </>
      ) : view === 'agent' ? (
        <Box marginTop={1}>
          {split && (
            <Box width={30} flexDirection="column" marginRight={2}>
              {agentList}
            </Box>
          )}
          <Box flexDirection="column" width={detailWidth}>
            <Text bold>{agent?.label}</Text>
            <Text>{lines.slice(offset, offset + detailHeight).join('\n')}</Text>
            <Text color={theme.text.secondary}>
              {`${offset + 1}–${Math.min(lines.length, offset + detailHeight)} of ${lines.length} lines`}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection={split ? 'row' : 'column'}>
          {(split || view === 'phases') && (
            <Box
              width={split ? 30 : undefined}
              marginRight={split ? 2 : 0}
              flexDirection="column"
            >
              <Text bold>Phases</Text>
              {phaseList}
            </Box>
          )}
          {(split || view === 'agents') && (
            <Box flexGrow={1} flexDirection="column">
              <Text bold>
                {phase?.title ?? 'Agents'}
                {filter ? ` · ${FILTERS[filter]}` : ''}
              </Text>
              {view === 'phases' && agents.length ? (
                agents.slice(0, height).map((a) => (
                  <Text key={a.index} wrap="truncate-end">
                    {glyph(agentStatus(a, run?.status === 'running'))}{' '}
                    {a.label || a.promptPreview} · {a.model ?? 'default'} ·{' '}
                    {workflowUsageLabel(a.tokens, a.usageUnavailable)}
                  </Text>
                ))
              ) : agents.length ? (
                agentList
              ) : (
                <Text color={theme.text.secondary}>
                  No agents in this view.
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}
      {notice && (
        <Text color={theme.text.accent} wrap="truncate-end">
          {notice}
        </Text>
      )}
      {!saving && (
        <DialogFooter
          primaryAction={
            view === 'agent'
              ? 'Enter expand/collapse · j/k scroll'
              : '↑/↓ select · Enter view'
          }
          navigationActions={
            view === 'runs'
              ? '/ search'
              : view === 'phases'
                ? undefined
                : run?.status === 'running' &&
                    agent &&
                    (agent.state === 'start' || agent.state === 'progress')
                  ? 'f filter · r restart agent'
                  : 'f filter'
          }
          extraParts={
            run
              ? [
                  ...(run.status === 'running'
                    ? [
                        (view === 'agents' || view === 'agent') && agent
                          ? agent.state === 'start' ||
                            agent.state === 'progress'
                            ? 'x stop agent'
                            : ''
                          : 'x stop workflow',
                      ].filter(Boolean)
                    : []),
                  run.status === 'running' ? 'p pause' : 'p resume',
                  's save',
                ]
              : []
          }
          cancelAction="Esc back"
        />
      )}
    </Box>
  );
}
