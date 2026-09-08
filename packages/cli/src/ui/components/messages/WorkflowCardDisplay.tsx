/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: This entire file is part of the workflow feature — the
// live card rendered for a `workflow` tool call. It subscribes to the
// WorkflowService registry so the card keeps updating while the run executes
// in the background (phases, agents, narrator logs, final status).

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  WorkflowDisplayData,
  WorkflowProgressEvent,
  WorkflowRunRecord,
} from '@google/gemini-cli-core';
import { useConfig } from '../../contexts/ConfigContext.js';
import { theme } from '../../semantic-colors.js';

const MAX_AGENT_ROWS = 12;
const MAX_LOG_ROWS = 4;

function stateGlyph(state: string, cached?: boolean): string {
  if (cached) return '↺';
  switch (state) {
    case 'done':
      return '✓';
    case 'error':
      return '✗';
    case 'progress':
      return '◐';
    default:
      return '○';
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function useRun(runId: string): WorkflowRunRecord | undefined {
  const config = useConfig();
  const [, setTick] = useState(0);
  const service = config.getWorkflowService();
  useEffect(() => {
    const onChange = (changed: string) => {
      if (changed === runId) setTick((t) => t + 1);
    };
    service.on('change', onChange);
    return () => {
      service.off('change', onChange);
    };
  }, [service, runId]);
  return service.registry.get(runId);
}

export const WorkflowCardDisplay: React.FC<{ data: WorkflowDisplayData }> = ({
  data,
}) => {
  const run = useRun(data.workflow.runId);
  const { workflow } = data;
  const status = run?.status ?? 'running';
  const progress: WorkflowProgressEvent[] = run?.workflowProgress ?? [];
  const agents = progress.filter((e) => e.type === 'workflow_agent');
  const done = agents.filter(
    (e) => e.type === 'workflow_agent' && e.state === 'done',
  ).length;
  const tokens = agents.reduce(
    (sum, e) => sum + (e.type === 'workflow_agent' ? (e.tokens ?? 0) : 0),
    0,
  );
  const logs = progress
    .filter((e) => e.type === 'workflow_log')
    .slice(-MAX_LOG_ROWS);
  const elapsedMs = run ? (run.endTime ?? Date.now()) - run.startTime : 0;

  const header =
    status === 'running'
      ? 'Running in background · /workflows to monitor'
      : `${status[0].toUpperCase()}${status.slice(1)} in ${Math.round(elapsedMs / 1000)}s`;
  const headerColor =
    status === 'completed'
      ? theme.status.success
      : status === 'failed' || status === 'killed'
        ? theme.status.error
        : theme.text.secondary;

  const phases = progress.filter((e) => e.type === 'workflow_phase');
  const visibleAgents = agents.slice(-MAX_AGENT_ROWS);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.accent}>{'⧉  '}</Text>
        <Text color={theme.text.primary}>{workflow.name}</Text>
        <Text color={theme.text.secondary}>
          {` · ${workflow.resumed ? 'resumed ' : ''}task ${workflow.taskId} · ${done}/${agents.length} agents · ${formatTokens(tokens)} tokens`}
        </Text>
      </Box>
      <Text color={headerColor}>{header}</Text>
      {phases.map((phase) =>
        phase.type === 'workflow_phase' ? (
          <Box key={`p${phase.index}`} flexDirection="column">
            <Text color={theme.text.secondary}>
              {phase.kind === 'child' ? '' : '▸ '}
              {phase.title}
            </Text>
            {visibleAgents
              .filter(
                (a) =>
                  a.type === 'workflow_agent' && a.phaseIndex === phase.index,
              )
              .map((a) =>
                a.type === 'workflow_agent' ? (
                  <Box key={`a${a.index}`} paddingLeft={2}>
                    <Text
                      color={
                        a.state === 'error'
                          ? theme.status.error
                          : a.state === 'done'
                            ? theme.status.success
                            : theme.text.secondary
                      }
                    >
                      {stateGlyph(a.state, a.cached)}{' '}
                    </Text>
                    <Text color={theme.text.primary}>
                      {a.label || a.promptPreview}
                    </Text>
                    <Text color={theme.text.secondary}>
                      {a.model ? ` · ${a.model}` : ''}
                      {a.tokens ? ` · ${formatTokens(a.tokens)}` : ''}
                      {a.lastToolName && a.state === 'progress'
                        ? ` · ${a.lastToolName}${a.lastToolSummary ? `: ${a.lastToolSummary}` : ''}`
                        : ''}
                      {a.error ? ` · ${a.error.slice(0, 80)}` : ''}
                    </Text>
                  </Box>
                ) : null,
              )}
          </Box>
        ) : null,
      )}
      {agents.length > MAX_AGENT_ROWS ? (
        <Text color={theme.text.secondary}>
          … {agents.length - MAX_AGENT_ROWS} earlier agent(s) not shown
        </Text>
      ) : null}
      {logs.map((l, i) =>
        l.type === 'workflow_log' ? (
          <Text key={`l${i}`} color={theme.text.secondary}>
            › {l.message}
          </Text>
        ) : null,
      )}
      {run?.error && status !== 'running' ? (
        <Text color={theme.status.error}>{run.error}</Text>
      ) : null}
    </Box>
  );
};
