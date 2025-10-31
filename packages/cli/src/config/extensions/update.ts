/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ExtensionUpdateAction,
  ExtensionUpdateState,
  type ExtensionUpdateStatus,
} from '../../ui/state/extensions.js';
import { loadInstallMetadata } from '../extension.js';
import { checkForExtensionUpdate } from './github.js';
import {
  debugLogger,
  t,
  type GeminiCLIExtension,
} from '@thacio/auditaria-cli-core';
import * as fs from 'node:fs';
import { getErrorMessage } from '../../utils/errors.js';
import { copyExtension, type ExtensionManager } from '../extension-manager.js';
import { ExtensionStorage } from './storage.js';

export interface ExtensionUpdateInfo {
  name: string;
  originalVersion: string;
  updatedVersion: string;
}

export async function updateExtension(
  extension: GeminiCLIExtension,
  extensionManager: ExtensionManager,
  currentState: ExtensionUpdateState,
  dispatchExtensionStateUpdate: (action: ExtensionUpdateAction) => void,
  enableExtensionReloading?: boolean,
): Promise<ExtensionUpdateInfo | undefined> {
  if (currentState === ExtensionUpdateState.UPDATING) {
    return undefined;
  }
  dispatchExtensionStateUpdate({
    type: 'SET_STATE',
    payload: { name: extension.name, state: ExtensionUpdateState.UPDATING },
  });
  const installMetadata = loadInstallMetadata(extension.path);

  if (!installMetadata?.type) {
    dispatchExtensionStateUpdate({
      type: 'SET_STATE',
      payload: { name: extension.name, state: ExtensionUpdateState.ERROR },
    });
    throw new Error(
      t(
        'commands.extensions.update.cannot_update_type_unknown',
        `Extension ${extension.name} cannot be updated, type is unknown.`,
        { name: extension.name },
      ),
    );
  }
  if (installMetadata?.type === 'link') {
    dispatchExtensionStateUpdate({
      type: 'SET_STATE',
      payload: { name: extension.name, state: ExtensionUpdateState.UP_TO_DATE },
    });
    throw new Error(
      t(
        'commands.extensions.update.linked_no_update',
        'Extension is linked so does not need to be updated',
      ),
    );
  }
  const originalVersion = extension.version;

  const tempDir = await ExtensionStorage.createTmpDir();
  try {
    const previousExtensionConfig = extensionManager.loadExtensionConfig(
      extension.path,
    );
    let updatedExtension: GeminiCLIExtension;
    try {
      updatedExtension = await extensionManager.installOrUpdateExtension(
        installMetadata,
        previousExtensionConfig,
      );
    } catch (e) {
      dispatchExtensionStateUpdate({
        type: 'SET_STATE',
        payload: { name: extension.name, state: ExtensionUpdateState.ERROR },
      });
      throw new Error(
        t(
          'commands.extensions.update.not_found_after_install',
          'Updated extension not found after installation.',
        ) + ` Got error:\n${e}`,
      );
    }
    const updatedVersion = updatedExtension.version;
    dispatchExtensionStateUpdate({
      type: 'SET_STATE',
      payload: {
        name: extension.name,
        state: enableExtensionReloading
          ? ExtensionUpdateState.UPDATED
          : ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      },
    });
    return {
      name: extension.name,
      originalVersion,
      updatedVersion,
    };
  } catch (e) {
    debugLogger.error(
      t(
        'commands.extensions.update.error_rolling_back',
        `Error updating extension, rolling back. ${getErrorMessage(e)}`,
        { error: getErrorMessage(e) },
      ),
    );
    dispatchExtensionStateUpdate({
      type: 'SET_STATE',
      payload: { name: extension.name, state: ExtensionUpdateState.ERROR },
    });
    await copyExtension(tempDir, extension.path);
    throw e;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export async function updateAllUpdatableExtensions(
  extensions: GeminiCLIExtension[],
  extensionsState: Map<string, ExtensionUpdateStatus>,
  extensionManager: ExtensionManager,
  dispatch: (action: ExtensionUpdateAction) => void,
  enableExtensionReloading?: boolean,
): Promise<ExtensionUpdateInfo[]> {
  return (
    await Promise.all(
      extensions
        .filter(
          (extension) =>
            extensionsState.get(extension.name)?.status ===
            ExtensionUpdateState.UPDATE_AVAILABLE,
        )
        .map((extension) =>
          updateExtension(
            extension,
            extensionManager,
            extensionsState.get(extension.name)!.status,
            dispatch,
            enableExtensionReloading,
          ),
        ),
    )
  ).filter((updateInfo) => !!updateInfo);
}

export interface ExtensionUpdateCheckResult {
  state: ExtensionUpdateState;
  error?: string;
}

export async function checkForAllExtensionUpdates(
  extensions: GeminiCLIExtension[],
  extensionManager: ExtensionManager,
  dispatch: (action: ExtensionUpdateAction) => void,
): Promise<void> {
  dispatch({ type: 'BATCH_CHECK_START' });
  try {
    const promises: Array<Promise<void>> = [];
    for (const extension of extensions) {
      if (!extension.installMetadata) {
        dispatch({
          type: 'SET_STATE',
          payload: {
            name: extension.name,
            state: ExtensionUpdateState.NOT_UPDATABLE,
          },
        });
        continue;
      }
      dispatch({
        type: 'SET_STATE',
        payload: {
          name: extension.name,
          state: ExtensionUpdateState.CHECKING_FOR_UPDATES,
        },
      });
      promises.push(
        checkForExtensionUpdate(extension, extensionManager).then((state) =>
          dispatch({
            type: 'SET_STATE',
            payload: { name: extension.name, state },
          }),
        ),
      );
    }
    await Promise.all(promises);
  } finally {
    dispatch({ type: 'BATCH_CHECK_END' });
  }
}
