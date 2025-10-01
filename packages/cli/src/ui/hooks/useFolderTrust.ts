/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { type Config } from '@thacio/auditaria-cli-core';
import type { LoadedSettings } from '../../config/settings.js';
import { FolderTrustChoice } from '../components/FolderTrustDialog.js';
import {
  loadTrustedFolders,
  TrustLevel,
  isWorkspaceTrusted,
} from '../../config/trustedFolders.js';
import * as process from 'node:process';

export const useFolderTrust = (
  settings: LoadedSettings,
  config: Config,
  onTrustChange: (isTrusted: boolean | undefined) => void,
  refreshStatic: () => void,
) => {
  const [isTrusted, setIsTrusted] = useState<boolean | undefined>(undefined);
  const [isFolderTrustDialogOpen, setIsFolderTrustDialogOpen] = useState(false);
  const [isRestarting] = useState(false);

  const folderTrust = settings.merged.security?.folderTrust?.enabled;

  useEffect(() => {
    const trusted = isWorkspaceTrusted(settings.merged);
    setIsTrusted(trusted);
    
    // WEB_INTERFACE_START: Pre-start terminal capture for folder trust dialog
    // If dialog will open, start capture before setting state to catch initial render
    if (trusted === undefined && (global as any).__preStartTerminalCapture) {
      (global as any).__preStartTerminalCapture();
    }
    // WEB_INTERFACE_END
    
    setIsFolderTrustDialogOpen(trusted === undefined);
    onTrustChange(trusted);
  }, [folderTrust, onTrustChange, settings.merged]);

  useEffect(() => {
    // When the folder trust dialog is about to open/close, we need to force a refresh
    // of the static content to ensure the Tips are hidden/shown correctly.
    refreshStatic();
  }, [isFolderTrustDialogOpen, refreshStatic]);

  const handleFolderTrustSelect = useCallback(
    (choice: FolderTrustChoice) => {
      const trustedFolders = loadTrustedFolders();
      const cwd = process.cwd();
      let trustLevel: TrustLevel;

      switch (choice) {
        case FolderTrustChoice.TRUST_FOLDER:
          trustLevel = TrustLevel.TRUST_FOLDER;
          break;
        case FolderTrustChoice.TRUST_PARENT:
          trustLevel = TrustLevel.TRUST_PARENT;
          break;
        case FolderTrustChoice.DO_NOT_TRUST:
          trustLevel = TrustLevel.DO_NOT_TRUST;
          break;
        default:
          return;
      }

      trustedFolders.setValue(cwd, trustLevel);
      const trusted = isWorkspaceTrusted(settings.merged);
      setIsTrusted(trusted);
      setIsFolderTrustDialogOpen(false);
      onTrustChange(trusted);
    },
    [settings.merged, onTrustChange],
  );

  return {
    isTrusted,
    isFolderTrustDialogOpen,
    handleFolderTrustSelect,
    isRestarting,
  };
};
