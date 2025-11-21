/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Simple event emitter utility

/**
 * Simple Event Emitter
 *
 * Provides pub/sub pattern for custom events
 */
export class EventEmitter {
  constructor() {
    this.events = new Map();
  }

  /**
   * Register event listener
   * @param {string} event - Event name
   * @param {Function} listener - Callback function
   */
  on(event, listener) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event).push(listener);
  }

  /**
   * Register one-time event listener
   * @param {string} event - Event name
   * @param {Function} listener - Callback function
   */
  once(event, listener) {
    const onceWrapper = (...args) => {
      listener(...args);
      this.off(event, onceWrapper);
    };
    this.on(event, onceWrapper);
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} listener - Callback function to remove
   */
  off(event, listener) {
    if (!this.events.has(event)) {
      return;
    }

    const listeners = this.events.get(event);
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }

    if (listeners.length === 0) {
      this.events.delete(event);
    }
  }

  /**
   * Emit event to all listeners
   * @param {string} event - Event name
   * @param {*} data - Data to pass to listeners
   */
  emit(event, data) {
    if (!this.events.has(event)) {
      return;
    }

    const listeners = this.events.get(event).slice(); // Clone to avoid issues if listeners are removed during emit
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in event listener for "${event}":`, error);
      }
    }
  }

  /**
   * Remove all listeners for an event, or all events
   * @param {string} [event] - Optional event name
   */
  removeAllListeners(event) {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
  }

  /**
   * Get listener count for an event
   * @param {string} event - Event name
   * @returns {number}
   */
  listenerCount(event) {
    return this.events.has(event) ? this.events.get(event).length : 0;
  }
}
