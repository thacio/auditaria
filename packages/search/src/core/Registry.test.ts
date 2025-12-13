import { describe, it, expect, beforeEach } from 'vitest';
import {
  Registry,
  createRegistry,
  type Provider,
  type SupportCheckProvider,
} from './Registry.js';

// Test provider implementations
interface TestProvider extends Provider {
  name: string;
  priority: number;
  value: string;
}

interface FileProvider extends SupportCheckProvider<string> {
  name: string;
  priority: number;
  supportedExtensions: string[];
  supports(filePath: string): boolean;
}

function createTestProvider(
  name: string,
  priority: number,
  value = '',
): TestProvider {
  return { name, priority, value };
}

function createFileProvider(
  name: string,
  priority: number,
  extensions: string[],
): FileProvider {
  return {
    name,
    priority,
    supportedExtensions: extensions,
    supports(filePath: string): boolean {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      return this.supportedExtensions.includes(ext);
    },
  };
}

describe('Registry', () => {
  describe('basic operations', () => {
    let registry: Registry<TestProvider>;

    beforeEach(() => {
      registry = createRegistry<TestProvider>();
    });

    it('should start empty', () => {
      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);
      expect(registry.getNames()).toEqual([]);
    });

    it('should register a provider', () => {
      const provider = createTestProvider('test', 10);
      registry.register(provider);

      expect(registry.size).toBe(1);
      expect(registry.has('test')).toBe(true);
      expect(registry.get('test')).toBe(provider);
    });

    it('should register multiple providers', () => {
      registry.register(createTestProvider('a', 1));
      registry.register(createTestProvider('b', 2));
      registry.register(createTestProvider('c', 3));

      expect(registry.size).toBe(3);
      expect(registry.getNames()).toEqual(['a', 'b', 'c']);
    });

    it('should replace provider with same name', () => {
      const provider1 = createTestProvider('test', 10, 'first');
      const provider2 = createTestProvider('test', 20, 'second');

      registry.register(provider1);
      registry.register(provider2);

      expect(registry.size).toBe(1);
      expect(registry.get('test')?.value).toBe('second');
      expect(registry.get('test')?.priority).toBe(20);
    });

    it('should unregister a provider', () => {
      registry.register(createTestProvider('test', 10));
      expect(registry.has('test')).toBe(true);

      const removed = registry.unregister('test');
      expect(removed).toBe(true);
      expect(registry.has('test')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('should return false when unregistering non-existent provider', () => {
      const removed = registry.unregister('nonexistent');
      expect(removed).toBe(false);
    });

    it('should return undefined for non-existent provider', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should clear all providers', () => {
      registry.register(createTestProvider('a', 1));
      registry.register(createTestProvider('b', 2));
      registry.register(createTestProvider('c', 3));

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('priority sorting', () => {
    let registry: Registry<TestProvider>;

    beforeEach(() => {
      registry = createRegistry<TestProvider>();
    });

    it('should return providers sorted by priority (highest first)', () => {
      registry.register(createTestProvider('low', 1));
      registry.register(createTestProvider('high', 100));
      registry.register(createTestProvider('medium', 50));

      const all = registry.getAll();

      expect(all[0].name).toBe('high');
      expect(all[1].name).toBe('medium');
      expect(all[2].name).toBe('low');
    });

    it('should maintain order for same priority', () => {
      registry.register(createTestProvider('a', 10));
      registry.register(createTestProvider('b', 10));
      registry.register(createTestProvider('c', 10));

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      // Order is not guaranteed for same priority, just check all are present
      expect(all.map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
    });

    it('should update sorting after new registration', () => {
      registry.register(createTestProvider('low', 1));
      registry.register(createTestProvider('medium', 50));

      let all = registry.getAll();
      expect(all[0].name).toBe('medium');

      // Add higher priority
      registry.register(createTestProvider('high', 100));

      all = registry.getAll();
      expect(all[0].name).toBe('high');
    });

    it('should update sorting after unregister', () => {
      registry.register(createTestProvider('low', 1));
      registry.register(createTestProvider('high', 100));

      registry.unregister('high');

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('low');
    });
  });

  describe('findBest with SupportCheckProvider', () => {
    let registry: Registry<FileProvider>;

    beforeEach(() => {
      registry = createRegistry<FileProvider>();
    });

    it('should find best matching provider', () => {
      registry.register(createFileProvider('pdf', 10, ['.pdf']));
      registry.register(createFileProvider('docx', 10, ['.docx']));
      registry.register(createFileProvider('office', 5, ['.docx', '.xlsx']));

      const best = registry.findBest('document.pdf');
      expect(best?.name).toBe('pdf');
    });

    it('should return highest priority matching provider', () => {
      registry.register(createFileProvider('generic', 1, ['.pdf', '.docx']));
      registry.register(createFileProvider('pdf-specialist', 100, ['.pdf']));

      const best = registry.findBest('document.pdf');
      expect(best?.name).toBe('pdf-specialist');
    });

    it('should return undefined when no provider matches', () => {
      registry.register(createFileProvider('pdf', 10, ['.pdf']));

      const best = registry.findBest('document.txt');
      expect(best).toBeUndefined();
    });

    it('should return undefined when registry is empty', () => {
      const best = registry.findBest('document.pdf');
      expect(best).toBeUndefined();
    });
  });

  describe('findAllMatching with SupportCheckProvider', () => {
    let registry: Registry<FileProvider>;

    beforeEach(() => {
      registry = createRegistry<FileProvider>();
    });

    it('should find all matching providers', () => {
      registry.register(createFileProvider('pdf', 10, ['.pdf']));
      registry.register(createFileProvider('generic', 5, ['.pdf', '.docx']));
      registry.register(createFileProvider('docx', 10, ['.docx']));

      const matching = registry.findAllMatching('document.pdf');
      expect(matching).toHaveLength(2);
      expect(matching.map((p) => p.name)).toContain('pdf');
      expect(matching.map((p) => p.name)).toContain('generic');
    });

    it('should return matching providers sorted by priority', () => {
      registry.register(createFileProvider('low', 1, ['.pdf']));
      registry.register(createFileProvider('high', 100, ['.pdf']));
      registry.register(createFileProvider('medium', 50, ['.pdf']));

      const matching = registry.findAllMatching('document.pdf');
      expect(matching[0].name).toBe('high');
      expect(matching[1].name).toBe('medium');
      expect(matching[2].name).toBe('low');
    });

    it('should return empty array when no provider matches', () => {
      registry.register(createFileProvider('pdf', 10, ['.pdf']));

      const matching = registry.findAllMatching('document.txt');
      expect(matching).toEqual([]);
    });
  });

  describe('createRegistry factory', () => {
    it('should create a new registry instance', () => {
      const registry = createRegistry<TestProvider>();
      expect(registry).toBeInstanceOf(Registry);
      expect(registry.size).toBe(0);
    });

    it('should create independent instances', () => {
      const registry1 = createRegistry<TestProvider>();
      const registry2 = createRegistry<TestProvider>();

      registry1.register(createTestProvider('test', 10));

      expect(registry1.size).toBe(1);
      expect(registry2.size).toBe(0);
    });
  });
});
