/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { GeminiWebService } from '../services/geminiService.js';
export interface WebSocketMessage {
    type: 'query' | 'ping' | 'get_history' | 'get_config';
    data?: any;
    sessionId?: string;
}
export interface WebSocketResponse {
    type: 'pong' | 'history' | 'config' | 'stream' | 'error';
    data?: any;
    sessionId?: string;
}
/**
 * Handles WebSocket connections and real-time communication
 */
export declare class WebSocketHandler {
    private geminiService;
    private connections;
    constructor(geminiService: GeminiWebService);
    handleConnection(ws: WebSocket, request: IncomingMessage): void;
    private handleMessage;
    private handleQuery;
    private sendMessage;
    private sendError;
}
//# sourceMappingURL=websocketHandler.d.ts.map