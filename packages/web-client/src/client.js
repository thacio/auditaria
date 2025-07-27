class AuditariaWebClient {
    constructor() {
        this.socket = null;
        this.messageCount = 0;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.hasFooterData = false;
        
        this.initializeUI();
        this.connect();
    }
    
    initializeUI() {
        this.statusElement = document.getElementById('connection-status');
        this.messageCountElement = document.getElementById('message-count');
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('message-input');
        this.sendButton = document.getElementById('send-button');
        this.inputStatus = document.getElementById('input-status');
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.loadingText = document.getElementById('loading-text');
        this.loadingTime = document.getElementById('loading-time');
        
        // Clear welcome message initially
        this.messagesContainer.innerHTML = '';
        
        // Set up input handlers
        this.setupInputHandlers();
    }
    
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
    
    setupSocketHandlers() {
        this.socket.onopen = () => {
            console.log('Connected to Auditaria CLI');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus();
            this.updateInputState();
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
            this.updateConnectionStatus();
            this.updateInputState();
            this.attemptReconnect();
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.handleDisconnection();
        };
    }
    
    handleMessage(message) {
        switch (message.type) {
            case 'connection':
                this.addWelcomeMessage(message.data.message);
                break;
            case 'history_item':
                this.addHistoryItem(message.data);
                break;
            case 'footer_data':
                this.updateFooter(message.data);
                break;
            case 'history_sync':
                this.loadHistoryItems(message.data.history);
                break;
            case 'loading_state':
                this.updateLoadingState(message.data);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }
    
    addWelcomeMessage(text) {
        const messageEl = this.createChatMessage('info', 'CONNECTION', text);
        this.messagesContainer.appendChild(messageEl);
        this.scrollToBottom();
    }
    
    addHistoryItem(historyItem) {
        const messageEl = this.createChatMessage(
            historyItem.type,
            this.getMessageTypeLabel(historyItem.type),
            this.getMessageContent(historyItem),
            historyItem
        );
        
        this.messagesContainer.appendChild(messageEl);
        this.messageCount++;
        this.updateMessageCount();
        this.scrollToBottom();
    }
    
    loadHistoryItems(historyItems) {
        // Clear welcome message when loading history
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        
        // Load all historical messages
        historyItems.forEach(historyItem => {
            const messageEl = this.createChatMessage(
                historyItem.type,
                this.getMessageTypeLabel(historyItem.type),
                this.getMessageContent(historyItem),
                historyItem
            );
            
            this.messagesContainer.appendChild(messageEl);
            this.messageCount++;
        });
        
        this.updateMessageCount();
        this.scrollToBottom();
    }
    
    createChatMessage(type, label, content, historyItem = null) {
        const messageEl = document.createElement('div');
        messageEl.className = `message message-${type}`;
        
        const timestamp = new Date().toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        const headerEl = document.createElement('div');
        headerEl.className = 'message-header';
        headerEl.textContent = label;
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'message-bubble';
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        contentEl.textContent = content;
        
        const timestampEl = document.createElement('div');
        timestampEl.className = 'message-timestamp';
        timestampEl.textContent = timestamp;
        
        bubbleEl.appendChild(contentEl);
        
        // Add special content for specific message types
        const specialContent = this.renderSpecialContent(historyItem);
        if (specialContent) {
            bubbleEl.appendChild(specialContent);
        }
        
        bubbleEl.appendChild(timestampEl);
        
        messageEl.appendChild(headerEl);
        messageEl.appendChild(bubbleEl);
        
        return messageEl;
    }
    
    renderSpecialContent(historyItem) {
        if (!historyItem) return null;
        
        switch (historyItem.type) {
            case 'tool_group':
                return this.renderToolGroup(historyItem.tools || []);
            case 'about':
                return this.renderAboutInfo(historyItem);
            default:
                return null;
        }
    }
    
    renderToolGroup(tools) {
        const toolListEl = document.createElement('div');
        toolListEl.className = 'tool-list';
        
        tools.forEach(tool => {
            const toolItemEl = document.createElement('div');
            toolItemEl.className = 'tool-item';
            
            const toolNameEl = document.createElement('span');
            toolNameEl.className = 'tool-name';
            toolNameEl.textContent = tool.name;
            
            const toolStatusEl = document.createElement('span');
            toolStatusEl.className = `tool-status tool-status-${tool.status.toLowerCase()}`;
            toolStatusEl.textContent = tool.status;
            
            toolItemEl.appendChild(toolNameEl);
            toolItemEl.appendChild(toolStatusEl);
            
            if (tool.description) {
                const toolDescEl = document.createElement('div');
                toolDescEl.textContent = tool.description;
                toolDescEl.style.fontSize = '12px';
                toolDescEl.style.color = 'var(--text-secondary)';
                toolDescEl.style.marginTop = '4px';
                toolItemEl.appendChild(toolDescEl);
            }
            
            toolListEl.appendChild(toolItemEl);
        });
        
        return toolListEl;
    }
    
    renderAboutInfo(aboutItem) {
        const aboutEl = document.createElement('div');
        aboutEl.className = 'about-info';
        
        const infoItems = [
            { label: 'CLI Version', value: aboutItem.cliVersion },
            { label: 'OS', value: aboutItem.osVersion },
            { label: 'Model', value: aboutItem.modelVersion },
            { label: 'Auth Type', value: aboutItem.selectedAuthType }
        ];
        
        infoItems.forEach(item => {
            if (item.value) {
                const itemEl = document.createElement('div');
                itemEl.innerHTML = `<strong>${item.label}:</strong> ${this.escapeHtml(item.value)}`;
                aboutEl.appendChild(itemEl);
            }
        });
        
        return aboutEl;
    }
    
    getMessageTypeLabel(type) {
        const labels = {
            'user': 'YOU',
            'user_shell': 'SHELL',
            'gemini': 'AUDITARIA',
            'gemini_content': 'AUDITARIA',
            'info': 'SYSTEM',
            'error': 'ERROR',
            'tool_group': 'TOOLS',
            'about': 'ABOUT',
            'stats': 'STATS',
            'model_stats': 'MODEL',
            'tool_stats': 'TOOLS',
            'quit': 'SESSION END',
            'compression': 'COMPRESSION'
        };
        return labels[type] || type.toUpperCase();
    }
    
    getMessageContent(historyItem) {
        if (historyItem.text) {
            return historyItem.text;
        }
        
        switch (historyItem.type) {
            case 'tool_group':
                const toolCount = historyItem.tools?.length || 0;
                return `Executed ${toolCount} tool${toolCount !== 1 ? 's' : ''}`;
            case 'stats':
                return `Session completed in ${historyItem.duration || 'unknown time'}`;
            case 'quit':
                return `Session ended after ${historyItem.duration || 'unknown time'}`;
            case 'compression':
                const comp = historyItem.compression;
                if (comp) {
                    return `Context compressed: ${comp.originalTokenCount || 'N/A'} → ${comp.newTokenCount || 'N/A'} tokens`;
                }
                return 'Context compression applied';
            default:
                return JSON.stringify(historyItem, null, 2);
        }
    }
    
    updateConnectionStatus() {
        if (this.isConnected) {
            this.statusElement.textContent = 'Connected';
            this.statusElement.className = 'status-connected';
        } else {
            this.statusElement.textContent = 'Disconnected';
            this.statusElement.className = 'status-disconnected';
        }
    }
    
    updateMessageCount() {
        const plural = this.messageCount !== 1 ? 's' : '';
        this.messageCountElement.textContent = `${this.messageCount} message${plural}`;
    }
    
    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
    
    handleDisconnection() {
        this.isConnected = false;
        this.updateConnectionStatus();
        this.updateInputState();
        this.attemptReconnect();
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnection attempts reached');
            this.addSystemMessage('Connection lost. Please refresh the page to reconnect.');
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect();
        }, this.reconnectDelay);
    }
    
    addSystemMessage(text) {
        const messageEl = this.createChatMessage('info', 'SYSTEM', text);
        this.messagesContainer.appendChild(messageEl);
        this.scrollToBottom();
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    setupInputHandlers() {
        // Send button click handler
        this.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // Keyboard handlers for textarea
        this.messageInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.sendMessage();
            }
        });
        
        // Auto-resize textarea
        this.messageInput.addEventListener('input', () => {
            this.autoResizeTextarea();
        });
    }
    
    sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || !this.isConnected) {
            return;
        }
        
        try {
            // Send message to server
            this.socket.send(JSON.stringify({
                type: 'user_message',
                content: message,
                timestamp: Date.now()
            }));
            
            // Clear input
            this.messageInput.value = '';
            this.autoResizeTextarea();
            
            // Focus back to input
            this.messageInput.focus();
            
        } catch (error) {
            console.error('Failed to send message:', error);
            this.updateInputStatus('Failed to send message');
        }
    }
    
    updateInputState() {
        const isEnabled = this.isConnected;
        this.messageInput.disabled = !isEnabled;
        this.sendButton.disabled = !isEnabled;
        
        if (isEnabled) {
            if (!this.hasFooterData) {
                this.updateInputStatus('Ready to send messages');
            }
            this.messageInput.focus();
        } else {
            this.updateInputStatus('Disconnected - Cannot send messages');
        }
    }
    
    updateInputStatus(message) {
        this.inputStatus.textContent = message;
    }
    
    updateFooter(footerData) {
        this.hasFooterData = true;
        
        // Format footer information similar to CLI footer
        const parts = [];
        
        // Left section: Directory and branch (with debug info if applicable)
        const shortPath = this.shortenPath(footerData.targetDir, 40);
        const dirAndBranch = footerData.branchName 
            ? `${shortPath} (${footerData.branchName}*)`
            : shortPath;
        parts.push(dirAndBranch);
        
        // Add debug mode info to left section
        if (footerData.debugMode) {
            const debugText = footerData.debugMessage || '--debug';
            parts[0] += ` ${debugText}`;
        }
        
        // Center section: Sandbox status
        if (footerData.sandboxStatus !== 'no sandbox') {
            parts.push(footerData.sandboxStatus);
        } else {
            parts.push('no sandbox (see /docs)');
        }
        
        // Right section: Model and context
        const contextText = `${footerData.contextPercentage.toFixed(0)}% context left`;
        parts.push(`${footerData.model} (${contextText})`);
        
        // Add corgi mode if enabled
        if (footerData.corgiMode) {
            parts.push('▼(´ᴥ`)▼');
        }
        
        // Add error count if any (only if not showing error details)
        if (!footerData.showErrorDetails && footerData.errorCount > 0) {
            parts.push(`✖ ${footerData.errorCount} error${footerData.errorCount !== 1 ? 's' : ''} (ctrl+o for details)`);
        }
        
        // Add memory usage indicator if enabled
        if (footerData.showMemoryUsage) {
            parts.push('📊 Memory');
        }
        
        // Update the input status with footer information
        const footerText = parts.join(' | ');
        
        // Apply special styling for nightly builds
        if (footerData.nightly) {
            this.inputStatus.innerHTML = `<span class="footer-info footer-nightly">${footerText}</span>`;
        } else {
            this.inputStatus.innerHTML = `<span class="footer-info">${footerText}</span>`;
        }
    }
    
    updateLoadingState(loadingState) {
        if (loadingState.isLoading) {
            // Show loading indicator
            this.showLoadingIndicator(loadingState);
        } else {
            // Hide loading indicator
            this.hideLoadingIndicator();
        }
    }
    
    showLoadingIndicator(loadingState) {
        // Update loading text
        const loadingMessage = loadingState.thought || loadingState.currentLoadingPhrase || 'Thinking...';
        this.loadingText.textContent = loadingMessage;
        
        // Update elapsed time
        const timeText = loadingState.elapsedTime < 60 
            ? `(${loadingState.elapsedTime}s)` 
            : `(${Math.floor(loadingState.elapsedTime / 60)}m ${loadingState.elapsedTime % 60}s)`;
        this.loadingTime.textContent = timeText;
        
        // Show the loading indicator with animation
        if (this.loadingIndicator.style.display === 'none') {
            this.loadingIndicator.style.display = 'flex';
            this.loadingIndicator.classList.remove('hidden');
        }
    }
    
    hideLoadingIndicator() {
        if (this.loadingIndicator.style.display !== 'none') {
            this.loadingIndicator.classList.add('hidden');
            setTimeout(() => {
                this.loadingIndicator.style.display = 'none';
                this.loadingIndicator.classList.remove('hidden');
            }, 300); // Match animation duration
        }
    }
    
    shortenPath(path, maxLength) {
        if (path.length <= maxLength) return path;
        const segments = path.split(/[\/\\]/);
        if (segments.length <= 2) return path;
        
        // Try to keep last 2 segments
        const lastTwo = segments.slice(-2).join('/');
        if (lastTwo.length <= maxLength - 3) {
            return `.../${lastTwo}`;
        }
        
        // Just keep the last segment
        const last = segments[segments.length - 1];
        return `.../${last}`;
    }
    
    autoResizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
    }
    
    
    formatDuration(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        if (minutes === 0) {
            return `${seconds}s`;
        } else {
            return `${minutes}m ${seconds}s`;
        }
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new AuditariaWebClient();
});