/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GeminiCLIExtension } from '@thacio/auditaria-cli-core';
import { t } from '@thacio/auditaria-cli-core';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionUpdateState } from '../state/extensions.js';
import { useState } from 'react';
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
  const [isChecking, setIsChecking] = useState(false);

  (async () => {
    if (isChecking) return;
    setIsChecking(true);
    try {
      const updateState = await checkForAllExtensionUpdates(
        extensions,
        extensionsUpdateState,
        setExtensionsUpdateState,
      );
      let extensionsWithUpdatesCount = 0;
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
          extensionsWithUpdatesCount++;
        }
      }
      if (extensionsWithUpdatesCount > 0) {
        const messageKey =
          extensionsWithUpdatesCount === 1
            ? 'extensions.updates_available_singular'
            : 'extensions.updates_available_plural';
        const defaultMessage =
          extensionsWithUpdatesCount === 1
            ? 'You have 1 extension with an update available, run "/extensions list" for more information.'
            : `You have ${extensionsWithUpdatesCount} extensions with an update available, run "/extensions list" for more information.`;
        addItem(
          {
            type: MessageType.INFO,
            text: t(messageKey, defaultMessage, {
              count: extensionsWithUpdatesCount.toString(),
            }),
          },
          Date.now(),
        );
      }
    } finally {
      setIsChecking(false);
    }
  })();

  return {
    extensionsUpdateState,
    setExtensionsUpdateState,
  };
};
