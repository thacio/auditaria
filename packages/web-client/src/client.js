/**
 * Extensible keyboard shortcut manager for future shortcuts like Ctrl+C, Ctrl+S, etc.
 */
class KeyboardShortcutManager {
    constructor(client) {
        this.client = client;
        this.shortcuts = new Map();
        this.isEnabled = false;
        this.setupGlobalListener();
    }
    
    /**
     * Register a keyboard shortcut
     * @param {string} key - The key code (e.g., 'Escape', 'KeyS')
     * @param {function} callback - Function to call when shortcut is pressed
     * @param {object} modifiers - Optional modifiers like { ctrl: true, shift: true }
     */
    register(key, callback, modifiers = {}) {
        const shortcutKey = this.createShortcutKey(key, modifiers);
        this.shortcuts.set(shortcutKey, callback);
    }
    
    /**
     * Create a unique key for the shortcut map
     */
    createShortcutKey(key, modifiers) {
        const parts = [];
        if (modifiers.ctrl) parts.push('ctrl');
        if (modifiers.shift) parts.push('shift');
        if (modifiers.alt) parts.push('alt');
        if (modifiers.meta) parts.push('meta');
        parts.push(key);
        return parts.join('+');
    }
    
    /**
     * Enable keyboard shortcuts (only when appropriate)
     */
    enable() {
        this.isEnabled = true;
    }
    
    /**
     * Disable keyboard shortcuts
     */
    disable() {
        this.isEnabled = false;
    }
    
    /**
     * Set up global keyboard listener
     */
    setupGlobalListener() {
        document.addEventListener('keydown', (event) => {
            if (!this.isEnabled) return;
            
            const modifiers = {
                ctrl: event.ctrlKey,
                shift: event.shiftKey,
                alt: event.altKey,
                meta: event.metaKey
            };
            
            const shortcutKey = this.createShortcutKey(event.code, modifiers);
            const callback = this.shortcuts.get(shortcutKey);
            
            if (callback) {
                event.preventDefault();
                callback(event);
            }
        });
    }
}

