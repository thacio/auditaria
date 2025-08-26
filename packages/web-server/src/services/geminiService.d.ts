/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { Config, GeminiClient } from '@thacio/auditaria-cli-core';
import { HistoryItem, HistoryItemWithoutId } from '@thacio/auditaria-cli';
export interface WebSession {
    id: string;
    config: Config;
    client: GeminiClient;
    history: HistoryItem[];
    createdAt: Date;
    lastActivity: Date;
}
/**
 * Web service that wraps the existing CLI functionality for web use
 */
export declare class GeminiWebService {
    private sessions;
    private defaultConfig;
    initialize(): Promise<void>;
    /**
     * Create a new web session
     */
    createSession(): Promise<string>;
    /**
     * Get session by ID
     */
    getSession(sessionId: string): WebSession;
    /**
     * Get session history
     */
    getHistory(sessionId: string): HistoryItem[];
    /**
     * Add item to session history
     */
    addHistoryItem(sessionId: string, item: HistoryItemWithoutId): HistoryItem;
    /**
     * Submit query to Gemini (this will be implemented with WebSocket streaming)
     */
    submitQuery(sessionId: string, message: string): Promise<void>;
    /**
     * Get session configuration
     */
    getSessionConfig(sessionId: string): {
        model: string;
        targetDir: string;
        debugMode: boolean;
    };
    /**
     * Clean up old sessions
     */
    cleanup(): void;
}
//# sourceMappingURL=geminiService.d.ts.map