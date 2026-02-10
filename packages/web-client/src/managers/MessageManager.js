/**
 * Message management and rendering
 */

import { createChatMessageWithCopy, createChatMessage, updateMessageContent, updateMessageTimestamp } from '../components/MessageComponent.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { processMarkdown } from '../utils/markdown.js';
import { getMessageTypeLabel, getMessageContent, isAIMessage } from '../utils/formatters.js';
import { renderToolGroup } from '../components/ToolRenderer.js';

export class MessageManager {
    constructor() {
        this.messagesContainer = document.getElementById('messages');
        this.messageCount = 0;
        this.autoScrollEnabled = true;

        // Merge tracking — only used by loadHistoryItems() for page reload
        this.lastAIMessage = null;
        this.mergeTimeframe = 10000;

        // Response state tracking for smart DOM updates
        this._previousBlocks = null;

        // Clear welcome message initially
        this.messagesContainer.innerHTML = '';
    }

    /**
     * Add a welcome message
     */
    addWelcomeMessage(text) {
        const messageEl = createChatMessage('info', 'CONNECTION', text);
        this.messagesContainer.appendChild(messageEl);
        this.scrollToBottom();
    }

    /**
     * Add a system message
     */
    addSystemMessage(text) {
        const messageEl = createChatMessage('info', 'SYSTEM', text);
        this.messagesContainer.appendChild(messageEl);
        this.scrollToBottom();
    }

    /**
     * Add a finalized history item message.
     * Inserts before the response-active container so finalized items always appear
     * above the active streaming area.
     */
    addHistoryItem(historyItem) {
        // Merge consecutive AI text messages (CLI splits long text for terminal performance)
        if (isAIMessage(historyItem) && this.lastAIMessage?.element) {
            if (this.mergeWithLastAIMessage(historyItem)) {
                return;
            }
        }

        const messageEl = this.createMessageWithCopy(historyItem);

        // Insert before the active response container if it exists
        const responseContainer = this.messagesContainer.querySelector('.response-active');
        if (responseContainer) {
            this.messagesContainer.insertBefore(messageEl, responseContainer);
        } else {
            this.messagesContainer.appendChild(messageEl);
        }

        this.messageCount++;
        this.updateMessageCount();
        this.scrollToBottom();

        // Track AI messages for merging consecutive splits
        if (isAIMessage(historyItem)) {
            this.lastAIMessage = {
                element: messageEl,
                text: getMessageContent(historyItem),
                timestamp: Date.now(),
                type: historyItem.type
            };
        } else {
            // Non-AI message breaks the merge chain
            this.lastAIMessage = null;
        }
    }

    /**
     * Create a message element with copy functionality
     */
    createMessageWithCopy(historyItem) {
        const type = historyItem.type;
        const label = getMessageTypeLabel(type);
        const content = getMessageContent(historyItem);

        const copyHandler = (content, format, button) => {
            copyToClipboard(content, format, button, { lastAIMessage: this.lastAIMessage });
        };

        return createChatMessageWithCopy(type, label, content, historyItem, copyHandler);
    }

    // ---- Unified response state rendering ----

    /**
     * Render unified response state from CLI.
     * Replaces all pending item management with a single ordered block array.
     * @param {Array|null} blocks - Ordered array of {type:'text',text} or {type:'tool_group',tools} blocks, or null to clear
     */
    renderResponseState(blocks) {
        // null/empty -> clear the response container
        if (!blocks || blocks.length === 0) {
            const existing = this.messagesContainer.querySelector('.response-active');
            if (existing) {
                existing.remove();
            }
            this._previousBlocks = null;
            return;
        }

        // Find or create response container
        let container = this.messagesContainer.querySelector('.response-active');
        if (!container) {
            container = document.createElement('div');
            container.className = 'response-active';
            this.messagesContainer.appendChild(container);
        }

        // Smart update: compare with previous blocks to minimize DOM churn
        const prevBlocks = this._previousBlocks || [];
        const needsFullRebuild = prevBlocks.length !== blocks.length ||
            blocks.some((block, i) => prevBlocks[i]?.type !== block.type);

        if (needsFullRebuild) {
            // Different block structure — rebuild container
            container.innerHTML = '';
            blocks.forEach((block, index) => {
                const blockEl = this._createBlockElement(block);
                blockEl.setAttribute('data-block-index', String(index));
                container.appendChild(blockEl);
            });
        } else {
            // Same structure — update in place
            blocks.forEach((block, index) => {
                const existingBlockEl = container.querySelector(`[data-block-index="${index}"]`);
                if (existingBlockEl) {
                    this._updateBlockElement(existingBlockEl, block);
                }
            });
        }

        this._previousBlocks = blocks.map(b => ({ ...b }));
        this.scrollToBottom();
    }

    /**
     * Create a DOM element for a single response block
     */
    _createBlockElement(block) {
        const blockEl = document.createElement('div');

        if (block.type === 'text') {
            blockEl.className = 'response-block response-block-text';
            const contentEl = document.createElement('div');
            contentEl.className = 'response-block-content';
            const textSpan = document.createElement('span');
            textSpan.innerHTML = processMarkdown(block.text);
            contentEl.appendChild(textSpan);
            blockEl.appendChild(contentEl);
        } else if (block.type === 'tool_group') {
            blockEl.className = 'response-block response-block-tools';
            const toolListEl = renderToolGroup(block.tools);
            blockEl.appendChild(toolListEl);
        }

        return blockEl;
    }

