/**
 * Type-safe event emitter for the search system.
 * Provides strongly-typed events with compile-time checking.
 */

import type { SearchSystemEvents, SearchSystemEventName } from '../types.js';

// ============================================================================
// Types
// ============================================================================

type EventHandler<T> = (data: T) => void | Promise<void>;

type EventHandlerMap = {
  [K in SearchSystemEventName]?: Set<EventHandler<SearchSystemEvents[K]>>;
};

// ============================================================================
// Generic EventEmitter Class
// ============================================================================

/**
 * Generic type-safe event emitter.
 * Use this as a base class for components that need custom events.
 *
 * @typeParam TEvents - Map of event names to their data types
 */
export class EventEmitter<TEvents extends { [key: string]: unknown }> {
  private handlers: Map<keyof TEvents, Set<EventHandler<unknown>>> = new Map();
  private onceHandlers: Map<keyof TEvents, Set<EventHandler<unknown>>> =
    new Map();

  /**
   * Subscribe to an event.
   */
  on<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);

    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event for one-time execution.
   */
  once<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler as EventHandler<unknown>);

    return () => {
      this.onceHandlers.get(event)?.delete(handler as EventHandler<unknown>);
    };
  }

  /**
   * Unsubscribe from an event.
   */
  off<K extends keyof TEvents>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): void {
    this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
    this.onceHandlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  /**
   * Emit an event to all subscribers.
   */
  protected async emit<K extends keyof TEvents>(
    event: K,
    data: TEvents[K],
  ): Promise<void> {
    const regularHandlers = this.handlers.get(event);
    const once = this.onceHandlers.get(event);

    const allHandlers: Array<EventHandler<TEvents[K]>> = [];

    if (regularHandlers) {
      for (const handler of regularHandlers) {
        allHandlers.push(handler as EventHandler<TEvents[K]>);
      }
    }

    if (once) {
      for (const handler of once) {
        allHandlers.push(handler as EventHandler<TEvents[K]>);
      }
      this.onceHandlers.set(event, new Set());
    }

    const promises = allHandlers.map(async (handler) => {
      try {
        await handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${String(event)}:`, error);
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
    if (event) {
      this.handlers.delete(event);
      this.onceHandlers.delete(event);
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
    }
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount<K extends keyof TEvents>(event: K): number {
    const regular = this.handlers.get(event)?.size ?? 0;
    const once = this.onceHandlers.get(event)?.size ?? 0;
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
export class SearchEventEmitter {
  private handlers: EventHandlerMap = {};
  private onceHandlers: EventHandlerMap = {};

  /**
   * Subscribe to an event.
   *
   * @param event - The event name
   * @param handler - The handler function
   * @returns A function to unsubscribe
   */
  on<K extends SearchSystemEventName>(
    event: K,
    handler: EventHandler<SearchSystemEvents[K]>,
  ): () => void {
    if (!this.handlers[event]) {
      this.handlers[event] = new Set() as EventHandlerMap[K];
    }
    this.handlers[event]!.add(
      handler as EventHandler<SearchSystemEvents[SearchSystemEventName]>,
    );

    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Subscribe to an event for one-time execution.
   *
   * @param event - The event name
   * @param handler - The handler function
   * @returns A function to unsubscribe
   */
  once<K extends SearchSystemEventName>(
    event: K,
    handler: EventHandler<SearchSystemEvents[K]>,
  ): () => void {
    if (!this.onceHandlers[event]) {
      this.onceHandlers[event] = new Set() as EventHandlerMap[K];
    }
    this.onceHandlers[event]!.add(
      handler as EventHandler<SearchSystemEvents[SearchSystemEventName]>,
    );

    return () => {
      this.onceHandlers[event]?.delete(
        handler as EventHandler<SearchSystemEvents[SearchSystemEventName]>,
      );
    };
  }

  /**
   * Unsubscribe from an event.
   *
   * @param event - The event name
   * @param handler - The handler function to remove
   */
  off<K extends SearchSystemEventName>(
    event: K,
    handler: EventHandler<SearchSystemEvents[K]>,
  ): void {
    this.handlers[event]?.delete(
      handler as EventHandler<SearchSystemEvents[SearchSystemEventName]>,
    );
    this.onceHandlers[event]?.delete(
      handler as EventHandler<SearchSystemEvents[SearchSystemEventName]>,
    );
  }

  /**
   * Emit an event to all subscribers.
   *
   * @param event - The event name
   * @param data - The event data
   */
  async emit<K extends SearchSystemEventName>(
    event: K,
    data: SearchSystemEvents[K],
  ): Promise<void> {
    const regularHandlers = this.handlers[event];
    const onceHandlers = this.onceHandlers[event];

    // Collect all handlers
    const allHandlers: Array<EventHandler<SearchSystemEvents[K]>> = [];

    if (regularHandlers) {
      for (const handler of regularHandlers) {
        allHandlers.push(handler);
      }
    }

    if (onceHandlers) {
      for (const handler of onceHandlers) {
        allHandlers.push(handler);
      }
      // Clear once handlers after collecting
      this.onceHandlers[event] = new Set() as EventHandlerMap[K];
    }

    // Execute all handlers
    const promises = allHandlers.map(async (handler) => {
      try {
        await handler(data);
      } catch (error) {
        // Log error but don't throw to allow other handlers to run
        console.error(`Error in event handler for ${event}:`, error);
      }
    });

    await Promise.all(promises);
  }

  /**
   * Emit an event synchronously (fire and forget).
   * Handlers are still executed but errors are silently caught.
   *
   * @param event - The event name
   * @param data - The event data
   */
  emitSync<K extends SearchSystemEventName>(
    event: K,
    data: SearchSystemEvents[K],
  ): void {
    void this.emit(event, data);
  }

  /**
   * Remove all handlers for a specific event.
   *
   * @param event - The event name
   */
  removeAllListeners<K extends SearchSystemEventName>(event?: K): void {
    if (event) {
      delete this.handlers[event];
      delete this.onceHandlers[event];
    } else {
      this.handlers = {};
      this.onceHandlers = {};
    }
  }

  /**
   * Get the number of listeners for an event.
   *
   * @param event - The event name
   */
  listenerCount<K extends SearchSystemEventName>(event: K): number {
    const regular = this.handlers[event]?.size ?? 0;
    const once = this.onceHandlers[event]?.size ?? 0;
    return regular + once;
  }

  /**
   * Check if there are any listeners for an event.
   *
   * @param event - The event name
   */
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
