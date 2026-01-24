/**
 * ONNX Runtime Shim for Bun Executables
 *
 * This shim intercepts imports of onnxruntime-node and onnxruntime-web
 * and provides the WASM-based ONNX runtime that works in Bun executables.
 *
 * The key insight is that @huggingface/transformers checks for
 * Symbol.for('onnxruntime') in globalThis first, before using the imports.
 * But the static imports still happen and need to succeed.
 *
 * This module:
 * 1. Loads the bundled onnxruntime-web (WASM version)
 * 2. Exports it in a way that's compatible with both import patterns
 */

// Re-export everything from the bundled ONNX web runtime
// This file will be aliased to replace both onnxruntime-node and onnxruntime-web
export * from 'onnxruntime-web/dist/ort.bundle.min.mjs';
export { default } from 'onnxruntime-web/dist/ort.bundle.min.mjs';
