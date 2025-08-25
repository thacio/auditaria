/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@google/gemini-cli-core';

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { UserTierId } from '@google/gemini-cli-core';
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
    borderColor={Colors.Gray}
    flexDirection="column"
    padding={1}
    marginY={1}
    width="100%"
  >
    <Box marginBottom={1}>
      <Text bold color={Colors.AccentPurple}>
        {t('about_box.title', 'About Gemini CLI')}
      </Text>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          {t('about_box.labels.cli_version', 'CLI Version')}
        </Text>
      </Box>
      <Box>
        <Text>{cliVersion}</Text>
      </Box>
    </Box>
    {GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO) && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={Colors.LightBlue}>
            {t('about_box.labels.git_commit', 'Git Commit')}
          </Text>
        </Box>
        <Box>
          <Text>{GIT_COMMIT_INFO}</Text>
        </Box>
      </Box>
    )}
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          {t('about_box.labels.model', 'Model')}
        </Text>
      </Box>
      <Box>
        <Text>{modelVersion}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          {t('about_box.labels.sandbox', 'Sandbox')}
        </Text>
      </Box>
      <Box>
        <Text>{sandboxEnv}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          {t('about_box.labels.os', 'OS')}
        </Text>
      </Box>
      <Box>
        <Text>{osVersion}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          {t('about_box.labels.auth_method', 'Auth Method')}
        </Text>
      </Box>
      <Box>
        <Text>
          {selectedAuthType.startsWith('oauth') ? 'OAuth' : selectedAuthType}
        </Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
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
          <Text bold color={Colors.LightBlue}>
            {t('about_box.labels.gcp_project', 'GCP Project')}
          </Text>
        </Box>
        <Box>
          <Text>{gcpProject}</Text>
        </Box>
      </Box>
    )}
    {ideClient && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={Colors.LightBlue}>
            {t('about_box.labels.ide_client', 'IDE Client')}
          </Text>
        </Box>
        <Box>
          <Text>{ideClient}</Text>
        </Box>
      </Box>
    )}
  </Box>
);
