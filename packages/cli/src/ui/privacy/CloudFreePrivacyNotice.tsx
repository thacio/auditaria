/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@thacio/auditaria-cli-core';

import { Box, Newline, Text } from 'ink';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { usePrivacySettings } from '../hooks/usePrivacySettings.js';

import type { Config } from '@thacio/auditaria-cli-core';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface CloudFreePrivacyNoticeProps {
  config: Config;
  onExit: () => void;
}

export const CloudFreePrivacyNotice = ({
  config,
  onExit,
}: CloudFreePrivacyNoticeProps) => {
  const { privacyState, updateDataCollectionOptIn } =
    usePrivacySettings(config);

  useKeypress(
    (key) => {
      if (
        (privacyState.error || privacyState.isFreeTier === false) &&
        key.name === 'escape'
      ) {
        onExit();
      }
    },
    { isActive: true },
  );

  if (privacyState.isLoading) {
    return (
      <Text color={theme.text.secondary}>
        {t('privacy.loading', 'Loading...')}
      </Text>
    );
  }

  if (privacyState.error) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color={theme.status.error}>
          {t(
            'privacy.error_loading_optin',
            'Error loading Opt-in settings: {error}',
            { error: privacyState.error },
          )}
        </Text>
        <Text color={theme.text.secondary}>
          {t('privacy.press_esc_exit', 'Press Esc to exit.')}
        </Text>
      </Box>
    );
  }

  if (privacyState.isFreeTier === false) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text bold color={theme.text.accent}>
          {t(
            'privacy.auditaria_privacy_notice_title',
            'Auditaria CLI Privacy Notice',
          )}
        </Text>
        <Newline />
        <Text>
          https://developers.google.com/gemini-code-assist/resources/privacy-notices
        </Text>
        <Newline />
        <Text color={theme.text.secondary}>
          {t('privacy.press_esc_exit', 'Press Esc to exit.')}
        </Text>
      </Box>
    );
  }

  const items = [
    { label: t('privacy.yes', 'Yes'), value: true, key: 'true' },
    { label: t('privacy.no', 'No'), value: false, key: 'false' },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.text.accent}>
        {t(
          'privacy.gemini_code_assist_notice_title',
          'Gemini Code Assist for Individuals Privacy Notice',
        )}
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        {t('privacy.notice_intro', 'This notice and our Privacy Policy')}
        <Text color={theme.text.link}>[1]</Text>{' '}
        {t(
          'privacy.notice_intro_cont',
          'describe how Gemini Code Assist handles your data. Please read them carefully.',
        )}
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        {t(
          'privacy.data_collection_description',
          'When you use Gemini Code Assist for individuals with Gemini CLI, Google collects your prompts, related code, generated output, code edits, related feature usage information, and your feedback to provide, improve, and develop Google products and services and machine learning technologies.',
        )}
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        {t(
          'privacy.human_review_description',
          "To help with quality and improve our products (such as generative machine-learning models), human reviewers may read, annotate, and process the data collected above. We take steps to protect your privacy as part of this process. This includes disconnecting the data from your Google Account before reviewers see or annotate it, and storing those disconnected copies for up to 18 months. Please don't submit confidential information or any data you wouldn't want a reviewer to see or Google to use to improve our products, services and machine-learning technologies.",
        )}
      </Text>
      <Newline />
      <Box flexDirection="column">
        <Text color={theme.text.primary}>
          {t(
            'privacy.allow_data_usage_question',
            'Allow Google to use this data to develop and improve our products?',
          )}
        </Text>
        <RadioButtonSelect
          items={items}
          initialIndex={privacyState.dataCollectionOptIn ? 0 : 1}
          onSelect={(value) => {
            updateDataCollectionOptIn(value);
            // Only exit if there was no error.
            if (!privacyState.error) {
              onExit();
            }
          }}
        />
      </Box>
      <Newline />
      <Text>
        <Text color={theme.text.link}>[1]</Text>{' '}
        https://policies.google.com/privacy
      </Text>
      <Newline />
      <Text color={theme.text.secondary}>
        {t(
          'privacy.press_enter_choose_exit',
          'Press Enter to choose an option and exit.',
        )}
      </Text>
    </Box>
  );
};
