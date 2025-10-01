/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { formatDuration } from '../utils/formatters.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
  USER_AGREEMENT_RATE_HIGH,
  USER_AGREEMENT_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import type { ToolCallStats } from '@thacio/auditaria-cli-core';

const TOOL_NAME_COL_WIDTH = 25;
const CALLS_COL_WIDTH = 8;
const SUCCESS_RATE_COL_WIDTH = 15;
const AVG_DURATION_COL_WIDTH = 15;

const StatRow: React.FC<{
  name: string;
  stats: ToolCallStats;
}> = ({ name, stats }) => {
  const successRate = stats.count > 0 ? (stats.success / stats.count) * 100 : 0;
  const avgDuration = stats.count > 0 ? stats.durationMs / stats.count : 0;
  const successColor = getStatusColor(successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });

  return (
    <Box>
      <Box width={TOOL_NAME_COL_WIDTH}>
        <Text color={theme.text.link}>{name}</Text>
      </Box>
      <Box width={CALLS_COL_WIDTH} justifyContent="flex-end">
        <Text color={theme.text.primary}>{stats.count}</Text>
      </Box>
      <Box width={SUCCESS_RATE_COL_WIDTH} justifyContent="flex-end">
        <Text color={successColor}>{successRate.toFixed(1)}%</Text>
      </Box>
      <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
        <Text color={theme.text.primary}>{formatDuration(avgDuration)}</Text>
      </Box>
    </Box>
  );
};

export const ToolStatsDisplay: React.FC = () => {
  const { stats } = useSessionStats();
  const { tools } = stats.metrics;
  const activeTools = Object.entries(tools.byName).filter(
    ([, metrics]) => metrics.count > 0,
  );

  if (activeTools.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        paddingY={1}
        paddingX={2}
      >
<<<<<<< HEAD
        <Text>{t('stats.no_tool_calls', 'No tool calls have been made in this session.')}</Text>
=======
        <Text color={theme.text.primary}>
          No tool calls have been made in this session.
        </Text>
>>>>>>> b9b6fe1f7
      </Box>
    );
  }

  const totalDecisions = Object.values(tools.byName).reduce(
    (acc, tool) => {
      acc.accept += tool.decisions.accept;
      acc.reject += tool.decisions.reject;
      acc.modify += tool.decisions.modify;
      return acc;
    },
    { accept: 0, reject: 0, modify: 0 },
  );

  const totalReviewed =
    totalDecisions.accept + totalDecisions.reject + totalDecisions.modify;
  const agreementRate =
    totalReviewed > 0 ? (totalDecisions.accept / totalReviewed) * 100 : 0;
  const agreementColor = getStatusColor(agreementRate, {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM,
  });

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
      width={70}
    >
<<<<<<< HEAD
      <Text bold color={Colors.AccentPurple}>
        {t('stats.tool_stats_title', 'Tool Stats For Nerds')}
=======
      <Text bold color={theme.text.accent}>
        Tool Stats For Nerds
>>>>>>> b9b6fe1f7
      </Text>
      <Box height={1} />

      {/* Header */}
      <Box>
        <Box width={TOOL_NAME_COL_WIDTH}>
<<<<<<< HEAD
          <Text bold>{t('stats.labels.tool_name', 'Tool Name')}</Text>
        </Box>
        <Box width={CALLS_COL_WIDTH} justifyContent="flex-end">
          <Text bold>{t('stats.labels.calls', 'Calls')}</Text>
        </Box>
        <Box width={SUCCESS_RATE_COL_WIDTH} justifyContent="flex-end">
          <Text bold>{t('stats.labels.success_rate', 'Success Rate')}</Text>
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text bold>{t('stats.labels.avg_duration', 'Avg Duration')}</Text>
=======
          <Text bold color={theme.text.primary}>
            Tool Name
          </Text>
        </Box>
        <Box width={CALLS_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            Calls
          </Text>
        </Box>
        <Box width={SUCCESS_RATE_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            Success Rate
          </Text>
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            Avg Duration
          </Text>
>>>>>>> b9b6fe1f7
        </Box>
      </Box>

      {/* Divider */}
      <Box
        borderStyle="single"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
        width="100%"
      />

      {/* Tool Rows */}
      {activeTools.map(([name, stats]) => (
        <StatRow key={name} name={name} stats={stats as ToolCallStats} />
      ))}

      <Box height={1} />

      {/* User Decision Summary */}
<<<<<<< HEAD
      <Text bold>{t('stats.sections.user_decision_summary', 'User Decision Summary')}</Text>
=======
      <Text bold color={theme.text.primary}>
        User Decision Summary
      </Text>
>>>>>>> b9b6fe1f7
      <Box>
        <Box
          width={TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH}
        >
<<<<<<< HEAD
          <Text color={Colors.LightBlue}>{t('stats.labels.total_reviewed', 'Total Reviewed Suggestions:')}</Text>
=======
          <Text color={theme.text.link}>Total Reviewed Suggestions:</Text>
>>>>>>> b9b6fe1f7
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text color={theme.text.primary}>{totalReviewed}</Text>
        </Box>
      </Box>
      <Box>
        <Box
          width={TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH}
        >
<<<<<<< HEAD
          <Text>{t('stats.labels.accepted', ' » Accepted:')}</Text>
=======
          <Text color={theme.text.primary}> » Accepted:</Text>
>>>>>>> b9b6fe1f7
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text color={theme.status.success}>{totalDecisions.accept}</Text>
        </Box>
      </Box>
      <Box>
        <Box
          width={TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH}
        >
<<<<<<< HEAD
          <Text>{t('stats.labels.rejected', ' » Rejected:')}</Text>
=======
          <Text color={theme.text.primary}> » Rejected:</Text>
>>>>>>> b9b6fe1f7
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text color={theme.status.error}>{totalDecisions.reject}</Text>
        </Box>
      </Box>
      <Box>
        <Box
          width={TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH}
        >
<<<<<<< HEAD
          <Text>{t('stats.labels.modified', ' » Modified:')}</Text>
=======
          <Text color={theme.text.primary}> » Modified:</Text>
>>>>>>> b9b6fe1f7
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text color={theme.status.warning}>{totalDecisions.modify}</Text>
        </Box>
      </Box>

      {/* Divider */}
      <Box
        borderStyle="single"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
        width="100%"
      />

      <Box>
        <Box
          width={TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH}
        >
<<<<<<< HEAD
          <Text>{t('stats.labels.overall_agreement', ' Overall Agreement Rate:')}</Text>
=======
          <Text color={theme.text.primary}> Overall Agreement Rate:</Text>
>>>>>>> b9b6fe1f7
        </Box>
        <Box width={AVG_DURATION_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={totalReviewed > 0 ? agreementColor : undefined}>
            {totalReviewed > 0 ? `${agreementRate.toFixed(1)}%` : '--'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
