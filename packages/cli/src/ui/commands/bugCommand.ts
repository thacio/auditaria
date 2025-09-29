/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import open from 'open';
import process from 'node:process';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t, sessionId, IdeClient } from '@thacio/auditaria-cli-core';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import { getCliVersion } from '../../utils/version.js';

export const bugCommand: SlashCommand = {
  name: 'bug',
  get description() {
    return t('commands.bug.description', 'submit a bug report');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    const bugDescription = (args || '').trim();
    const { config } = context.services;

    const osVersion = `${process.platform} ${process.version}`;
    let sandboxEnv = t('commands.bug.no_sandbox', 'no sandbox');
    if (process.env['SANDBOX'] && process.env['SANDBOX'] !== 'sandbox-exec') {
      sandboxEnv = process.env['SANDBOX'].replace(/^gemini-(?:code-)?/, '');
    } else if (process.env['SANDBOX'] === 'sandbox-exec') {
      sandboxEnv = `sandbox-exec (${
        process.env['SEATBELT_PROFILE'] || t('commands.bug.unknown_profile', 'unknown')
      })`;
    }
    const modelVersion = config?.getModel() || t('commands.bug.unknown_model', 'Unknown');
    const cliVersion = await getCliVersion();
    const memoryUsage = formatMemoryUsage(process.memoryUsage().rss);
    const ideClient = await getIdeClientName(context);

    let info = `
* **CLI Version:** ${cliVersion}
* **Git Commit:** ${GIT_COMMIT_INFO}
* **Session ID:** ${sessionId}
* **Operating System:** ${osVersion}
* **Sandbox Environment:** ${sandboxEnv}
* **Model Version:** ${modelVersion}
* **Memory Usage:** ${memoryUsage}
`;
    if (ideClient) {
      info += `* **IDE Client:** ${ideClient}\n`;
    }

    let bugReportUrl =
      'https://github.com/google-gemini/gemini-cli/issues/new?template=bug_report.yml&title={title}&info={info}';

    const bugCommandSettings = config?.getBugCommand();
    if (bugCommandSettings?.urlTemplate) {
      bugReportUrl = bugCommandSettings.urlTemplate;
    }

    bugReportUrl = bugReportUrl
      .replace('{title}', encodeURIComponent(bugDescription))
      .replace('{info}', encodeURIComponent(info));

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('commands.bug.submit_message', 'To submit your bug report, please open the following URL in your browser:\n{url}', { url: bugReportUrl }),
      },
      Date.now(),
    );

    try {
      await open(bugReportUrl);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('commands.bug.browser_error', 'Could not open URL in browser: {error}', { error: errorMessage }),
        },
        Date.now(),
      );
    }
  },
};

async function getIdeClientName(context: CommandContext) {
  if (!context.services.config?.getIdeMode()) {
    return '';
  }
  const ideClient = await IdeClient.getInstance();
  return ideClient.getDetectedIdeDisplayName() ?? '';
}
