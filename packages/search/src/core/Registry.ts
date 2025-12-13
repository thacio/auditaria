/**
 * Generic Registry pattern implementation for pluggable components.
 * Used for parsers, chunkers, embedders, OCR providers, etc.
 */

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Base interface for all providers in the registry system.
 * Providers are pluggable components that can be swapped at runtime.
 */
export interface Provider {
  /** Unique name identifier for this provider */
  readonly name: string;
  /** Priority for auto-selection (higher = preferred) */
  readonly priority: number;
}

/**
 * Provider that can check if it supports a given input.
 */
export interface SupportCheckProvider<TInput = unknown> extends Provider {
  /**
   * Check if this provider can handle the given input.
   */
  supports(input: TInput): boolean;
}

// ============================================================================
// Registry Class
// ============================================================================

/**
 * Generic registry for managing pluggable providers.
 * Supports registration, lookup, and auto-selection based on priority.
 *
 * @template T - The provider type this registry manages
 */
export class Registry<T extends Provider> {
  private readonly providers: Map<string, T> = new Map();
  private sorted: T[] | null = null;

  /**
   * Register a new provider.
   * If a provider with the same name exists, it will be replaced.
   *
   * @param provider - The provider to register
   */
  register(provider: T): void {
    this.providers.set(provider.name, provider);
    this.sorted = null; // Invalidate cache
  }

  /**
   * Unregister a provider by name.
   *
   * @param name - The name of the provider to remove
   * @returns true if the provider was found and removed
   */
  unregister(name: string): boolean {
    const existed = this.providers.has(name);
    this.providers.delete(name);
    if (existed) {
      this.sorted = null; // Invalidate cache
    }
    return existed;
  }

  /**
   * Get a provider by name.
   *
   * @param name - The name of the provider
   * @returns The provider, or undefined if not found
   */
  get(name: string): T | undefined {
    return this.providers.get(name);
  }

  /**
   * Check if a provider with the given name exists.
   *
   * @param name - The name to check
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all registered providers, sorted by priority (highest first).
   */
  getAll(): T[] {
    if (this.sorted === null) {
      this.sorted = Array.from(this.providers.values()).sort(
        (a, b) => b.priority - a.priority,
      );
    }
    return this.sorted;
  }

  /**
   * Get all provider names.
   */
  getNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get the number of registered providers.
   */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Clear all registered providers.
   */
  clear(): void {
    this.providers.clear();
    this.sorted = null;
  }

  /**
   * Find the best provider that supports the given input.
   * Returns the highest-priority provider where supports() returns true.
   *
   * @param input - The input to check support for
   * @returns The best matching provider, or undefined if none match
   */
  findBest<TInput>(
    input: TInput,
  ): T extends SupportCheckProvider<TInput> ? T | undefined : never {
    const providers = this.getAll();
    for (const provider of providers) {
      if ('supports' in provider && typeof provider.supports === 'function') {
        if ((provider as SupportCheckProvider<TInput>).supports(input)) {
          return provider as T extends SupportCheckProvider<TInput> ? T : never;
        }
      }
    }
    return undefined as T extends SupportCheckProvider<TInput>
      ? T | undefined
      : never;
  }

  /**
   * Find all providers that support the given input.
   * Returns providers sorted by priority (highest first).
   *
   * @param input - The input to check support for
   * @returns Array of matching providers
   */
  findAllMatching<TInput>(
    input: TInput,
  ): T extends SupportCheckProvider<TInput> ? T[] : never {
    const providers = this.getAll();
    const matching: T[] = [];

    for (const provider of providers) {
      if ('supports' in provider && typeof provider.supports === 'function') {
        if ((provider as SupportCheckProvider<TInput>).supports(input)) {
          matching.push(provider);
        }
      }
    }

    return matching as T extends SupportCheckProvider<TInput> ? T[] : never;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new registry instance.
 *
 * @template T - The provider type
 * @returns A new Registry instance
 */
export function createRegistry<T extends Provider>(): Registry<T> {
  return new Registry<T>();
}
