/**
 * Clipboard utilities for copying text content
 */

import { convertHtmlToFormattedText, convertHtmlToMarkdown } from './markdown.js';

/**
 * Copy content to clipboard with visual feedback
 * @param {string} content - The content to copy
 * @param {string} format - 'markdown' or 'formatted'
 * @param {HTMLElement} button - The button element for feedback
 * @param {object} context - Additional context for copying
 */
export async function copyToClipboard(content, format, button, context = {}) {
    try {
        let textToCopy = content;
        
        // Get the complete message content (handling merged messages)
        const messageEl = button.closest('.message');
        const contentSpan = messageEl?.querySelector('.message-content span');
        const messageType = button.closest('.copy-buttons-container')?.getAttribute('data-message-type');
        
        if (format === 'markdown') {
            // For markdown copy, we need to reconstruct the original markdown
            if ((messageType === 'gemini' || messageType === 'gemini_content') && 
                context.lastAIMessage && context.lastAIMessage.element === messageEl && 
                context.lastAIMessage.text) {
                textToCopy = context.lastAIMessage.text;
            } else {
                // For other cases, reverse-engineer from the HTML
                textToCopy = convertHtmlToMarkdown(contentSpan ? contentSpan.innerHTML : content);
            }
        } else if (format === 'formatted') {
            // For formatted text, convert HTML to properly formatted plain text
            if (contentSpan && contentSpan.innerHTML !== contentSpan.textContent) {
                textToCopy = convertHtmlToFormattedText(contentSpan.innerHTML);
            } else {
                textToCopy = contentSpan ? contentSpan.textContent : content;
            }
        }
        
        // Use the modern Clipboard API if available
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(textToCopy);
        } else {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = textToCopy;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            textArea.remove();
        }
        
        // Visual feedback
        showCopyFeedback(button, true);
        
    } catch (error) {
        console.error('Failed to copy text:', error);
        showCopyFeedback(button, false);
    }
}

/**
 * Show visual feedback for copy operation
 * @param {HTMLElement} button - The button element
 * @param {boolean} success - Whether the copy was successful
 */
export function showCopyFeedback(button, success) {
    const originalTitle = button.title;
    const label = button.querySelector('.copy-label');
    const originalText = label?.textContent;
    
    // Update button appearance
    button.classList.add(success ? 'copy-success' : 'copy-error');
    button.title = success ? 'Copied!' : 'Copy failed';
    if (label) {
        label.textContent = success ? 'Copied!' : 'Failed';
    }
    
    // Reset after delay
    setTimeout(() => {
        button.classList.remove('copy-success', 'copy-error');
        button.title = originalTitle;
        if (label) {
            label.textContent = originalText;
        }
    }, 2000);
}

/**
 * Create copy buttons for a message
 * @param {string} content - The message content
 * @param {string} type - The message type
 * @param {function} copyHandler - The copy handler function
 * @returns {HTMLElement} The copy buttons container
 */
export function createCopyButtons(content, type, copyHandler) {
    const copyContainer = document.createElement('div');
    copyContainer.className = 'copy-buttons-container';
    
    const copyButtonsEl = document.createElement('div');
    copyButtonsEl.className = 'copy-buttons';
    
    // Store message type for copy functionality
    copyContainer.setAttribute('data-message-type', type);
    
    // Create markdown copy button
    const markdownBtn = document.createElement('button');
    markdownBtn.className = 'copy-button copy-markdown';
    markdownBtn.title = 'Copy as Markdown';
    markdownBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <path d="m9 9 5 12 4-12"></path>
        </svg>
        <span class="copy-label">Markdown</span>
    `;
    
    // Create formatted text copy button
    const formattedBtn = document.createElement('button');
    formattedBtn.className = 'copy-button copy-formatted';
    formattedBtn.title = 'Copy as Plain Text';
    formattedBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14,2 14,8 20,8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10,9 9,9 8,9"></polyline>
        </svg>
        <span class="copy-label">Text</span>
    `;
    
    // Add click handlers
    markdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyHandler(content, 'markdown', markdownBtn);
    });
    
    formattedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyHandler(content, 'formatted', formattedBtn);
    });
    
    copyButtonsEl.appendChild(markdownBtn);
    copyButtonsEl.appendChild(formattedBtn);
    copyContainer.appendChild(copyButtonsEl);
    
    return copyContainer;
}