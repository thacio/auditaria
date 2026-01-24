/**
 * Sharp shim for Bun executables
 *
 * Sharp is used by @huggingface/transformers for image processing.
 * Since we only use text embeddings, we provide this shim to prevent
 * the import from failing while allowing the code to detect that
 * image processing is not available.
 *
 * This shim:
 * 1. Exports a function that looks like sharp()
 * 2. Returns an object with chainable methods that throw when actually used
 * 3. Allows the transformers.js image.js module to load without crashing
 */

function sharpShim(input) {
  const notAvailable = () => {
    throw new Error(
      'Sharp image processing is not available in Bun executables. ' +
      'This feature requires native binaries that cannot be bundled. ' +
      'Text embeddings work fine without this.'
    );
  };

  // Return a chainable object that throws when actually used
  const chainable = {
    metadata: notAvailable,
    rotate: () => chainable,
    raw: () => chainable,
    toBuffer: notAvailable,
    resize: () => chainable,
    toFormat: () => chainable,
    jpeg: () => chainable,
    png: () => chainable,
    webp: () => chainable,
    toFile: notAvailable,
    clone: () => sharpShim(input),
  };

  return chainable;
}

// Export as default (how it's imported in transformers.js)
export default sharpShim;

// Also export as named for any other import patterns
export { sharpShim as sharp };