class AuditariaWebClient {
    constructor() {
        this.socket = null;
        this.messageCount = 0;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.hasFooterData = false;
        this.isLoading = false;
        
        this.initializeUI();
        this.setupKeyboardShortcuts();
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
    
    setupKeyboardShortcuts() {
        // Initialize keyboard shortcut manager
        this.shortcuts = new KeyboardShortcutManager(this);
        
        // Register ESC key for interrupting AI processing
        this.shortcuts.register('Escape', () => {
            if (this.isLoading && this.isConnected) {
                this.sendInterruptRequest();
            }
        });
        
        // Future shortcuts can be added here easily:
        // this.shortcuts.register('KeyS', () => { /* Save functionality */ }, { ctrl: true });
        // this.shortcuts.register('KeyC', () => { /* Copy functionality */ }, { ctrl: true });
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
            case 'pending_item':
                this.updatePendingItem(message.data);
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
        // Check if this is converting a pending message to final
        if (historyItem.type === 'gemini' || historyItem.type === 'gemini_content') {
            const pendingTextEl = this.messagesContainer.querySelector('.message-pending-text');
            if (pendingTextEl) {
                // Convert pending text message to final message
                pendingTextEl.classList.remove('message-pending-text');
                
                // Update content to final version
                const contentEl = pendingTextEl.querySelector('.message-content');
                if (contentEl) {
                    contentEl.textContent = this.getMessageContent(historyItem);
                }
                
                // Update timestamp
                const timestampEl = pendingTextEl.querySelector('.message-timestamp');
                if (timestampEl) {
                    const timestamp = new Date().toLocaleTimeString([], { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    timestampEl.textContent = timestamp;
                }
                
                this.messageCount++;
                this.updateMessageCount();
                this.scrollToBottom();
                return;
            }
        } else if (historyItem.type === 'tool_group') {
            const pendingToolEl = this.messagesContainer.querySelector('.message-pending-tools');
            if (pendingToolEl) {
                // Convert pending tool group to final tool group
                pendingToolEl.classList.remove('message-pending-tools');
                
                // Update content to final version - regenerate tool list
                const bubbleEl = pendingToolEl.querySelector('.message-bubble');
                if (bubbleEl) {
                    // Remove old tool content
                    const existingToolList = bubbleEl.querySelector('.tool-list');
                    if (existingToolList) {
                        existingToolList.remove();
                    }
                    
                    // Add final tool content
                    const specialContent = this.renderSpecialContent(historyItem);
                    if (specialContent) {
                        const timestampEl = bubbleEl.querySelector('.message-timestamp');
                        if (timestampEl) {
                            bubbleEl.insertBefore(specialContent, timestampEl);
                        } else {
                            bubbleEl.appendChild(specialContent);
                        }
                    }
                }
                
                // Update timestamp
                const timestampEl = pendingToolEl.querySelector('.message-timestamp');
                if (timestampEl) {
                    const timestamp = new Date().toLocaleTimeString([], { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    timestampEl.textContent = timestamp;
                }
                
                this.messageCount++;
                this.updateMessageCount();
                this.scrollToBottom();
                return;
            }
        }
        
        // Regular new message (no pending version exists)
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
    
    updatePendingItem(pendingItem) {
        if (pendingItem.type === 'tool_group') {
            this.updatePendingToolGroup(pendingItem);
        } else {
            this.updatePendingTextMessage(pendingItem);
        }
    }
    
    updatePendingTextMessage(pendingItem) {
        // Find existing pending text message element or create new one
        let pendingMessageEl = this.messagesContainer.querySelector('.message-pending-text');
        
        if (!pendingMessageEl) {
            // Create new pending message element
            pendingMessageEl = this.createChatMessage(
                pendingItem.type,
                this.getMessageTypeLabel(pendingItem.type),
                this.getMessageContent(pendingItem),
                pendingItem
            );
            pendingMessageEl.classList.add('message-pending-text');
            this.messagesContainer.appendChild(pendingMessageEl);
        } else {
            // Update existing pending message content
            const contentEl = pendingMessageEl.querySelector('.message-content');
            if (contentEl) {
                contentEl.textContent = this.getMessageContent(pendingItem);
            }
            
            // Update timestamp
            const timestampEl = pendingMessageEl.querySelector('.message-timestamp');
            if (timestampEl) {
                const timestamp = new Date().toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                timestampEl.textContent = timestamp;
            }
        }
        
        this.scrollToBottom();
    }
    
    updatePendingToolGroup(pendingItem) {
        // Find existing pending tool group element or create new one
        let pendingToolEl = this.messagesContainer.querySelector('.message-pending-tools');
        
        if (!pendingToolEl) {
            // Create new pending tool group element
            pendingToolEl = this.createChatMessage(
                pendingItem.type,
                this.getMessageTypeLabel(pendingItem.type),
                this.getMessageContent(pendingItem),
                pendingItem
            );
            pendingToolEl.classList.add('message-pending-tools');
            this.messagesContainer.appendChild(pendingToolEl);
        } else {
            // Update existing tool group content - regenerate the tool list
            const bubbleEl = pendingToolEl.querySelector('.message-bubble');
            if (bubbleEl) {
                // Remove old tool content but keep header and timestamp
                const existingToolList = bubbleEl.querySelector('.tool-list');
                if (existingToolList) {
                    existingToolList.remove();
                }
                
                // Add updated tool content
                const specialContent = this.renderSpecialContent(pendingItem);
                if (specialContent) {
                    const timestampEl = bubbleEl.querySelector('.message-timestamp');
                    if (timestampEl) {
                        bubbleEl.insertBefore(specialContent, timestampEl);
                    } else {
                        bubbleEl.appendChild(specialContent);
                    }
                }
            }
            
            // Update timestamp
            const timestampEl = pendingToolEl.querySelector('.message-timestamp');
            if (timestampEl) {
                const timestamp = new Date().toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                timestampEl.textContent = timestamp;
            }
        }
        
        this.scrollToBottom();
    }
    
    loadHistoryItems(historyItems) {
        // Clear welcome message and any pending items when loading history
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
            
            // Tool header with status indicator, name, and status text
            const toolHeaderEl = document.createElement('div');
            toolHeaderEl.className = 'tool-header';
            
            const toolStatusIndicatorEl = document.createElement('span');
            toolStatusIndicatorEl.className = `tool-status-indicator tool-status-${tool.status.toLowerCase()}`;
            toolStatusIndicatorEl.textContent = this.getToolStatusIndicator(tool.status);
            
            const toolNameEl = document.createElement('span');
            toolNameEl.className = 'tool-name';
            toolNameEl.textContent = tool.name;
            
            const toolStatusEl = document.createElement('span');
            toolStatusEl.className = `tool-status tool-status-${tool.status.toLowerCase()}`;
            toolStatusEl.textContent = tool.status;
            
            toolHeaderEl.appendChild(toolStatusIndicatorEl);
            toolHeaderEl.appendChild(toolNameEl);
            toolHeaderEl.appendChild(toolStatusEl);
            toolItemEl.appendChild(toolHeaderEl);
            
            // Tool description
            if (tool.description) {
                const toolDescEl = document.createElement('div');
                toolDescEl.className = 'tool-description';
                toolDescEl.textContent = tool.description;
                toolItemEl.appendChild(toolDescEl);
            }
            
            // Tool output/result display
            if (tool.resultDisplay) {
                const toolOutputEl = document.createElement('div');
                toolOutputEl.className = 'tool-output';
                
                if (typeof tool.resultDisplay === 'string') {
                    // Handle string output (most common case)
                    if (tool.name === 'TodoWrite' && this.isTodoWriteResult(tool.resultDisplay)) {
                        // Special handling for TodoWrite - could be enhanced later
                        toolOutputEl.textContent = tool.resultDisplay;
                    } else {
                        // Regular text output - preserve formatting
                        const outputPreEl = document.createElement('pre');
                        outputPreEl.className = 'tool-output-text';
                        outputPreEl.textContent = tool.resultDisplay;
                        toolOutputEl.appendChild(outputPreEl);
                    }
                } else if (tool.resultDisplay && typeof tool.resultDisplay === 'object') {
                    // Handle diff/file output
                    if (tool.resultDisplay.fileDiff) {
                        const diffEl = document.createElement('div');
                        diffEl.className = 'tool-output-diff';
                        
                        if (tool.resultDisplay.fileName) {
                            const fileNameEl = document.createElement('div');
                            fileNameEl.className = 'diff-filename';
                            fileNameEl.textContent = `File: ${tool.resultDisplay.fileName}`;
                            diffEl.appendChild(fileNameEl);
                        }
                        
                        const diffContentEl = document.createElement('pre');
                        diffContentEl.className = 'diff-content';
                        diffContentEl.textContent = tool.resultDisplay.fileDiff;
                        diffEl.appendChild(diffContentEl);
                        
                        toolOutputEl.appendChild(diffEl);
                    } else {
                        // Fallback for other object types
                        const objOutputEl = document.createElement('pre');
                        objOutputEl.className = 'tool-output-object';
                        objOutputEl.textContent = JSON.stringify(tool.resultDisplay, null, 2);
                        toolOutputEl.appendChild(objOutputEl);
                    }
                }
                
                toolItemEl.appendChild(toolOutputEl);
            }
            
            toolListEl.appendChild(toolItemEl);
        });
        
        return toolListEl;
    }
    
    getToolStatusIndicator(status) {
        switch (status) {
            case 'Pending': return 'o';
            case 'Executing': return '⊷';
            case 'Success': return '✔';
            case 'Confirming': return '?';
            case 'Canceled': return '-';
            case 'Error': return '✗';
            default: return '•';
        }
    }
    
    isTodoWriteResult(text) {
        // Simple check for TodoWrite results - could be enhanced
        return text && text.includes('Todos have been') && text.includes('modified successfully');
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
    
    sendInterruptRequest() {
        if (!this.isConnected) {
            console.warn('Cannot send interrupt request: not connected');
            return;
        }
        
        try {
            // Send interrupt request to server
            this.socket.send(JSON.stringify({
                type: 'interrupt_request',
                timestamp: Date.now()
            }));
            
            console.log('Interrupt request sent');
            
        } catch (error) {
            console.error('Failed to send interrupt request:', error);
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
        // Update internal loading state for keyboard shortcuts
        this.isLoading = loadingState.isLoading;
        
        if (loadingState.isLoading) {
            // Show loading indicator and enable keyboard shortcuts
            this.showLoadingIndicator(loadingState);
            this.shortcuts.enable();
        } else {
            // Hide loading indicator and disable keyboard shortcuts
            this.hideLoadingIndicator();
            this.shortcuts.disable();
        }
    }
    
    showLoadingIndicator(loadingState) {
        // Update loading text
        const loadingMessage = loadingState.thought || loadingState.currentLoadingPhrase || 'Thinking...';
        this.loadingText.textContent = loadingMessage;
        
        // Update elapsed time with ESC cancel text (matching CLI format)
        const timeText = loadingState.elapsedTime < 60 
            ? `(esc to cancel, ${loadingState.elapsedTime}s)` 
            : `(esc to cancel, ${Math.floor(loadingState.elapsedTime / 60)}m ${loadingState.elapsedTime % 60}s)`;
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