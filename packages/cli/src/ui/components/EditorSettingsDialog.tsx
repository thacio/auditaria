/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  EDITOR_DISPLAY_NAMES,
  editorSettingsManager,
  type EditorDisplay,
} from '../editors/editorSettingsManager.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { EditorType } from '@thacio/auditaria-cli-core';
import { isEditorAvailable } from '@thacio/auditaria-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';

interface EditorDialogProps {
  onSelect: (editorType: EditorType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  onExit: () => void;
}

export function EditorSettingsDialog({
  onSelect,
  settings,
  onExit,
}: EditorDialogProps): React.JSX.Element {
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  const [focusedSection, setFocusedSection] = useState<'editor' | 'scope'>(
    'editor',
  );
  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setFocusedSection((prev) => (prev === 'editor' ? 'scope' : 'editor'));
      }
      if (key.name === 'escape') {
        onExit();
      }
    },
    { isActive: true },
  );

  const editorItems: EditorDisplay[] =
    editorSettingsManager.getAvailableEditorDisplays();

  const currentPreference =
    settings.forScope(selectedScope).settings.general?.preferredEditor;
  let editorIndex = currentPreference
    ? editorItems.findIndex(
        (item: EditorDisplay) => item.type === currentPreference,
      )
    : 0;
  if (editorIndex === -1) {
    console.error(`Editor is not supported: ${currentPreference}`);
    editorIndex = 0;
  }

  const scopeItems = [
    { label: t('editor_dialog.scope_options.user_settings', 'User Settings'), value: SettingScope.User },
    { label: t('editor_dialog.scope_options.workspace_settings', 'Workspace Settings'), value: SettingScope.Workspace },
  ];

  const handleEditorSelect = (editorType: EditorType | 'not_set') => {
    if (editorType === 'not_set') {
      onSelect(undefined, selectedScope);
      return;
    }
    onSelect(editorType, selectedScope);
  };

  const handleScopeSelect = (scope: SettingScope) => {
    setSelectedScope(scope);
    setFocusedSection('editor');
  };

  let otherScopeModifiedMessage = '';
  const otherScope =
    selectedScope === SettingScope.User
      ? SettingScope.Workspace
      : SettingScope.User;
  if (
    settings.forScope(otherScope).settings.general?.preferredEditor !==
    undefined
  ) {
    otherScopeModifiedMessage =
      settings.forScope(selectedScope).settings.general?.preferredEditor !==
      undefined
        ? t('editor_dialog.messages.also_modified_in', '(Also modified in {scope})', { scope: otherScope })
        : t('editor_dialog.messages.modified_in', '(Modified in {scope})', { scope: otherScope });
  }

  let mergedEditorName = t('editor_dialog.messages.none', 'None');
  if (
    settings.merged.general?.preferredEditor &&
    isEditorAvailable(settings.merged.general?.preferredEditor)
  ) {
    mergedEditorName =
      EDITOR_DISPLAY_NAMES[
        settings.merged.general?.preferredEditor as EditorType
      ];
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="row"
      padding={1}
      width="100%"
    >
      <Box flexDirection="column" width="45%" paddingRight={2}>
        <Text bold={focusedSection === 'editor'}>
          {focusedSection === 'editor' ? '> ' : '  '}{t('editor_dialog.title', 'Select Editor')}{' '}
          <Text color={theme.text.secondary}>{otherScopeModifiedMessage}</Text>
        </Text>
        <RadioButtonSelect
          items={editorItems.map((item) => ({
            label: item.name,
            value: item.type,
            disabled: item.disabled,
          }))}
          initialIndex={editorIndex}
          onSelect={handleEditorSelect}
          isFocused={focusedSection === 'editor'}
          key={selectedScope}
        />

        <Box marginTop={1} flexDirection="column">
          <Text bold={focusedSection === 'scope'}>
            {focusedSection === 'scope' ? '> ' : '  '}{t('editor_dialog.apply_to', 'Apply To')}
          </Text>
          <RadioButtonSelect
            items={scopeItems}
            initialIndex={0}
            onSelect={handleScopeSelect}
            isFocused={focusedSection === 'scope'}
          />
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('editor_dialog.messages.use_enter_tab', '(Use Enter to select, Tab to change focus)')}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" width="55%" paddingLeft={2}>
        <Text bold>{t('editor_dialog.editor_preference', 'Editor Preference')}</Text>
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('editor_dialog.messages.supported_editors', 'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.')}
          </Text>
          <Text color={theme.text.secondary}>
            {t('editor_dialog.messages.preferred_editor', 'Your preferred editor is:')}{' '}
            <Text
              color={
                mergedEditorName === t('editor_dialog.messages.none', 'None')
                  ? theme.status.error
                  : theme.text.link
              }
              bold
            >
              {mergedEditorName}
            </Text>
            .
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
