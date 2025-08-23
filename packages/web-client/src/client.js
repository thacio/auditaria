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
import { FileHandler } from './utils/fileHandler.js';
import { AudioRecorder } from './utils/audioRecorder.js';
import { audioPlayerModal } from './components/AudioPlayerModal.js';
import { attachmentCacheManager } from './managers/AttachmentCacheManager.js';
import { ttsManager } from './providers/tts/TTSManager.js';

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
        
        // Initialize TTS manager
        ttsManager.initialize();
        
        // State properties
        this.hasFooterData = false;
        this.attachments = []; // Store current attachments
        this.audioRecorder = null; // Audio recorder instance
        
        // Initialize UI elements
        this.initializeUI();
        
        // Set up WebSocket event handlers
        this.setupWebSocketHandlers();
        
        // Set up keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Set up input handlers
        this.setupInputHandlers();
        
        // Set up visibility change detection
        this.setupVisibilityHandling();
        
        // Connect to WebSocket AFTER all handlers are set up
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
        
        // Attachment elements
        this.attachButton = document.getElementById('attach-button');
        this.fileInput = document.getElementById('file-input');
        this.attachmentPreview = document.getElementById('attachment-preview');
        this.attachmentItems = document.getElementById('attachment-items');
        this.dropOverlay = document.getElementById('drop-overlay');
        this.imageModal = document.getElementById('image-modal');
        this.imageModalContent = document.getElementById('image-modal-content');
        this.imageModalClose = document.getElementById('image-modal-close');
        
        // Audio recording elements
        this.micButton = document.getElementById('mic-button');
        this.recordingIndicator = document.getElementById('recording-indicator');
        this.recordingTime = document.getElementById('recording-time');
        this.recordingStop = document.getElementById('recording-stop');
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
        
        // Handle force resync (buffer overrun)
        this.wsManager.addEventListener('force_resync', () => {
            this.messageManager.clearAllMessages();
            this.loadingIndicator.resetThoughtsExpansion();
            // The WebSocketManager will request full state automatically
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
        
        // Attachment button
        this.attachButton.addEventListener('click', () => {
            this.fileInput.click();
        });
        
        // File input change
        this.fileInput.addEventListener('change', async (event) => {
            await this.handleFileSelection(event.target.files);
            event.target.value = ''; // Reset input so same file can be selected again
        });
        
        // Paste event for images
        this.messageInput.addEventListener('paste', async (event) => {
            const files = FileHandler.getFilesFromPasteEvent(event);
            if (files.length > 0) {
                event.preventDefault();
                await this.handleFileSelection(files);
            }
        });
        
        // Drag and drop
        document.addEventListener('dragover', (event) => {
            event.preventDefault();
            this.dropOverlay.classList.add('active');
        });
        
        document.addEventListener('dragleave', (event) => {
            if (event.clientX === 0 && event.clientY === 0) {
                this.dropOverlay.classList.remove('active');
            }
        });
        
        document.addEventListener('drop', async (event) => {
            event.preventDefault();
            this.dropOverlay.classList.remove('active');
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0) {
                await this.handleFileSelection(files);
            }
        });
        
        // Image modal close
        this.imageModalClose.addEventListener('click', () => {
            this.imageModal.style.display = 'none';
        });
        
        this.imageModal.addEventListener('click', (event) => {
            if (event.target === this.imageModal) {
                this.imageModal.style.display = 'none';
            }
        });
        
        // Audio recording handlers
        this.micButton.addEventListener('click', () => {
            this.toggleRecording();
        });
        
        this.recordingStop.addEventListener('click', () => {
            this.stopRecording();
        });
    }
    
    sendMessage() {
        const message = this.messageInput.value.trim();
        if ((!message && this.attachments.length === 0) || !this.wsManager.getState().isConnected) {
            return;
        }
        
        // Check if this is a /clear command and show confirmation
        if (message.toLowerCase() === '/clear') {
            this.showClearConfirmation(message);
            return;
        }
        
        // Check if this is a slash command (starts with /)
        const isSlashCommand = message.startsWith('/');
        
        // Cache attachments before sending (so we can rehydrate them later)
        if (!isSlashCommand && this.attachments.length > 0) {
            attachmentCacheManager.cacheAttachments(this.attachments);
        }
        
        // Send message with attachments (but not for slash commands)
        if (this.wsManager.sendUserMessage(message, isSlashCommand ? [] : this.attachments)) {
            this.messageInput.value = '';
            // Only clear attachments if we're not sending a slash command
            if (!isSlashCommand) {
                this.clearAttachments();
            }
            this.autoResizeTextarea();
            this.messageInput.focus();
        } else {
            this.updateInputStatus('Failed to send message');
        }
    }
    
    async handleFileSelection(files) {
        // Check if we've reached the maximum number of attachments
        const maxAttachments = 20;
        const remainingSlots = maxAttachments - this.attachments.length;
        
        if (remainingSlots <= 0) {
            alert(`Maximum ${maxAttachments} attachments allowed`);
            return;
        }
        
        // Filter out duplicate files
        const existingFiles = new Set(this.attachments.map(att => `${att.name}_${att.size}`));
        const duplicateFiles = [];
        const uniqueFiles = Array.from(files).filter(file => {
            const fileKey = `${file.name}_${file.size}`;
            if (existingFiles.has(fileKey)) {
                duplicateFiles.push(file.name);
                return false;
            }
            return true;
        });
        
        if (uniqueFiles.length === 0 && duplicateFiles.length > 0) {
            alert(`File(s) already attached: ${duplicateFiles.join(', ')}`);
            return;
        }
        
        // Only process files up to the remaining slots
        const filesToProcess = uniqueFiles.slice(0, remainingSlots);
        
        if (uniqueFiles.length > filesToProcess.length) {
            alert(`Only ${filesToProcess.length} of ${uniqueFiles.length} files added (max ${maxAttachments} attachments)`);
        }
        
        let addedCount = 0;
        let errors = [];
        
        for (const file of filesToProcess) {
            try {
                // Double-check for duplicates (in case of race conditions)
                const isDuplicate = this.attachments.some(att => 
                    att.name === file.name && att.size === file.size
                );
                
                if (isDuplicate) {
                    continue;
                }
                
                const attachment = await FileHandler.createAttachment(file, this.attachments);
                this.attachments.push(attachment);
                this.updateAttachmentPreview();
                addedCount++;
            } catch (error) {
                console.error('Failed to process file:', error);
                errors.push(`${file.name}: ${error.message}`);
            }
        }
        
        // Show error alert if there were any errors
        if (errors.length > 0) {
            alert(`Failed to attach files:\n\n${errors.join('\n')}`);
        }
        
        // Show summary if we had partial success
        if (duplicateFiles.length > 0 && addedCount > 0) {
            console.log(`Added ${addedCount} files, skipped ${duplicateFiles.length} duplicates`);
        }
    }
    
    updateAttachmentPreview() {
        if (this.attachments.length === 0) {
            this.attachmentPreview.style.display = 'none';
            this.attachmentItems.innerHTML = '';
            return;
        }
        
        this.attachmentPreview.style.display = 'block';
        this.attachmentItems.innerHTML = '';
        
        this.attachments.forEach((attachment, index) => {
            const item = document.createElement('div');
            item.className = 'attachment-item';
            
            // Check if this is an audio file
            const isAudio = attachment.type === 'audio' || 
                           (attachment.mimeType && attachment.mimeType.startsWith('audio/'));
            
            // Add click handler for audio files to preview them
            if (isAudio) {
                item.style.cursor = 'pointer';
                item.onclick = (e) => {
                    // Don't trigger if clicking the remove button
                    if (e.target.classList.contains('attachment-remove')) {
                        return;
                    }
                    // Open audio player modal with the attachment
                    if (audioPlayerModal) {
                        audioPlayerModal.open(attachment);
                    }
                };
            }
            
            // Thumbnail or icon
            if (attachment.thumbnail) {
                const img = document.createElement('img');
                img.src = attachment.thumbnail;
                img.className = 'attachment-thumbnail';
                img.alt = attachment.name;
                item.appendChild(img);
            } else {
                const icon = document.createElement('div');
                icon.className = 'attachment-icon';
                icon.textContent = attachment.icon;
                item.appendChild(icon);
            }
            
            // Info
            const info = document.createElement('div');
            info.className = 'attachment-info';
            
            const name = document.createElement('div');
            name.className = 'attachment-name';
            name.textContent = attachment.name;
            name.title = attachment.name;
            
            const size = document.createElement('div');
            size.className = 'attachment-size';
            size.textContent = attachment.displaySize;
            
            info.appendChild(name);
            info.appendChild(size);
            item.appendChild(info);
            
            // Remove button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'attachment-remove';
            removeBtn.textContent = '×';
            removeBtn.onclick = () => this.removeAttachment(index);
            item.appendChild(removeBtn);
            
            this.attachmentItems.appendChild(item);
        });
    }
    
    removeAttachment(index) {
        this.attachments.splice(index, 1);
        this.updateAttachmentPreview();
    }
    
    clearAttachments() {
        this.attachments = [];
        this.updateAttachmentPreview();
    }
    
    // Audio Recording Methods
    async toggleRecording() {
        if (!this.audioRecorder) {
            this.audioRecorder = new AudioRecorder();
        }
        
        if (this.audioRecorder.isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }
    
    async startRecording() {
        try {
            // Check if browser supports recording
            if (!AudioRecorder.isSupported()) {
                console.error('Audio recording is not supported in your browser');
                return;
            }
            
            // Initialize audio recorder
            if (!this.audioRecorder) {
                this.audioRecorder = new AudioRecorder();
            }
            
            // Set up callbacks
            this.audioRecorder.onStop = (audioFile, duration) => {
                this.handleRecordingComplete(audioFile, duration);
            };
            
            this.audioRecorder.onError = (error) => {
                console.error('Recording error:', error);
                this.hideRecordingIndicator();
            };
            
            this.audioRecorder.onTimeUpdate = (timeString) => {
                this.recordingTime.textContent = timeString;
            };
            
            // Start recording
            const started = await this.audioRecorder.start();
            if (started) {
                this.showRecordingIndicator();
                this.micButton.classList.add('recording');
            }
        } catch (error) {
            console.error('Failed to start recording:', error);
            // Just log the error, don't show in footer
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                console.error('Microphone permission denied. Please allow microphone access.');
            }
        }
    }
    
    stopRecording() {
        if (this.audioRecorder && this.audioRecorder.isRecording) {
            this.audioRecorder.stop();
            this.hideRecordingIndicator();
            this.micButton.classList.remove('recording');
        }
    }
    
    async handleRecordingComplete(audioFile, duration) {
        try {
            // Convert audio file to attachment
            const attachment = await FileHandler.createAttachment(audioFile, this.attachments);
            
            // Add custom properties for audio
            attachment.duration = Math.round(duration / 1000); // Duration in seconds
            attachment.icon = '🎙️'; // Use microphone icon for audio
            
            // Add to attachments
            this.attachments.push(attachment);
            this.updateAttachmentPreview();
        } catch (error) {
            console.error('Failed to process audio recording:', error);
        }
    }
    
    showRecordingIndicator() {
        this.recordingIndicator.style.display = 'block';
        this.recordingTime.textContent = '0:00';
        
        // Disable input controls during recording
        this.messageInput.disabled = true;
        this.sendButton.disabled = true;
        this.attachButton.disabled = true;
    }
    
    hideRecordingIndicator() {
        this.recordingIndicator.style.display = 'none';
        
        // Re-enable input controls
        this.messageInput.disabled = false;
        this.sendButton.disabled = false;
        this.attachButton.disabled = false;
        
        // Re-focus on input
        this.messageInput.focus();
    }
    
    formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
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
    
    setupVisibilityHandling() {
        let wasHidden = false;
        
        // Handle visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && wasHidden) {
                // Tab became visible after being hidden
                console.log('Tab became visible, checking for missed messages');
                this.wsManager.checkForMissedMessages();
                wasHidden = false;
            } else if (document.visibilityState === 'hidden') {
                wasHidden = true;
                // Send any pending acknowledgments before tab goes hidden
                this.wsManager.sendAcknowledgment();
            }
        });
        
        // Also handle focus events as a backup
        window.addEventListener('focus', () => {
            if (wasHidden) {
                console.log('Window focused, checking for missed messages');
                this.wsManager.checkForMissedMessages();
                wasHidden = false;
            }
        });
        
        window.addEventListener('blur', () => {
            // Send any pending acknowledgments when window loses focus
            this.wsManager.sendAcknowledgment();
        });
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const client = new AuditariaWebClient();
    
    // Clean up audio recorder and TTS on page unload
    window.addEventListener('beforeunload', () => {
        if (client.audioRecorder) {
            client.audioRecorder.cleanup();
        }
        // Stop any ongoing TTS
        ttsManager.stop();
    });
});