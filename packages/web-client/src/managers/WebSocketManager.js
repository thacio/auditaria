/**
 * WebSocket connection and message management
 */
export class WebSocketManager extends EventTarget {
    constructor() {
        super();
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
    }
    
    /**
     * Connect to WebSocket server
     */
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        try {
            this.socket = new WebSocket(wsUrl);
            this.setupSocketHandlers();
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.handleDisconnection();
        }
    }
    
    /**
     * Set up WebSocket event handlers
     */
    setupSocketHandlers() {
        this.socket.onopen = () => {
            console.log('Connected to Auditaria CLI');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.dispatchEvent(new CustomEvent('connected'));
        };
        
        this.socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Failed to parse message:', error);
            }
        };
        
        this.socket.onclose = () => {
            console.log('Disconnected from Auditaria CLI');
            this.isConnected = false;
            this.dispatchEvent(new CustomEvent('disconnected'));
            this.attemptReconnect();
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.handleDisconnection();
        };
    }
    
    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(message) {
        // Dispatch specific event for message type
        this.dispatchEvent(new CustomEvent(message.type, { detail: message.data }));
        
        // Also dispatch generic message event
        this.dispatchEvent(new CustomEvent('message', { detail: message }));
    }
    
    /**
     * Send a message through WebSocket
     */
    send(data) {
        if (!this.isConnected || !this.socket) {
            console.warn('Cannot send message: not connected');
            return false;
        }
        
        try {
            this.socket.send(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }
    
    /**
     * Send a user message with optional attachments
     */
    sendUserMessage(content, attachments = []) {
        return this.send({
            type: 'user_message',
            content: content,
            attachments: attachments,
            timestamp: Date.now()
        });
    }
    
    /**
     * Send an interrupt request
     */
    sendInterruptRequest() {
        return this.send({
            type: 'interrupt_request',
            timestamp: Date.now()
        });
    }
    
    /**
     * Send tool confirmation response
     */
    sendConfirmationResponse(callId, outcome) {
        return this.send({
            type: 'tool_confirmation_response',
            callId: callId,
            outcome: outcome,
            timestamp: Date.now()
        });
    }
    
    /**
     * Send terminal keyboard input
     */
    sendTerminalInput(key) {
        return this.send({
            type: 'terminal_input',
            key: key,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle disconnection
     */
    handleDisconnection() {
        this.isConnected = false;
        this.dispatchEvent(new CustomEvent('disconnected'));
        this.attemptReconnect();
    }
    
    /**
     * Attempt to reconnect to WebSocket
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnection attempts reached');
            this.dispatchEvent(new CustomEvent('reconnect_failed'));
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect();
        }, this.reconnectDelay);
    }
    
    /**
     * Close the WebSocket connection
     */
    close() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.isConnected = false;
    }
    
    /**
     * Get connection state
     */
    getState() {
        return {
            isConnected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts
        };
    }
}