/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIBSQL_OPTIONS,
  DEFAULT_PGLITE_OPTIONS,
  DEFAULT_SQLITE_OPTIONS,
  DEFAULT_LANCEDB_OPTIONS,
  getDefaultBackendOptions,
  mergeBackendOptions,
  getTypedBackendOptions,
  validateBackendOptions,
  type BackendOptions,
  type BackendOptionsMap,
} from './backend-options.js';

describe('backend-options', () => {
  // ==========================================================================
  // Default Values
  // ==========================================================================

  describe('default values', () => {
    it('should have correct libsql defaults', () => {
      expect(DEFAULT_LIBSQL_OPTIONS).toEqual({
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should have empty pglite defaults', () => {
      expect(DEFAULT_PGLITE_OPTIONS).toEqual({});
    });

    it('should have empty sqlite defaults', () => {
      expect(DEFAULT_SQLITE_OPTIONS).toEqual({});
    });

    it('should have empty lancedb defaults', () => {
      expect(DEFAULT_LANCEDB_OPTIONS).toEqual({});
    });
  });

  // ==========================================================================
  // getDefaultBackendOptions
  // ==========================================================================

  describe('getDefaultBackendOptions', () => {
    it('should return libsql defaults with discriminator', () => {
      const options = getDefaultBackendOptions('libsql');
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should return pglite defaults with discriminator', () => {
      const options = getDefaultBackendOptions('pglite');
      expect(options).toEqual({
        backend: 'pglite',
      });
    });

    it('should return sqlite defaults with discriminator', () => {
      const options = getDefaultBackendOptions('sqlite');
      expect(options).toEqual({
        backend: 'sqlite',
      });
    });

    it('should return lancedb defaults with discriminator', () => {
      const options = getDefaultBackendOptions('lancedb');
      expect(options).toEqual({
        backend: 'lancedb',
      });
    });
  });

  // ==========================================================================
  // mergeBackendOptions
  // ==========================================================================

  describe('mergeBackendOptions', () => {
    it('should return defaults when no user options provided', () => {
      const options = mergeBackendOptions('libsql');
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should return defaults when user options is empty', () => {
      const options = mergeBackendOptions('libsql', {});
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should return defaults when user options has different backend', () => {
      const userOptions: BackendOptionsMap = {
        pglite: {},
      };
      const options = mergeBackendOptions('libsql', userOptions);
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should merge partial libsql options with defaults', () => {
      const userOptions: BackendOptionsMap = {
        libsql: {
          maxNeighbors: 50,
        },
      };
      const options = mergeBackendOptions('libsql', userOptions);
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 50, // User override
      });
    });

    it('should merge multiple libsql options', () => {
      const userOptions: BackendOptionsMap = {
        libsql: {
          metric: 'l2',
          compressNeighbors: null,
          maxNeighbors: 30,
        },
      };
      const options = mergeBackendOptions('libsql', userOptions);
      expect(options).toEqual({
        backend: 'libsql',
        metric: 'l2',
        compressNeighbors: null,
        maxNeighbors: 30,
      });
    });

    it('should merge lancedb options', () => {
      const userOptions: BackendOptionsMap = {
        lancedb: {
          numPartitions: 100,
        },
      };
      const options = mergeBackendOptions('lancedb', userOptions);
      expect(options).toEqual({
        backend: 'lancedb',
        numPartitions: 100,
      });
    });
  });

  // ==========================================================================
  // getTypedBackendOptions
  // ==========================================================================

  describe('getTypedBackendOptions', () => {
    it('should return undefined for undefined options', () => {
      const result = getTypedBackendOptions(undefined, 'libsql');
      expect(result).toBeUndefined();
    });

    it('should return undefined for mismatched backend', () => {
      const options: BackendOptions = {
        backend: 'pglite',
      };
      const result = getTypedBackendOptions(options, 'libsql');
      expect(result).toBeUndefined();
    });

    it('should return typed options for matching backend', () => {
      const options: BackendOptions = {
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      };
      const result = getTypedBackendOptions(options, 'libsql');
      expect(result).toEqual({
        backend: 'libsql',
        metric: 'cosine',
        compressNeighbors: 'float8',
        maxNeighbors: 20,
      });
    });

    it('should provide type narrowing for libsql', () => {
      const options: BackendOptions = {
        backend: 'libsql',
        metric: 'l2',
        compressNeighbors: null,
        maxNeighbors: 50,
      };
      const typed = getTypedBackendOptions(options, 'libsql');
      if (typed) {
        // TypeScript should know this is LibSQLBackendOptions
        expect(typed.metric).toBe('l2');
        expect(typed.maxNeighbors).toBe(50);
      }
    });
  });

  // ==========================================================================
  // validateBackendOptions
  // ==========================================================================

  describe('validateBackendOptions', () => {
    describe('libsql validation', () => {
      it('should pass for valid libsql options', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'float8',
          maxNeighbors: 20,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for l2 metric', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'l2',
          compressNeighbors: 'float8',
          maxNeighbors: 20,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for inner_product metric', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'inner_product',
          compressNeighbors: 'float8',
          maxNeighbors: 20,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for null compressNeighbors', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: null,
          maxNeighbors: 20,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for float1bit compressNeighbors', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'float1bit',
          maxNeighbors: 20,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should throw for invalid metric', () => {
        const options = {
          backend: 'libsql',
          metric: 'invalid',
          compressNeighbors: 'float8',
          maxNeighbors: 20,
        } as unknown as BackendOptions;
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid libsql metric/,
        );
      });

      it('should throw for invalid compressNeighbors', () => {
        const options = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'invalid',
          maxNeighbors: 20,
        } as unknown as BackendOptions;
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid libsql compressNeighbors/,
        );
      });

      it('should throw for zero maxNeighbors', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'float8',
          maxNeighbors: 0,
        };
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid libsql maxNeighbors/,
        );
      });

      it('should throw for negative maxNeighbors', () => {
        const options: BackendOptions = {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'float8',
          maxNeighbors: -5,
        };
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid libsql maxNeighbors/,
        );
      });
    });

    describe('lancedb validation', () => {
      it('should pass for valid lancedb options', () => {
        const options: BackendOptions = {
          backend: 'lancedb',
          numPartitions: 100,
          numSubVectors: 8,
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for empty lancedb options', () => {
        const options: BackendOptions = {
          backend: 'lancedb',
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should throw for zero numPartitions', () => {
        const options: BackendOptions = {
          backend: 'lancedb',
          numPartitions: 0,
        };
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid lancedb numPartitions/,
        );
      });

      it('should throw for negative numSubVectors', () => {
        const options: BackendOptions = {
          backend: 'lancedb',
          numSubVectors: -1,
        };
        expect(() => validateBackendOptions(options)).toThrow(
          /Invalid lancedb numSubVectors/,
        );
      });
    });

    describe('other backends validation', () => {
      it('should pass for empty pglite options', () => {
        const options: BackendOptions = {
          backend: 'pglite',
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });

      it('should pass for empty sqlite options', () => {
        const options: BackendOptions = {
          backend: 'sqlite',
        };
        expect(() => validateBackendOptions(options)).not.toThrow();
      });
    });
  });

  // ==========================================================================
  // Type Narrowing
  // ==========================================================================

  describe('type narrowing', () => {
    it('should narrow types based on backend discriminator', () => {
      const options: BackendOptions = getDefaultBackendOptions('libsql');

      // TypeScript narrows based on backend property
      if (options.backend === 'libsql') {
        // These properties should be accessible
        const metric: 'cosine' | 'l2' | 'inner_product' = options.metric;
        const maxNeighbors: number = options.maxNeighbors;
        expect(metric).toBe('cosine');
        expect(maxNeighbors).toBe(20);
      }
    });

    it('should support switch-based narrowing', () => {
      const options: BackendOptions = getDefaultBackendOptions('lancedb');

      switch (options.backend) {
        case 'libsql':
          // Should not reach here
          expect(options.maxNeighbors).toBeDefined();
          break;
        case 'lancedb':
          // Should reach here
          expect(options.backend).toBe('lancedb');
          break;
        case 'pglite':
        case 'sqlite':
          // Should not reach here
          break;
        default:
          // Exhaustive check
          break;
      }
    });
  });
});
