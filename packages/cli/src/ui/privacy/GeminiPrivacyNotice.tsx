/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { Box, Newline, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

interface GeminiPrivacyNoticeProps {
  onExit: () => void;
}

export const GeminiPrivacyNotice = ({ onExit }: GeminiPrivacyNoticeProps) => {
  useInput((input, key) => {
    if (key.escape) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={Colors.AccentPurple}>
        {t('privacy.gemini_api_key_notice_title', 'Gemini API Key Notice')}
      </Text>
      <Newline />
      <Text>
        {t('privacy.gemini_api_terms_text', 'By using the Gemini API {ref1}, Google AI Studio {ref2}, and the other Google developer services that reference these terms (collectively, the "APIs" or "Services"), you are agreeing to Google APIs Terms of Service (the "API Terms") {ref3}, and the Gemini API Additional Terms of Service (the "Additional Terms") {ref4}.', { ref1: '<Text color={Colors.AccentBlue}>[1]</Text>', ref2: '<Text color={Colors.AccentRed}>[2]</Text>', ref3: '<Text color={Colors.AccentGreen}>[3]</Text>', ref4: '<Text color={Colors.AccentPurple}>[4]</Text>' })}
      </Text>
      <Newline />
      <Text>
        <Text color={Colors.AccentBlue}>[1]</Text>{' '}
        https://ai.google.dev/docs/gemini_api_overview
      </Text>
      <Text>
        <Text color={Colors.AccentRed}>[2]</Text> https://aistudio.google.com/
      </Text>
      <Text>
        <Text color={Colors.AccentGreen}>[3]</Text>{' '}
        https://developers.google.com/terms
      </Text>
      <Text>
        <Text color={Colors.AccentPurple}>[4]</Text>{' '}
        https://ai.google.dev/gemini-api/terms
      </Text>
      <Newline />
      <Text color={Colors.Gray}>{t('privacy.press_esc_exit', 'Press Esc to exit.')}</Text>
    </Box>
  );
};
