/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: One place that turns (provider family, options) into a
// live ProviderDriver for a sub-agent. Two interaction styles:
//   'interactive' — the drivers `external_agent_session` has always used
//                   (Claude in a PTY with the web mirror off, Copilot ACP, …);
//   'headless'    — the promptless form workflow leaves use (`claude -p`
//                   print driver, `codex exec`, Copilot ACP, `agy --print`).

import type { CodexReasoningEffort, ProviderDriver } from './types.js';

export type DriverFamily = 'claude' | 'codex' | 'copilot' | 'agy';
export type DriverInteractionStyle = 'interactive' | 'headless';

export interface DriverSpec {
  family: DriverFamily;
  interactionStyle: DriverInteractionStyle;
  cwd: string;
  model?: string;
  /** Provider-agnostic effort word; clamped per provider by the caller. */
  reasoningEffort?: string;
  toolBridgePort?: number;
  toolBridgeScript?: string;
  toolBridgeExclude?: string[];
  /** Isolates the per-driver system-prompt file (sub-agents). */
  promptFileId: string;
  /** Codex: `read-only` for consult sessions, else full access. */
  readOnly?: boolean;
  /** Claude: native tools to block. */
  disallowedTools?: string[];
  /** Codex: an isolated CODEX_HOME (must carry auth.json/config.toml). */
  codexConfigHome?: string;
  /** Correlates this spawn's bridge with a registered StructuredOutput schema. */
  toolBridgeCallId?: string;
}

/** Construct the driver for a spec. The dynamic imports keep the CLI bundles lazy. */
export async function createProviderDriver(
  spec: DriverSpec,
): Promise<ProviderDriver> {
  const bridge = {
    toolBridgePort: spec.toolBridgePort,
    toolBridgeScript: spec.toolBridgeScript,
    toolBridgeExclude: spec.toolBridgeExclude?.length
      ? spec.toolBridgeExclude
      : undefined,
    toolBridgeCallId: spec.toolBridgeCallId,
  };
  switch (spec.family) {
    case 'claude': {
      const config = {
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        cwd: spec.cwd,
        permissionMode: 'bypassPermissions',
        disallowedTools: spec.disallowedTools,
        ...bridge,
        promptFileId: spec.promptFileId,
        mirrorPty: false,
      };
      if (spec.interactionStyle === 'headless') {
        const { ClaudeCLIDriverPrint } = await import(
          './claude/claudeCLIDriver.print.js'
        );
        return new ClaudeCLIDriverPrint(config);
      }
      const { ClaudeCLIDriver } = await import('./claude/claudeCLIDriver.js');
      return new ClaudeCLIDriver(config);
    }
    case 'codex': {
      const { CodexCLIDriver } = await import('./codex/codexCLIDriver.js');
      return new CodexCLIDriver({
        model: spec.model,
        cwd: spec.cwd,
        ...bridge,
        reasoningEffort: codexEffort(spec.reasoningEffort),
        sandboxMode: spec.readOnly ? 'read-only' : 'danger-full-access',
        promptFileId: spec.promptFileId,
        codexConfigHome: spec.codexConfigHome,
      });
    }
    case 'copilot': {
      const { CopilotCLIDriver } = await import(
        './copilot/copilotCLIDriver.js'
      );
      return new CopilotCLIDriver({
        model: spec.model,
        cwd: spec.cwd,
        ...bridge,
        reasoningEffort: spec.reasoningEffort,
        promptFileId: spec.promptFileId,
      });
    }
    case 'agy': {
      const { AgyCLIDriver } = await import('./agy/agyCLIDriver.js');
      return new AgyCLIDriver({
        model: spec.model,
        cwd: spec.cwd,
        ...bridge,
        promptFileId: spec.promptFileId,
      });
    }
    default:
      throw new Error(`Unknown provider family: ${String(spec.family)}`);
  }
}

function codexEffort(
  effort: string | undefined,
): CodexReasoningEffort | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return effort;
    default:
      return undefined;
  }
}
