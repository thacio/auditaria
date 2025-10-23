/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolCallRequestInfo,
  ExecutingToolCall,
  ScheduledToolCall,
  ValidatingToolCall,
  WaitingToolCall,
  CompletedToolCall,
  CancelledToolCall,
  OutputUpdateHandler,
  AllToolCallsCompleteHandler,
  ToolCallsUpdateHandler,
  ToolCall,
  Status as CoreStatus,
  EditorType,
} from '@thacio/auditaria-cli-core';
import { CoreToolScheduler, debugLogger } from '@thacio/auditaria-cli-core';
import { useCallback, useState, useMemo, useEffect, useRef } from 'react';
import type {
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';
// WEB_INTERFACE_START
import { useToolConfirmation } from '../contexts/ToolConfirmationContext.js';
// WEB_INTERFACE_END
export type ScheduleFn = (
  request: ToolCallRequestInfo | ToolCallRequestInfo[],
  signal: AbortSignal,
) => void;
export type MarkToolsAsSubmittedFn = (callIds: string[]) => void;

export type TrackedScheduledToolCall = ScheduledToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedValidatingToolCall = ValidatingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedWaitingToolCall = WaitingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedExecutingToolCall = ExecutingToolCall & {
  responseSubmittedToGemini?: boolean;
  pid?: number;
};
export type TrackedCompletedToolCall = CompletedToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCancelledToolCall = CancelledToolCall & {
  responseSubmittedToGemini?: boolean;
};

export type TrackedToolCall =
  | TrackedScheduledToolCall
  | TrackedValidatingToolCall
  | TrackedWaitingToolCall
  | TrackedExecutingToolCall
  | TrackedCompletedToolCall
  | TrackedCancelledToolCall;

export function useReactToolScheduler(
  onComplete: (tools: CompletedToolCall[]) => Promise<void>,
  config: Config,
  getPreferredEditor: () => EditorType | undefined,
  onEditorClose: () => void,
): [TrackedToolCall[], ScheduleFn, MarkToolsAsSubmittedFn] {
  const [toolCallsForDisplay, setToolCallsForDisplay] = useState<
    TrackedToolCall[]
  >([]);

  // WEB_INTERFACE_START
  const toolConfirmationContext = useToolConfirmation();
  // WEB_INTERFACE_END

  // Store callbacks in refs to keep them up-to-date without causing re-renders.
  const onCompleteRef = useRef(onComplete);
  const getPreferredEditorRef = useRef(getPreferredEditor);
  const onEditorCloseRef = useRef(onEditorClose);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    getPreferredEditorRef.current = getPreferredEditor;
  }, [getPreferredEditor]);

  useEffect(() => {
    onEditorCloseRef.current = onEditorClose;
  }, [onEditorClose]);
  const outputUpdateHandler: OutputUpdateHandler = useCallback(
    (toolCallId, outputChunk) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) => {
          if (tc.request.callId === toolCallId && tc.status === 'executing') {
            const executingTc = tc as TrackedExecutingToolCall;
            return { ...executingTc, liveOutput: outputChunk };
          }
          return tc;
        }),
      );
    },
    [],
  );

  const allToolCallsCompleteHandler: AllToolCallsCompleteHandler = useCallback(
    async (completedToolCalls) => {
      await onCompleteRef.current(completedToolCalls);
    },
    [],
  );

  const toolCallsUpdateHandler: ToolCallsUpdateHandler = useCallback(
    (updatedCoreToolCalls: ToolCall[]) => {
      setToolCallsForDisplay((prevTrackedCalls) =>
        updatedCoreToolCalls.map((coreTc) => {
          const existingTrackedCall = prevTrackedCalls.find(
            (ptc) => ptc.request.callId === coreTc.request.callId,
          );
          // Start with the new core state, then layer on the existing UI state
          // to ensure UI-only properties like pid are preserved.
          const responseSubmittedToGemini =
            existingTrackedCall?.responseSubmittedToGemini ?? false;

          if (coreTc.status === 'executing') {
            return {
              ...coreTc,
              responseSubmittedToGemini,
              liveOutput: (existingTrackedCall as TrackedExecutingToolCall)
                ?.liveOutput,
              pid: (coreTc as ExecutingToolCall).pid,
            };
          }

          // For other statuses, explicitly set liveOutput and pid to undefined
          // to ensure they are not carried over from a previous executing state.
          return {
            ...coreTc,
            responseSubmittedToGemini,
            liveOutput: undefined,
            pid: undefined,
          };
        }),
      );
    },
    [setToolCallsForDisplay],
  );
  // WEB_INTERFACE_START
  // Handle tool confirmations for web interface
  const prevAwaitingApprovalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!toolConfirmationContext) return;

    // Get current call IDs that are awaiting approval
    const currentAwaitingApprovalIds = new Set(
      toolCallsForDisplay
        .filter((tc) => tc.status === 'awaiting_approval')
        .map((tc) => tc.request.callId),
    );

    const prevAwaitingApprovalIds = prevAwaitingApprovalIdsRef.current;

    // Add new confirmations (only those not seen before)
    toolCallsForDisplay.forEach((toolCall) => {
      if (
        toolCall.status === 'awaiting_approval' &&
        'confirmationDetails' in toolCall &&
        !prevAwaitingApprovalIds.has(toolCall.request.callId)
      ) {
        const waitingCall = toolCall as TrackedWaitingToolCall;
        const pendingConfirmation = {
          callId: waitingCall.request.callId,
          toolName: waitingCall.tool?.displayName || waitingCall.request.name,
          confirmationDetails: waitingCall.confirmationDetails,
          timestamp: Date.now(),
        };

        toolConfirmationContext.addPendingConfirmation(pendingConfirmation);
      }
    });

    // Remove confirmations that are no longer awaiting approval (based on previous state)
    prevAwaitingApprovalIds.forEach((prevCallId) => {
      if (!currentAwaitingApprovalIds.has(prevCallId)) {
        toolConfirmationContext.removePendingConfirmation(prevCallId);
      }
    });

    // Update the ref for next time
    prevAwaitingApprovalIdsRef.current = currentAwaitingApprovalIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallsForDisplay]); // Only depend on toolCallsForDisplay
  // WEB_INTERFACE_END

  const stableGetPreferredEditor = useCallback(
    () => getPreferredEditorRef.current(),
    [],
  );
  const stableOnEditorClose = useCallback(() => onEditorCloseRef.current(), []);
  const scheduler = useMemo(
    () =>
      new CoreToolScheduler({
        outputUpdateHandler,
        onAllToolCallsComplete: allToolCallsCompleteHandler,
        onToolCallsUpdate: toolCallsUpdateHandler,
        getPreferredEditor: stableGetPreferredEditor,
        config,
        onEditorClose: stableOnEditorClose,
      }),
    [
      config,
      outputUpdateHandler,
      allToolCallsCompleteHandler,
      toolCallsUpdateHandler,
      stableGetPreferredEditor,
      stableOnEditorClose,
    ],
  );

  const schedule: ScheduleFn = useCallback(
    (
      request: ToolCallRequestInfo | ToolCallRequestInfo[],
      signal: AbortSignal,
    ) => {
      void scheduler.schedule(request, signal);
    },
    [scheduler],
  );

  const markToolsAsSubmitted: MarkToolsAsSubmittedFn = useCallback(
    (callIdsToMark: string[]) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) =>
          callIdsToMark.includes(tc.request.callId)
            ? { ...tc, responseSubmittedToGemini: true }
            : tc,
        ),
      );
    },
    [],
  );

  return [toolCallsForDisplay, schedule, markToolsAsSubmitted];
}

