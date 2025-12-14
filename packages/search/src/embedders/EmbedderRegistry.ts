/**
 * Registry for text embedders.
 * Manages multiple embedder implementations and provides the best one for a given context.
 */

import type { TextEmbedder, ProgressCallback } from './types.js';
import type { Embedder } from '../indexing/types.js';

// ============================================================================
// EmbedderRegistry
// ============================================================================

/**
 * Registry for managing embedder implementations.
 */
export class EmbedderRegistry {
  private embedders: Map<string, TextEmbedder> = new Map();
  private defaultEmbedder: TextEmbedder | null = null;

  /**
   * Register an embedder.
   * @param embedder - The embedder to register
   */
  register(embedder: TextEmbedder): void {
    this.embedders.set(embedder.name, embedder);

    // Update default if this has higher priority
    if (
      !this.defaultEmbedder ||
      embedder.priority > this.defaultEmbedder.priority
    ) {
      this.defaultEmbedder = embedder;
    }
  }

  /**
   * Unregister an embedder.
   * @param name - The embedder name to unregister
   */
  unregister(name: string): void {
    const embedder = this.embedders.get(name);
    this.embedders.delete(name);

    // Update default if we removed the current default
    if (embedder === this.defaultEmbedder) {
      this.defaultEmbedder = this.findHighestPriority();
    }
  }

  /**
   * Get an embedder by name.
   * @param name - The embedder name
   */
  get(name: string): TextEmbedder | undefined {
    return this.embedders.get(name);
  }

  /**
   * Get the default (highest priority) embedder.
   */
  getDefault(): TextEmbedder | undefined {
    return this.defaultEmbedder ?? undefined;
  }

  /**
   * Get all registered embedders.
   */
  getAll(): TextEmbedder[] {
    return Array.from(this.embedders.values());
  }

  /**
   * Get all embedder names.
   */
  getNames(): string[] {
    return Array.from(this.embedders.keys());
  }

  /**
   * Check if an embedder is registered.
   * @param name - The embedder name
   */
  has(name: string): boolean {
    return this.embedders.has(name);
  }

  /**
   * Get the number of registered embedders.
   */
  get size(): number {
    return this.embedders.size;
  }

  /**
   * Initialize the default embedder.
   * @param onProgress - Optional progress callback
   */
  async initializeDefault(onProgress?: ProgressCallback): Promise<void> {
    const embedder = this.getDefault();
    if (!embedder) {
      throw new Error('No embedders registered');
    }

    if (!embedder.isReady()) {
      await embedder.initialize(onProgress);
    }
  }

  /**
   * Initialize a specific embedder.
   * @param name - The embedder name
   * @param onProgress - Optional progress callback
   */
  async initialize(name: string, onProgress?: ProgressCallback): Promise<void> {
    const embedder = this.get(name);
    if (!embedder) {
      throw new Error(`Embedder not found: ${name}`);
    }

    if (!embedder.isReady()) {
      await embedder.initialize(onProgress);
    }
  }

  /**
   * Get the default embedder as the simpler Embedder interface.
   * This is useful for passing to IndexingPipeline.
   */
  getAsEmbedder(): Embedder | undefined {
    const embedder = this.getDefault();
    if (!embedder) return undefined;

    // Check if the embedder has embedBatchDocuments method
    const hasEmbedBatchDocuments =
      'embedBatchDocuments' in embedder &&
      typeof embedder.embedBatchDocuments === 'function';

    return {
      name: embedder.name,
      dimensions: embedder.dimensions,
      initialize: () => embedder.initialize(),
      isReady: () => embedder.isReady(),
      embed: (text: string) => embedder.embed(text),
      embedBatch: (texts: string[]) => embedder.embedBatch(texts),
      embedBatchDocuments: hasEmbedBatchDocuments
        ? (texts: string[]) => embedder.embedBatchDocuments!(texts)
        : undefined,
      dispose: () => embedder.dispose(),
    };
  }

  /**
   * Set a specific embedder as the default (by name).
   * Useful for runtime switching.
   */
  setDefault(name: string): void {
    const embedder = this.get(name);
    if (!embedder) {
      throw new Error(`Embedder not found: ${name}`);
    }
    this.defaultEmbedder = embedder;
  }

  /**
   * Dispose of all embedders.
   */
  async disposeAll(): Promise<void> {
    const promises = Array.from(this.embedders.values()).map((e) =>
      e.dispose(),
    );
    await Promise.all(promises);
  }

  /**
   * Find the embedder with highest priority.
   */
  private findHighestPriority(): TextEmbedder | null {
    let highest: TextEmbedder | null = null;

    for (const embedder of this.embedders.values()) {
      if (!highest || embedder.priority > highest.priority) {
        highest = embedder;
      }
    }

    return highest;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new EmbedderRegistry instance.
 * Note: Use createEmbedderRegistryAsync() for auto-registration of default embedders.
 */
export function createEmbedderRegistry(): EmbedderRegistry {
  return new EmbedderRegistry();
}

/**
 * Create a new EmbedderRegistry with default embedders registered.
 * This is async because it dynamically imports the TransformersJS embedder.
 */
export async function createEmbedderRegistryAsync(): Promise<EmbedderRegistry> {
  const registry = new EmbedderRegistry();

  // Import and register the default embedder
  const { TransformersJsEmbedder } = await import(
    './TransformersJsEmbedder.js'
  );
  const embedder = new TransformersJsEmbedder();
  registry.register(embedder);

  return registry;
}
