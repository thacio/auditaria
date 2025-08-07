/**
 * Message management and rendering
 */

import { createChatMessageWithCopy, createChatMessage, updateMessageContent, updateMessageTimestamp, addSpecialContentToMessage } from '../components/MessageComponent.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { processMarkdown } from '../utils/markdown.js';
import { getMessageTypeLabel, getMessageContent, isAIMessage } from '../utils/formatters.js';

export class MessageManager {
    constructor() {
        this.messagesContainer = document.getElementById('messages');
        this.messageCount = 0;
        this.autoScrollEnabled = true;
        
        // Message merging properties
        this.lastAIMessage = null;
        this.mergeTimeframe = 10000; // 10 seconds in milliseconds
        
        // Track tool groups and their individual tools by callId
        this.pendingToolGroups = new Map(); // Map<messageId, { element, tools: Map<callId, toolData> }>
        this.completedToolCallIds = new Set(); // Track completed tools to ignore stale updates
        
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
     * Add a history item message
     */
    addHistoryItem(historyItem) {
        // Log tool groups for debugging
        if (historyItem.type === 'tool_group') {
            console.log('[MessageManager] Received history tool group:', {
                toolCount: historyItem.tools?.length,
                callIds: historyItem.tools?.map(t => t.callId),
                statuses: historyItem.tools?.map(t => t.status)
            });
        }
        
        // Check if this is converting a pending message to final
        if (historyItem.type === 'gemini' || historyItem.type === 'gemini_content') {
            const pendingTextEl = this.messagesContainer.querySelector('.message-pending-text');
            if (pendingTextEl) {
                if (isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
                    pendingTextEl.remove();
                    if (this.mergeWithLastAIMessage(historyItem)) {
                        return;
                    }
                }
                
                // Convert pending text message to final message
                this.convertPendingToFinal(pendingTextEl, historyItem);
                return;
            }
        } else if (historyItem.type === 'tool_group') {
            // Mark all tools in this group as completed
            if (historyItem.tools) {
                historyItem.tools.forEach(tool => {
                    if (tool.callId && (tool.status === 'Success' || tool.status === 'Error' || tool.status === 'Canceled')) {
                        this.completedToolCallIds.add(tool.callId);
                    }
                });
            }
            
            // Check if we have any pending tool groups that match these tools
            const matchingGroup = this.findMatchingPendingToolGroup(historyItem.tools);
            if (matchingGroup) {
                // Update the existing pending group with final status
                this.updatePendingToolGroupToFinal(matchingGroup, historyItem);
                return;
            }
        }
        
        // Check if this AI message can be merged with the last AI message
        if (isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
            if (this.mergeWithLastAIMessage(historyItem)) {
                return;
            }
        }
        
        // Regular new message (no pending version exists)
        const messageEl = this.createMessageWithCopy(historyItem);
        
        this.messagesContainer.appendChild(messageEl);
        this.messageCount++;
        this.updateMessageCount();
        this.scrollToBottom();
        
        // Track this message if it's an AI message for potential future merging
        if (isAIMessage(historyItem)) {
            this.lastAIMessage = {
                element: messageEl,
                text: getMessageContent(historyItem),
                timestamp: Date.now(),
                type: historyItem.type
            };
        } else {
            // Clear AI message tracking if this is not an AI message
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
    
    /**
     * Convert pending text message to final
     */
    convertPendingToFinal(pendingTextEl, historyItem) {
        pendingTextEl.classList.remove('message-pending-text');
        
        updateMessageContent(pendingTextEl, getMessageContent(historyItem), historyItem.type);
        updateMessageTimestamp(pendingTextEl);
        
        // Track this converted AI message for potential future merging
        this.lastAIMessage = {
            element: pendingTextEl,
            text: getMessageContent(historyItem),
            timestamp: Date.now(),
            type: historyItem.type
        };
        
        this.messageCount++;
        this.updateMessageCount();
        this.scrollToBottom();
    }
    
    /**
     * Find matching pending tool group based on callIds
     */
    findMatchingPendingToolGroup(tools) {
        if (!tools || tools.length === 0) return null;
        
        // Find the best matching group - the one with the most matching callIds
        let bestMatch = null;
        let maxMatches = 0;
        
        for (const [messageId, groupData] of this.pendingToolGroups) {
            let matchCount = 0;
            for (const tool of tools) {
                if (tool.callId && groupData.tools.has(tool.callId)) {
                    matchCount++;
                }
            }
            
            if (matchCount > maxMatches) {
                maxMatches = matchCount;
                bestMatch = { messageId, groupData, matchCount };
            }
        }
        
        // Only return a match if we have at least one matching tool
        return maxMatches > 0 ? bestMatch : null;
    }
    
    /**
     * Update pending tool group to final status
     */
    updatePendingToolGroupToFinal(matchingGroup, historyItem) {
        const { messageId, groupData } = matchingGroup;
        const { element } = groupData;
        
        // Always convert to final when we get a history item
        // The history item represents the final state of these tools
        element.classList.remove('message-pending-tools');
        
        // Update with final tool content
        addSpecialContentToMessage(element, historyItem);
        updateMessageTimestamp(element);
        
        // Clean up tracking for this group
        this.pendingToolGroups.delete(messageId);
        
        // Also clean up any other pending groups that contain these tools
        // This handles the case where duplicate pending updates were created
        const completedCallIds = new Set(historyItem.tools?.map(t => t.callId) || []);
        const groupsToDelete = [];
        
        for (const [otherMessageId, otherGroupData] of this.pendingToolGroups) {
            // Check if this group contains any of the completed tools
            let hasCompletedTool = false;
            for (const callId of completedCallIds) {
                if (callId && otherGroupData.tools.has(callId)) {
                    hasCompletedTool = true;
                    break;
                }
            }
            
            if (hasCompletedTool) {
                console.log('[MessageManager] Removing duplicate pending group:', otherMessageId);
                // Remove the duplicate pending element
                if (otherGroupData.element && otherGroupData.element.parentNode) {
                    otherGroupData.element.remove();
                }
                groupsToDelete.push(otherMessageId);
            }
        }
        
        // Delete the duplicate groups
        groupsToDelete.forEach(id => this.pendingToolGroups.delete(id));
        
        this.messageCount++;
        this.updateMessageCount();
        this.scrollToBottom();
    }
    
    /**
     * Update pending item
     */
    updatePendingItem(pendingItem) {
        if (!pendingItem) {
            this.clearAllPendingToolGroups();
            this.clearPendingTextMessage();
            return;
        }
        
        if (pendingItem.type === 'tool_group') {
            console.log('[MessageManager] Updating pending tool group:', {
                toolCount: pendingItem.tools?.length,
                callIds: pendingItem.tools?.map(t => t.callId),
                statuses: pendingItem.tools?.map(t => t.status)
            });
            this.updatePendingToolGroup(pendingItem);
        } else {
            this.updatePendingTextMessage(pendingItem);
        }
    }
    
    /**
     * Update pending text message
     */
    updatePendingTextMessage(pendingItem) {
        let pendingMessageEl = this.messagesContainer.querySelector('.message-pending-text');
        
        if (!pendingMessageEl) {
            // Create new pending message element
            pendingMessageEl = this.createMessageWithCopy(pendingItem);
            pendingMessageEl.classList.add('message-pending-text');
            this.messagesContainer.appendChild(pendingMessageEl);
        } else {
            // Update existing pending message content
            updateMessageContent(pendingMessageEl, getMessageContent(pendingItem), pendingItem.type);
            updateMessageTimestamp(pendingMessageEl);
        }
        
        this.scrollToBottom();
    }
    
    /**
     * Update pending tool group
     */
    updatePendingToolGroup(pendingItem) {
        // Filter out any tools that are already completed
        if (pendingItem.tools) {
            pendingItem.tools = pendingItem.tools.filter(tool => {
                if (tool.callId && this.completedToolCallIds.has(tool.callId)) {
                    console.log('[MessageManager] Ignoring completed tool in pending update:', tool.callId);
                    return false;
                }
                return true;
            });
            
            // If all tools were filtered out, ignore this update
            if (pendingItem.tools.length === 0) {
                console.log('[MessageManager] All tools in pending update are already completed, ignoring');
                return;
            }
        }
        
        // For pending tools, we need to find or create a group that matches
        // We'll look for an existing pending group that has overlapping tools
        let matchingGroup = null;
        
        // First check if any of the tools are already being tracked
        if (pendingItem.tools && pendingItem.tools.length > 0) {
            for (const [msgId, groupData] of this.pendingToolGroups) {
                for (const tool of pendingItem.tools) {
                    if (tool.callId && groupData.tools.has(tool.callId)) {
                        matchingGroup = { messageId: msgId, groupData };
                        break;
                    }
                }
                if (matchingGroup) break;
            }
        }
        
        if (!matchingGroup) {
            // Create new pending tool group element
            const messageId = `tool-group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const pendingToolEl = this.createMessageWithCopy(pendingItem);
            pendingToolEl.classList.add('message-pending-tools');
            pendingToolEl.setAttribute('data-tool-group-id', messageId);
            this.messagesContainer.appendChild(pendingToolEl);
            
            // Track this tool group and its tools
            const toolsMap = new Map();
            if (pendingItem.tools) {
                pendingItem.tools.forEach(tool => {
                    if (tool.callId) {
                        toolsMap.set(tool.callId, tool);
                    }
                });
            }
            
            this.pendingToolGroups.set(messageId, {
                element: pendingToolEl,
                tools: toolsMap,
                timestamp: Date.now()
            });
        } else {
            // Update existing tool group - merge tool updates
            const { messageId, groupData } = matchingGroup;
            
            if (pendingItem.tools) {
                // Update or add tools, but skip completed ones
                pendingItem.tools.forEach(tool => {
                    if (tool.callId && !this.completedToolCallIds.has(tool.callId)) {
                        groupData.tools.set(tool.callId, tool);
                    }
                });
            }
            
            // Update the display with all tools in the group
            const mergedItem = {
                ...pendingItem,
                tools: Array.from(groupData.tools.values())
            };
            addSpecialContentToMessage(groupData.element, mergedItem);
            updateMessageTimestamp(groupData.element);
        }
        
        this.scrollToBottom();
    }
    
    
    /**
     * Clear all pending tool groups
     */
    clearAllPendingToolGroups() {
        // Remove all pending tool elements from DOM
        this.messagesContainer.querySelectorAll('.message-pending-tools').forEach(el => {
            el.remove();
        });
        // Clear the tracking map
        this.pendingToolGroups.clear();
    }
    
    /**
     * Clear pending text message
     */
    clearPendingTextMessage() {
        const pendingTextEl = this.messagesContainer.querySelector('.message-pending-text');
        if (pendingTextEl) {
            pendingTextEl.remove();
        }
    }
    
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
        
        // Get the existing message content
        const contentEl = this.lastAIMessage.element.querySelector('.message-content span');
        if (!contentEl) {
            return false;
        }
        
        // Get current and new content
        const existingContent = this.lastAIMessage.text || '';
        const newContent = getMessageContent(historyItem);
        
        // Combine content with double line break for separation
        const combinedContent = existingContent + '\n\n' + newContent;
        
        // Update the DOM with combined content (apply markdown processing)
        contentEl.innerHTML = processMarkdown(combinedContent);
        
        // Update timestamp
        updateMessageTimestamp(this.lastAIMessage.element);
        
        // Update the lastAIMessage tracking
        this.lastAIMessage.text = combinedContent;
        this.lastAIMessage.timestamp = Date.now();
        
        // Scroll to bottom after merging
        this.scrollToBottom();
        
        return true;
    }
    
    /**
     * Load history items
     */
    loadHistoryItems(historyItems) {
        // Clear welcome message and any pending items when loading history
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null;
        this.pendingToolGroups.clear();
        this.completedToolCallIds.clear();
        
        // Load all historical messages with merging logic
        historyItems.forEach(historyItem => {
            // Check if this AI message can be merged with the last AI message
            if (isAIMessage(historyItem) && this.canMergeWithLast(historyItem)) {
                if (this.mergeWithLastAIMessage(historyItem)) {
                    return;
                }
            }
            
            // Create regular message
            const messageEl = this.createMessageWithCopy(historyItem);
            
            this.messagesContainer.appendChild(messageEl);
            this.messageCount++;
            
            // Track this message if it's an AI message for potential future merging
            if (isAIMessage(historyItem)) {
                this.lastAIMessage = {
                    element: messageEl,
                    text: getMessageContent(historyItem),
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
    
    /**
     * Clear all messages
     */
    clearAllMessages() {
        this.messagesContainer.innerHTML = '';
        this.messageCount = 0;
        this.lastAIMessage = null;
        this.pendingToolGroups.clear();
        this.completedToolCallIds.clear();
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