/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@google/gemini-cli-core';
import { SettingScope, LoadedSettings } from '../config/settings.js';
import { settingExistsInScope } from './settingsUtils.js';

/**
 * Shared scope labels for dialog components that need to display setting scopes
 */
export const SCOPE_LABELS = {
  [SettingScope.User]: t('settings_dialog.scope_options.user_settings', 'User Settings'),
  [SettingScope.Workspace]: t('settings_dialog.scope_options.workspace_settings', 'Workspace Settings'),
  [SettingScope.System]: t('settings_dialog.scope_options.system_settings', 'System Settings'),
} as const;

/**
 * Helper function to get scope items for radio button selects
 */
export function getScopeItems() {
  return [
    { label: SCOPE_LABELS[SettingScope.User], value: SettingScope.User },
    {
      label: SCOPE_LABELS[SettingScope.Workspace],
      value: SettingScope.Workspace,
    },
    { label: SCOPE_LABELS[SettingScope.System], value: SettingScope.System },
  ];
}

/**
 * Generate scope message for a specific setting
 */
export function getScopeMessageForSetting(
  settingKey: string,
  selectedScope: SettingScope,
  settings: LoadedSettings,
): string {
  const otherScopes = Object.values(SettingScope).filter(
    (scope) => scope !== selectedScope,
  );

  const modifiedInOtherScopes = otherScopes.filter((scope) => {
    const scopeSettings = settings.forScope(scope).settings;
    return settingExistsInScope(settingKey, scopeSettings);
  });

  if (modifiedInOtherScopes.length === 0) {
    return '';
  }

  const modifiedScopesStr = modifiedInOtherScopes.join(', ');
  const currentScopeSettings = settings.forScope(selectedScope).settings;
  const existsInCurrentScope = settingExistsInScope(
    settingKey,
    currentScopeSettings,
  );

  return existsInCurrentScope
    ? t('settings_dialog.messages.also_modified_in', '(Also modified in {scope})', { scope: modifiedScopesStr })
    : t('settings_dialog.messages.modified_in', '(Modified in {scope})', { scope: modifiedScopesStr });
}
