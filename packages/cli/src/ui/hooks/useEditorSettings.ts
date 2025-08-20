/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { useState, useCallback, useContext } from 'react';
import { SettingScope } from '../../config/settings.js';
import { type HistoryItem, MessageType } from '../types.js';
import {
  allowEditorTypeInSandbox,
  checkHasEditorType,
  EditorType,
} from '@thacio/auditaria-cli-core';
import { SettingsContext } from '../contexts/SettingsContext.js';

interface UseEditorSettingsReturn {
  isEditorDialogOpen: boolean;
  openEditorDialog: () => void;
  handleEditorSelect: (
    editorType: EditorType | undefined,
    scope: SettingScope,
  ) => void;
  exitEditorDialog: () => void;
}

export const useEditorSettings = (
  setEditorError: (error: string | null) => void,
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
): UseEditorSettingsReturn => {
  const [isEditorDialogOpen, setIsEditorDialogOpen] = useState(false);
  const settingsContext = useContext(SettingsContext);

  const openEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(true);
  }, []);

  const handleEditorSelect = useCallback(
    (editorType: EditorType | undefined, scope: SettingScope) => {
      if (
        editorType &&
        (!checkHasEditorType(editorType) ||
          !allowEditorTypeInSandbox(editorType))
      ) {
        return;
      }

      try {
        settingsContext?.settings.setValue(
          scope,
          'preferredEditor',
          editorType,
        );
        addItem(
          {
            type: MessageType.INFO,
            text: editorType 
              ? t('editor.preference_set', 'Editor preference set to "{editor}" in {scope} settings.', { editor: editorType, scope })
              : t('editor.preference_cleared', 'Editor preference cleared in {scope} settings.', { scope }),
          },
          Date.now(),
        );
        setEditorError(null);
        setIsEditorDialogOpen(false);
      } catch (error) {
        setEditorError(t('editor.failed_to_set', 'Failed to set editor preference: {error}', { error: error instanceof Error ? error.message : String(error) }));
      }
    },
    [settingsContext, setEditorError, addItem],
  );

  const exitEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(false);
  }, []);

  return {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  };
};
