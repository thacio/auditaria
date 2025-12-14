/**
 * Registry for text chunkers.
 * Manages chunker registration and provides unified chunking interface.
 */

import { Registry } from '../core/Registry.js';
import type {
  Chunk,
  ChunkerOptions,
  ChunkerRegistryOptions,
  DocumentChunker,
} from './types.js';
import { DEFAULT_CHUNKER_OPTIONS } from './types.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import { FixedSizeChunker } from './FixedSizeChunker.js';

// ============================================================================
// ChunkerRegistry Class
// ============================================================================

/**
 * Registry for text chunkers with default options support.
 */
export class ChunkerRegistry {
  private readonly registry: Registry<DocumentChunker>;
  private readonly defaultOptions: ChunkerOptions;
  private defaultChunkerName: string | null = null;

  constructor(options?: ChunkerRegistryOptions) {
    this.registry = new Registry<DocumentChunker>();
    this.defaultOptions = {
      ...DEFAULT_CHUNKER_OPTIONS,
      ...options?.defaultOptions,
    };
  }

  /**
   * Register a chunker.
   */
  register(chunker: DocumentChunker): void {
    this.registry.register(chunker);

    // Auto-set default to highest priority if not set
    if (this.defaultChunkerName === null) {
      const all = this.registry.getAll();
      if (all.length > 0) {
        this.defaultChunkerName = all[0].name;
      }
    }
  }

  /**
   * Unregister a chunker by name.
   */
  unregister(name: string): boolean {
    const result = this.registry.unregister(name);

    // Reset default if we removed it
    if (result && this.defaultChunkerName === name) {
      const all = this.registry.getAll();
      this.defaultChunkerName = all.length > 0 ? all[0].name : null;
    }

    return result;
  }

  /**
   * Get a chunker by name.
   */
  get(name: string): DocumentChunker | undefined {
    return this.registry.get(name);
  }

  /**
   * Get all registered chunkers.
   */
  getAll(): DocumentChunker[] {
    return this.registry.getAll();
  }

  /**
   * Get the number of registered chunkers.
   */
  get size(): number {
    return this.registry.size;
  }

  /**
   * Set the default chunker by name.
   */
  setDefault(name: string): void {
    if (!this.registry.has(name)) {
      throw new Error(`Chunker not found: ${name}`);
    }
    this.defaultChunkerName = name;
  }

  /**
   * Get the default chunker.
   */
  getDefault(): DocumentChunker | undefined {
    if (this.defaultChunkerName === null) {
      const all = this.registry.getAll();
      return all.length > 0 ? all[0] : undefined;
    }
    return this.registry.get(this.defaultChunkerName);
  }

  /**
   * Get the default chunker name.
   */
  getDefaultName(): string | null {
    return this.defaultChunkerName;
  }

  /**
   * Chunk text using the default chunker.
   *
   * @param text - Text to chunk
   * @param options - Chunking options (merged with defaults)
   * @returns Array of chunks
   */
  async chunk(
    text: string,
    options?: Partial<ChunkerOptions>,
  ): Promise<Chunk[]> {
    const chunker = this.getDefault();

    if (!chunker) {
      throw new Error('No chunkers registered');
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    return chunker.chunk(text, mergedOptions);
  }

  /**
   * Chunk text using a specific chunker.
   *
   * @param chunkerName - Name of the chunker to use
   * @param text - Text to chunk
   * @param options - Chunking options
   * @returns Array of chunks
   */
  async chunkWith(
    chunkerName: string,
    text: string,
    options?: Partial<ChunkerOptions>,
  ): Promise<Chunk[]> {
    const chunker = this.registry.get(chunkerName);

    if (!chunker) {
      throw new Error(`Chunker not found: ${chunkerName}`);
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    return chunker.chunk(text, mergedOptions);
  }

  /**
   * Get the default chunking options.
   */
  getDefaultOptions(): ChunkerOptions {
    return { ...this.defaultOptions };
  }

  /**
   * Update the default chunking options.
   */
  updateDefaultOptions(options: Partial<ChunkerOptions>): void {
    Object.assign(this.defaultOptions, options);
  }

  /**
   * Clear all registered chunkers.
   */
  clear(): void {
    this.registry.clear();
    this.defaultChunkerName = null;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new ChunkerRegistry with default chunkers registered.
 */
export function createChunkerRegistry(
  options?: ChunkerRegistryOptions,
): ChunkerRegistry {
  const registry = new ChunkerRegistry(options);

  // Register default chunkers
  registry.register(new RecursiveChunker()); // Priority 100 - default
  registry.register(new FixedSizeChunker()); // Priority 50 - alternative

  return registry;
}

/**
 * Create an empty ChunkerRegistry without default chunkers.
 */
export function createEmptyChunkerRegistry(
  options?: ChunkerRegistryOptions,
): ChunkerRegistry {
  return new ChunkerRegistry(options);
}
