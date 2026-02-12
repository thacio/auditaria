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
import { ConfirmationQueue } from './confirmation-queue.js';
import { SlashAutocompleteManager } from './managers/SlashAutocompleteManager.js';
import { themeManager } from './utils/theme-manager.js';
import { layoutManager } from './utils/layout-manager.js';
import { showErrorToast, showInfoToast } from './components/Toast.js';

// WEB_INTERFACE_START: File browser and editor imports
import { FileTreeManager } from './managers/FileTreeManager.js';
import { EditorManager } from './managers/EditorManager.js';
import { FileTreePanel } from './components/FileTreePanel.js';
import { EditorPanel } from './components/EditorPanel.js';
import { PreviewManager, DEFAULT_PREVIEWS } from './utils/preview/index.js';
import { isBinaryFile } from './utils/binaryExtensions.js';
import { detectLanguage } from './utils/languageDetection.js';
// WEB_INTERFACE_END

// Knowledge Base Search & Management
import { KnowledgeBaseManager } from './knowledge-base/KnowledgeBaseManager.js';

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

        // WEB_INTERFACE_START: Initialize file browser and editor
        this.initializeFileBrowser();
        // WEB_INTERFACE_END

        // Initialize Knowledge Base manager
        this.knowledgeBaseManager = new KnowledgeBaseManager(this.wsManager);

        // Initialize slash command autocomplete (after UI init)
        this.slashAutocomplete = null; // Will be initialized after UI elements are ready

        // State properties
        this.hasFooterData = false;
        this.latestFooterData = null;
        this.modelMenuData = null;
        this.modelMenuElement = null;
        this.modelMenuAnchor = null;
        this.modelMenuScrollTop = 0;
        this.codexMenuEfforts = new Map();
        this.handleModelMenuOutsideClick = this.handleModelMenuOutsideClick.bind(this);
        this.handleModelMenuEscape = this.handleModelMenuEscape.bind(this);
        this.handleModelMenuViewportChange = this.handleModelMenuViewportChange.bind(this);
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

        // Wire theme picker
        themeManager.mountPicker(document.getElementById('theme-picker'));
        // Wire layout picker
        layoutManager.mountPicker(document.getElementById('layout-picker'));
        
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

        // Initialize slash command autocomplete
        this.slashAutocomplete = new SlashAutocompleteManager(this.messageInput);

        // Knowledge Base button
        this.knowledgeBaseButton = document.getElementById('knowledge-base-button');
        if (this.knowledgeBaseButton) {
            this.knowledgeBaseButton.addEventListener('click', () => {
                if (this.knowledgeBaseManager) {
                    this.knowledgeBaseManager.openModal();
                }
            });
        }

        // Set up Knowledge Base open file callback
        if (this.knowledgeBaseManager) {
            this.knowledgeBaseManager.setOpenFileCallback((path) => {
                if (this.editorManager) {
                    this.handleFileOpen(path);
                }
            });
        }
    }

    setupWebSocketHandlers() {
        // Connection events
        this.wsManager.addEventListener('connected', () => {
            this.updateConnectionStatus(true);
            this.updateInputState();

            // WEB_INTERFACE_START: Request file tree after WebSocket is connected
            if (this.fileTreeManager) {
                this.fileTreeManager.initialize();
            }
            // WEB_INTERFACE_END

            // Enable Knowledge Base button and request status
            if (this.knowledgeBaseButton) {
                this.knowledgeBaseButton.disabled = false;
            }
            if (this.knowledgeBaseManager) {
                this.knowledgeBaseManager.requestStatus();
            }
        });
        
        this.wsManager.addEventListener('disconnected', () => {
            this.updateConnectionStatus(false);
            this.updateInputState();

            // Disable Knowledge Base button on disconnect
            if (this.knowledgeBaseButton) {
                this.knowledgeBaseButton.disabled = true;
            }
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
        
        // WEB_INTERFACE: Unified response state replaces fragmented pending_item
        this.wsManager.addEventListener('response_state', (e) => {
            this.messageManager.renderResponseState(e.detail);
        });
        
        this.wsManager.addEventListener('footer_data', (e) => {
            this.updateFooter(e.detail);
        });

        this.wsManager.addEventListener('model_menu_data', (e) => {
            this.updateModelMenuData(e.detail);
        });
        
        this.wsManager.addEventListener('slash_commands', (e) => {
            this.modalManager.handleSlashCommands(e.detail);
            // Also pass commands to autocomplete
            if (this.slashAutocomplete) {
                this.slashAutocomplete.setCommands(e.detail.commands || []);
            }
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
            // Check if autocomplete wants to handle the event first
            if (this.slashAutocomplete && this.slashAutocomplete.handleKeyDown(event)) {
                return; // Autocomplete consumed the event
            }

            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.sendMessage();
            }
        });

        // Auto-resize textarea
        this.messageInput.addEventListener('input', () => {
            this.autoResizeTextarea();
        });

        this.messageInput.addEventListener('focus', () => {
            this.handleMessageInputFocus();
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
            showErrorToast(`Maximum ${maxAttachments} attachments allowed`);
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
            showInfoToast(`Already attached: ${duplicateFiles.join(', ')}`);
            return;
        }
        
        // Only process files up to the remaining slots
        const filesToProcess = uniqueFiles.slice(0, remainingSlots);
        
        if (uniqueFiles.length > filesToProcess.length) {
            showInfoToast(`Added ${filesToProcess.length} of ${uniqueFiles.length} files (max ${maxAttachments})`);
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
            showErrorToast(`Failed to attach files: ${errors.join('; ')}`);
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
            showInfoToast('No messages to print yet.');
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
            showErrorToast('Failed to prepare the chat for printing.');
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
        this.closeModelMenu();
        this.inputStatus.classList.remove('has-footer-data');
        this.inputStatus.textContent = message;
    }

    formatModelFooterText(rawModel, displayModel) {
        const raw = String(rawModel || '').trim();
        const display = String(displayModel || '').trim();
        const rawLower = raw.toLowerCase();
        const displayLower = display.toLowerCase();
        const toTitleCase = (value) =>
            String(value || '')
                .split(/[-_\s]+/)
                .filter(Boolean)
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' ');

        if (rawLower.startsWith('claude-code:')) {
            const variant = raw.slice('claude-code:'.length);
            const label = variant.toLowerCase() === 'auto'
                ? 'Auto'
                : toTitleCase(variant);
            return `Claude (${label})`;
        }

        if (rawLower.startsWith('codex-code:')) {
            const variant = raw.slice('codex-code:'.length);
            if (variant.toLowerCase() === 'auto') {
                return 'Codex (Auto)';
            }
            const codexTitleMap = {
                'gpt-5.3-codex': 'GPT-5.3 Codex',
                'gpt-5.2-codex': 'GPT-5.2 Codex',
                'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
            };
            const mapped = codexTitleMap[variant.toLowerCase()];
            return `Codex (${mapped || variant})`;
        }

        if (
            rawLower === 'auto' ||
            rawLower === 'auto-gemini-2.5' ||
            rawLower === 'auto-gemini-3' ||
            displayLower.startsWith('auto (gemini')
        ) {
            return 'Gemini (Auto)';
        }

        if (rawLower.startsWith('gemini-')) {
            return `Gemini (${raw})`;
        }

        if (
            rawLower === 'pro' ||
            rawLower === 'flash' ||
            rawLower === 'flash-lite'
        ) {
            return `Gemini (${toTitleCase(raw)})`;
        }

        if (
            displayLower.startsWith('claude (') ||
            displayLower.startsWith('codex (')
        ) {
            return display;
        }

        if (displayLower.includes('gemini')) {
            return `Gemini (${raw || display})`;
        }

        if (displayLower.startsWith('auditaria (')) {
            const label = display.replace(/^auditaria\s*\(/i, '').replace(/\)$/, '');
            return `Gemini (${label})`;
        }

        return raw || display || 'Model';
    }

    createFooterPill({ text, tone = 'neutral', extraClass = '', title = '' }) {
        const pill = document.createElement('div');
        pill.className = `web-footer-pill web-footer-pill-${tone}${extraClass ? ` ${extraClass}` : ''}`;
        if (title) {
            pill.title = title;
        }

        const valueNode = document.createElement('span');
        valueNode.className = 'web-footer-pill-text';
        valueNode.textContent = text;

        pill.append(valueNode);
        return pill;
    }

    normalizeModelMenuLabel(value, fallback = 'Model') {
        const text = String(value || '').trim();
        if (!text) return fallback;
        if (/^auditaria\s*\(/i.test(text)) {
            const inner = text.replace(/^auditaria\s*\(/i, '').replace(/\)\s*$/, '').trim();
            return `Gemini (${inner || 'Auto'})`;
        }
        if (/^auditaria$/i.test(text)) {
            return 'Gemini';
        }
        return text;
    }

    normalizeModelMenuData(modelMenuData) {
        if (!modelMenuData || typeof modelMenuData !== 'object') {
            return null;
        }

        const groups = Array.isArray(modelMenuData.groups)
            ? modelMenuData.groups.map((group) => ({
                ...group,
                label: this.normalizeModelMenuLabel(group?.label, 'Group'),
                options: Array.isArray(group?.options)
                    ? group.options.map((option) => ({
                        ...option,
                        label: this.normalizeModelMenuLabel(
                            option?.label,
                            option?.selection || 'Model',
                        ),
                    }))
                    : [],
            }))
            : [];

        return {
            ...modelMenuData,
            groups,
        };
    }

    updateModelMenuData(modelMenuData) {
        const wasOpen = Boolean(this.modelMenuElement);
        if (this.modelMenuElement) {
            this.modelMenuScrollTop = this.modelMenuElement.scrollTop;
        }
        this.modelMenuData = this.normalizeModelMenuData(modelMenuData);
        const codexOptions =
            this.modelMenuData?.groups?.find((group) => group.id === 'codex')?.options || [];
        const codexSelections = new Set(codexOptions.map((option) => option.selection));
        for (const selection of this.codexMenuEfforts.keys()) {
            if (!codexSelections.has(selection)) {
                this.codexMenuEfforts.delete(selection);
            }
        }
        if (this.latestFooterData) {
            this.updateFooter(this.latestFooterData);
        }
        if (wasOpen && this.modelMenuAnchor) {
            this.openModelMenu(this.modelMenuAnchor);
        }
    }

    getActiveModelMenuOption() {
        if (!this.modelMenuData?.groups || !this.modelMenuData?.activeSelection) {
            return null;
        }
        for (const group of this.modelMenuData.groups) {
            for (const option of group.options || []) {
                if (option.selection === this.modelMenuData.activeSelection) {
                    return option;
                }
            }
        }
        return null;
    }

    hasModelMenuOptions() {
        return this.modelMenuData?.groups?.some(
            (group) => Array.isArray(group.options) && group.options.length > 0,
        ) || false;
    }

    setModelMenuExpanded(expanded) {
        if (this.modelMenuAnchor) {
            this.modelMenuAnchor.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
    }

    getCodexReasoningMetadataForSelection(selection) {
        if (!selection?.startsWith('codex:')) return null;
        const codexReasoning = this.modelMenuData?.codexReasoning;
        if (!codexReasoning?.options?.length) return null;

        const codexGroup = this.modelMenuData?.groups?.find((group) => group.id === 'codex');
        const activeOption = codexGroup?.options?.find((option) => option.selection === selection);
        const supportedEfforts = Array.isArray(activeOption?.supportedReasoningEfforts)
            ? activeOption.supportedReasoningEfforts
            : [];
        if (!supportedEfforts.length) return null;

        return {
            currentEffort: codexReasoning.currentEffort,
            options: codexReasoning.options,
            supportedEfforts,
        };
    }

    getCodexEffortStateForSelection(selection) {
        const codexReasoning = this.getCodexReasoningMetadataForSelection(selection);
        if (!codexReasoning) return null;

        const effortOrder = codexReasoning.options.map((option) => option.value);
        const supportedEfforts = codexReasoning.supportedEfforts.filter((value) =>
            effortOrder.includes(value),
        );
        if (!supportedEfforts.length) return null;

        const effortLabelMap = new Map(
            codexReasoning.options.map((option) => [option.value, option.label]),
        );

        const overriddenEffort = this.codexMenuEfforts.get(selection);
        let currentEffort = overriddenEffort || codexReasoning.currentEffort;
        if (!supportedEfforts.includes(currentEffort)) {
            const fallback =
                [...supportedEfforts]
                    .reverse()
                    .find((value) => effortOrder.indexOf(value) <= effortOrder.indexOf(codexReasoning.currentEffort)) ||
                supportedEfforts[0];
            currentEffort = fallback;
        }

        const currentIndex = supportedEfforts.indexOf(currentEffort);
        const previousEffort =
            supportedEfforts[Math.max(0, currentIndex - 1)] || currentEffort;
        const nextEffort =
            supportedEfforts[Math.min(supportedEfforts.length - 1, currentIndex + 1)] ||
            currentEffort;
        const canDecrease = currentIndex > 0;
        const canIncrease = currentIndex < supportedEfforts.length - 1;

        const maxEffort = supportedEfforts[supportedEfforts.length - 1];
        const filledBars = Math.max(1, effortOrder.indexOf(currentEffort) + 1);
        const maxBars = Math.max(filledBars, effortOrder.indexOf(maxEffort) + 1);

        return {
            currentEffort,
            currentLabel: effortLabelMap.get(currentEffort) || 'Medium',
            previousEffort,
            previousLabel: effortLabelMap.get(previousEffort) || 'Medium',
            nextEffort,
            nextLabel: effortLabelMap.get(nextEffort) || 'Medium',
            canDecrease,
            canIncrease,
            filledBars,
            maxBars,
        };
    }

    buildModelMenuElement() {
        if (!this.modelMenuData?.groups?.length) {
            return null;
        }

        const menu = document.createElement('div');
        menu.className = 'web-footer-model-menu';

        const menuHeader = document.createElement('div');
        menuHeader.className = 'web-footer-model-menu-header';
        menuHeader.textContent = 'Model selection';
        menu.append(menuHeader);

        for (const group of this.modelMenuData.groups) {
            const section = document.createElement('div');
            section.className = 'web-footer-model-menu-section';
            const isCodexGroup = group.id === 'codex';
            const isAvailable = group.available !== false; // AUDITARIA_PROVIDER_AVAILABILITY: Default to true for backwards compatibility

            const title = document.createElement('div');
            title.className = 'web-footer-model-menu-title';
            title.textContent = group.label;
            section.append(title);

            // AUDITARIA_PROVIDER_AVAILABILITY: Show install message for unavailable providers
            if (!isAvailable && group.installMessage) {
                const installMsg = document.createElement('div');
                installMsg.className = 'web-footer-model-menu-install-message';
                installMsg.textContent = group.installMessage;
                section.append(installMsg);
            }

            for (const option of group.options || []) {
                const item = document.createElement('div');
                item.className = 'web-footer-model-menu-item';

                // AUDITARIA_PROVIDER_AVAILABILITY: Disable unavailable providers
                if (!isAvailable) {
                    item.classList.add('is-disabled');
                    item.setAttribute('aria-disabled', 'true');
                    item.title = `${option.label} (not available - install required)`;
                } else {
                    item.setAttribute('role', 'button');
                    item.setAttribute('tabindex', '0');
                    item.title = option.description || option.label;
                }

                if (option.selection === this.modelMenuData.activeSelection) {
                    item.classList.add('is-active');
                }
                if (isCodexGroup) {
                    item.classList.add('web-footer-model-menu-item-codex');
                }

                const main = document.createElement('div');
                main.className = 'web-footer-model-menu-item-main';

                const label = document.createElement('span');
                label.className = 'web-footer-model-menu-item-label';
                label.textContent = option.label;
                main.append(label);

                if (option.description) {
                    const description = document.createElement('span');
                    description.className = 'web-footer-model-menu-item-description';
                    description.textContent = option.description;
                    main.append(description);
                }
                item.append(main);

                if (isCodexGroup) {
                    const effortState = this.getCodexEffortStateForSelection(
                        option.selection,
                    );
                    if (effortState) {
                        const effortControl = document.createElement('div');
                        effortControl.className = 'web-footer-codex-effort-control';

                        const effortTitle = document.createElement('span');
                        effortTitle.className = 'web-footer-codex-effort-title';
                        effortTitle.textContent = 'Thinking';
                        effortControl.append(effortTitle);

                        const leftArrow = document.createElement('button');
                        leftArrow.type = 'button';
                        leftArrow.className = 'web-footer-codex-effort-arrow';
                        leftArrow.textContent = '\u2039';
                        effortControl.append(leftArrow);

                        const effortBars = document.createElement('span');
                        effortBars.className = 'web-footer-codex-effort-bars';
                        effortControl.append(effortBars);

                        const rightArrow = document.createElement('button');
                        rightArrow.type = 'button';
                        rightArrow.className = 'web-footer-codex-effort-arrow';
                        rightArrow.textContent = '\u203A';
                        effortControl.append(rightArrow);

                        const renderBars = (state) => {
                            effortBars.replaceChildren();

                            const filledBars = document.createElement('span');
                            filledBars.className = 'is-filled';
                            filledBars.textContent = '|'.repeat(state.filledBars);
                            effortBars.append(filledBars);

                            const emptyBarCount = Math.max(
                                0,
                                state.maxBars - state.filledBars,
                            );
                            if (emptyBarCount > 0) {
                                const emptyBars = document.createElement('span');
                                emptyBars.className = 'is-empty';
                                emptyBars.textContent = '|'.repeat(emptyBarCount);
                                effortBars.append(emptyBars);
                            }
                        };

                        const renderState = () => {
                            const state = this.getCodexEffortStateForSelection(option.selection);
                            if (!state) return;

                            const decreaseTarget = state.canDecrease
                                ? state.previousLabel
                                : state.currentLabel;
                            const increaseTarget = state.canIncrease
                                ? state.nextLabel
                                : state.currentLabel;
                            effortControl.title = `Thinking: ${state.currentLabel}`;
                            leftArrow.title = `Decrease thinking to ${decreaseTarget}`;
                            rightArrow.title = `Increase thinking to ${increaseTarget}`;
                            leftArrow.disabled = !state.canDecrease;
                            rightArrow.disabled = !state.canIncrease;
                            renderBars(state);
                        };
                        renderState();

                        leftArrow.addEventListener('click', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const state = this.getCodexEffortStateForSelection(option.selection);
                            if (!state || !state.canDecrease) return;
                            this.codexMenuEfforts.set(option.selection, state.previousEffort);
                            renderState();
                        });
                        rightArrow.addEventListener('click', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const state = this.getCodexEffortStateForSelection(option.selection);
                            if (!state || !state.canIncrease) return;
                            this.codexMenuEfforts.set(option.selection, state.nextEffort);
                            renderState();
                        });

                        item.append(effortControl);
                    }
                }

                item.addEventListener('click', () => {
                    // AUDITARIA_PROVIDER_AVAILABILITY: Prevent selection of unavailable providers
                    if (!isAvailable) {
                        return;
                    }

                    if (isCodexGroup) {
                        const state = this.getCodexEffortStateForSelection(option.selection);
                        this.wsManager.sendModelSelection(
                            option.selection,
                            state?.currentEffort
                                ? { reasoningEffort: state.currentEffort }
                                : {},
                        );
                    } else {
                        this.wsManager.sendModelSelection(option.selection);
                    }
                    this.closeModelMenu();
                });
                item.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        item.click();
                    }
                });
                section.append(item);
            }

            menu.append(section);
        }

        return menu;
    }

    positionModelMenu() {
        if (!this.modelMenuElement || !this.modelMenuAnchor) return;

        const anchorRect = this.modelMenuAnchor.getBoundingClientRect();
        const menuRect = this.modelMenuElement.getBoundingClientRect();

        const viewportPadding = 12;
        const menuGap = 10;
        let left = anchorRect.left + (anchorRect.width / 2) - (menuRect.width / 2);
        const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
        left = Math.max(viewportPadding, Math.min(left, maxLeft));

        const availableAbove = anchorRect.top - viewportPadding - menuGap;
        const availableBelow =
            window.innerHeight - anchorRect.bottom - viewportPadding - menuGap;
        const canFitAbove = menuRect.height <= availableAbove;
        const canFitBelow = menuRect.height <= availableBelow;

        let top;
        if (canFitAbove || (!canFitBelow && availableAbove >= availableBelow)) {
            top = anchorRect.top - menuRect.height - menuGap;
        } else {
            top = anchorRect.bottom + menuGap;
        }

        const minTop = viewportPadding;
        const maxTop = Math.max(viewportPadding, window.innerHeight - menuRect.height - viewportPadding);
        top = Math.max(minTop, Math.min(top, maxTop));

        this.modelMenuElement.style.left = `${Math.round(left)}px`;
        this.modelMenuElement.style.top = `${Math.round(top)}px`;
    }

    openModelMenu(anchorElement) {
        this.closeModelMenu();
        this.modelMenuAnchor = anchorElement;

        const menu = this.buildModelMenuElement();
        if (!menu) return;

        this.modelMenuElement = menu;
        this.setModelMenuExpanded(true);
        document.body.append(menu);
        this.modelMenuElement.scrollTop = this.modelMenuScrollTop;
        this.modelMenuElement.addEventListener('scroll', () => {
            if (this.modelMenuElement) {
                this.modelMenuScrollTop = this.modelMenuElement.scrollTop;
            }
        });
        this.positionModelMenu();

        requestAnimationFrame(() => {
            if (this.modelMenuElement) {
                this.modelMenuElement.classList.add('is-open');
            }
        });

        document.addEventListener('click', this.handleModelMenuOutsideClick);
        document.addEventListener('keydown', this.handleModelMenuEscape);
        window.addEventListener('resize', this.handleModelMenuViewportChange);
        window.addEventListener('scroll', this.handleModelMenuViewportChange, true);
    }

    closeModelMenu() {
        document.removeEventListener('click', this.handleModelMenuOutsideClick);
        document.removeEventListener('keydown', this.handleModelMenuEscape);
        window.removeEventListener('resize', this.handleModelMenuViewportChange);
        window.removeEventListener('scroll', this.handleModelMenuViewportChange, true);
        this.setModelMenuExpanded(false);

        if (this.modelMenuElement) {
            this.modelMenuScrollTop = this.modelMenuElement.scrollTop;
            this.modelMenuElement.remove();
        }
        this.modelMenuElement = null;
        this.modelMenuAnchor = null;
    }

    toggleModelMenu(anchorElement) {
        if (this.modelMenuElement) {
            this.closeModelMenu();
        } else {
            this.openModelMenu(anchorElement);
        }
    }

    handleModelMenuOutsideClick(event) {
        if (!this.modelMenuElement) return;
        const target = event.target;
        if (this.modelMenuElement.contains(target) || this.modelMenuAnchor?.contains(target)) {
            return;
        }
        this.closeModelMenu();
    }

    handleModelMenuEscape(event) {
        if (event.key === 'Escape') {
            this.closeModelMenu();
        }
    }

    handleModelMenuViewportChange() {
        this.positionModelMenu();
    }
    
    updateFooter(footerData) {
        this.hasFooterData = true;
        this.latestFooterData = footerData;
        const shouldPreserveModelMenu = Boolean(this.modelMenuElement);
        if (this.modelMenuElement) {
            this.modelMenuScrollTop = this.modelMenuElement.scrollTop;
        }

        const workingDirectory = footerData.workingDirectory || footerData.targetDir || '';
        const shortPath = shortenPath(workingDirectory, 52);
        const workingDirectoryText = footerData.branchName
            ? `${shortPath} (${footerData.branchName}*)`
            : shortPath;

        const sandboxStatus = footerData.sandboxStatus || 'no sandbox';
        const isSandboxed = Boolean(footerData.isSandboxed);
        const isUntrusted = sandboxStatus === 'untrusted';
        const sandboxValue = isUntrusted
            ? 'Untrusted Workspace'
            : isSandboxed
                ? 'Sandboxed'
                : 'No Sandbox';
        const sandboxTone = isUntrusted ? 'warning' : isSandboxed ? 'good' : 'danger';

        const contextPercentage = Number(footerData.contextPercentage);
        const contextPercentageSafe = Number.isFinite(contextPercentage)
            ? contextPercentage
            : 0;
        const contextDisplay = `${contextPercentageSafe.toFixed(0)}% context left`;

        const modelDisplay = footerData.modelDisplayName || footerData.model || 'unknown';
        const activeModelOption = this.getActiveModelMenuOption();
        const modelText =
            activeModelOption?.label ||
            this.formatModelFooterText(footerData.model, modelDisplay);
        const canSelectModel = this.hasModelMenuOptions();

        const footerNode = document.createElement('div');
        footerNode.className = 'web-footer';
        if (footerData.nightly) {
            footerNode.classList.add('web-footer-nightly');
        }

        const modelPill = this.createFooterPill({
            text: modelText,
            extraClass: `web-footer-pill-model${canSelectModel ? ' web-footer-pill-action' : ''}`,
            title: canSelectModel ? `${modelDisplay} (click to change)` : modelDisplay,
        });
        if (canSelectModel) {
            modelPill.setAttribute('role', 'button');
            modelPill.setAttribute('tabindex', '0');
            modelPill.setAttribute('aria-haspopup', 'menu');
            modelPill.setAttribute(
                'aria-expanded',
                shouldPreserveModelMenu ? 'true' : 'false',
            );

            const modelCaret = document.createElement('span');
            modelCaret.className = 'web-footer-pill-caret';
            modelCaret.textContent = '\u25BE';
            modelPill.append(modelCaret);

            modelPill.addEventListener('click', (event) => {
                event.stopPropagation();
                this.toggleModelMenu(modelPill);
            });
            modelPill.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.toggleModelMenu(modelPill);
                } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.openModelMenu(modelPill);
                }
            });
        }

        footerNode.append(
            modelPill,
            this.createFooterPill({
                text: sandboxValue,
                tone: sandboxTone,
                extraClass: 'web-footer-pill-sandbox',
                title: sandboxStatus,
            }),
            this.createFooterPill({
                text: contextDisplay,
                extraClass: 'web-footer-pill-context',
                title: `${contextPercentageSafe.toFixed(2)}% context left`,
            }),
            this.createFooterPill({
                text: workingDirectoryText,
                tone: 'subtle',
                extraClass: 'web-footer-pill-path',
                title: workingDirectory,
            }),
        );

        if (footerData.debugMode) {
            footerNode.append(this.createFooterPill({
                text: footerData.debugMessage || 'Debug Mode',
                tone: 'warning',
            }));
        }

        if (!footerData.showErrorDetails && footerData.errorCount > 0) {
            footerNode.append(this.createFooterPill({
                text: `${footerData.errorCount} error${footerData.errorCount !== 1 ? 's' : ''}`,
                tone: 'danger',
            }));
        }

        this.inputStatus.classList.add('has-footer-data');
        this.inputStatus.replaceChildren(footerNode);

        if (shouldPreserveModelMenu && canSelectModel) {
            this.modelMenuAnchor = modelPill;
            this.setModelMenuExpanded(true);
            this.positionModelMenu();
        } else if (!canSelectModel) {
            this.closeModelMenu();
        }
    }

    autoResizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
    }
    
    handleConfirmationResponse(callId, outcome, payload) {
        this.wsManager.sendConfirmationResponse(callId, outcome, payload);
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

    // WEB_INTERFACE_START: File browser and editor initialization
    /**
     * Initialize file browser and editor components
     */
    initializeFileBrowser() {
        try {
            // Initialize managers
            this.fileTreeManager = new FileTreeManager(this.wsManager);
            this.editorManager = new EditorManager(this.wsManager);

            // Initialize preview manager with default previews
            this.previewManager = new PreviewManager();
            this.previewManager.registerDefaults(DEFAULT_PREVIEWS);

            // Initialize UI components
            this.fileTreePanel = new FileTreePanel(this.fileTreeManager);
            this.editorPanel = new EditorPanel(this.editorManager, this.previewManager);

            this.editorPanel.on('open-with-system', ({ path }) => {
                if (this.fileTreeManager) {
                    this.fileTreeManager.openWithSystemDefault(path);
                }
            });

            // Set up event handlers
            this.setupFileBrowserHandlers();
            this.setupHeaderPanelToggles();

            // File tree will be requested after WebSocket connects (see 'connected' event handler)

            console.log('File browser initialized successfully');
        } catch (error) {
            console.error('Failed to initialize file browser:', error);
        }
    }

    /**
     * Set up file browser event handlers
     */
    setupFileBrowserHandlers() {
        // File selected in tree -> smart file opening
        this.fileTreePanel.on('file-selected', ({ path }) => {
            this.handleFileOpen(path);
        });

        // Editor events
        // Error handling is done by EditorPanel, no need to duplicate here

        this.editorManager.on('file-saved', ({ path }) => {
            console.log('File saved:', path);
            // Could show a toast notification here
        });
    }

    /**
     * Set up header toggle buttons for panels
     */
    setupHeaderPanelToggles() {
        const toggleFilesButton = document.getElementById('toggle-files-button');
        const toggleEditorButton = document.getElementById('toggle-editor-button');

        // Files toggle button
        if (toggleFilesButton) {
            toggleFilesButton.addEventListener('click', () => {
                this.fileTreePanel.toggleCollapse();
            });

            // Listen to panel collapse events to update button state
            this.fileTreePanel.on('collapse-changed', ({ isCollapsed }) => {
                toggleFilesButton.classList.toggle('active', !isCollapsed);
                toggleFilesButton.title = isCollapsed ? 'Show File Explorer' : 'Hide File Explorer';
            });

            // Set initial state
            toggleFilesButton.classList.toggle('active', !this.fileTreePanel.isCollapsed);
        }

        // Editor toggle button
        if (toggleEditorButton) {
            toggleEditorButton.addEventListener('click', () => {
                if (this.editorPanel.isVisible) {
                    // If visible, toggle between collapsed and expanded
                    if (this.editorPanel.isCollapsed) {
                        this.editorPanel.show();
                    } else {
                        this.editorPanel.hide();
                    }
                } else {
                    // If not visible, show the panel
                    this.editorPanel.show();
                }
            });

            // Listen to panel visibility and collapse events
            this.editorPanel.on('visibility-changed', ({ isVisible }) => {
                const isActive = isVisible && !this.editorPanel.isCollapsed;
                toggleEditorButton.classList.toggle('active', isActive);
                toggleEditorButton.title = isActive ? 'Hide Editor Panel' : 'Show Editor Panel';
            });

            this.editorPanel.on('collapse-changed', ({ isCollapsed }) => {
                const isActive = this.editorPanel.isVisible && !isCollapsed;
                toggleEditorButton.classList.toggle('active', isActive);
                toggleEditorButton.title = isActive ? 'Hide Editor Panel' : 'Show Editor Panel';
            });

            // Set initial state (editor starts hidden)
            toggleEditorButton.classList.toggle('active', false);
        }
    }

    /**
     * Smart file opening - routes binary files to preview, text files to editor
     * @param {string} path - File path to open
     */
    handleFileOpen(path) {
        const filename = path.split('/').pop() || path;
        const language = detectLanguage(filename);

        // Check if file is binary
        if (isBinaryFile(filename)) {
            // Binary file - check if we can preview it
            if (this.previewManager && this.previewManager.canPreview(language, filename)) {
                // Open in preview-only mode
                this.openBinaryFileInPreview(path, language, filename);
            } else {
                // No preview available for this binary file
                this.showBinaryFileError(path, filename);
            }
        } else {
            // Text file - normal flow via WebSocket
            this.editorManager.requestFile(path);
        }
    }

    /**
     * Open binary file in preview-only mode
     * @param {string} path - File path
     * @param {string} language - Monaco language ID
     * @param {string} filename - Filename
     */
    openBinaryFileInPreview(path, language, filename) {
        // Notify EditorPanel to open in preview-only mode
        this.editorPanel.openBinaryPreview(path, language, filename);
    }

    /**
     * Show error message for binary files that can't be previewed
     * @param {string} filename - Filename
     */
    showBinaryFileError(path, filename) {
        if (this.editorPanel) {
            this.editorPanel.openUnsupportedFile(path, filename);
            return;
        }
        showErrorToast(`Cannot open "${filename}". This file type cannot be previewed.`);
    }

    /**
     * Handle message input focus - auto-hide file tree panel
     */
    handleMessageInputFocus() {
        if (this.fileTreePanel && !this.fileTreePanel.isCollapsed) {
            this.fileTreePanel.toggleCollapse();
        }
    }
    // WEB_INTERFACE_END
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const client = new AuditariaWebClient();
    
    // Clean up audio recorder, TTS, and autocomplete on page unload
    window.addEventListener('beforeunload', () => {
        if (client.audioRecorder) {
            client.audioRecorder.cleanup();
        }
        // Stop any ongoing TTS
        ttsManager.stop();
        // Clean up autocomplete
        if (client.slashAutocomplete) {
            client.slashAutocomplete.destroy();
        }
    });
});
