/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
} from 'react';
import { useStdout } from 'ink';
import { registerStdoutHook } from '@google/gemini-cli-core';

// Dynamic import to handle the ESM module
let AnsiToHtml: any;
try {
  AnsiToHtml = require('ansi-to-html');
} catch (e) {
  console.warn(
    'ansi-to-html not available, terminal capture will use plain text',
  );
}

export interface TerminalCaptureData {
  content: string; // HTML content
  timestamp: number;
  isInteractive: boolean;
}

interface TerminalCaptureContextValue {
  getCapturedContent: () => string;
  isCapturing: boolean;
  setInteractiveScreenActive: (active: boolean) => void;
}

const TerminalCaptureContext = createContext<
  TerminalCaptureContextValue | undefined
>(undefined);

interface TerminalCaptureProviderProps {
  children: React.ReactNode;
  onTerminalUpdate?: (data: TerminalCaptureData) => void;
}

export function TerminalCaptureProvider({
  children,
  onTerminalUpdate,
}: TerminalCaptureProviderProps) {
  const { stdout } = useStdout();
  const cleanupHookRef = useRef<(() => void) | null>(null);
  const capturedOutput = useRef<string>('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [isInteractiveScreen, setIsInteractiveScreen] = useState(false);
  const isInteractiveScreenRef = useRef(isInteractiveScreen);
  const lastBroadcast = useRef<string>('');
  const writeBuffer = useRef<string>('');
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const converter = useRef(
    AnsiToHtml
      ? new AnsiToHtml({
          fg: '#c9d1d9',
          bg: '#0d1117',
          newline: true,
          escapeXML: true,
          colors: {
            0: '#000000',
            1: '#da3633',
            2: '#238636',
            3: '#fb8500',
            4: '#1f6feb',
            5: '#8b5cf6',
            6: '#39c5cf',
            7: '#c9d1d9',
            8: '#666666',
            9: '#ff7b72',
            10: '#3fb950',
            11: '#ffa657',
            12: '#58a6ff',
            13: '#bc8cff',
            14: '#79c0ff',
            15: '#ffffff',
          },
        })
      : null,
  );

  // Store onTerminalUpdate in a ref to avoid stale closure issues
  // This is critical: the callback captured by setTimeout must use the latest version
  const onTerminalUpdateRef = useRef(onTerminalUpdate);
  useEffect(() => {
    onTerminalUpdateRef.current = onTerminalUpdate;
  }, [onTerminalUpdate]);

  // Keep isInteractiveScreenRef in sync
  useEffect(() => {
    isInteractiveScreenRef.current = isInteractiveScreen;
  }, [isInteractiveScreen]);

  // Process buffered writes and broadcast (only when interactive screen is active)
  // This function is called via setTimeout, so we use refs to get the latest values
  const processBuffer = useCallback(() => {
    // Process any pending writes first
    if (writeBuffer.current) {
      // Detect Ink re-render signals
      // \x1B[...A - Cursor up (most reliable signal for redraw)
      // \x1B[...J - Clear screen (fallback)
      // \x1B[H - Cursor home (often precedes redraw)
      const redrawSignalRegex = /\x1B\[(\d+)?A|\x1B\[[0-2]?J|\x1B\[H/;

      // If redraw signal detected, reset the captured output
      if (redrawSignalRegex.test(writeBuffer.current)) {
        capturedOutput.current = '';
      }

      // Append the buffered content
      capturedOutput.current += writeBuffer.current;
      writeBuffer.current = ''; // Clear buffer after processing
    }

    // Only broadcast when interactive screen is active
    // This is the key to the generic prewarming solution:
    // - Hook captures ALL output (including first dialog render)
    // - But we only broadcast when isInteractiveScreen is true
    // - When dialog opens, useEffect sets isInteractiveScreen=true
    // - By then, the first render is already in capturedOutput
    if (!isInteractiveScreenRef.current) {
      return;
    }

    // Broadcast the update - use ref to get latest callback
    // IMPORTANT: We broadcast even if writeBuffer was empty, because capturedOutput
    // might have content that was processed before the interactive screen became active
    const callback = onTerminalUpdateRef.current;
    if (callback && capturedOutput.current !== lastBroadcast.current) {
      lastBroadcast.current = capturedOutput.current;

      const htmlContent = converter.current
        ? converter.current.toHtml(capturedOutput.current)
        : `<pre>${capturedOutput.current}</pre>`;

      callback({
        content: htmlContent,
        timestamp: Date.now(),
        isInteractive: true,
      });
    }
  }, []); // No dependencies - uses refs for latest values

  // Register stdout hook on mount (always-on capture)
  // This is the key to generic prewarming: hook is always active,
  // so first dialog render is captured before useEffect runs
  useEffect(() => {
    if (!onTerminalUpdate) return; // Don't capture if no callback

    // Register hook to capture Ink's output via the core's writeToStdout
    cleanupHookRef.current = registerStdoutHook((chunk, encoding) => {
      // Capture the output
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Buffer
            ? chunk.toString(encoding)
            : String(chunk);

      // Add to write buffer
      writeBuffer.current += text;

      // Cancel any pending processing
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      // Schedule processing after current event loop tick
      // This batches all writes from a single Ink render
      debounceTimer.current = setTimeout(processBuffer, 0);
    });

    setIsCapturing(true);

    // Cleanup on unmount
    return () => {
      if (cleanupHookRef.current) {
        cleanupHookRef.current();
        cleanupHookRef.current = null;
      }
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      setIsCapturing(false);
    };
  }, [onTerminalUpdate, processBuffer]);

  const getCapturedContent = useCallback(() => {
    return capturedOutput.current;
  }, []);

  const setInteractiveScreenActive = useCallback((active: boolean) => {
    // CRITICAL: Update ref synchronously BEFORE setTimeout callback runs
    // The useEffect that normally updates this ref runs AFTER React's render cycle,
    // but setTimeout(0) runs in the next macrotask which is BEFORE the useEffect.
    // Without this fix, processBuffer() would check isInteractiveScreenRef.current
    // while it's still false, causing it to bail out without broadcasting.
    isInteractiveScreenRef.current = active;
    setIsInteractiveScreen(active);

    if (active) {
      // Dialog is opening - force a broadcast of any buffered content
      // The buffer may already contain the first render from before this useEffect ran
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      // Use setTimeout to allow any pending React renders to complete first
      setTimeout(() => {
        // Force process any pending buffer
        if (writeBuffer.current || capturedOutput.current) {
          processBuffer();
        }
      }, 0);
    } else {
      // Dialog is closing - clear buffers and send empty content
      capturedOutput.current = '';
      lastBroadcast.current = '';
      writeBuffer.current = '';

      // Send clear signal
      const callback = onTerminalUpdateRef.current;
      if (callback) {
        callback({
          content: '',
          timestamp: Date.now(),
          isInteractive: false,
        });
      }
    }
  }, [processBuffer]);

  const value: TerminalCaptureContextValue = {
    getCapturedContent,
    isCapturing,
    setInteractiveScreenActive,
  };

  return (
    <TerminalCaptureContext.Provider value={value}>
      {children}
    </TerminalCaptureContext.Provider>
  );
}

export function useTerminalCapture() {
  const context = useContext(TerminalCaptureContext);
  if (!context) {
    throw new Error(
      'useTerminalCapture must be used within TerminalCaptureProvider',
    );
  }
  return context;
}
