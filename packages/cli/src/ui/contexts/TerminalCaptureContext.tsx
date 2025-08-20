/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useStdout } from 'ink';

// Dynamic import to handle the ESM module
let AnsiToHtml: any;
try {
  AnsiToHtml = require('ansi-to-html');
} catch (e) {
  console.warn('ansi-to-html not available, terminal capture will use plain text');
}

export interface TerminalCaptureData {
  content: string;  // HTML content
  timestamp: number;
  isInteractive: boolean;
}

interface TerminalCaptureContextValue {
  startCapture: () => void;
  stopCapture: () => void;
  getCapturedContent: () => string;
  isCapturing: boolean;
  setInteractiveScreenActive: (active: boolean) => void;
}

const TerminalCaptureContext = createContext<TerminalCaptureContextValue | undefined>(undefined);

interface TerminalCaptureProviderProps {
  children: React.ReactNode;
  onTerminalUpdate?: (data: TerminalCaptureData) => void;
}

export function TerminalCaptureProvider({ children, onTerminalUpdate }: TerminalCaptureProviderProps) {
  const { stdout } = useStdout();
  const originalWrite = useRef<typeof process.stdout.write | null>(null);
  const capturedOutput = useRef<string>('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [isInteractiveScreen, setIsInteractiveScreen] = useState(false);
  const lastBroadcast = useRef<string>('');
  const writeBuffer = useRef<string>('');
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const converter = useRef(AnsiToHtml ? new AnsiToHtml({
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
      15: '#ffffff'
    }
  }) : null);

  // Process buffered writes and broadcast
  const processBuffer = useCallback(() => {
    if (!writeBuffer.current) return;
    
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
    
    // Broadcast the update
    if (onTerminalUpdate && capturedOutput.current !== lastBroadcast.current) {
      lastBroadcast.current = capturedOutput.current;
      
      const htmlContent = converter.current
        ? converter.current.toHtml(capturedOutput.current)
        : `<pre>${capturedOutput.current}</pre>`;
      
      onTerminalUpdate({
        content: htmlContent,
        timestamp: Date.now(),
        isInteractive: isInteractiveScreen
      });
    }
  }, [onTerminalUpdate, isInteractiveScreen]);
  
  const startCapture = useCallback(() => {
    if (originalWrite.current) return; // Already capturing
    
    // Clear previous capture
    capturedOutput.current = '';
    lastBroadcast.current = '';
    writeBuffer.current = '';
    
    // Store original write function
    originalWrite.current = process.stdout.write.bind(process.stdout);
    
    // Override stdout.write to capture output
    (process.stdout.write as any) = (chunk: any, encoding?: any, callback?: any): boolean => {
      // Capture the output
      if (typeof chunk === 'string' || chunk instanceof Buffer) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        
        // Add to write buffer
        writeBuffer.current += text;
        
        // Cancel any pending processing
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
        }
        
        // Schedule processing after current event loop tick
        // This batches all writes from a single Ink render
        debounceTimer.current = setTimeout(processBuffer, 0);
      }
      
      // Still write to actual stdout
      if (originalWrite.current) {
        return originalWrite.current(chunk, encoding, callback);
      }
      return true;
    };
    
    setIsCapturing(true);
  }, [processBuffer]);

  const stopCapture = useCallback(() => {
    if (originalWrite.current) {
      // Restore original write function
      process.stdout.write = originalWrite.current;
      originalWrite.current = null;
    }
    
    // Clear any pending timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    
    // Clear capture buffers
    capturedOutput.current = '';
    lastBroadcast.current = '';
    writeBuffer.current = '';
    setIsCapturing(false);
    
    // Send clear signal
    if (onTerminalUpdate) {
      onTerminalUpdate({
        content: '',
        timestamp: Date.now(),
        isInteractive: false
      });
    }
  }, [onTerminalUpdate]);

  const getCapturedContent = useCallback(() => {
    return capturedOutput.current;
  }, []);

  const setInteractiveScreenActive = useCallback((active: boolean) => {
    setIsInteractiveScreen(active);
    
    if (active) {
      startCapture();
    } else {
      stopCapture();
    }
  }, [startCapture, stopCapture]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (originalWrite.current) {
        process.stdout.write = originalWrite.current;
      }
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const value: TerminalCaptureContextValue = {
    startCapture,
    stopCapture,
    getCapturedContent,
    isCapturing,
    setInteractiveScreenActive
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
    throw new Error('useTerminalCapture must be used within TerminalCaptureProvider');
  }
  return context;
}