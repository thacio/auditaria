/**
 * OcrRegistry - Registry for OCR providers.
 * Manages multiple OCR providers and selects the best one for a given task.
 */

import type {
  OcrProvider,
  OcrResult,
  OcrOptions,
  OcrRegistryOptions,
  OcrProgressCallback,
} from './types.js';
import type { OcrRegion } from '../parsers/types.js';

// ============================================================================
// OcrRegistry Implementation
// ============================================================================

/**
 * Registry that manages OCR providers.
 * Allows registering multiple providers and selecting the best one.
 */
export class OcrRegistry {
  private providers: Map<string, OcrProvider> = new Map();
  private defaultOptions: OcrOptions;
  private defaultProvider: string | null = null;

  constructor(options: OcrRegistryOptions = {}) {
    this.defaultOptions = options.defaultOptions || {};
  }

  /**
   * Register an OCR provider.
   */
  register(provider: OcrProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider already registered: ${provider.name}`);
    }
    this.providers.set(provider.name, provider);

    // Set as default if first provider
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  /**
   * Unregister an OCR provider.
   */
  unregister(name: string): void {
    this.providers.delete(name);

    // Clear default if removed
    if (this.defaultProvider === name) {
      this.defaultProvider =
        this.providers.size > 0 ? Array.from(this.providers.keys())[0] : null;
    }
  }

  /**
   * Get a provider by name.
   */
  get(name: string): OcrProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered providers.
   */
  getAll(): OcrProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get the default provider.
   */
  getDefault(): OcrProvider | undefined {
    if (!this.defaultProvider) {
      return undefined;
    }
    return this.providers.get(this.defaultProvider);
  }

  /**
   * Set the default provider.
   */
  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider not found: ${name}`);
    }
    this.defaultProvider = name;
  }

  /**
   * Get the best provider for the given languages.
   * Selects based on language support and priority.
   */
  getBestForLanguages(languages: string[]): OcrProvider | undefined {
    if (this.providers.size === 0) {
      return undefined;
    }

    // Find providers that support all requested languages
    const matching = this.getAll().filter((p) =>
      languages.every((lang) => p.supportedLanguages.includes(lang)),
    );

    // Sort by priority (descending)
    matching.sort((a, b) => b.priority - a.priority);

    // Return highest priority match, or default if none match
    return matching[0] || this.getDefault();
  }

  /**
   * Check if any provider is available.
   */
  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  /**
   * Check if any provider is ready.
   */
  hasReadyProvider(): boolean {
    return this.getAll().some((p) => p.isReady());
  }

  /**
   * Initialize all providers.
   */
  async initializeAll(progressCallback?: OcrProgressCallback): Promise<void> {
    const providers = this.getAll();
    const total = providers.length;

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];

      progressCallback?.({
        stage: 'loading',
        progress: (i / total) * 100,
        message: `Initializing ${provider.name}...`,
      });

      try {
        await provider.initialize((info) => {
          progressCallback?.({
            ...info,
            progress: ((i + info.progress / 100) / total) * 100,
          });
        });
      } catch (error) {
        console.warn(
          `Failed to initialize OCR provider ${provider.name}:`,
          error,
        );
      }
    }

    progressCallback?.({
      stage: 'loading',
      progress: 100,
      message: 'All providers initialized',
    });
  }

  /**
   * Recognize text using the default or specified provider.
   */
  async recognize(
    image: Buffer | string,
    options?: OcrOptions & { provider?: string },
  ): Promise<OcrResult> {
    const provider = options?.provider
      ? this.get(options.provider)
      : this.getDefault();

    if (!provider) {
      throw new Error('No OCR provider available');
    }

    if (!provider.isReady()) {
      await provider.initialize();
    }

    return provider.recognize(image, { ...this.defaultOptions, ...options });
  }

  /**
   * Recognize text from multiple regions.
   */
  async recognizeRegions(
    regions: OcrRegion[],
    options?: OcrOptions & { provider?: string },
  ): Promise<OcrResult[]> {
    const provider = options?.provider
      ? this.get(options.provider)
      : this.getDefault();

    if (!provider) {
      throw new Error('No OCR provider available');
    }

    if (!provider.isReady()) {
      await provider.initialize();
    }

    return provider.recognizeRegions(regions, {
      ...this.defaultOptions,
      ...options,
    });
  }

  /**
   * Recognize text from a file.
   */
  async recognizeFile(
    filePath: string,
    options?: OcrOptions & { provider?: string },
  ): Promise<OcrResult> {
    const provider = options?.provider
      ? this.get(options.provider)
      : this.getDefault();

    if (!provider) {
      throw new Error('No OCR provider available');
    }

    if (!provider.isReady()) {
      await provider.initialize();
    }

    return provider.recognizeFile(filePath, {
      ...this.defaultOptions,
      ...options,
    });
  }

  /**
   * Dispose all providers.
   */
  async disposeAll(): Promise<void> {
    for (const provider of this.getAll()) {
      try {
        await provider.dispose();
      } catch (error) {
        console.warn(`Failed to dispose OCR provider ${provider.name}:`, error);
      }
    }
    this.providers.clear();
    this.defaultProvider = null;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new OcrRegistry.
 */
export function createOcrRegistry(options?: OcrRegistryOptions): OcrRegistry {
  return new OcrRegistry(options);
}

/**
 * Create an OcrRegistry with TesseractJsProvider if available.
 */
export async function createOcrRegistryAsync(
  options?: OcrRegistryOptions,
): Promise<OcrRegistry> {
  const registry = new OcrRegistry(options);

  try {
    // Try to import and register Tesseract.js provider
    const { TesseractJsProvider, isTesseractAvailable } = await import(
      './TesseractJsProvider.js'
    );

    if (await isTesseractAvailable()) {
      const provider = new TesseractJsProvider();
      registry.register(provider);
    }
  } catch {
    // tesseract.js not available
  }

  return registry;
}
