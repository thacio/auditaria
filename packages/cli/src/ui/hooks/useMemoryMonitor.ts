/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import process from 'node:process';
import { type HistoryItemWithoutId, MessageType } from '../types.js';
import { t } from '@thacio/auditaria-cli-core';

export const MEMORY_WARNING_THRESHOLD = 7 * 1024 * 1024 * 1024; // 7GB in bytes
export const MEMORY_CHECK_INTERVAL = 60 * 1000; // one minute

interface MemoryMonitorOptions {
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
}

export const useMemoryMonitor = ({ addItem }: MemoryMonitorOptions) => {
  useEffect(() => {
    const intervalId = setInterval(() => {
      const usage = process.memoryUsage().rss;
      if (usage > MEMORY_WARNING_THRESHOLD) {
        const usageGB = (usage / (1024 * 1024 * 1024)).toFixed(2);
        addItem(
          {
            type: MessageType.WARNING,
            text: t(
              'system.memory.high_usage_warning',
              'High memory usage detected: {usage} GB. If you experience a crash, please file a bug report by running `/bug`',
              { usage: usageGB },
            ),
          },
          Date.now(),
        );
        clearInterval(intervalId);
      }
    }, MEMORY_CHECK_INTERVAL);

    return () => clearInterval(intervalId);
  }, [addItem]);
};
