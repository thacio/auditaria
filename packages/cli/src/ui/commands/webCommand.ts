/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand, CommandKind } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const webCommand: SlashCommand = {
  name: 'web',
  get description() {
    return t('commands.web.description', 'manage web interface');
  },
  kind: CommandKind.BUILT_IN,
  action: () => ({
    type: 'message',
    messageType: 'info',
    content: t('commands.web.help', 'Web interface commands are not yet implemented. Use --web flag to start with web interface enabled.'),
  }),
};