    /**
     * Update an existing block element in place to avoid flicker
     */
    _updateBlockElement(existingBlockEl, block) {
        if (block.type === 'text') {
            const textSpan = existingBlockEl.querySelector('.response-block-content span');
            if (textSpan) {
                textSpan.innerHTML = processMarkdown(block.text);
            }
        } else if (block.type === 'tool_group') {
            // Capture expand/collapse state by callId before rebuild
            const expandState = new Map();
            existingBlockEl.querySelectorAll('.tool-item').forEach(item => {
                const callId = item.getAttribute('data-call-id');
                if (callId) {
                    expandState.set(callId, item.classList.contains('tool-item-expanded'));
                }
            });

            // Rebuild tool list
            const existingToolList = existingBlockEl.querySelector('.tool-list');
            if (existingToolList) existingToolList.remove();
            const newToolList = renderToolGroup(block.tools);
            existingBlockEl.appendChild(newToolList);

            // Restore expand/collapse state
            newToolList.querySelectorAll('.tool-item').forEach(item => {
                const callId = item.getAttribute('data-call-id');
                if (callId && expandState.has(callId)) {
                    if (!expandState.get(callId)) {
                        item.classList.remove('tool-item-expanded');
                        item.classList.add('tool-item-collapsed');
                    }
                }
            });
        }
    }

    // ---- Merge logic (only used by loadHistoryItems for page reload) ----

    /**
     * Check if current message can be merged with the last AI message
     */
    canMergeWithLast(historyItem) {
        if (!this.lastAIMessage || !isAIMessage(historyItem)) {
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

        const contentEl = this.lastAIMessage.element.querySelector('.message-content span');
        if (!contentEl) {
            return false;
        }

        const existingContent = this.lastAIMessage.text || '';
        const newContent = getMessageContent(historyItem);
        const combinedContent = existingContent + '\n\n' + newContent;

        contentEl.innerHTML = processMarkdown(combinedContent);
        updateMessageTimestamp(this.lastAIMessage.element);

        // Update TTS button with combined content
        const ttsContainer = this.lastAIMessage.element.querySelector('.tts-button-container');
        if (ttsContainer && ttsContainer.ttsButtonInstance) {
            ttsContainer.ttsButtonInstance.updateText(combinedContent);
        }

        // Update copy buttons
        const copyButtons = this.lastAIMessage.element.querySelectorAll('.copy-button');
        copyButtons.forEach(button => {
            if (button.classList.contains('copy-markdown')) {
                button.onclick = (e) => {
                    e.stopPropagation();
                    copyToClipboard(combinedContent, 'markdown', button, { lastAIMessage: this.lastAIMessage });
                };
            } else if (button.classList.contains('copy-formatted')) {
                button.onclick = (e) => {
                    e.stopPropagation();
                    copyToClipboard(combinedContent, 'formatted', button, { lastAIMessage: this.lastAIMessage });
                };
            }
        });

        this.lastAIMessage.text = combinedContent;
        this.lastAIMessage.timestamp = Date.now();

        this.scrollToBottom();
        return true;
    }

    /**
     * Load history items (page reload / reconnect).
     * Merges consecutive AI messages for clean display.
     */
    loadHistoryItems(historyItems) {
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null;
        this._previousBlocks = null;

        historyItems.forEach(historyItem => {
            // Merge consecutive AI messages for cleaner display
            if (isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
                if (this.mergeWithLastAIMessage(historyItem)) {
                    return;
                }
            }

            const messageEl = this.createMessageWithCopy(historyItem);

            this.messagesContainer.appendChild(messageEl);
            this.messageCount++;

            if (isAIMessage(historyItem)) {
                this.lastAIMessage = {
                    element: messageEl,
                    text: getMessageContent(historyItem),
                    timestamp: Date.now(),
                    type: historyItem.type
                };
            } else {
                this.lastAIMessage = null;
            }
        });

        this.updateMessageCount();
        this.scrollToBottom();
    }

    /**
     * Clear all messages
     */
    clearAllMessages() {
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null;
        this._previousBlocks = null;
        this.updateMessageCount();
    }

    /**
     * Update message count display
     */
    updateMessageCount() {
        const messageCountElement = document.getElementById('message-count');
        if (messageCountElement) {
            const plural = this.messageCount !== 1 ? 's' : '';
            messageCountElement.textContent = `${this.messageCount} message${plural}`;
        }
    }

    /**
     * Scroll to bottom of messages
     */
    scrollToBottom() {
        if (this.autoScrollEnabled) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }

    /**
     * Toggle auto-scroll functionality
     */
    toggleAutoScroll() {
        this.autoScrollEnabled = !this.autoScrollEnabled;

        const autoscrollButton = document.getElementById('autoscroll-button');
        if (autoscrollButton) {
            if (this.autoScrollEnabled) {
                autoscrollButton.classList.add('active');
                autoscrollButton.title = 'Auto-scroll: On';
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            } else {
                autoscrollButton.classList.remove('active');
                autoscrollButton.title = 'Auto-scroll: Off';
            }
        }
    }

    /**
     * Get message count
     */
    getMessageCount() {
        return this.messageCount;
    }
}
