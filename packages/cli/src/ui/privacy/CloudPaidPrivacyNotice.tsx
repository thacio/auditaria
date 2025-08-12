/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';


import { Box, Newline, Text } from 'ink';
import { Colors } from '../colors.js';
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
      <Text bold color={Colors.AccentPurple}>
        {t('privacy.vertex_ai_notice_title', 'Vertex AI Notice')}
      </Text>
      <Newline />
      <Text>
        {t('privacy.vertex_ai_service_terms_text', 'Service Specific Terms {ref1} are incorporated into the agreement under which Google has agreed to provide Google Cloud Platform {ref2} to Customer (the "Agreement"). If the Agreement authorizes the resale or supply of Google Cloud Platform under a Google Cloud partner or reseller program, then except for in the section entitled "Partner-Specific Terms", all references to Customer in the Service Specific Terms mean Partner or Reseller (as applicable), and all references to Customer Data in the Service Specific Terms mean Partner Data. Capitalized terms used but not defined in the Service Specific Terms have the meaning given to them in the Agreement.', { ref1: '<Text color={Colors.AccentBlue}>[1]</Text>', ref2: '<Text color={Colors.AccentGreen}>[2]</Text>' })}
      </Text>
      <Newline />
      <Text>
        <Text color={Colors.AccentBlue}>[1]</Text>{' '}
        https://cloud.google.com/terms/service-terms
      </Text>
      <Text>
        <Text color={Colors.AccentGreen}>[2]</Text>{' '}
        https://cloud.google.com/terms/services
      </Text>
      <Newline />
      <Text color={Colors.Gray}>{t('privacy.press_esc_exit', 'Press Esc to exit.')}</Text>
    </Box>
  );
};
