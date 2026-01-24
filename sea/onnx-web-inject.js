/**
 * ONNX Runtime Web Injection for Bun Executables
 *
 * TransformersJS checks for Symbol.for('onnxruntime') in globalThis first.
 * If found, it uses that instead of importing onnxruntime-node or onnxruntime-web.
 *
 * IMPORTANT: We use 'onnxruntime-web/wasm' which:
 * - Has the WASM backend bundled (ort.wasm.bundle.min.mjs)
 * - Doesn't have "node" condition, so it uses the default import
 * - Works without WebGL/WebGPU (pure WASM)
 */

// Import the WASM-only bundle which has no "node" condition
// This ensures we get the WASM backend, not the node version
import * as ort from 'onnxruntime-web/wasm';

// Set the ONNX runtime on globalThis using the symbol that TransformersJS checks
const ORT_SYMBOL = Symbol.for('onnxruntime');
globalThis[ORT_SYMBOL] = ort.default ?? ort;

console.log('[Bun] Registered ONNX runtime (WASM) via Symbol.for("onnxruntime")');

export default ort;
