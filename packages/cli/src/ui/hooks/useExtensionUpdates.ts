/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GeminiCLIExtension } from '@thacio/auditaria-cli-core';
import { t } from '@thacio/auditaria-cli-core';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionUpdateState } from '../state/extensions.js';
import { useMemo, useState } from 'react';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType } from '../types.js';
import {
  checkForAllExtensionUpdates,
  updateExtension,
} from '../../config/extensions/update.js';
import { requestConsentInteractive } from '../../config/extension.js';

export const useExtensionUpdates = (
  extensions: GeminiCLIExtension[],
  addItem: UseHistoryManagerReturn['addItem'],
  cwd: string,
) => {
  const [extensionsUpdateState, setExtensionsUpdateState] = useState(
    new Map<string, ExtensionUpdateState>(),
  );
  useMemo(() => {
    const checkUpdates = async () => {
      const updateState = await checkForAllExtensionUpdates(
        extensions,
        extensionsUpdateState,
        setExtensionsUpdateState,
      );
      for (const extension of extensions) {
        const prevState = extensionsUpdateState.get(extension.name);
        const currentState = updateState.get(extension.name);
        if (
          prevState === currentState ||
          currentState !== ExtensionUpdateState.UPDATE_AVAILABLE
        ) {
          continue;
        }
        if (extension.installMetadata?.autoUpdate) {
          updateExtension(
            extension,
            cwd,
            (description) => requestConsentInteractive(description, addItem),
            currentState,
            (newState) => {
              setExtensionsUpdateState((prev) => {
                const finalState = new Map(prev);
                finalState.set(extension.name, newState);
                return finalState;
              });
            },
          )
            .then((result) => {
              if (!result) return;
              addItem(
                {
                  type: MessageType.INFO,
                  text: t(
                    'extensions.auto_update.success',
                    `Extension "${extension.name}" successfully updated: ${result.originalVersion} → ${result.updatedVersion}.`,
                    {
                      name: extension.name,
                      originalVersion: result.originalVersion,
                      updatedVersion: result.updatedVersion,
                    },
                  ),
                },
                Date.now(),
              );
            })
            .catch((error) => {
              console.error(
                `Error updating extension "${extension.name}": ${getErrorMessage(error)}.`,
              );
            });
        } else {
          addItem(
            {
              type: MessageType.INFO,
              text: t(
                'extensions.auto_update.available',
                `Extension ${extension.name} has an update available, run "/extensions update ${extension.name}" to install it.`,
                { name: extension.name },
              ),
            },
            Date.now(),
          );
        }
      }
    };
    checkUpdates();
  }, [
    extensions,
    extensionsUpdateState,
    setExtensionsUpdateState,
    addItem,
    cwd,
  ]);
  return {
    extensionsUpdateState,
    setExtensionsUpdateState,
  };
};
