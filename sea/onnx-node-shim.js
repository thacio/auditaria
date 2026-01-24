/**
 * ONNX Runtime Node Shim for Bun Executables
 *
 * This shim replaces onnxruntime-node which has native bindings that don't work in Bun.
 * Instead of throwing, we re-export onnxruntime-web/wasm so that if the code
 * somehow still uses onnxruntime-node, it gets the WASM runtime.
 *
 * This handles the case where IS_NODE_ENV detection might not work as expected.
 */

// Re-export everything from onnxruntime-web/wasm
// This way, if code uses onnxruntime-node, it actually gets onnxruntime-web
export * from 'onnxruntime-web/wasm';
export { default } from 'onnxruntime-web/wasm';
