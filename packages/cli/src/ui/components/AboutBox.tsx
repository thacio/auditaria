/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import type { UserTierId } from '@thacio/auditaria-cli-core';
import { getLicenseDisplay } from '../../utils/license.js';

interface AboutBoxProps {
  cliVersion: string;
  osVersion: string;
  sandboxEnv: string;
  modelVersion: string;
  selectedAuthType: string;
  gcpProject: string;
  ideClient: string;
  userTier?: UserTierId;
}

export const AboutBox: React.FC<AboutBoxProps> = ({
  cliVersion,
  osVersion,
  sandboxEnv,
  modelVersion,
  selectedAuthType,
  gcpProject,
  ideClient,
  userTier,
}) => (
  <Box
    borderStyle="round"
    borderColor={theme.border.default}
    flexDirection="column"
    padding={1}
    marginY={1}
    width="100%"
  >
    <Box marginBottom={1}>
      <Text bold color={theme.text.accent}>
        {t('about_box.title', 'About Gemini CLI')}
      </Text>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.cli_version', 'CLI Version')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>{cliVersion}</Text>
      </Box>
    </Box>
    {GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO) && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={theme.text.link}>
            {t('about_box.labels.git_commit', 'Git Commit')}
          </Text>
        </Box>
        <Box>
          <Text color={theme.text.primary}>{GIT_COMMIT_INFO}</Text>
        </Box>
      </Box>
    )}
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.model', 'Model')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>{modelVersion}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.sandbox', 'Sandbox')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>{sandboxEnv}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.os', 'OS')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>{osVersion}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.auth_method', 'Auth Method')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>
          {selectedAuthType.startsWith('oauth') ? 'OAuth' : selectedAuthType}
        </Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={theme.text.link}>
          {t('about_box.labels.license', 'License')}
        </Text>
      </Box>
      <Box>
        <Text>{getLicenseDisplay(selectedAuthType, userTier)}</Text>
      </Box>
    </Box>
    {gcpProject && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={theme.text.link}>
            {t('about_box.labels.gcp_project', 'GCP Project')}
          </Text>
        </Box>
        <Box>
          <Text color={theme.text.primary}>{gcpProject}</Text>
        </Box>
      </Box>
    )}
    {ideClient && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={theme.text.link}>
            {t('about_box.labels.ide_client', 'IDE Client')}
          </Text>
        </Box>
        <Box>
          <Text color={theme.text.primary}>{ideClient}</Text>
        </Box>
      </Box>
    )}
  </Box>
);
