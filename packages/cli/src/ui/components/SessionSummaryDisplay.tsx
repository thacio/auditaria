/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@google/gemini-cli-core';

import React from 'react';
import { StatsDisplay } from './StatsDisplay.js';

interface SessionSummaryDisplayProps {
  duration: string;
}

export const SessionSummaryDisplay: React.FC<SessionSummaryDisplayProps> = ({
  duration,
}) => (
  <StatsDisplay title={t('stats.session_goodbye', 'Agent powering down. Goodbye!')} duration={duration} />
);
