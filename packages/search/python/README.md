# Auditaria Python Embedder

This is an alternative embedding implementation using Python's ONNX runtime that
produces **IDENTICAL** embeddings to the Node.js TransformersJsEmbedder.

## Why Python?

The Python embedder offers several advantages for certain use cases:

1. **Better memory management** - Python's ML ecosystem has more mature memory
   handling for large-scale indexing jobs
2. **Shared knowledge bases** - Because embeddings are identical, teams can
   share knowledge bases regardless of whether they use Python or Node.js for
   indexing
3. **Flexibility** - Users can choose the implementation that works best for
   their environment

## Requirements

- Python 3.8 or later
- pip (Python package manager)

## Installation

```bash
# Navigate to the Python directory
cd packages/search/python

# Install dependencies
pip install -r requirements.txt
```

Or install dependencies directly:

```bash
pip install onnxruntime transformers numpy huggingface_hub
```

## Usage

### Enable Python Embedder

In your search system configuration, set `preferPythonEmbedder: true`:

```typescript
import { SearchSystem } from '@thacio/auditaria/search';

const searchSystem = await SearchSystem.initialize({
  config: {
    embeddings: {
      preferPythonEmbedder: true,
    },
  },
});
```

### Fallback Behavior

If Python is not available or initialization fails, the system automatically
falls back to the Node.js embedder. This means you can safely enable
`preferPythonEmbedder` without worrying about breaking functionality.

## How It Works

### IDENTICAL Embeddings

Both the Node.js (TransformersJsEmbedder) and Python (OnnxEmbedder)
implementations:

1. Use the same ONNX model files from HuggingFace cache
2. Apply the same tokenization using the same tokenizer
3. Use mean pooling for token embeddings
4. Apply L2 normalization
5. Handle E5 prefixes (`query:` and `passage:`) identically

This guarantees bit-identical embeddings regardless of which implementation is
used.

### Communication Protocol

The Python script (`embedder.py`) communicates with Node.js via JSON Lines
(JSONL) over stdin/stdout:

**Requests (Node.js → Python):**

```json
{"type": "init", "model": "Xenova/multilingual-e5-small", "quantization": "q8"}
{"type": "embed_batch_documents", "id": "req_1", "texts": ["document 1", "document 2"]}
{"type": "embed_query", "id": "req_2", "text": "search query"}
{"type": "shutdown"}
```

**Responses (Python → Node.js):**

```json
{"type": "ready", "dimensions": 384}
{"type": "embeddings", "id": "req_1", "embeddings": [[...], [...]]}
{"type": "embedding", "id": "req_2", "embedding": [...]}
```

## Troubleshooting

### Python Not Found

If you see "Python not available" in the logs:

1. Ensure Python 3.8+ is installed: `python3 --version` or `python --version`
2. Make sure Python is in your system PATH
3. On Windows, try `py -3 --version`

### Missing Dependencies

If you see "Missing dependencies" errors:

```bash
pip install onnxruntime transformers numpy huggingface_hub
```

### Model Download Issues

The embedder uses models from HuggingFace. If download fails:

1. Check your internet connection
2. Ensure you have write access to `~/.cache/huggingface/`
3. Try downloading manually:
   ```python
   from huggingface_hub import snapshot_download
   snapshot_download("Xenova/multilingual-e5-small", allow_patterns=["onnx/*", "tokenizer*", "*.json"])
   ```

### Memory Issues

For large indexing jobs, Python may use significant memory. Solutions:

1. Reduce batch size in configuration
2. Process files in smaller chunks
3. Use a machine with more RAM

## Development

### Running the Script Directly

For debugging, you can run the Python script directly:

```bash
cd packages/search/python
python embedder.py
```

Then send JSONL commands via stdin:

```json
{"type": "init", "model": "Xenova/multilingual-e5-small", "quantization": "q8"}
{"type": "embed_document", "id": "test", "text": "Hello, world!"}
{"type": "shutdown"}
```

### Debug Logging

Enable debug logging by checking stderr output. The script logs to stderr (not
stdout) to keep the JSONL protocol clean.

## Model Support

Currently supported models:

- `Xenova/multilingual-e5-small` (384 dimensions) - Default
- `Xenova/multilingual-e5-base` (768 dimensions)
- `Xenova/multilingual-e5-large` (1024 dimensions)

The Python embedder automatically handles the `Xenova/` prefix and downloads
models from HuggingFace.
