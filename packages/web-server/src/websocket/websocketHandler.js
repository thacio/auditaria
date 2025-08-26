/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { WebSocket } from 'ws';
import { URL } from 'url';
import { GeminiEventType, t } from '@thacio/auditaria-cli-core';
/**
 * Handles WebSocket connections and real-time communication
 */
export class WebSocketHandler {
    geminiService;
    connections = new Map(); // ws -> sessionId
    constructor(geminiService) {
        this.geminiService = geminiService;
    }
    handleConnection(ws, request) {
        console.log('🔌 New WebSocket connection');
        // Parse session ID from query params or create new session
        let sessionId;
        try {
            const url = new URL(request.url || '', `http://${request.headers.host}`);
            sessionId = url.searchParams.get('sessionId') || '';
            if (!sessionId) {
                // Create new session
                this.geminiService.createSession().then(newSessionId => {
                    sessionId = newSessionId;
                    this.connections.set(ws, sessionId);
                    // Send session ID to client
                    this.sendMessage(ws, {
                        type: 'config',
                        sessionId,
                        data: {
                            sessionId,
                            ...this.geminiService.getSessionConfig(sessionId)
                        }
                    });
                });
            }
            else {
                // Use existing session
                this.connections.set(ws, sessionId);
                // Send current config and history
                this.sendMessage(ws, {
                    type: 'config',
                    sessionId,
                    data: {
                        sessionId,
                        ...this.geminiService.getSessionConfig(sessionId)
                    }
                });
                this.sendMessage(ws, {
                    type: 'history',
                    sessionId,
                    data: this.geminiService.getHistory(sessionId)
                });
            }
        }
        catch (error) {
            console.error('Error handling WebSocket connection:', error);
            ws.close(1011, 'Server error');
            return;
        }
        // Handle incoming messages
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(ws, message);
            }
            catch (error) {
                console.error('Error parsing WebSocket message:', error);
                this.sendError(ws, 'Invalid message format');
            }
        });
        // Handle connection close
        ws.on('close', () => {
            const sessionId = this.connections.get(ws);
            this.connections.delete(ws);
            console.log(`🔌 WebSocket connection closed (session: ${sessionId})`);
        });
        // Handle errors
        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            const sessionId = this.connections.get(ws);
            this.connections.delete(ws);
        });
    }
    async handleMessage(ws, message) {
        const sessionId = this.connections.get(ws);
        if (!sessionId) {
            this.sendError(ws, 'No active session');
            return;
        }
        try {
            switch (message.type) {
                case 'ping':
                    this.sendMessage(ws, { type: 'pong', sessionId });
                    break;
                case 'get_history':
                    const history = this.geminiService.getHistory(sessionId);
                    this.sendMessage(ws, {
                        type: 'history',
                        sessionId,
                        data: history
                    });
                    break;
                case 'get_config':
                    const config = this.geminiService.getSessionConfig(sessionId);
                    this.sendMessage(ws, {
                        type: 'config',
                        sessionId,
                        data: { sessionId, ...config }
                    });
                    break;
                case 'query':
                    if (!message.data?.text) {
                        this.sendError(ws, 'Query text is required');
                        return;
                    }
                    await this.handleQuery(ws, sessionId, message.data.text);
                    break;
                default:
                    this.sendError(ws, `Unknown message type: ${message.type}`);
            }
        }
        catch (error) {
            console.error('Error handling message:', error);
            this.sendError(ws, 'Internal server error');
        }
    }
    async handleQuery(ws, sessionId, queryText) {
        console.log(`🤖 Processing query for session ${sessionId}: ${queryText.substring(0, 50)}...`);
        try {
            const session = this.geminiService.getSession(sessionId);
            // Add user message to history
            const userMessage = this.geminiService.addHistoryItem(sessionId, {
                type: 'user',
                text: queryText
            });
            // Send user message to client immediately
            this.sendMessage(ws, {
                type: 'stream',
                sessionId,
                data: {
                    type: 'history_update',
                    item: userMessage
                }
            });
            // Start streaming response
            this.sendMessage(ws, {
                type: 'stream',
                sessionId,
                data: {
                    type: 'streaming_start'
                }
            });
            // Use the existing GeminiClient to generate response
            const client = session.client;
            // Create a simple streaming handler
            let responseText = '';
            const responseStartTime = Date.now();
            try {
                // Use the correct sendMessageStream method from GeminiClient
                const abortController = new AbortController();
                const promptId = `web-query-${Date.now()}`;
                // Send message using the streaming API
                const messageStream = client.sendMessageStream([{ text: queryText }], // PartListUnion format
                abortController.signal, promptId);
                // Process streaming events
                for await (const event of messageStream) {
                    if (event.type === GeminiEventType.Content) {
                        responseText += event.value || '';
                        // Could send incremental updates here if needed
                    }
                    // For other event types, we could handle them later (tool calls, errors, etc.)
                }
                // Add response to history
                const responseMessage = this.geminiService.addHistoryItem(sessionId, {
                    type: 'gemini',
                    text: responseText || t('web.no_response', 'No response received')
                });
                // Send final response
                this.sendMessage(ws, {
                    type: 'stream',
                    sessionId,
                    data: {
                        type: 'history_update',
                        item: responseMessage
                    }
                });
                this.sendMessage(ws, {
                    type: 'stream',
                    sessionId,
                    data: {
                        type: 'streaming_end'
                    }
                });
            }
            catch (error) {
                console.error('Error generating response:', error);
                const errorMessage = this.geminiService.addHistoryItem(sessionId, {
                    type: 'error',
                    text: t('web.response_error', 'Error generating response: {error}', {
                        error: error instanceof Error ? error.message : String(error)
                    })
                });
                this.sendMessage(ws, {
                    type: 'stream',
                    sessionId,
                    data: {
                        type: 'history_update',
                        item: errorMessage
                    }
                });
                this.sendMessage(ws, {
                    type: 'stream',
                    sessionId,
                    data: {
                        type: 'streaming_end'
                    }
                });
            }
        }
        catch (error) {
            console.error('Error in handleQuery:', error);
            this.sendError(ws, 'Failed to process query');
        }
    }
    sendMessage(ws, response) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        }
    }
    sendError(ws, error) {
        this.sendMessage(ws, {
            type: 'error',
            data: { message: error }
        });
    }
}
//# sourceMappingURL=websocketHandler.js.map