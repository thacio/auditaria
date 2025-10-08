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
        
        // Message resilience system
        this.lastReceivedSequence = 0;
        this.lastPersistentSequence = 0; // Track last non-ephemeral message
        this.processedSequences = new Set();
        this.ackTimer = null;
        this.pendingAckSequence = 0;
        this.ACK_BATCH_DELAY = 500; // Send ACK every 500ms
        this.MAX_PROCESSED_SEQUENCES = 1000; // Keep track of last 1000 sequences
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
            // Reset sequence tracking on new connection
            this.lastReceivedSequence = 0;
            this.lastPersistentSequence = 0;
            this.processedSequences.clear();
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
        // Special handling for connection message with starting sequence
        if (message.type === 'connection' && message.data?.startingSequence !== undefined) {
            // Set our sequence tracking to match the server's current sequence
            this.lastReceivedSequence = message.data.startingSequence;
            this.lastPersistentSequence = message.data.startingSequence;
            console.log(`Starting sequence set to ${this.lastReceivedSequence}`);
        }
        
        // Handle sequenced messages for resilience
        if (message.sequence !== undefined) {
            // Check for duplicate messages
            if (this.processedSequences.has(message.sequence)) {
                // console.log(`Duplicate message ignored: sequence ${message.sequence}`);
                return;
            }
            
            // Track ephemeral vs persistent messages separately
            const isEphemeral = message.ephemeral === true;
            
            // Only check for gaps in PERSISTENT messages
            if (!isEphemeral) {
                // Check if we missed any persistent messages
                // Handle sequence wrap-around: if last sequence was near MAX and new is near 0
                const isLikelyWrap = this.lastPersistentSequence > Number.MAX_SAFE_INTEGER - 1000000 && message.sequence < 1000;
                
                if (this.lastPersistentSequence > 0 && !isLikelyWrap && message.sequence > this.lastPersistentSequence + 1) {
                    // We might have missed persistent messages - need to check with server
                    // console.log(`Potential gap in persistent messages: last was ${this.lastPersistentSequence}, got ${message.sequence}`);
                    this.requestResync(this.lastPersistentSequence);
                }
                // Update last persistent sequence
                this.lastPersistentSequence = message.sequence;
            }
            
            // Always update overall sequence tracking
            this.lastReceivedSequence = message.sequence;
            this.processedSequences.add(message.sequence);
            
            // Prune old sequences if set gets too large
            if (this.processedSequences.size > this.MAX_PROCESSED_SEQUENCES) {
                const sortedSequences = Array.from(this.processedSequences).sort((a, b) => a - b);
                const toRemove = sortedSequences.slice(0, sortedSequences.length - this.MAX_PROCESSED_SEQUENCES);
                toRemove.forEach(seq => this.processedSequences.delete(seq));
            }
            
            // Schedule acknowledgment
            this.scheduleAcknowledgment(message.sequence);
        }
        
        // Handle special message types
        if (message.type === 'force_resync') {
            this.handleForceResync();
            return;
        }
        
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
    sendConfirmationResponse(callId, outcome, payload) {
        return this.send({
            type: 'tool_confirmation_response',
            callId: callId,
            outcome: outcome,
            payload: payload,
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
    
    /**
     * Schedule batched acknowledgment
     */
    scheduleAcknowledgment(sequence) {
        this.pendingAckSequence = Math.max(this.pendingAckSequence, sequence);
        
        // Clear existing timer
        if (this.ackTimer) {
            clearTimeout(this.ackTimer);
        }
        
        // Schedule new acknowledgment
        this.ackTimer = setTimeout(() => {
            this.sendAcknowledgment();
        }, this.ACK_BATCH_DELAY);
    }
    
    /**
     * Send acknowledgment for received messages
     */
    sendAcknowledgment() {
        if (this.pendingAckSequence > 0 && this.isConnected) {
            this.send({
                type: 'ack',
                lastSequence: this.pendingAckSequence
            });
            this.pendingAckSequence = 0;
        }
    }
    
    /**
     * Request resync for missed messages
     */
    requestResync(fromSequence) {
        if (this.isConnected) {
            // console.log(`Requesting resync of persistent messages after sequence ${fromSequence}`);
            this.send({
                type: 'resync_request',
                from: fromSequence,
                persistentOnly: true  // Only want non-ephemeral messages
            });
        }
    }
    
    /**
     * Handle force resync (buffer overrun)
     */
    handleForceResync() {
        console.warn('Force resync required - clearing all messages');
        
        // Reset sequence tracking
        this.lastReceivedSequence = 0;
        this.lastPersistentSequence = 0;
        this.processedSequences.clear();
        
        // Notify client to clear messages
        this.dispatchEvent(new CustomEvent('force_resync'));
    }
    
    /**
     * Check for missed messages (called when tab becomes visible)
     */
    checkForMissedMessages() {
        // If we're connected and have received persistent messages, request resync of any gaps
        if (this.isConnected && this.lastPersistentSequence > 0) {
            // Send a resync request for persistent messages we might have missed
            this.requestResync(this.lastPersistentSequence);
        }
    }
}