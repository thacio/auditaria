/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Config, sessionId } from '@thacio/auditaria-cli-core';
import { loadSettings, LoadedSettings } from '../config/settings.js';
import { themeManager } from './themes/theme-manager.js';
import { SettingsContext } from './contexts/SettingsContext.js';
import { AppWrapper } from './App.js';
import { loadCliConfig, CliArgs } from '../config/config.js';
import { Extension } from '../config/extension.js';

interface MainComponentProps {
  initialConfig: Config;
  settings: LoadedSettings;
  startupWarnings: string[];
  version: string;
  workspaceRoot: string;
  extensions: Extension[];
  argv: CliArgs;
  // WEB_INTERFACE_START: Web interface props
  webEnabled?: boolean;
  webOpenBrowser?: boolean;
  // WEB_INTERFACE_END
}

export const MainComponent = ({
  initialConfig,
  settings,
  startupWarnings,
  version,
  workspaceRoot,
  extensions,
  argv,
  // WEB_INTERFACE_START
  webEnabled,
  webOpenBrowser,
  // WEB_INTERFACE_END
}: MainComponentProps) => {
  const [currentSettings, setCurrentSettings] =
    useState<LoadedSettings>(settings);
  const [config, setConfig] = useState<Config>(initialConfig);

  const recomputeSettings = () => {
    const newSettings = loadSettings(workspaceRoot);
    setCurrentSettings(newSettings);
  };

  React.useEffect(() => {
    const recomputeConfigAndTheme = async () => {
      // Don't run on initial mount, since the initial config is correct.
      if (currentSettings === settings) {
        return;
      }

      // Reload config
      const newConfig = await loadCliConfig(
        currentSettings.merged,
        extensions,
        sessionId,
        argv,
      );
      await newConfig.initialize();
      if (newConfig.getIdeMode()) {
        await newConfig.getIdeClient().connect();
      }

      // Reload themes
      themeManager.loadCustomThemes(currentSettings.merged.customThemes);
      if (currentSettings.merged.theme) {
        if (!themeManager.setActiveTheme(currentSettings.merged.theme)) {
          console.warn(
            `Warning: Theme "${currentSettings.merged.theme}" not found.`,
          );
        }
      }

      setConfig(newConfig);
    };

    recomputeConfigAndTheme();
  }, [currentSettings, settings, extensions, argv, workspaceRoot]);

  const contextValue = {
    settings: currentSettings,
    recomputeSettings,
  };

  return (
    <React.StrictMode>
      <SettingsContext.Provider value={contextValue}>
        <AppWrapper
          config={config}
          startupWarnings={startupWarnings}
          version={version}
          // WEB_INTERFACE_START: Pass web interface flags
          webEnabled={webEnabled}
          webOpenBrowser={webOpenBrowser}
          // WEB_INTERFACE_END
        />
      </SettingsContext.Provider>
    </React.StrictMode>
  );
};
