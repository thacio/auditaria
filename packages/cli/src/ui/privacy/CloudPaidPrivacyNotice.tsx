/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';


import { Box, Newline, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface CloudPaidPrivacyNoticeProps {
  onExit: () => void;
}

export const CloudPaidPrivacyNotice = ({
  onExit,
}: CloudPaidPrivacyNoticeProps) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onExit();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.text.accent}>
        {t('privacy.vertex_ai_notice_title', 'Vertex AI Notice')}
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        {t('privacy.vertex_ai_service_terms_intro', 'Service Specific Terms')}
        <Text color={theme.text.link}>[1]</Text> {t('privacy.vertex_ai_service_terms_p1', 'are incorporated into the agreement under which Google has agreed to provide Google Cloud Platform')}
        <Text color={theme.status.success}>[2]</Text> {t('privacy.vertex_ai_service_terms_p2', 'to Customer (the "Agreement"). If the Agreement authorizes the resale or supply of Google Cloud Platform under a Google Cloud partner or reseller program, then except for in the section entitled "Partner-Specific Terms", all references to Customer in the Service Specific Terms mean Partner or Reseller (as applicable), and all references to Customer Data in the Service Specific Terms mean Partner Data. Capitalized terms used but not defined in the Service Specific Terms have the meaning given to them in the Agreement.')}
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        <Text color={theme.text.link}>[1]</Text>{' '}
        https://cloud.google.com/terms/service-terms
      </Text>
      <Text color={theme.text.primary}>
        <Text color={theme.status.success}>[2]</Text>{' '}
        https://cloud.google.com/terms/services
      </Text>
      <Newline />
      <Text color={theme.text.secondary}>{t('privacy.press_esc_exit', 'Press Esc to exit.')}</Text>
    </Box>
  );
};
