/**
 * Auditaria Web Client - Refactored modular architecture
 * Main orchestrator for web interface functionality
 */

import { WebSocketManager } from './managers/WebSocketManager.js';
import { MessageManager } from './managers/MessageManager.js';
import { ModalManager } from './managers/ModalManager.js';
import { KeyboardManager } from './managers/KeyboardManager.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { TerminalDisplay } from './components/TerminalDisplay.js';
import { shortenPath } from './utils/formatters.js';

class AuditariaWebClient {
    constructor() {
        // Initialize managers
        this.wsManager = new WebSocketManager();
        this.messageManager = new MessageManager();
        this.modalManager = new ModalManager();
        this.keyboardManager = new KeyboardManager();
        this.loadingIndicator = new LoadingIndicator();
        this.terminalDisplay = new TerminalDisplay(this.wsManager);
        
        // Initialize confirmation queue (keep existing module)
        this.confirmationQueue = new ConfirmationQueue(this);
        
        // State properties
        this.hasFooterData = false;
        
        // Initialize UI elements
        this.initializeUI();
        
        // Set up WebSocket event handlers
        this.setupWebSocketHandlers();
        
        // Set up keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Set up input handlers
        this.setupInputHandlers();
        
        // Connect to WebSocket
        this.wsManager.connect();
    }
    
    initializeUI() {
        this.statusElement = document.getElementById('connection-status');
        this.messageCountElement = document.getElementById('message-count');
        this.messageInput = document.getElementById('message-input');
        this.sendButton = document.getElementById('send-button');
        this.printButton = document.getElementById('print-button');
        this.autoscrollButton = document.getElementById('autoscroll-button');
        this.inputStatus = document.getElementById('input-status');
    }
    
    setupWebSocketHandlers() {
        // Connection events
        this.wsManager.addEventListener('connected', () => {
            this.updateConnectionStatus(true);
            this.updateInputState();
        });
        
        this.wsManager.addEventListener('disconnected', () => {
            this.updateConnectionStatus(false);
            this.updateInputState();
        });
        
        this.wsManager.addEventListener('reconnect_failed', () => {
            this.messageManager.addSystemMessage('Connection lost. Please refresh the page to reconnect.');
        });
        
        // Message type handlers
        this.wsManager.addEventListener('connection', (e) => {
            this.messageManager.addWelcomeMessage(e.detail.message);
        });
        
        this.wsManager.addEventListener('history_item', (e) => {
            this.messageManager.addHistoryItem(e.detail);
        });
        
        this.wsManager.addEventListener('pending_item', (e) => {
            this.messageManager.updatePendingItem(e.detail);
        });
        
        this.wsManager.addEventListener('footer_data', (e) => {
            this.updateFooter(e.detail);
        });
        
        this.wsManager.addEventListener('slash_commands', (e) => {
            this.modalManager.handleSlashCommands(e.detail);
        });
        
        this.wsManager.addEventListener('mcp_servers', (e) => {
            this.modalManager.handleMCPServers(e.detail);
        });
        
        this.wsManager.addEventListener('console_messages', (e) => {
            this.modalManager.handleConsoleMessages(e.detail);
        });
        
        this.wsManager.addEventListener('cli_action_required', (e) => {
            // Don't show the old modal, terminal capture will handle it
            // this.modalManager.handleCliActionRequired(e.detail);
            this.updateInputStateForCliAction(e.detail.active);
        });
        
        this.wsManager.addEventListener('terminal_capture', (e) => {
            // Show terminal display instead of CLI action modal
            if (e.detail && e.detail.content) {
                this.terminalDisplay.show(e.detail);
            } else {
                this.terminalDisplay.hide();
            }
        });
        
        this.wsManager.addEventListener('history_sync', (e) => {
            this.messageManager.loadHistoryItems(e.detail.history);
        });
        
        this.wsManager.addEventListener('loading_state', (e) => {
            const isLoading = this.loadingIndicator.updateLoadingState(e.detail);
            this.sendButton.disabled = isLoading;
            
            if (isLoading) {
                this.keyboardManager.enable();
            } else {
                this.keyboardManager.disable();
            }
        });
        
        this.wsManager.addEventListener('tool_confirmation', (e) => {
            this.confirmationQueue.add(e.detail);
        });
        
        this.wsManager.addEventListener('tool_confirmation_removal', (e) => {
            this.confirmationQueue.remove(e.detail.callId);
        });
        
        this.wsManager.addEventListener('clear', () => {
            this.messageManager.clearAllMessages();
            this.loadingIndicator.resetThoughtsExpansion();
        });
    }
    
    setupKeyboardShortcuts() {
        // Register ESC key for interrupting AI processing
        this.keyboardManager.register('Escape', () => {
            if (this.loadingIndicator.getState().isLoading && this.wsManager.getState().isConnected) {
                this.wsManager.sendInterruptRequest();
            }
        });
        
        // Future shortcuts can be added here:
        // this.keyboardManager.register('KeyS', () => { /* Save */ }, { ctrl: true });
        // this.keyboardManager.register('KeyC', () => { /* Copy */ }, { ctrl: true });
    }
    
