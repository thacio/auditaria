/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { initI18n, t } from '@google/gemini-cli-core';
import { loadCliConfig, loadSettings } from '@google/gemini-cli';
import { v4 as uuidv4 } from 'uuid';
/**
 * Web service that wraps the existing CLI functionality for web use
 */
export class GeminiWebService {
    sessions = new Map();
    defaultConfig = null;
    async initialize() {
        // Initialize i18n with default language
        await initI18n('en');
        // Load default configuration (same as CLI does)
        const workspaceRoot = process.cwd();
        const settings = loadSettings(workspaceRoot);
        if (settings.errors.length > 0) {
            console.warn('Configuration warnings:', settings.errors);
        }
        // Create default config
        this.defaultConfig = await loadCliConfig(settings.merged, [], // No extensions for web for now
        `web-default-${Date.now()}`, {} // No CLI args
        );
        await this.defaultConfig.initialize();
        console.log('✅ Auditaria Web Service initialized');
    }
    /**
     * Create a new web session
     */
    async createSession() {
        if (!this.defaultConfig) {
            throw new Error('Service not initialized');
        }
        const sessionId = uuidv4();
        const workspaceRoot = process.cwd();
        const settings = loadSettings(workspaceRoot);
        // Create session-specific config
        const config = await loadCliConfig(settings.merged, [], `web-session-${sessionId}`, {});
        await config.initialize();
        const session = {
            id: sessionId,
            config,
            client: config.getGeminiClient(),
            history: [],
            createdAt: new Date(),
            lastActivity: new Date()
        };
        this.sessions.set(sessionId, session);
        // Add welcome message
        this.addHistoryItem(sessionId, {
            type: 'info',
            text: t('web.welcome', 'Welcome to Auditaria Web Interface! You can use all the same commands as the CLI.')
        });
        console.log(`📱 Created new web session: ${sessionId}`);
        return sessionId;
    }
    /**
     * Get session by ID
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        session.lastActivity = new Date();
        return session;
    }
    /**
     * Get session history
     */
    getHistory(sessionId) {
        const session = this.getSession(sessionId);
        return session.history;
    }
    /**
     * Add item to session history
     */
    addHistoryItem(sessionId, item) {
        const session = this.getSession(sessionId);
        const historyItem = {
            ...item,
            id: Date.now() + Math.random() // Simple ID generation
        };
        session.history.push(historyItem);
        session.lastActivity = new Date();
        return historyItem;
    }
    /**
     * Submit query to Gemini (this will be implemented with WebSocket streaming)
     */
    async submitQuery(sessionId, message) {
        const session = this.getSession(sessionId);
        // Add user message to history
        this.addHistoryItem(sessionId, {
            type: 'user',
            text: message
        });
        // This will be implemented with streaming via WebSocket
        // For now, just acknowledge receipt
        console.log(`💬 Query received for session ${sessionId}: ${message.substring(0, 50)}...`);
    }
    /**
     * Get session configuration
     */
    getSessionConfig(sessionId) {
        const session = this.getSession(sessionId);
        return {
            model: session.config.getModel(),
            targetDir: session.config.getTargetDir(),
            debugMode: session.config.getDebugMode(),
            // Add other relevant config properties
        };
    }
    /**
     * Clean up old sessions
     */
    cleanup() {
        const now = new Date();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        for (const [sessionId, session] of this.sessions.entries()) {
            if (now.getTime() - session.lastActivity.getTime() > maxAge) {
                this.sessions.delete(sessionId);
                console.log(`🧹 Cleaned up old session: ${sessionId}`);
            }
        }
    }
}
//# sourceMappingURL=geminiService.js.map