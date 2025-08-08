/**
 * Message rendering component
 */

import { processMarkdown } from '../utils/markdown.js';
import { createCopyButtons } from '../utils/clipboard.js';
import { renderToolGroup, renderAboutInfo } from './ToolRenderer.js';

/**
 * Create a chat message element
 */
export function createChatMessage(type, label, content, historyItem = null) {
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
        textSpan.innerHTML = processMarkdown(content);
    } else {
        textSpan.textContent = content;
    }
    
    contentEl.appendChild(textSpan);
    
    const timestampEl = document.createElement('div');
    timestampEl.className = 'message-timestamp';
    timestampEl.textContent = timestamp;
    
    bubbleEl.appendChild(contentEl);
    
    // Add special content for specific message types
    const specialContent = renderSpecialContent(historyItem);
    if (specialContent) {
        bubbleEl.appendChild(specialContent);
    }
    
    bubbleEl.appendChild(timestampEl);
    
    messageEl.appendChild(headerEl);
    messageEl.appendChild(bubbleEl);
    
    return messageEl;
}

/**
 * Create a chat message with copy buttons
 */
export function createChatMessageWithCopy(type, label, content, historyItem, copyHandler) {
    const messageEl = createChatMessage(type, label, content, historyItem);
    
    // Add copy buttons for messages that contain content
    if (content && content.trim()) {
        const copyButtonsEl = createCopyButtons(content, type, copyHandler);
        messageEl.appendChild(copyButtonsEl);
    }
    
    return messageEl;
}

/**
 * Render special content based on message type
 */
function renderSpecialContent(historyItem) {
    if (!historyItem) return null;
    
    switch (historyItem.type) {
        case 'tool_group':
            return renderToolGroup(historyItem.tools || []);
        case 'about':
            return renderAboutInfo(historyItem);
        default:
            return null;
    }
}

/**
 * Update an existing message element with new content
 */
export function updateMessageContent(messageEl, content, type) {
    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;
    
    const textSpan = contentEl.querySelector('span');
    if (!textSpan) return;
    
    // Use markdown processing for AI messages only
    if (type === 'gemini' || type === 'gemini_content') {
        textSpan.innerHTML = processMarkdown(content);
    } else {
        textSpan.textContent = content;
    }
}

/**
 * Update message timestamp
 */
export function updateMessageTimestamp(messageEl) {
    const timestampEl = messageEl.querySelector('.message-timestamp');
    if (timestampEl) {
        const timestamp = new Date().toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        timestampEl.textContent = timestamp;
    }
}

/**
 * Add special content to a message bubble
 */
export function addSpecialContentToMessage(messageEl, historyItem, preserveExisting = false) {
    const bubbleEl = messageEl.querySelector('.message-bubble');
    if (!bubbleEl) return;
    
    // Remove existing special content unless preserving
    if (!preserveExisting) {
        const existingSpecial = bubbleEl.querySelector('.tool-list, .about-info');
        if (existingSpecial) {
            existingSpecial.remove();
        }
    }
    
    // Add new special content
    const specialContent = renderSpecialContent(historyItem);
    if (specialContent) {
        const timestampEl = bubbleEl.querySelector('.message-timestamp');
        if (timestampEl) {
            bubbleEl.insertBefore(specialContent, timestampEl);
        } else {
            bubbleEl.appendChild(specialContent);
        }
    }
}