    setupInputHandlers() {
        // Send button
        this.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // Print button
        this.printButton.addEventListener('click', () => {
            this.printChat();
        });
        
        // Auto-scroll button
        this.autoscrollButton.addEventListener('click', () => {
            this.messageManager.toggleAutoScroll();
        });
        
        // Message input
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
        if (!message || !this.wsManager.getState().isConnected) {
            return;
        }
        
        // Check if this is a /clear command and show confirmation
        if (message.toLowerCase() === '/clear') {
            this.showClearConfirmation(message);
            return;
        }
        
        if (this.wsManager.sendUserMessage(message)) {
            this.messageInput.value = '';
            this.autoResizeTextarea();
            this.messageInput.focus();
        } else {
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
        if (this.wsManager.sendUserMessage(message)) {
            this.messageInput.value = '';
            this.autoResizeTextarea();
            this.messageInput.focus();
        } else {
            this.updateInputStatus('Failed to send clear command');
        }
    }
    
    printChat() {
        if (this.messageManager.getMessageCount() === 0) {
            alert('No messages to print. Start a conversation first.');
            return;
        }
        
        try {
            const originalTitle = document.title;
            const timestamp = new Date().toLocaleString();
            document.title = `Auditaria Chat - ${this.messageManager.getMessageCount()} messages - ${timestamp}`;
            
            document.body.classList.add('printing');
            
            window.print();
            
            setTimeout(() => {
                document.title = originalTitle;
                document.body.classList.remove('printing');
            }, 100);
            
        } catch (error) {
            console.error('Error printing chat:', error);
            alert('An error occurred while preparing the chat for printing. Please try again.');
        }
    }
    
    updateConnectionStatus(isConnected) {
        if (isConnected) {
            this.statusElement.textContent = 'Connected';
            this.statusElement.className = 'status-connected';
            this.messageInput.disabled = false;
            this.sendButton.disabled = false;
            this.printButton.disabled = false;
            this.autoscrollButton.disabled = false;
        } else {
            this.statusElement.textContent = 'Disconnected';
            this.statusElement.className = 'status-disconnected';
            this.messageInput.disabled = true;
            this.sendButton.disabled = true;
            this.printButton.disabled = true;
            this.autoscrollButton.disabled = true;
        }
    }
    
    updateInputState() {
        const isEnabled = this.wsManager.getState().isConnected;
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
    
    updateInputStateForCliAction(isActive) {
        if (isActive) {
            this.messageInput.disabled = true;
            this.sendButton.disabled = true;
        } else if (this.wsManager.getState().isConnected) {
            this.messageInput.disabled = false;
            this.sendButton.disabled = false;
        }
    }
    
    updateInputStatus(message) {
        this.inputStatus.textContent = message;
    }
    
    updateFooter(footerData) {
        this.hasFooterData = true;
        
        const parts = [];
        
        // Directory and branch
        const shortPath = shortenPath(footerData.targetDir, 40);
        const dirAndBranch = footerData.branchName 
            ? `${shortPath} (${footerData.branchName}*)`
            : shortPath;
        parts.push(dirAndBranch);
        
        // Add debug mode info
        if (footerData.debugMode) {
            const debugText = footerData.debugMessage || '--debug';
            parts[0] += ` ${debugText}`;
        }
        
        // Sandbox status
        if (footerData.sandboxStatus !== 'no sandbox') {
            parts.push(footerData.sandboxStatus);
        } else {
            parts.push('no sandbox (see /docs)');
        }
        
        // Model and context
        const contextText = `${footerData.contextPercentage.toFixed(0)}% context left`;
        parts.push(`${footerData.model} (${contextText})`);
        
        // Add corgi mode if enabled
        if (footerData.corgiMode) {
            parts.push('▼(´ᴥ`)▼');
        }
        
        // Add error count if any
        if (!footerData.showErrorDetails && footerData.errorCount > 0) {
            parts.push(`✖ ${footerData.errorCount} error${footerData.errorCount !== 1 ? 's' : ''} (ctrl+o for details)`);
        }
        
        // Add memory usage indicator if enabled
        if (footerData.showMemoryUsage) {
            parts.push('📊 Memory');
        }
        
        // Update the input status with footer information
        const footerText = parts.join(' | ');
        
        if (footerData.nightly) {
            this.inputStatus.innerHTML = `<span class="footer-info footer-nightly">${footerText}</span>`;
        } else {
            this.inputStatus.innerHTML = `<span class="footer-info">${footerText}</span>`;
        }
    }
    
    autoResizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
    }
    
    handleConfirmationResponse(callId, outcome) {
        this.wsManager.sendConfirmationResponse(callId, outcome);
        this.confirmationQueue.next();
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new AuditariaWebClient();
});