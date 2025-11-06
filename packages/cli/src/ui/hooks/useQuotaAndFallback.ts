/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type FallbackModelHandler,
  type FallbackIntent,
  TerminalQuotaError,
  UserTierId,
  t,
} from '@thacio/auditaria-cli-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType } from '../types.js';
import { type ProQuotaDialogRequest } from '../contexts/UIStateContext.js';

interface UseQuotaAndFallbackArgs {
  config: Config;
  historyManager: UseHistoryManagerReturn;
  userTier: UserTierId | undefined;
  setModelSwitchedFromQuotaError: (value: boolean) => void;
}

export function useQuotaAndFallback({
  config,
  historyManager,
  userTier,
  setModelSwitchedFromQuotaError,
}: UseQuotaAndFallbackArgs) {
  const [proQuotaRequest, setProQuotaRequest] =
    useState<ProQuotaDialogRequest | null>(null);
  const isDialogPending = useRef(false);

  // Set up Flash fallback handler
  useEffect(() => {
    const fallbackHandler: FallbackModelHandler = async (
      failedModel,
      fallbackModel,
      error,
    ): Promise<FallbackIntent | null> => {
      if (config.isInFallbackMode()) {
        return null;
      }

      // Fallbacks are currently only handled for OAuth users.
      const contentGeneratorConfig = config.getContentGeneratorConfig();
      if (
        !contentGeneratorConfig ||
        contentGeneratorConfig.authType !== AuthType.LOGIN_WITH_GOOGLE
      ) {
        return null;
      }

      // Use actual user tier if available; otherwise, default to FREE tier behavior (safe default)
      const isPaidTier =
        userTier === UserTierId.LEGACY || userTier === UserTierId.STANDARD;

      let message: string;

      if (error instanceof TerminalQuotaError) {
        // Pro Quota specific messages (Interactive)
        if (isPaidTier) {
          message = t(
            'quota.pro_exceeded_paid_new',
            '⚡ You have reached your daily {model} quota limit.\n⚡ You can choose to authenticate with a paid API key or continue with the fallback model.\n⚡ Increase your limits by using a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key\n⚡ You can switch authentication methods by typing /auth',
            { model: failedModel },
          );
        } else {
          message = t(
            'quota.pro_exceeded_free_new',
            '⚡ You have reached your daily {model} quota limit.\n⚡ You can choose to authenticate with a paid API key or continue with the fallback model.\n⚡ Increase your limits by \n⚡ - signing up for a plan with higher limits at https://goo.gle/set-up-gemini-code-assist\n⚡ - or using a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key\n⚡ You can switch authentication methods by typing /auth',
            { model: failedModel },
          );
        }
      } else {
        message = t(
          'quota.congestion_error',
          '🚦Pardon Our Congestion! It looks like {model} is very popular at the moment.\nPlease retry again later.',
          { model: failedModel },
        );
      }

      // Add message to UI history
      historyManager.addItem(
        {
          type: MessageType.INFO,
          text: message,
        },
        Date.now(),
      );

      setModelSwitchedFromQuotaError(true);
      config.setQuotaErrorOccurred(true);

      if (isDialogPending.current) {
        return 'stop'; // A dialog is already active, so just stop this request.
      }
      isDialogPending.current = true;

      const intent: FallbackIntent = await new Promise<FallbackIntent>(
        (resolve) => {
          setProQuotaRequest({
            failedModel,
            fallbackModel,
            resolve,
          });
        },
      );

      return intent;
    };

    config.setFallbackModelHandler(fallbackHandler);
  }, [config, historyManager, userTier, setModelSwitchedFromQuotaError]);

  const handleProQuotaChoice = useCallback(
    (choice: FallbackIntent) => {
      if (!proQuotaRequest) return;

      const intent: FallbackIntent = choice;
      proQuotaRequest.resolve(intent);
      setProQuotaRequest(null);
      isDialogPending.current = false; // Reset the flag here

      if (choice === 'retry') {
        historyManager.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'quota.switched_to_fallback',
              'Switched to fallback model. Tip: Press Ctrl+P (or Up Arrow) to recall your previous prompt and submit it again if you wish.',
            ),
          },
          Date.now(),
        );
      }
    },
    [proQuotaRequest, historyManager],
  );

  return {
    proQuotaRequest,
    handleProQuotaChoice,
  };
}