/**
 * Maps a CoreToolScheduler status to the UI's ToolCallStatus enum.
 */
function mapCoreStatusToDisplayStatus(coreStatus: CoreStatus): ToolCallStatus {
  switch (coreStatus) {
    case 'validating':
      return ToolCallStatus.Executing;
    case 'awaiting_approval':
      return ToolCallStatus.Confirming;
    case 'executing':
      return ToolCallStatus.Executing;
    case 'success':
      return ToolCallStatus.Success;
    case 'cancelled':
      return ToolCallStatus.Canceled;
    case 'error':
      return ToolCallStatus.Error;
    case 'scheduled':
      return ToolCallStatus.Pending;
    default: {
      const exhaustiveCheck: never = coreStatus;
      debugLogger.warn(`Unknown core status encountered: ${exhaustiveCheck}`);
      return ToolCallStatus.Error;
    }
  }
}

/**
 * Transforms `TrackedToolCall` objects into `HistoryItemToolGroup` objects for UI display.
 */
export function mapToDisplay(
  toolOrTools: TrackedToolCall[] | TrackedToolCall,
): HistoryItemToolGroup {
  const toolCalls = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];

  const toolDisplays = toolCalls.map(
    (trackedCall): IndividualToolCallDisplay => {
      let displayName: string;
      let description: string;
      let renderOutputAsMarkdown = false;

      if (trackedCall.status === 'error') {
        displayName =
          trackedCall.tool === undefined
            ? trackedCall.request.name
            : trackedCall.tool.displayName;
        description = JSON.stringify(trackedCall.request.args);
      } else {
        displayName = trackedCall.tool.displayName;
        description = trackedCall.invocation.getDescription();
        renderOutputAsMarkdown = trackedCall.tool.isOutputMarkdown;
      }

      const baseDisplayProperties: Omit<
        IndividualToolCallDisplay,
        'status' | 'resultDisplay' | 'confirmationDetails'
      > = {
        callId: trackedCall.request.callId,
        name: displayName,
        description,
        renderOutputAsMarkdown,
      };

      switch (trackedCall.status) {
        case 'success':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
            outputFile: trackedCall.response.outputFile,
          };
        case 'error':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
          };
        case 'cancelled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
          };
        case 'awaiting_approval':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: trackedCall.confirmationDetails,
          };
        case 'executing':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay:
              (trackedCall as TrackedExecutingToolCall).liveOutput ?? undefined,
            confirmationDetails: undefined,
            ptyId: (trackedCall as TrackedExecutingToolCall).pid,
          };
        case 'validating': // Fallthrough
        case 'scheduled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: undefined,
          };
        default: {
          const exhaustiveCheck: never = trackedCall;
          return {
            callId: (exhaustiveCheck as TrackedToolCall).request.callId,
            name: 'Unknown Tool',
            description: 'Encountered an unknown tool call state.',
            status: ToolCallStatus.Error,
            resultDisplay: 'Unknown tool call state',
            confirmationDetails: undefined,
            renderOutputAsMarkdown: false,
          };
        }
      }
    },
  );

  return {
    type: 'tool_group',
    tools: toolDisplays,
  };
}
