/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message management and rendering
 */

import {
  createChatMessageWithCopy,
  createChatMessage,
  updateMessageTimestamp,
} from '../components/MessageComponent.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { processMarkdown } from '../utils/markdown.js';
import {
  getMessageTypeLabel,
  getMessageContent,
  isAIMessage,
} from '../utils/formatters.js';
import {
  renderToolGroup,
  updateToolGroup,
  restoreToolGroupState,
} from '../components/ToolRenderer.js';

export class MessageManager {
  constructor() {
    this.messagesContainer = document.getElementById('messages');
    this.messageCount = 0;
    this.autoScrollEnabled = true;
    this._followingLatest = true;
    this.messagesContainer.addEventListener(
      'scroll',
      () => {
        const { scrollHeight, scrollTop, clientHeight } =
          this.messagesContainer;
        this._followingLatest = scrollHeight - scrollTop - clientHeight < 80;
      },
      { passive: true },
    );

    // Merge tracking — only used by loadHistoryItems() for page reload
    this.lastAIMessage = null;
    this.mergeTimeframe = 10000;

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
    if (historyItem.type === 'user') this._followingLatest = true;
    const responseContainer =
      this.messagesContainer.querySelector('.response-active');
    const previousMessage =
      responseContainer?.previousElementSibling ||
      this.messagesContainer.lastElementChild;
    if (
      this.mergeWithPreviousActivity(
        historyItem,
        previousMessage,
        responseContainer,
      )
    ) {
      return;
    }
    // Merge consecutive AI text messages (CLI splits long text for terminal performance)
    if (isAIMessage(historyItem) && this.lastAIMessage?.element) {
      if (this.mergeWithLastAIMessage(historyItem)) {
        return;
      }
    }

    const messageEl = this.createMessageWithCopy(historyItem);

    // Insert before the active response container if it exists
    if (responseContainer) {
      restoreToolGroupState(responseContainer, messageEl);
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
        type: historyItem.type,
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
      copyToClipboard(content, format, button, {
        lastAIMessage: this.lastAIMessage,
      });
    };

    const messageEl = createChatMessageWithCopy(
      type,
      label,
      content,
      historyItem,
      copyHandler,
    );
    if (type === 'tool_group')
      messageEl._historyTools = [...(historyItem.tools || [])];
    return messageEl;
  }

  /** Coalesce adjacent batches without losing call details or inspection state. */
  mergeWithPreviousActivity(
    historyItem,
    previousMessage,
    responseContainer = null,
  ) {
    if (
      historyItem.type !== 'tool_group' ||
      !previousMessage?.classList.contains('message-tool_group')
    ) {
      return false;
    }
    previousMessage._historyTools.push(...(historyItem.tools || []));
    updateToolGroup(
      previousMessage.querySelector('.tool-list'),
      previousMessage._historyTools,
    );
    restoreToolGroupState(responseContainer, previousMessage);
    this.lastAIMessage = null;
    this.scrollToBottom();
    return true;
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
      return;
    }

    // Tool batches are a single activity until visible text separates them.
    const groupedBlocks = [];
    for (const block of blocks) {
      if (block.type === 'text' && !block.text?.trim()) continue;
      const previous = groupedBlocks.at(-1);
      if (block.type === 'tool_group' && previous?.type === 'tool_group') {
        previous.tools.push(...block.tools);
      } else {
        groupedBlocks.push(
          block.type === 'tool_group'
            ? { ...block, tools: [...block.tools] }
            : block,
        );
      }
    }
    blocks = groupedBlocks;

    // Find or create response container
    let container = this.messagesContainer.querySelector('.response-active');
    if (!container) {
      container = document.createElement('div');
      container.className = 'response-active';
      this.messagesContainer.appendChild(container);
    }

    // Append new blocks without replacing disclosures the reader is inspecting.
    blocks.forEach((block, index) => {
      const existingBlockEl = container.children[index];
      if (existingBlockEl?.dataset.blockType === block.type) {
        this._updateBlockElement(existingBlockEl, block);
      } else {
        const blockEl = this._createBlockElement(block);
        blockEl.setAttribute('data-block-index', String(index));
        if (existingBlockEl) existingBlockEl.replaceWith(blockEl);
        else container.appendChild(blockEl);
      }
    });
    while (container.children.length > blocks.length) {
      container.lastElementChild.remove();
    }

    this.scrollToBottom();
  }

  /**
   * Create a DOM element for a single response block
   */
  _createBlockElement(block) {
    const blockEl = document.createElement('div');
    blockEl.dataset.blockType = block.type;

    if (block.type === 'text') {
      blockEl.className = 'response-block response-block-text';
      const contentEl = document.createElement('div');
      contentEl.className = 'response-block-content';
      const textSpan = document.createElement('span');
      textSpan.innerHTML = processMarkdown(block.text);
      blockEl._text = block.text;
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
      const textSpan = existingBlockEl.querySelector(
        '.response-block-content span',
      );
      if (textSpan && existingBlockEl._text !== block.text) {
        textSpan.innerHTML = processMarkdown(block.text);
        existingBlockEl._text = block.text;
      }
    } else if (block.type === 'tool_group') {
      updateToolGroup(existingBlockEl.querySelector('.tool-list'), block.tools);
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

    const contentEl = this.lastAIMessage.element.querySelector(
      '.message-content span',
    );
    if (!contentEl) {
      return false;
    }

    const existingContent = this.lastAIMessage.text || '';
    const newContent = getMessageContent(historyItem);
    const combinedContent = existingContent + '\n\n' + newContent;

    contentEl.innerHTML = processMarkdown(combinedContent);
    updateMessageTimestamp(this.lastAIMessage.element);

    // Update TTS button with combined content
    const ttsContainer = this.lastAIMessage.element.querySelector(
      '.tts-button-container',
    );
    if (ttsContainer && ttsContainer.ttsButtonInstance) {
      ttsContainer.ttsButtonInstance.updateText(combinedContent);
    }

    // Update copy buttons
    const copyButtons =
      this.lastAIMessage.element.querySelectorAll('.copy-button');
    copyButtons.forEach((button) => {
      if (button.classList.contains('copy-markdown')) {
        button.onclick = (e) => {
          e.stopPropagation();
          copyToClipboard(combinedContent, 'markdown', button, {
            lastAIMessage: this.lastAIMessage,
          });
        };
      } else if (button.classList.contains('copy-formatted')) {
        button.onclick = (e) => {
          e.stopPropagation();
          copyToClipboard(combinedContent, 'formatted', button, {
            lastAIMessage: this.lastAIMessage,
          });
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
    this._followingLatest = true;
    this.messagesContainer.innerHTML = '';
    this.messageCount = 0;
    this.lastAIMessage = null;

    historyItems.forEach((historyItem) => {
      if (
        this.mergeWithPreviousActivity(
          historyItem,
          this.messagesContainer.lastElementChild,
        )
      ) {
        return;
      }
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
          type: historyItem.type,
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
    this._followingLatest = true;
    this.messagesContainer.innerHTML = '';
    this.messageCount = 0;
    this.lastAIMessage = null;
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
    if (this.autoScrollEnabled && this._followingLatest) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }

  /**
   * Toggle auto-scroll functionality
   */
  toggleAutoScroll() {
    this.autoScrollEnabled = !this.autoScrollEnabled;
    if (this.autoScrollEnabled) this._followingLatest = true;

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
