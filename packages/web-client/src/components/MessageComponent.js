/**
 * Message rendering component
 */

import { processMarkdown } from '../utils/markdown.js';
import { createCopyButtons } from '../utils/clipboard.js';
import { renderToolGroup, renderAboutInfo } from './ToolRenderer.js';
import { audioPlayerModal } from './AudioPlayerModal.js';
import { attachmentCacheManager } from '../managers/AttachmentCacheManager.js';

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
    
    const container = document.createElement('div');
    
    // Add attachments if present
    if (historyItem.attachments && historyItem.attachments.length > 0) {
        const attachmentsEl = renderAttachments(historyItem.attachments);
        if (attachmentsEl) {
            container.appendChild(attachmentsEl);
        }
    }
    
    // Add other special content
    let specialContent = null;
    switch (historyItem.type) {
        case 'tool_group':
            specialContent = renderToolGroup(historyItem.tools || []);
            break;
        case 'about':
            specialContent = renderAboutInfo(historyItem);
            break;
    }
    
    if (specialContent) {
        container.appendChild(specialContent);
    }
    
    return container.children.length > 0 ? container : null;
}

/**
 * Render attachments in a message
 */
function renderAttachments(attachments) {
    if (!attachments || attachments.length === 0) return null;
    
    // Rehydrate attachments with cached data
    const rehydratedAttachments = attachmentCacheManager.rehydrateAttachments(attachments);
    
    const attachmentsEl = document.createElement('div');
    attachmentsEl.className = 'message-attachments';
    
    rehydratedAttachments.forEach(attachment => {
        const attachmentEl = document.createElement('div');
        attachmentEl.className = 'message-attachment';
        attachmentEl.title = attachment.name;
        
        // Check if it's an audio file
        const isAudio = attachment.type === 'audio' || 
                       (attachment.mimeType && attachment.mimeType.startsWith('audio/')) ||
                       attachment.icon === '🎙️' || attachment.icon === '🎵';
        
        if (isAudio) {
            attachmentEl.classList.add('audio-attachment');
        }
        
        // Thumbnail or icon
        if (attachment.thumbnail) {
            const img = document.createElement('img');
            img.src = attachment.thumbnail;
            img.className = 'message-attachment-thumbnail';
            img.alt = attachment.name;
            
            // Click to view full size for images
            if (attachment.type === 'image') {
                attachmentEl.style.cursor = 'pointer';
                attachmentEl.onclick = () => {
                    showImageModal(attachment);
                };
            }
            
            attachmentEl.appendChild(img);
        } else {
            const icon = document.createElement('div');
            icon.className = 'message-attachment-icon';
            icon.textContent = attachment.icon || '📎';
            attachmentEl.appendChild(icon);
        }
        
        // Add click handler for audio files
        if (isAudio) {
            attachmentEl.style.cursor = 'pointer';
            attachmentEl.onclick = () => {
                if (audioPlayerModal) {
                    audioPlayerModal.open(attachment);
                }
            };
        }
        
        // Info
        const info = document.createElement('div');
        info.className = 'message-attachment-info';
        
        const name = document.createElement('div');
        name.className = 'message-attachment-name';
        name.textContent = attachment.name;
        
        const size = document.createElement('div');
        size.className = 'message-attachment-size';
        size.textContent = attachment.displaySize || formatFileSize(attachment.size);
        
        info.appendChild(name);
        info.appendChild(size);
        attachmentEl.appendChild(info);
        
        attachmentsEl.appendChild(attachmentEl);
    });
    
    return attachmentsEl;
}

/**
 * Show image in modal
 */
function showImageModal(attachment) {
    const modal = document.getElementById('image-modal');
    const modalContent = document.getElementById('image-modal-content');
    
    if (modal && modalContent) {
        // For base64 images, construct data URL
        const dataUrl = attachment.data ? 
            `data:${attachment.mimeType};base64,${attachment.data}` : 
            attachment.thumbnail;
            
        modalContent.src = dataUrl;
        modalContent.alt = attachment.name;
        modal.style.display = 'block';
    }
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
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