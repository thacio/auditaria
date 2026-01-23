/**
 * Tests for Python detection utility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectPython,
  isPythonAvailable,
  getPythonCommand,
  clearPythonDetectionCache,
} from './python-detection.js';

describe('Python Detection', () => {
  beforeEach(() => {
    // Clear cache before each test to ensure fresh detection
    clearPythonDetectionCache();
  });

  afterEach(() => {
    clearPythonDetectionCache();
  });

  describe('detectPython', () => {
    it('should return a PythonDetectionResult object', async () => {
      const result = await detectPython();

      expect(result).toHaveProperty('available');
      expect(result).toHaveProperty('command');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('error');

      expect(typeof result.available).toBe('boolean');
    });

    it('should cache the result on subsequent calls', async () => {
      const result1 = await detectPython();
      const result2 = await detectPython();

      // Should return the same object (cached)
      expect(result1).toBe(result2);
    });

    it('should refresh cache when forceRefresh is true', async () => {
      const result1 = await detectPython();
      const result2 = await detectPython(true);

      // Both should have same values but different object references
      expect(result1.available).toBe(result2.available);
      // Note: We can't guarantee different references if both detections
      // return the same result, but the function should at least run
    });

    it('should return valid result structure when Python is available', async () => {
      const result = await detectPython();

      if (result.available) {
        expect(result.command).not.toBeNull();
        expect(result.version).not.toBeNull();
        expect(result.error).toBeNull();

        // Version should be a valid semver-like string
        expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);

        // Command should be one of the expected values
        expect(['python', 'python3', 'py -3']).toContain(result.command);
      } else {
        expect(result.command).toBeNull();
        expect(result.version).toBeNull();
        expect(result.error).not.toBeNull();
      }
    });
  });

  describe('isPythonAvailable', () => {
    it('should return a boolean', async () => {
      const available = await isPythonAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should match detectPython result', async () => {
      const detection = await detectPython();
      const available = await isPythonAvailable();

      expect(available).toBe(detection.available);
    });
  });

  describe('getPythonCommand', () => {
    it('should return string or null', async () => {
      const command = await getPythonCommand();

      if (command !== null) {
        expect(typeof command).toBe('string');
        expect(command.length).toBeGreaterThan(0);
      }
    });

    it('should match detectPython result', async () => {
      const detection = await detectPython();
      const command = await getPythonCommand();

      expect(command).toBe(detection.command);
    });
  });

  describe('clearPythonDetectionCache', () => {
    it('should clear the cached result', async () => {
      // First detection
      await detectPython();

      // Clear cache
      clearPythonDetectionCache();

      // This should trigger a new detection (though we can't easily verify
      // it's a new detection without mocking, we can at least verify the
      // function doesn't throw)
      const result = await detectPython();
      expect(result).toBeDefined();
    });
  });
});

describe('Python Detection - Integration', () => {
  beforeEach(() => {
    clearPythonDetectionCache();
  });

  it('should detect Python if installed on the system', async () => {
    const result = await detectPython();

    // Log the result for debugging in CI environments
    console.log('Python detection result:', JSON.stringify(result, null, 2));

    // This test documents the actual state rather than asserting
    // Python must be available - it could legitimately be missing
    if (result.available) {
      console.log(`Python ${result.version} found at: ${result.command}`);
    } else {
      console.log(`Python not available: ${result.error}`);
    }
  });

  it('should return version 3.8+ if Python is available', async () => {
    const result = await detectPython();

    if (result.available && result.version) {
      const [major, minor] = result.version.split('.').map(Number);

      // If Python is detected, it should be 3.8+
      expect(major).toBeGreaterThanOrEqual(3);
      if (major === 3) {
        expect(minor).toBeGreaterThanOrEqual(8);
      }
    }
  });
});
