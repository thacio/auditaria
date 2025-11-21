/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Toast Notification Component
 *
 * A simple, non-intrusive notification system for displaying
 * brief messages to the user.
 *
 * Features:
 * - Auto-dismiss after specified duration
 * - Multiple toast types (success, error, info)
 * - Smooth animations
 * - Queue support for multiple toasts
 */
export class Toast {
  constructor() {
    this.container = null;
    this.activeToasts = [];
    this.toastQueue = [];
    this.maxVisible = 3;

    this.createContainer();
  }

  /**
   * Create the toast container
   */
  createContainer() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(this.container);
  }

  /**
   * Show a toast notification
   * @param {string} message - Toast message
   * @param {string} type - Toast type (success, error, info)
   * @param {number} duration - Duration in milliseconds (default: 3000)
   * @returns {Object} Toast instance with hide() method
   */
  show(message, type = 'info', duration = 3000) {
    const toast = this.createToast(message, type);

    // If too many toasts are visible, queue it
    if (this.activeToasts.length >= this.maxVisible) {
      this.toastQueue.push({ toast, duration });
      return { hide: () => this.hideToast(toast) };
    }

    // Show toast
    this.showToast(toast, duration);

    return {
      hide: () => this.hideToast(toast)
    };
  }

  /**
   * Create a toast element
   * @param {string} message - Toast message
   * @param {string} type - Toast type
   * @returns {HTMLElement} Toast element
   */
  createToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.setAttribute('role', 'status');

    // Icon based on type
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');

    switch (type) {
      case 'success':
        icon.textContent = '✓';
        break;
      case 'error':
        icon.textContent = '✕';
        break;
      case 'info':
      default:
        icon.textContent = 'ℹ';
        break;
    }

    // Message
    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      this.hideToast(toast);
    });

    toast.appendChild(icon);
    toast.appendChild(messageEl);
    toast.appendChild(closeBtn);

    return toast;
  }

  /**
   * Show a toast element
   * @param {HTMLElement} toast - Toast element
   * @param {number} duration - Duration in milliseconds
   */
  showToast(toast, duration) {
    this.container.appendChild(toast);
    this.activeToasts.push(toast);

    // Trigger animation
    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    // Auto-hide after duration
    if (duration > 0) {
      toast.autoHideTimeout = setTimeout(() => {
        this.hideToast(toast);
      }, duration);
    }
  }

  /**
   * Hide a toast element
   * @param {HTMLElement} toast - Toast element
   */
  hideToast(toast) {
    if (!toast || !this.container.contains(toast)) {
      return;
    }

    // Clear auto-hide timeout
    if (toast.autoHideTimeout) {
      clearTimeout(toast.autoHideTimeout);
      toast.autoHideTimeout = null;
    }

    // Trigger hide animation
    toast.classList.remove('show');
    toast.classList.add('hide');

    // Remove from DOM after animation
    setTimeout(() => {
      if (this.container.contains(toast)) {
        this.container.removeChild(toast);
      }

      // Remove from active toasts
      const index = this.activeToasts.indexOf(toast);
      if (index !== -1) {
        this.activeToasts.splice(index, 1);
      }

      // Show next toast in queue
      this.showNextInQueue();
    }, 300);
  }

  /**
   * Show next toast in queue
   */
  showNextInQueue() {
    if (this.toastQueue.length > 0 && this.activeToasts.length < this.maxVisible) {
      const { toast, duration } = this.toastQueue.shift();
      this.showToast(toast, duration);
    }
  }

  /**
   * Hide all toasts
   */
  hideAll() {
    // Clear queue
    this.toastQueue = [];

    // Hide all active toasts
    [...this.activeToasts].forEach(toast => {
      this.hideToast(toast);
    });
  }

  /**
   * Destroy the toast system
   */
  destroy() {
    this.hideAll();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.activeToasts = [];
    this.toastQueue = [];
  }
}

// Create a singleton instance
export const toast = new Toast();

// Convenience methods
export const showToast = (message, type = 'info', duration = 3000) => {
  return toast.show(message, type, duration);
};

export const showSuccessToast = (message, duration = 3000) => {
  return toast.show(message, 'success', duration);
};

export const showErrorToast = (message, duration = 3000) => {
  return toast.show(message, 'error', duration);
};

export const showInfoToast = (message, duration = 3000) => {
  return toast.show(message, 'info', duration);
};
