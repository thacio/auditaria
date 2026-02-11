/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAvailableLanguages } from '@google/gemini-cli-core';
import type { LanguageInfo, SupportedLanguage } from '@google/gemini-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type { LoadedSettings } from '../../config/settings.js';
import { getPreferredUiLanguage } from '../../config/settings.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface LanguageSelectionDialogProps {
  /** Callback function when a language is selected */
  onSelect: (languageCode: SupportedLanguage | undefined) => void;
  /** The settings object */
  settings: LoadedSettings;
  /** Whether this is the first-time setup (prevents escape exit) */
  isFirstTimeSetup?: boolean;
}

export function LanguageSelectionDialog({
  onSelect,
  settings,
  isFirstTimeSetup = false,
}: LanguageSelectionDialogProps): React.JSX.Element {
  // Get available languages synchronously from the hardcoded list
  const availableLanguages: LanguageInfo[] = getAvailableLanguages();

  // Generate language items for the radio button selector
  const languageItems = availableLanguages.map((lang) => ({
    label: `${lang.nativeName} (${lang.name})`,
    value: lang.code,
    languageInfo: lang,
    key: lang.code,
  }));

  // Determine which language should be initially selected
  // Priority: settings > English > first available
  const currentLanguage = getPreferredUiLanguage(settings);
  const initialLanguageIndex = languageItems.findIndex((item) => {
    if (currentLanguage) {
      return item.value === currentLanguage;
    }
    // Default to English if available, otherwise first language
    return item.value === 'en';
  });

  const handleLanguageSelect = (languageCode: SupportedLanguage) => {
    onSelect(languageCode);
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape' && !isFirstTimeSetup) {
        // Only allow escape if not first-time setup
        onSelect(undefined);
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {isFirstTimeSetup
          ? 'Welcome! Select Your Language'
          : 'Language Selection'}
      </Text>

      {isFirstTimeSetup && (
        <Box marginTop={1}>
          <Text>
            Choose your preferred language for the interface. You can change
            this later using the /language command.
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold wrap="truncate">
          {'> '}Select Language
        </Text>

        <RadioButtonSelect
          items={languageItems}
          initialIndex={Math.max(0, initialLanguageIndex)}
          onSelect={handleLanguageSelect}
          isFocused={true}
        />
      </Box>

      <Box marginTop={1}>
        <Text color={Colors.Gray} wrap="truncate">
          (Use Enter to select{!isFirstTimeSetup ? ', Esc to cancel' : ''})
        </Text>
      </Box>
    </Box>
  );
}
