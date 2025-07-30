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
        this.confirmationQueue = new ConfirmationQueue(this);
        
        // Message merging properties
        this.lastAIMessage = null;
        this.mergeTimeframe = 5000; // 5 seconds in milliseconds
        
        this.initializeUI();
        this.setupKeyboardShortcuts();
        this.connect();
    }
    
    /**
     * Clean HTML specifically for list spacing issues
     * Targets: <ul>, <ol>, <li> and nested combinations
     */
    cleanListHTML(html) {
        return html
            // Remove extra whitespace around list containers
            .replace(/\s*<(ul|ol)>/g, '<$1>')
            .replace(/<\/(ul|ol)>\s*/g, '</$1>')
            // Remove extra whitespace around list items
            .replace(/\s*<li>/g, '<li>')
            .replace(/<\/li>\s*/g, '</li>')
            // Remove paragraph tags inside list items (common marked.js issue)
            .replace(/<li><p>(.*?)<\/p><\/li>/g, '<li>$1</li>')
            // Handle nested lists - remove extra spacing between </li> and <ul>/<ol>
            .replace(/<\/li>\s*<(ul|ol)>/g, '</li><$1>')
            .replace(/<\/(ul|ol)>\s*<\/li>/g, '</$1></li>')
            // Remove trailing paragraph tags only at the end
            .replace(/<\/p>\s*$/, '</p>')
            .trim();
    }
    
    /**
     * Clean multiple line breaks throughout ALL HTML content
     * Converts multiple consecutive line breaks to single ones
     */
    cleanMultipleLineBreaks(html) {
        return html
            // Convert multiple consecutive <br> tags to single ones (2 or more becomes 1)
            .replace(/(<br\s*\/?>){2,}/gi, '<br>')
            // Convert multiple newlines to single ones (3 or more becomes 2 to preserve paragraphs)
            .replace(/\n{3,}/g, '\n\n')
            // Remove multiple paragraph breaks (empty paragraphs) but preserve single ones
            .replace(/(<p>\s*<\/p>){2,}/gi, '<p></p>')
            // Clean up excessive spacing between paragraph tags while preserving structure
            .replace(/(<\/p>)\s{2,}(<p>)/gi, '$1\n$2')
            // Clean up excessive whitespace but preserve single spaces and line breaks
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }
    
    /**
     * Process markdown text with marked.js and apply cleaning
     */
    processMarkdown(text) {
        if (!window.marked || !text) {
            return text;
        }
        
        try {
            // Convert markdown to HTML using marked.js
            let html = marked.parse(text);
            
            // Apply cleaning functions
            html = this.cleanListHTML(html);
            html = this.cleanMultipleLineBreaks(html);
            
            return html;
        } catch (error) {
            console.error('Error processing markdown:', error);
            // Return original text if markdown processing fails
            return text;
        }
    }
    
    /**
     * Check if a message is an AI message that can be merged
     */
    isAIMessage(historyItem) {
        return historyItem && (historyItem.type === 'gemini' || historyItem.type === 'gemini_content');
    }
    
    /**
     * Check if current message can be merged with the last AI message
     */
    canMergeWithLast(historyItem) {
        if (!this.lastAIMessage || !this.isAIMessage(historyItem)) {
            return false;
        }
        
        const now = Date.now();
        const timeDiff = now - this.lastAIMessage.timestamp;
        
        return timeDiff <= this.mergeTimeframe;
    }
    
    /**
     * Merge current AI message with the last AI message
     */
    mergeWithLastAIMessage(historyItem) {
        if (!this.lastAIMessage || !this.lastAIMessage.element) {
            return false;
        }
        
        // Get the existing message content
        const contentEl = this.lastAIMessage.element.querySelector('.message-content span');
        if (!contentEl) {
            return false;
        }
        
        // Get current and new content
        const existingContent = this.lastAIMessage.text || '';
        const newContent = this.getMessageContent(historyItem);
        
        // Combine content with double line break for separation
        const combinedContent = existingContent + '\n\n' + newContent;
        
        // Update the DOM with combined content (apply markdown processing)
        contentEl.innerHTML = this.processMarkdown(combinedContent);
        
        // Update timestamp
        const timestampEl = this.lastAIMessage.element.querySelector('.message-timestamp');
        if (timestampEl) {
            const timestamp = new Date().toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            timestampEl.textContent = timestamp;
        }
        
        // Update the lastAIMessage tracking
        this.lastAIMessage.text = combinedContent;
        this.lastAIMessage.timestamp = Date.now();
        
        // Scroll to bottom after merging
        this.scrollToBottom();
        
        return true;
    }
    
    initializeUI() {
        this.statusElement = document.getElementById('connection-status');
        this.messageCountElement = document.getElementById('message-count');
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('message-input');
        this.sendButton = document.getElementById('send-button');
        this.printButton = document.getElementById('print-button');
        this.inputStatus = document.getElementById('input-status');
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.loadingText = document.getElementById('loading-text');
        this.loadingTime = document.getElementById('loading-time');
        this.loadingHeader = document.getElementById('loading-header');
        this.loadingExpandIndicator = document.getElementById('loading-expand-indicator');
        this.loadingExpandableContent = document.getElementById('loading-expandable-content');
        this.loadingDescription = document.getElementById('loading-description');
        
        // Initialize expandable state
        this.isThoughtsExpanded = false;
        this.currentThoughtObject = null;
        this.lastLoggedSubject = null;
        
        // Set initial state for loading header
        this.loadingHeader.style.cursor = 'default';
        this.loadingHeader.setAttribute('aria-label', 'AI is thinking');
        
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
            case 'tool_confirmation':
                this.handleToolConfirmation(message.data);
                break;
            case 'tool_confirmation_removal':
                this.handleToolConfirmationRemoval(message.data);
                break;
            case 'clear':
                this.clearAllMessages();
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
        console.log('addHistoryItem called with:', {
            type: historyItem.type,
            hasTools: !!(historyItem.tools),
            toolCount: historyItem.tools?.length,
            toolStatuses: historyItem.tools?.map(t => ({ name: t.name, status: t.status }))
        });
        
        // Check if this is converting a pending message to final
        if (historyItem.type === 'gemini' || historyItem.type === 'gemini_content') {
            const pendingTextEl = this.messagesContainer.querySelector('.message-pending-text');
            if (pendingTextEl) {
                // First check if we can merge with the last AI message instead of converting pending
                console.log('Pending conversion - checking merge first:', {
                    isAI: this.isAIMessage(historyItem),
                    hasLast: !!this.lastAIMessage,
                    canMerge: this.canMergeWithLast(historyItem),
                    type: historyItem.type,
                    lastType: this.lastAIMessage?.type
                });
                
                if (this.isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
                    console.log('Merging instead of converting pending message');
                    // Remove the pending message since we're merging with the last AI message
                    pendingTextEl.remove();
                    
                    if (this.mergeWithLastAIMessage(historyItem)) {
                        console.log('Successfully merged with last AI message instead of pending conversion');
                        return;
                    }
                }
                // Convert pending text message to final message
                pendingTextEl.classList.remove('message-pending-text');
                
                // Update content to final version
                const contentEl = pendingTextEl.querySelector('.message-content');
                if (contentEl) {
                    const textSpan = contentEl.querySelector('span');
                    if (textSpan) {
                        const content = this.getMessageContent(historyItem);
                        // Use markdown processing for AI messages only
                        if (historyItem.type === 'gemini' || historyItem.type === 'gemini_content') {
                            textSpan.innerHTML = this.processMarkdown(content);
                        } else {
                            textSpan.textContent = content;
                        }
                    }
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
                
                // Track this converted AI message for potential future merging
                this.lastAIMessage = {
                    element: pendingTextEl,
                    text: this.getMessageContent(historyItem),
                    timestamp: Date.now(),
                    type: historyItem.type
                };
                
                this.messageCount++;
                this.updateMessageCount();
                this.scrollToBottom();
                return;
            }
        } else if (historyItem.type === 'tool_group') {
            const pendingToolEl = this.messagesContainer.querySelector('.message-pending-tools');
            console.log('Tool group conversion - found pending element:', !!pendingToolEl);
            if (pendingToolEl) {
                console.log('Converting pending tool group to final with tools:', historyItem.tools?.map(t => ({ name: t.name, status: t.status })));
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
        
        // Check if this AI message can be merged with the last AI message
        console.log('Merge check:', {
            isAI: this.isAIMessage(historyItem),
            hasLast: !!this.lastAIMessage,
            canMerge: this.canMergeWithLast(historyItem),
            type: historyItem.type,
            lastType: this.lastAIMessage?.type,
            timeDiff: this.lastAIMessage ? Date.now() - this.lastAIMessage.timestamp : 'N/A'
        });
        
        if (this.isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
            console.log('Attempting to merge AI message');
            if (this.mergeWithLastAIMessage(historyItem)) {
                console.log('Successfully merged AI message');
                // Message was successfully merged, no need to create new element
                return;
            } else {
                console.log('Failed to merge AI message');
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
        
        // Track this message if it's an AI message for potential future merging
        if (this.isAIMessage(historyItem)) {
            this.lastAIMessage = {
                element: messageEl,
                text: this.getMessageContent(historyItem),
                timestamp: Date.now(),
                type: historyItem.type
            };
        } else {
            // Clear AI message tracking if this is not an AI message
            this.lastAIMessage = null;
        }
    }
    
    updatePendingItem(pendingItem) {
        // Handle null pendingItem (means clear all pending items)
        if (!pendingItem) {
            this.clearPendingToolGroup();
            this.clearPendingTextMessage();
            return;
        }
        
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
                const textSpan = contentEl.querySelector('span');
                if (textSpan) {
                    const content = this.getMessageContent(pendingItem);
                    // Use markdown processing for AI messages only
                    if (pendingItem.type === 'gemini' || pendingItem.type === 'gemini_content') {
                        textSpan.innerHTML = this.processMarkdown(content);
                    } else {
                        textSpan.textContent = content;
                    }
                }
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
    
    clearPendingToolGroup() {
        // Remove any existing pending tool group element
        const pendingToolEl = this.messagesContainer.querySelector('.message-pending-tools');
        if (pendingToolEl) {
            pendingToolEl.remove();
        }
    }
    
    clearPendingTextMessage() {
        // Remove any existing pending text message element
        const pendingTextEl = this.messagesContainer.querySelector('.message-pending-text');
        if (pendingTextEl) {
            pendingTextEl.remove();
        }
    }
    
    loadHistoryItems(historyItems) {
        // Clear welcome message and any pending items when loading history
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null; // Reset AI message tracking for history loading
        
        // Load all historical messages with merging logic
        historyItems.forEach(historyItem => {
            // Check if this AI message can be merged with the last AI message
            if (this.isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
                if (this.mergeWithLastAIMessage(historyItem)) {
                    // Message was successfully merged, no need to create new element
                    return;
                }
            }
            
            // Create regular message
            const messageEl = this.createChatMessage(
                historyItem.type,
                this.getMessageTypeLabel(historyItem.type),
                this.getMessageContent(historyItem),
                historyItem
            );
            
            this.messagesContainer.appendChild(messageEl);
            this.messageCount++;
            
            // Track this message if it's an AI message for potential future merging
            if (this.isAIMessage(historyItem)) {
                this.lastAIMessage = {
                    element: messageEl,
                    text: this.getMessageContent(historyItem),
                    timestamp: Date.now(),
                    type: historyItem.type
                };
            } else {
                // Clear AI message tracking if this is not an AI message
                this.lastAIMessage = null;
            }
        });
        
        this.updateMessageCount();
        this.scrollToBottom();
    }
    
    clearAllMessages() {
        // Clear all messages from the web interface
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null; // Reset AI message tracking when clearing messages
        this.updateMessageCount();
        
        // Reset thoughts expansion state when clearing conversation
        this.resetThoughtsExpansion();
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
        const textSpan = document.createElement('span');
        
        // Use markdown processing for AI messages only
        if (type === 'gemini' || type === 'gemini_content') {
            textSpan.innerHTML = this.processMarkdown(content);
        } else {
            textSpan.textContent = content;
        }
        
        contentEl.appendChild(textSpan);
        
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
        
        // Debug logging for tool outputs
        console.log('Rendering tool group:', tools.map(t => ({ 
            name: t.name, 
            status: t.status, 
            hasResultDisplay: !!t.resultDisplay,
            resultDisplayType: typeof t.resultDisplay,
            resultDisplayPreview: typeof t.resultDisplay === 'string' ? t.resultDisplay.substring(0, 100) : t.resultDisplay,
            fullResultDisplay: t.resultDisplay
        })));
        
        // Additional logging for debugging state transitions
        console.log('Tool group debug - complete tool objects:', tools);
        
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
            console.log(`Tool ${tool.name} (${tool.status}): resultDisplay =`, tool.resultDisplay);
            
            // Show output for tools with resultDisplay OR for error/canceled states with messages
            const shouldShowOutput = tool.resultDisplay || 
                                   (tool.status === 'Error' || tool.status === 'Canceled') ||
                                   (tool.status === 'Executing' && tool.liveOutput);
            
            if (shouldShowOutput) {
                console.log(`Rendering output for ${tool.name} with status ${tool.status}`);
                const toolOutputEl = document.createElement('div');
                toolOutputEl.className = 'tool-output';
                
                // Determine what content to display
                let outputContent = tool.resultDisplay;
                if (!outputContent && tool.status === 'Error') {
                    outputContent = 'Tool execution failed';
                }
                if (!outputContent && tool.status === 'Canceled') {
                    outputContent = 'Tool execution was canceled';
                }
                if (!outputContent && tool.status === 'Executing' && tool.liveOutput) {
                    outputContent = tool.liveOutput;
                }
                
                if (typeof outputContent === 'string') {
                    // Handle string output (most common case)
                    if (tool.name === 'TodoWrite' && this.isTodoWriteResult(outputContent)) {
                        // Special handling for TodoWrite - could be enhanced later
                        const todos = this.extractTodosFromDisplay(outputContent);
                        if (todos) {
                            toolOutputEl.appendChild(this.renderTodoList(todos));
                        } else {
                            const outputPreEl = document.createElement('pre');
                            outputPreEl.className = 'tool-output-text';
                            outputPreEl.textContent = outputContent;
                            toolOutputEl.appendChild(outputPreEl);
                        }
                    } else {
                        // Regular text output - preserve formatting
                        const outputPreEl = document.createElement('pre');
                        outputPreEl.className = 'tool-output-text';
                        outputPreEl.textContent = outputContent;
                        toolOutputEl.appendChild(outputPreEl);
                    }
                } else if (outputContent && typeof outputContent === 'object') {
                    // Handle diff/file output
                    if (outputContent.fileDiff) {
                        const diffEl = document.createElement('div');
                        diffEl.className = 'tool-output-diff';
                        
                        if (outputContent.fileName) {
                            const fileNameEl = document.createElement('div');
                            fileNameEl.className = 'diff-filename';
                            fileNameEl.textContent = `File: ${outputContent.fileName}`;
                            diffEl.appendChild(fileNameEl);
                        }
                        
                        const diffContentEl = document.createElement('pre');
                        diffContentEl.className = 'diff-content';
                        diffContentEl.textContent = outputContent.fileDiff;
                        diffEl.appendChild(diffContentEl);
                        
                        toolOutputEl.appendChild(diffEl);
                    } else {
                        // Fallback for other object types
                        const objOutputEl = document.createElement('pre');
                        objOutputEl.className = 'tool-output-object';
                        objOutputEl.textContent = JSON.stringify(outputContent, null, 2);
                        toolOutputEl.appendChild(objOutputEl);
                    }
                } else if (!outputContent) {
                    // Fallback for when we want to show output but have no content
                    const fallbackEl = document.createElement('div');
                    fallbackEl.className = 'tool-output-fallback';
                    fallbackEl.textContent = 'No output available';
                    toolOutputEl.appendChild(fallbackEl);
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

    extractTodosFromDisplay(resultDisplay) {
        try {
            const systemReminderMatch = resultDisplay.match(
                /<system-reminder>[\s\S]*?Here are the latest contents of your todo list:\s*(.*?)\. Continue on with the tasks/
            );
            
            if (!systemReminderMatch) {
                return null;
            }
            
            const todosJsonString = systemReminderMatch[1].trim();
            const todos = JSON.parse(todosJsonString);
            
            if (!Array.isArray(todos)) {
                return null;
            }
            
            for (const todo of todos) {
                if (
                    !todo.content ||
                    !todo.id ||
                    !['high', 'medium', 'low'].includes(todo.priority) ||
                    !['pending', 'in_progress', 'completed'].includes(todo.status)
                ) {
                    return null;
                }
            }
            
            return todos;
        } catch (error) {
            console.error('Error parsing todos from display:', error);
            return null;
        }
    }

    renderTodoList(todos) {
        const todoListEl = document.createElement('div');
        todoListEl.className = 'todo-list-container';

        const titleEl = document.createElement('h4');
        titleEl.className = 'todo-list-title';
        titleEl.textContent = 'Update Todos';
        todoListEl.appendChild(titleEl);

        todos.forEach(todo => {
            const todoItemEl = document.createElement('div');
            todoItemEl.className = `todo-item status-${todo.status}`;

            const iconEl = document.createElement('span');
            iconEl.className = 'todo-item-icon';
            iconEl.textContent = this.getTodoStatusIcon(todo.status);

            const contentEl = document.createElement('span');
            contentEl.className = 'todo-item-content';
            contentEl.textContent = todo.content;

            todoItemEl.appendChild(iconEl);
            todoItemEl.appendChild(contentEl);
            todoListEl.appendChild(todoItemEl);
        });

        return todoListEl;
    }

    getTodoStatusIcon(status) {
        switch (status) {
            case 'pending':
                return '☐';
            case 'in_progress':
                return '☐';
            case 'completed':
                return '☑';
            default:
                return '☐';
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
            this.messageInput.disabled = false;
            this.sendButton.disabled = false;
            this.printButton.disabled = false;
        } else {
            this.statusElement.textContent = 'Disconnected';
            this.statusElement.className = 'status-disconnected';
            this.messageInput.disabled = true;
            this.sendButton.disabled = true;
            this.printButton.disabled = true;
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
    
    /**
     * Print the entire chat conversation as PDF
     * Prepares the content and triggers the browser's print dialog
     */
    printChat() {
        // Check if there are any messages to print
        if (this.messageCount === 0) {
            alert('No messages to print. Start a conversation first.');
            return;
        }
        
        try {
            // Store original title and set a print-friendly title
            const originalTitle = document.title;
            const timestamp = new Date().toLocaleString();
            document.title = `Auditaria Chat - ${this.messageCount} messages - ${timestamp}`;
            
            // Add a CSS class to indicate we're in print mode (for any additional styling)
            document.body.classList.add('printing');
            
            // Trigger the browser's print dialog
            window.print();
            
            // Restore original title and remove print mode class after printing
            setTimeout(() => {
                document.title = originalTitle;
                document.body.classList.remove('printing');
            }, 100);
            
        } catch (error) {
            console.error('Error printing chat:', error);
            alert('An error occurred while preparing the chat for printing. Please try again.');
        }
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
        
        // Print button click handler
        this.printButton.addEventListener('click', () => {
            this.printChat();
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
        
        // Loading indicator expand/collapse handler
        this.loadingHeader.addEventListener('click', () => {
            this.toggleThoughtsExpansion();
        });
        
        // Keyboard accessibility for loading header
        this.loadingHeader.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.toggleThoughtsExpansion();
            }
        });
    }
    
    sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || !this.isConnected) {
            return;
        }
        
        // Check if this is a /clear command and show confirmation
        if (message.toLowerCase() === '/clear') {
            this.showClearConfirmation(message);
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
    
    showClearConfirmation(message) {
        // Remove any existing confirmation dialog
        this.hideClearConfirmation();
        
        // Create confirmation dialog
        const overlay = document.createElement('div');
        overlay.className = 'clear-confirmation-overlay';
        
        const dialog = document.createElement('div');
        dialog.className = 'clear-confirmation-dialog';
        
        const icon = document.createElement('div');
        icon.className = 'clear-confirmation-icon';
        icon.textContent = '⚠️';
        
        const title = document.createElement('h3');
        title.className = 'clear-confirmation-title';
        title.textContent = 'Clear Conversation History';
        
        const description = document.createElement('p');
        description.className = 'clear-confirmation-description';
        description.textContent = 'This will permanently delete all messages in the current conversation. This action cannot be undone.';
        
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'clear-confirmation-buttons';
        
        const cancelButton = document.createElement('button');
        cancelButton.className = 'clear-confirmation-button clear-confirmation-cancel';
        cancelButton.textContent = 'Cancel';
        cancelButton.onclick = () => this.hideClearConfirmation();
        
        const confirmButton = document.createElement('button');
        confirmButton.className = 'clear-confirmation-button clear-confirmation-confirm';
        confirmButton.textContent = 'Clear History';
        confirmButton.onclick = () => {
            this.hideClearConfirmation();
            this.executeClearCommand(message);
        };
        
        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        
        dialog.appendChild(icon);
        dialog.appendChild(title);
        dialog.appendChild(description);
        dialog.appendChild(buttonContainer);
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        
        // Focus the confirm button for accessibility
        confirmButton.focus();
        
        // Handle escape key
        const handleEscape = (event) => {
            if (event.key === 'Escape') {
                this.hideClearConfirmation();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
        
        // Handle clicking outside dialog
        overlay.onclick = (event) => {
            if (event.target === overlay) {
                this.hideClearConfirmation();
            }
        };
    }
    
    hideClearConfirmation() {
        const existingDialog = document.querySelector('.clear-confirmation-overlay');
        if (existingDialog) {
            existingDialog.remove();
        }
    }
    
    executeClearCommand(message) {
        try {
            // Send the clear command to server
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
            console.error('Failed to send clear command:', error);
            this.updateInputStatus('Failed to send clear command');
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

        // Disable/enable send button only
        this.sendButton.disabled = this.isLoading;
        
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
        // Update loading text (subject from thought or fallback)
        const loadingMessage = loadingState.thought || loadingState.currentLoadingPhrase || 'Thinking...';
        this.loadingText.textContent = loadingMessage;
        
        // Update elapsed time with ESC cancel text (matching CLI format)
        const timeText = loadingState.elapsedTime < 60 
            ? `(esc to cancel, ${loadingState.elapsedTime}s)` 
            : `(esc to cancel, ${Math.floor(loadingState.elapsedTime / 60)}m ${loadingState.elapsedTime % 60}s)`;
        this.loadingTime.textContent = timeText;
        
        // Update thought content with full thought object
        this.updateThoughtContent(loadingState.thoughtObject);
        
        // Show the loading indicator with animation
        if (this.loadingIndicator.style.display === 'none') {
            this.loadingIndicator.style.display = 'block';
            this.loadingIndicator.classList.remove('hidden');
            
            // Restore previous expansion state if it was expanded
            if (this.isThoughtsExpanded && this.currentThoughtObject && this.currentThoughtObject.description) {
                this.loadingIndicator.classList.add('expanded');
            }
        }
    }
    
    hideLoadingIndicator() {
        if (this.loadingIndicator.style.display !== 'none') {
            this.loadingIndicator.classList.add('hidden');
            setTimeout(() => {
                this.loadingIndicator.style.display = 'none';
                this.loadingIndicator.classList.remove('hidden');
                // Keep expansion state persistent across hide/show cycles
                // Do not reset isThoughtsExpanded or remove 'expanded' class
            }, 300); // Match animation duration
        }
    }
    
    /**
     * Reset the expansion state (only call when appropriate, like on conversation clear)
     */
    resetThoughtsExpansion() {
        this.isThoughtsExpanded = false;
        this.loadingIndicator.classList.remove('expanded');
        this.currentThoughtObject = null;
    }
    
    /**
     * Toggle the expansion of the thoughts section
     */
    toggleThoughtsExpansion() {
        // Only allow expansion if there's thought content
        if (!this.currentThoughtObject || !this.currentThoughtObject.description) {
            return;
        }
        
        this.isThoughtsExpanded = !this.isThoughtsExpanded;
        
        if (this.isThoughtsExpanded) {
            this.loadingIndicator.classList.add('expanded');
        } else {
            this.loadingIndicator.classList.remove('expanded');
        }
        
        // Update accessibility attribute
        this.loadingHeader.setAttribute('aria-expanded', this.isThoughtsExpanded.toString());
    }
    
    /**
     * Update the thought content with smooth transitions
     */
    updateThoughtContent(thoughtObject) {
        if (!thoughtObject) {
            this.currentThoughtObject = null;
            this.loadingDescription.textContent = '';
            return;
        }
        
        // Store current thought object
        this.currentThoughtObject = thoughtObject;
        
        // Track subject changes for performance
        if (thoughtObject.subject !== this.lastLoggedSubject) {
            this.lastLoggedSubject = thoughtObject.subject;
        }
        
        // Update the description content immediately (no jiggling transitions)
        this.loadingDescription.textContent = this.currentThoughtObject.description || '';
        
        // Show/hide expand indicator based on whether there's description content
        if (this.currentThoughtObject.description && this.currentThoughtObject.description.trim()) {
            this.loadingExpandIndicator.style.display = 'block';
            this.loadingHeader.style.cursor = 'pointer';
            this.loadingHeader.setAttribute('aria-label', 'Expand AI thoughts');
            this.loadingHeader.setAttribute('aria-expanded', this.isThoughtsExpanded.toString());
        } else {
            this.loadingExpandIndicator.style.display = 'none';
            this.loadingHeader.style.cursor = 'default';
            this.loadingHeader.setAttribute('aria-label', 'AI is thinking');
            this.loadingHeader.removeAttribute('aria-expanded');
            // Collapse if expanded and no description
            if (this.isThoughtsExpanded) {
                this.isThoughtsExpanded = false;
                this.loadingIndicator.classList.remove('expanded');
            }
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
    
    handleToolConfirmation(confirmationData) {
        this.confirmationQueue.add(confirmationData);
    }
    
    
    
    handleConfirmationResponse(callId, outcome) {
        try {
            this.socket.send(JSON.stringify({
                type: 'tool_confirmation_response',
                callId: callId,
                outcome: outcome,
                timestamp: Date.now()
            }));
            this.confirmationQueue.next();
        } catch (error) {
            console.error('Failed to send confirmation response:', error);
        }
    }
    
    handleToolConfirmationRemoval(removalData) {
        this.confirmationQueue.remove(removalData.callId);
    }
    
    hideConfirmationDialog() {
        const existingDialog = document.querySelector('.confirmation-dialog');
        if (existingDialog) {
            existingDialog.remove();
        }
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