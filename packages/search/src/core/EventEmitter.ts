/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type-safe event emitter for the search system.
 * Provides strongly-typed events with compile-time checking.
 */

import { createModuleLogger } from './Logger.js';
const log = createModuleLogger('EventEmitter');

import type { SearchSystemEvents, SearchSystemEventName } from '../types.js';

// ============================================================================
// Types
// ============================================================================

type EventHandler<T> = (data: T) => void | Promise<void>;

type EventHandlerMap<TEvents> = {
  [K in keyof TEvents]?: Set<EventHandler<TEvents[K]>>;
};

function createHandlerMap<TEvents>(): EventHandlerMap<TEvents> {
  const handlers: EventHandlerMap<TEvents> = {};
  Object.setPrototypeOf(handlers, null);
  return handlers;
}

// ============================================================================
// Generic EventEmitter Class
// ============================================================================

/**
 * Generic type-safe event emitter.
 * Use this as a base class for components that need custom events.
 *
 * @typeParam TEvents - Map of event names to their data types
 */
export class EventEmitter<TEvents extends object> {
  private handlers = createHandlerMap<TEvents>();
  private onceHandlers = createHandlerMap<TEvents>();

  /**
   * Subscribe to an event.
   */
  on<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void {
    (this.handlers[event] ??= new Set()).add(handler);

    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event for one-time execution.
   */
  once<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void {
    (this.onceHandlers[event] ??= new Set()).add(handler);

    return () => {
      this.onceHandlers[event]?.delete(handler);
    };
  }

  /**
   * Unsubscribe from an event.
   */
  off<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): void {
    this.handlers[event]?.delete(handler);
    this.onceHandlers[event]?.delete(handler);
  }

  /**
   * Emit an event to all subscribers.
   */
  protected async emit<K extends keyof TEvents>(
    event: K,
    data: TEvents[K],
  ): Promise<void> {
    const regularHandlers = this.handlers[event];
    const once = this.onceHandlers[event];

    const allHandlers: Array<EventHandler<TEvents[K]>> = [];

    if (regularHandlers) {
      for (const handler of regularHandlers) {
        allHandlers.push(handler);
      }
    }

    if (once) {
      for (const handler of once) {
        allHandlers.push(handler);
      }
      delete this.onceHandlers[event];
    }

    const promises = allHandlers.map(async (handler) => {
      try {
        await handler(data);
      } catch (error) {
        log.error(`Error in event handler for ${String(event)}`, { error });
      }
    });

    await Promise.all(promises);
  }

  /**
   * Emit an event synchronously (fire and forget).
   */
  protected emitSync<K extends keyof TEvents>(
    event: K,
    data: TEvents[K],
  ): void {
    void this.emit(event, data);
  }

  /**
   * Remove all handlers for a specific event.
   */
  removeAllListeners<K extends keyof TEvents>(event?: K): void {
    if (event !== undefined) {
      delete this.handlers[event];
      delete this.onceHandlers[event];
    } else {
      this.handlers = createHandlerMap<TEvents>();
      this.onceHandlers = createHandlerMap<TEvents>();
    }
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount<K extends keyof TEvents>(event: K): number {
    const regular = this.handlers[event]?.size ?? 0;
    const once = this.onceHandlers[event]?.size ?? 0;
    return regular + once;
  }
}

// ============================================================================
// SearchEventEmitter Class
// ============================================================================

/**
 * Type-safe event emitter for search system events.
 * All events are strongly typed based on SearchSystemEvents.
 */
export class SearchEventEmitter extends EventEmitter<SearchSystemEvents> {
  override async emit<K extends SearchSystemEventName>(
    event: K,
    data: SearchSystemEvents[K],
  ): Promise<void> {
    await super.emit(event, data);
  }
  override emitSync<K extends SearchSystemEventName>(
    event: K,
    data: SearchSystemEvents[K],
  ): void {
    super.emitSync(event, data);
  }
  hasListeners<K extends SearchSystemEventName>(event: K): boolean {
    return this.listenerCount(event) > 0;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new event emitter instance.
 */
export function createEventEmitter(): SearchEventEmitter {
  return new SearchEventEmitter();
}
