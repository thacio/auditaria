/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { IdeIntegrationNudge } from '../IdeIntegrationNudge.js';
import { FolderTrustDialog } from './FolderTrustDialog.js';
import { ShellConfirmationDialog } from './ShellConfirmationDialog.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { ThemeDialog } from './ThemeDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { AuthInProgress } from '../auth/AuthInProgress.js';
import { AuthDialog } from '../auth/AuthDialog.js';
import { EditorSettingsDialog } from './EditorSettingsDialog.js';
import { LanguageSelectionDialog } from './LanguageSelectionDialog.js';
import { PrivacyNotice } from '../privacy/PrivacyNotice.js';
import { WorkspaceMigrationDialog } from './WorkspaceMigrationDialog.js';
import { ProQuotaDialog } from './ProQuotaDialog.js';
import { Colors } from '../colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { DEFAULT_GEMINI_FLASH_MODEL, t } from '@thacio/auditaria-cli-core';
import process from 'node:process';

// Props for DialogManager
export const DialogManager = () => {
  const config = useConfig();
  const settings = useSettings();

  const uiState = useUIState();
  const uiActions = useUIActions();
  const { constrainHeight, terminalHeight, staticExtraHeight, mainAreaWidth } =
    uiState;

  if (uiState.showIdeRestartPrompt) {
    return (
      <Box borderStyle="round" borderColor={Colors.AccentYellow} paddingX={1}>
        <Text color={Colors.AccentYellow}>
          {t(
            'app.ide_trust_changed',
            "Workspace trust has changed. Press 'r' to restart Auditaria to apply the changes."
          )}
        </Text>
      </Box>
    );
  }
  if (uiState.showWorkspaceMigrationDialog) {
    return (
      <WorkspaceMigrationDialog
        workspaceExtensions={uiState.workspaceExtensions}
        onOpen={uiActions.onWorkspaceMigrationDialogOpen}
        onClose={uiActions.onWorkspaceMigrationDialogClose}
      />
    );
  }
  if (uiState.isProQuotaDialogOpen) {
    return (
      <ProQuotaDialog
        currentModel={uiState.currentModel}
        fallbackModel={DEFAULT_GEMINI_FLASH_MODEL}
        onChoice={uiActions.handleProQuotaChoice}
      />
    );
  }
  if (uiState.shouldShowIdePrompt) {
    return (
      <IdeIntegrationNudge
        ide={uiState.currentIDE!}
        onComplete={uiActions.handleIdePromptComplete}
      />
    );
  }
  if (uiState.isFolderTrustDialogOpen) {
    return (
      <FolderTrustDialog
        onSelect={uiActions.handleFolderTrustSelect}
        isRestarting={uiState.isRestarting}
      />
    );
  }
  if (uiState.shellConfirmationRequest) {
    return (
      <ShellConfirmationDialog request={uiState.shellConfirmationRequest} />
    );
  }
  if (uiState.confirmationRequest) {
    return (
      <Box flexDirection="column">
        {uiState.confirmationRequest.prompt}
        <Box paddingY={1}>
          <RadioButtonSelect
            items={[
              { label: t('tool_confirmation.options.yes', 'Yes'), value: true },
              {
                label: t('tool_confirmation.options.no', 'No'),
                value: false,
              },
            ]}
            onSelect={(value: boolean) => {
              uiState.confirmationRequest!.onConfirm(value);
            }}
          />
        </Box>
      </Box>
    );
  }
  if (uiState.isThemeDialogOpen) {
    return (
      <Box flexDirection="column">
        {uiState.themeError && (
          <Box marginBottom={1}>
            <Text color={Colors.AccentRed}>{uiState.themeError}</Text>
          </Box>
        )}
        <ThemeDialog
          onSelect={uiActions.handleThemeSelect}
          onHighlight={uiActions.handleThemeHighlight}
          settings={settings}
          availableTerminalHeight={
            constrainHeight ? terminalHeight - staticExtraHeight : undefined
          }
          terminalWidth={mainAreaWidth}
        />
      </Box>
    );
  }
  if (uiState.isSettingsDialogOpen) {
    return (
      <Box flexDirection="column">
        <SettingsDialog
          settings={settings}
          onSelect={() => uiActions.closeSettingsDialog()}
          onRestartRequest={() => process.exit(0)}
        />
      </Box>
    );
  }
  if (uiState.isAuthenticating) {
    return (
      <AuthInProgress
        onTimeout={() => {
          /* This is now handled in AppContainer */
        }}
      />
    );
  }
  if (uiState.isAuthDialogOpen) {
    return (
      <Box flexDirection="column">
        <AuthDialog
          config={config}
          settings={settings}
          setAuthState={uiActions.setAuthState}
          authError={uiState.authError}
          onAuthError={uiActions.onAuthError}
        />
      </Box>
    );
  }
  if (uiState.isEditorDialogOpen) {
    return (
      <Box flexDirection="column">
        {uiState.editorError && (
          <Box marginBottom={1}>
            <Text color={Colors.AccentRed}>{uiState.editorError}</Text>
          </Box>
        )}
        <EditorSettingsDialog
          onSelect={uiActions.handleEditorSelect}
          settings={settings}
          onExit={uiActions.exitEditorDialog}
        />
      </Box>
    );
  }
  if (uiState.isLanguageDialogOpen) {
    return (
      <Box flexDirection="column">
        {uiState.languageError && (
          <Box marginBottom={1}>
            <Text color={Colors.AccentRed}>{uiState.languageError}</Text>
          </Box>
        )}
        <LanguageSelectionDialog
          onSelect={uiActions.handleLanguageSelect}
          settings={settings}
        />
      </Box>
    );
  }
  if (uiState.showPrivacyNotice) {
    return (
      <PrivacyNotice
        onExit={() => uiActions.exitPrivacyNotice()}
        config={config}
      />
    );
  }

  return null;
};
