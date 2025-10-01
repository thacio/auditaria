/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { Box, Newline, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface GeminiPrivacyNoticeProps {
  onExit: () => void;
}

export const GeminiPrivacyNotice = ({ onExit }: GeminiPrivacyNoticeProps) => {
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
<<<<<<< HEAD
      <Text bold color={Colors.AccentPurple}>
        {t('privacy.gemini_api_key_notice_title', 'Gemini API Key Notice')}
      </Text>
      <Newline />
      <Text>
        {t('privacy.gemini_api_terms_text', 'By using the Gemini API {ref1}, Google AI Studio {ref2}, and the other Google developer services that reference these terms (collectively, the "APIs" or "Services"), you are agreeing to Google APIs Terms of Service (the "API Terms") {ref3}, and the Gemini API Additional Terms of Service (the "Additional Terms") {ref4}.', { ref1: '<Text color={Colors.AccentBlue}>[1]</Text>', ref2: '<Text color={Colors.AccentRed}>[2]</Text>', ref3: '<Text color={Colors.AccentGreen}>[3]</Text>', ref4: '<Text color={Colors.AccentPurple}>[4]</Text>' })}
=======
      <Text bold color={theme.text.accent}>
        Gemini API Key Notice
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        By using the Gemini API<Text color={theme.text.link}>[1]</Text>, Google
        AI Studio
        <Text color={theme.status.error}>[2]</Text>, and the other Google
        developer services that reference these terms (collectively, the
        &quot;APIs&quot; or &quot;Services&quot;), you are agreeing to Google
        APIs Terms of Service (the &quot;API Terms&quot;)
        <Text color={theme.status.success}>[3]</Text>, and the Gemini API
        Additional Terms of Service (the &quot;Additional Terms&quot;)
        <Text color={theme.text.accent}>[4]</Text>.
>>>>>>> b9b6fe1f7
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        <Text color={theme.text.link}>[1]</Text>{' '}
        https://ai.google.dev/docs/gemini_api_overview
      </Text>
      <Text color={theme.text.primary}>
        <Text color={theme.status.error}>[2]</Text> https://aistudio.google.com/
      </Text>
      <Text color={theme.text.primary}>
        <Text color={theme.status.success}>[3]</Text>{' '}
        https://developers.google.com/terms
      </Text>
      <Text color={theme.text.primary}>
        <Text color={theme.text.accent}>[4]</Text>{' '}
        https://ai.google.dev/gemini-api/terms
      </Text>
      <Newline />
<<<<<<< HEAD
      <Text color={Colors.Gray}>{t('privacy.press_esc_exit', 'Press Esc to exit.')}</Text>
=======
      <Text color={theme.text.secondary}>Press Esc to exit.</Text>
>>>>>>> b9b6fe1f7
    </Box>
  );
};
