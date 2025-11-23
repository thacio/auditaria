/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getTranslationData, t } from '@google/gemini-cli-core';

import { useState, useEffect, useRef } from 'react';
import { INFORMATIVE_TIPS } from '../constants/tips.js';
import { WITTY_LOADING_PHRASES } from '../constants/wittyPhrases.js';

export const PHRASE_CHANGE_INTERVAL_MS = 15000;

const getWittyLoadingPhrases = (): string[] => {
  try {
    const translationData = getTranslationData();
    return translationData?.loading?.phrases || WITTY_LOADING_PHRASES;
  } catch {
    return WITTY_LOADING_PHRASES;
  }
};

/**
 * Custom hook to manage cycling through loading phrases.
 * @param isActive Whether the phrase cycling should be active.
 * @param isWaiting Whether to show a specific waiting phrase.
 * @returns The current loading phrase.
 */
export const usePhraseCycler = (
  isActive: boolean,
  isWaiting: boolean,
  customPhrases?: string[],
) => {
  const loadingPhrases =
    customPhrases && customPhrases.length > 0
      ? customPhrases
      : getWittyLoadingPhrases();

  const [currentLoadingPhrase, setCurrentLoadingPhrase] = useState(
    loadingPhrases[0],
  );
  const phraseIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasShownFirstRequestTipRef = useRef(false);

  useEffect(() => {
    if (isWaiting) {
      setCurrentLoadingPhrase(
        t('loading.waiting_confirmation', 'Waiting for user confirmation...'),
      );
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    } else if (isActive) {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
      }

      const setRandomPhrase = () => {
        if (customPhrases && customPhrases.length > 0) {
          const randomIndex = Math.floor(Math.random() * customPhrases.length);
          setCurrentLoadingPhrase(customPhrases[randomIndex]);
        } else {
          let phraseList;
          // Show a tip on the first request after startup, then continue with 1/6 chance
          if (!hasShownFirstRequestTipRef.current) {
            // Show a tip during the first request
            phraseList = INFORMATIVE_TIPS;
            hasShownFirstRequestTipRef.current = true;
          } else {
            // Roughly 1 in 6 chance to show a tip after the first request
            const showTip = Math.random() < 1 / 6;
            phraseList = showTip ? INFORMATIVE_TIPS : WITTY_LOADING_PHRASES;
          }
          const randomIndex = Math.floor(Math.random() * phraseList.length);
          setCurrentLoadingPhrase(phraseList[randomIndex]);
        }
      };

      // Select an initial random phrase
      setRandomPhrase();

      phraseIntervalRef.current = setInterval(() => {
        // Select a new random phrase
        setRandomPhrase();
      }, PHRASE_CHANGE_INTERVAL_MS);
    } else {
      // Idle or other states, clear the phrase interval
      // and reset to the first phrase for next active state.
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
      setCurrentLoadingPhrase(loadingPhrases[0]);
    }

    return () => {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    };
  }, [isActive, isWaiting, customPhrases, loadingPhrases]);

  return currentLoadingPhrase;
};
