/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Shared usage labels for workflow cards and the panel.
export function workflowUsageLabel(tokens, unavailable) {
  if (unavailable)
    return tokens
      ? `${tokens.toLocaleString()} tokens (partial)`
      : 'Usage unavailable';
  return tokens === undefined
    ? 'Usage pending'
    : `${tokens.toLocaleString()} tokens`;
}

export function workflowRunUsage(run) {
  return workflowUsageLabel(
    run.totalTokens,
    run.progress?.some((row) => row.usageUnavailable),
  );
}
