/**
 * Tests for OcrRegistry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { OcrRegistry} from './OcrRegistry.js';
import { createOcrRegistry } from './OcrRegistry.js';
import type { OcrProvider, OcrResult, OcrOptions } from './types.js';
import type { OcrRegion } from '../parsers/types.js';

// Mock OCR Provider
class MockOcrProvider implements OcrProvider {
  readonly name = 'mock-ocr';
  readonly supportedLanguages = ['en', 'pt', 'es'];
  readonly priority = 50;
  private ready = false;
  initializeCalls = 0;
  recognizeCalls = 0;

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    this.initializeCalls++;
    this.ready = true;
  }

  async recognize(
    _image: Buffer | string,
    _options?: OcrOptions,
  ): Promise<OcrResult> {
    this.recognizeCalls++;
    return {
      text: 'Mock OCR result',
      confidence: 0.95,
      regions: [
        {
          text: 'Mock OCR result',
          bounds: { x: 0, y: 0, width: 100, height: 20 },
          confidence: 0.95,
        },
      ],
    };
  }

  async recognizeRegions(
    regions: OcrRegion[],
    _options?: OcrOptions,
  ): Promise<OcrResult[]> {
    return regions.map(() => ({
      text: 'Mock region result',
      confidence: 0.9,
      regions: [],
    }));
  }

  async recognizeFile(
    _filePath: string,
    _options?: OcrOptions,
  ): Promise<OcrResult> {
    return this.recognize(Buffer.from(''));
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }
}

describe('OcrRegistry', () => {
  let registry: OcrRegistry;
  let mockProvider: MockOcrProvider;

  beforeEach(() => {
    registry = createOcrRegistry();
    mockProvider = new MockOcrProvider();
  });

  describe('registration', () => {
    it('should register a provider', () => {
      registry.register(mockProvider);
      expect(registry.get('mock-ocr')).toBe(mockProvider);
    });

    it('should throw when registering duplicate provider', () => {
      registry.register(mockProvider);
      expect(() => registry.register(mockProvider)).toThrow(
        'Provider already registered',
      );
    });

    it('should unregister a provider', () => {
      registry.register(mockProvider);
      registry.unregister('mock-ocr');
      expect(registry.get('mock-ocr')).toBeUndefined();
    });

    it('should set first provider as default', () => {
      registry.register(mockProvider);
      expect(registry.getDefault()).toBe(mockProvider);
    });
  });

  describe('provider selection', () => {
    it('should get all providers', () => {
      const provider2 = new MockOcrProvider();
      Object.defineProperty(provider2, 'name', { value: 'mock-ocr-2' });
      Object.defineProperty(provider2, 'priority', { value: 100 });

      registry.register(mockProvider);
      registry.register(provider2);

      expect(registry.getAll()).toHaveLength(2);
    });

    it('should get best provider for languages', () => {
      registry.register(mockProvider);
      const best = registry.getBestForLanguages(['en', 'pt']);
      expect(best).toBe(mockProvider);
    });

    it('should return undefined when no providers match languages', () => {
      registry.register(mockProvider);
      const best = registry.getBestForLanguages(['zh', 'ja']);
      // Falls back to default
      expect(best).toBe(mockProvider);
    });

    it('should set and get default provider', () => {
      const provider2 = new MockOcrProvider();
      Object.defineProperty(provider2, 'name', { value: 'mock-ocr-2' });

      registry.register(mockProvider);
      registry.register(provider2);
      registry.setDefault('mock-ocr-2');

      expect(registry.getDefault()).toBe(provider2);
    });

    it('should throw when setting non-existent default', () => {
      expect(() => registry.setDefault('non-existent')).toThrow(
        'Provider not found',
      );
    });
  });

  describe('recognition', () => {
    beforeEach(() => {
      registry.register(mockProvider);
    });

    it('should recognize using default provider', async () => {
      await mockProvider.initialize();
      const result = await registry.recognize(Buffer.from('test'));
      expect(result.text).toBe('Mock OCR result');
      expect(mockProvider.recognizeCalls).toBe(1);
    });

    it('should auto-initialize provider if not ready', async () => {
      await registry.recognize(Buffer.from('test'));
      expect(mockProvider.initializeCalls).toBe(1);
    });

    it('should throw when no provider available', async () => {
      const emptyRegistry = createOcrRegistry();
      await expect(
        emptyRegistry.recognize(Buffer.from('test')),
      ).rejects.toThrow('No OCR provider available');
    });

    it('should recognize file', async () => {
      await mockProvider.initialize();
      const result = await registry.recognizeFile('/test/image.png');
      expect(result.text).toBe('Mock OCR result');
    });

    it('should recognize regions', async () => {
      await mockProvider.initialize();
      const regions: OcrRegion[] = [
        { page: 1, bounds: { x: 0, y: 0, width: 100, height: 50 } },
        { page: 2, bounds: { x: 0, y: 0, width: 100, height: 50 } },
      ];
      const results = await registry.recognizeRegions(regions);
      expect(results).toHaveLength(2);
    });
  });

  describe('lifecycle', () => {
    it('should check if has providers', () => {
      expect(registry.hasProviders()).toBe(false);
      registry.register(mockProvider);
      expect(registry.hasProviders()).toBe(true);
    });

    it('should check if has ready provider', async () => {
      registry.register(mockProvider);
      expect(registry.hasReadyProvider()).toBe(false);
      await mockProvider.initialize();
      expect(registry.hasReadyProvider()).toBe(true);
    });

    it('should initialize all providers', async () => {
      const provider2 = new MockOcrProvider();
      Object.defineProperty(provider2, 'name', { value: 'mock-ocr-2' });

      registry.register(mockProvider);
      registry.register(provider2);

      await registry.initializeAll();

      expect(mockProvider.isReady()).toBe(true);
      expect(provider2.isReady()).toBe(true);
    });

    it('should dispose all providers', async () => {
      registry.register(mockProvider);
      await mockProvider.initialize();

      await registry.disposeAll();

      expect(registry.hasProviders()).toBe(false);
      expect(mockProvider.isReady()).toBe(false);
    });
  });
});
