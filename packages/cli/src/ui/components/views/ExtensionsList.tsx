/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useUIState } from '../../contexts/UIStateContext.js';
import { ExtensionUpdateState } from '../../state/extensions.js';
import { t } from '@thacio/auditaria-cli-core';

export const ExtensionsList = () => {
  const { commandContext, extensionsUpdateState } = useUIState();
  const allExtensions = commandContext.services.config!.getExtensions();

  if (allExtensions.length === 0) {
    return (
      <Text>
        {t('commands.extensions.list.no_extensions', 'No extensions installed.')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>
        {t(
          'commands.extensions.list.installed_extensions',
          'Installed extensions:',
        )}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {allExtensions.map((ext) => {
          const state = extensionsUpdateState.get(ext.name);
          const isActive = ext.isActive;
          const activeString = isActive
            ? t('commands.extensions.list.status.active', 'active')
            : t('commands.extensions.list.status.disabled', 'disabled');
          const activeColor = isActive ? 'green' : 'grey';

          let stateColor = 'gray';
          const stateText =
            state ||
            t('commands.extensions.list.status.unknown', 'unknown state');

          switch (state) {
            case ExtensionUpdateState.CHECKING_FOR_UPDATES:
            case ExtensionUpdateState.UPDATING:
              stateColor = 'cyan';
              break;
            case ExtensionUpdateState.UPDATE_AVAILABLE:
            case ExtensionUpdateState.UPDATED_NEEDS_RESTART:
              stateColor = 'yellow';
              break;
            case ExtensionUpdateState.ERROR:
              stateColor = 'red';
              break;
            case ExtensionUpdateState.UP_TO_DATE:
            case ExtensionUpdateState.NOT_UPDATABLE:
              stateColor = 'green';
              break;
            default:
              console.error(
                t(
                  'commands.extensions.list.unhandled_state_error',
                  'Unhandled ExtensionUpdateState {state}',
                  { state: String(state) },
                ),
              );
              break;
          }

          return (
            <Box key={ext.name}>
              <Text>
                <Text color="cyan">{`${ext.name} (v${ext.version})`}</Text>
                <Text color={activeColor}>{` - ${activeString}`}</Text>
                {<Text color={stateColor}>{` (${stateText})`}</Text>}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
