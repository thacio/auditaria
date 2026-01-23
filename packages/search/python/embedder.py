#!/usr/bin/env python3
"""
Auditaria Python Embedder - ONNX-based embedding generation.

This script produces IDENTICAL embeddings to the Node.js TransformersJsEmbedder
by using the same ONNX model files with onnxruntime.

Communication Protocol:
- Receives JSON Lines on stdin
- Outputs JSON Lines on stdout
- Errors go to stderr (for debugging)

Request types:
- init: Initialize the model
- embed: Embed single text
- embed_batch: Embed multiple texts
- embed_query: Embed query with E5 prefix
- embed_document: Embed document with E5 prefix
- embed_batch_documents: Embed multiple documents with E5 prefix
- shutdown: Clean exit

Response types:
- ready: Initialization complete
- embedding: Single embedding result
- embeddings: Batch embedding result
- error: Error occurred
- progress: Progress update
"""

import sys
import json
import os
import unicodedata
from pathlib import Path
from typing import Optional, List, Dict, Any


# =============================================================================
# Text Sanitization - Matches transformers.js BertNormalizer._clean_text()
# =============================================================================
# This implementation is a 1-to-1 port of the sanitization logic from
# @huggingface/transformers/src/tokenizers.js to ensure identical text
# preprocessing between Node and Python embedders.
# =============================================================================

def _is_control(char: str) -> bool:
    """
    Check if character is a control character.

    Matches transformers.js BertNormalizer._is_control() exactly:
    - Returns False for tab, newline, carriage return (treated as whitespace)
    - Returns True for Unicode categories: Cc (Control), Cf (Format),
      Co (Private Use), Cs (Surrogate)

    Reference: @huggingface/transformers/src/tokenizers.js lines 1289-1305
    """
    # Tab, newline, carriage return are treated as whitespace, not control
    if char in ('\t', '\n', '\r'):
        return False

    # Get Unicode category
    # This matches JavaScript's /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u regex
    try:
        category = unicodedata.category(char)
        return category in ('Cc', 'Cf', 'Co', 'Cs')
    except (ValueError, TypeError):
        # If we can't determine category, treat as control (safe fallback)
        return True


def _is_whitespace(char: str) -> bool:
    """
    Check if character is whitespace.

    Matches JavaScript's /^\s$/ regex behavior.
    Python's str.isspace() is equivalent for practical purposes.
    """
    return char.isspace()


def clean_text(text: str) -> str:
    """
    Clean text by removing problematic characters.

    This is a 1-to-1 port of transformers.js BertNormalizer._clean_text():
    - Removes null bytes (code point 0)
    - Removes Unicode replacement character (U+FFFD)
    - Removes control characters (Cc, Cf, Co, Cs - includes surrogates)
    - Normalizes all whitespace to regular spaces

    Reference: @huggingface/transformers/src/tokenizers.js lines 1313-1327

    Args:
        text: Input text that may contain invalid Unicode

    Returns:
        Cleaned text safe for tokenization
    """
    if not text:
        return ""

    output = []
    for char in text:
        cp = ord(char)

        # Skip null byte, replacement character, and control characters
        # This matches: if (cp === 0 || cp === 0xFFFD || this._is_control(char))
        if cp == 0 or cp == 0xFFFD or _is_control(char):
            continue

        # Normalize whitespace to regular space
        # This matches: if (/^\s$/.test(char)) { output.push(" "); }
        if _is_whitespace(char):
            output.append(' ')
        else:
            output.append(char)

    return ''.join(output)


# Alias for backward compatibility
sanitize_unicode = clean_text

# Check dependencies before importing
def check_dependencies() -> Optional[str]:
    """Check if required dependencies are installed."""
    missing = []

    try:
        import numpy
    except ImportError:
        missing.append("numpy")

    try:
        import onnxruntime
    except ImportError:
        missing.append("onnxruntime")

    try:
        from transformers import AutoTokenizer
    except ImportError:
        missing.append("transformers")

    if missing:
        return f"Missing dependencies: {', '.join(missing)}. Install with: pip install {' '.join(missing)}"

    return None


def send_response(response: Dict[str, Any]) -> None:
    """Send a JSON response to stdout."""
    print(json.dumps(response), flush=True)


def send_error(message: str, request_id: Optional[str] = None) -> None:
    """Send an error response."""
    response = {"type": "error", "message": message}
    if request_id:
        response["id"] = request_id
    send_response(response)


def log_debug(message: str) -> None:
    """Log debug message to stderr."""
    print(f"[PythonEmbedder] {message}", file=sys.stderr, flush=True)


# Check dependencies first
dep_error = check_dependencies()
if dep_error:
    send_error(dep_error)
    sys.exit(1)

# Now import the actual dependencies
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer


class OnnxEmbedder:
    """
    ONNX-based text embedder that produces identical embeddings to TransformersJsEmbedder.

    Uses the same model files from HuggingFace cache to ensure bit-identical results.
    """

    # Model configuration
    DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small"
    MODEL_DIMENSIONS = {
        "Xenova/multilingual-e5-small": 384,
        "Xenova/multilingual-e5-base": 768,
        "Xenova/multilingual-e5-large": 1024,
        "intfloat/multilingual-e5-small": 384,
        "intfloat/multilingual-e5-base": 768,
        "intfloat/multilingual-e5-large": 1024,
    }

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        quantization: str = "q8",
        cache_dir: Optional[str] = None,
        batch_size: int = 16,
    ):
        self.model_id = model_id
        self.quantization = quantization
        self.cache_dir = cache_dir
        self.batch_size = batch_size
        self.dimensions = self.MODEL_DIMENSIONS.get(model_id, 384)

        self.session: Optional[ort.InferenceSession] = None
        self.tokenizer = None
        self._ready = False

    def _find_onnx_model_path(self) -> Optional[Path]:
        """
        Find the ONNX model in HuggingFace cache.

        Transformers.js downloads models to:
        ~/.cache/huggingface/hub/models--{org}--{model}/snapshots/{hash}/onnx/
        """
        # Determine cache directory
        if self.cache_dir:
            cache_base = Path(self.cache_dir)
        else:
            # Default HuggingFace cache location
            cache_base = Path.home() / ".cache" / "huggingface" / "hub"

        # Convert model ID to cache directory format
        # e.g., "Xenova/multilingual-e5-small" -> "models--Xenova--multilingual-e5-small"
        model_dir_name = "models--" + self.model_id.replace("/", "--")
        model_cache = cache_base / model_dir_name

        if not model_cache.exists():
            log_debug(f"Model cache not found at {model_cache}")
            return None

        # Find snapshots directory
        snapshots_dir = model_cache / "snapshots"
        if not snapshots_dir.exists():
            log_debug(f"Snapshots directory not found at {snapshots_dir}")
            return None

        # Get the latest snapshot (there might be multiple)
        snapshots = list(snapshots_dir.iterdir())
        if not snapshots:
            log_debug("No snapshots found")
            return None

        # Use the most recently modified snapshot
        latest_snapshot = max(snapshots, key=lambda p: p.stat().st_mtime)

        # Find ONNX file based on quantization
        onnx_dir = latest_snapshot / "onnx"
        if not onnx_dir.exists():
            log_debug(f"ONNX directory not found at {onnx_dir}")
            return None

        # Determine which ONNX file to use
        if self.quantization == "q8":
            onnx_file = onnx_dir / "model_quantized.onnx"
            if not onnx_file.exists():
                # Fallback to regular model
                onnx_file = onnx_dir / "model.onnx"
        elif self.quantization == "q4":
            onnx_file = onnx_dir / "model_q4.onnx"
            if not onnx_file.exists():
                onnx_file = onnx_dir / "model_quantized.onnx"
        else:
            # fp16 or fp32 - use regular model
            onnx_file = onnx_dir / "model.onnx"

        if onnx_file.exists():
            return onnx_file

        # Try any ONNX file in the directory
        onnx_files = list(onnx_dir.glob("*.onnx"))
        if onnx_files:
            return onnx_files[0]

        return None

    def _download_model_if_needed(self) -> Path:
        """
        Download the model using HuggingFace hub if not in cache.
        Returns the path to the ONNX model file.
        """
        # First check if model is already cached
        cached_path = self._find_onnx_model_path()
        if cached_path:
            log_debug(f"Found cached model at {cached_path}")
            return cached_path

        # Model not found, try to download using huggingface_hub
        log_debug(f"Model not in cache, attempting to download {self.model_id}")

        try:
            from huggingface_hub import hf_hub_download, snapshot_download

            # Download the entire ONNX directory
            send_response({
                "type": "progress",
                "stage": "download",
                "progress": 0,
                "message": f"Downloading model {self.model_id}..."
            })

            # Download snapshot
            local_dir = snapshot_download(
                repo_id=self.model_id,
                allow_patterns=["onnx/*", "tokenizer*", "*.json"],
                cache_dir=self.cache_dir,
            )

            send_response({
                "type": "progress",
                "stage": "download",
                "progress": 100,
                "message": "Download complete"
            })

            # Now find the model
            cached_path = self._find_onnx_model_path()
            if cached_path:
                return cached_path

            raise FileNotFoundError("Model downloaded but ONNX file not found")

        except ImportError:
            raise ImportError(
                "huggingface_hub is required to download models. "
                "Install with: pip install huggingface_hub"
            )

    def initialize(self, on_progress=None) -> None:
        """Initialize the ONNX session and tokenizer."""
        if self._ready:
            return

        if on_progress:
            on_progress("load", 0, "Loading model...")

        # Find or download the model
        onnx_path = self._download_model_if_needed()
        log_debug(f"Loading ONNX model from {onnx_path}")

        if on_progress:
            on_progress("load", 30, "Creating ONNX session...")

        # Create ONNX Runtime session
        # Use CPU execution provider for consistency
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        # Try to use available providers
        providers = ['CPUExecutionProvider']

        self.session = ort.InferenceSession(
            str(onnx_path),
            sess_options,
            providers=providers,
        )

        if on_progress:
            on_progress("load", 60, "Loading tokenizer...")

        # Load tokenizer - try the source model ID first
        tokenizer_model = self.model_id
        if tokenizer_model.startswith("Xenova/"):
            # Xenova models are conversions, use the original model for tokenizer
            tokenizer_model = tokenizer_model.replace("Xenova/", "intfloat/")

        try:
            self.tokenizer = AutoTokenizer.from_pretrained(
                tokenizer_model,
                cache_dir=self.cache_dir,
            )
        except Exception:
            # Fallback to original model ID
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_id,
                cache_dir=self.cache_dir,
            )

        if on_progress:
            on_progress("ready", 100, "Model loaded successfully")

        self._ready = True
        log_debug("Embedder initialized successfully")

    def is_ready(self) -> bool:
        """Check if the embedder is ready."""
        return self._ready

    def _mean_pooling(
        self,
        token_embeddings: np.ndarray,
        attention_mask: np.ndarray
    ) -> np.ndarray:
        """
        Apply mean pooling to token embeddings.

        Args:
            token_embeddings: Shape (batch, seq_len, hidden_dim)
            attention_mask: Shape (batch, seq_len)

        Returns:
            Pooled embeddings of shape (batch, hidden_dim)
        """
        # Expand attention mask to hidden dimension
        mask_expanded = np.expand_dims(attention_mask, axis=-1).astype(np.float32)

        # Sum embeddings weighted by attention mask
        sum_embeddings = np.sum(token_embeddings * mask_expanded, axis=1)

        # Sum mask for normalization
        sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)

        return sum_embeddings / sum_mask

    def _l2_normalize(self, embeddings: np.ndarray) -> np.ndarray:
        """
        Apply L2 normalization to embeddings.

        Args:
            embeddings: Shape (batch, hidden_dim) or (hidden_dim,)

        Returns:
            Normalized embeddings with same shape
        """
        if embeddings.ndim == 1:
            norm = np.linalg.norm(embeddings)
            return embeddings / max(norm, 1e-9)
        else:
            norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
            return embeddings / np.clip(norms, a_min=1e-9, a_max=None)

    def embed(self, text: str) -> List[float]:
        """
        Generate embedding for a single text.

        Args:
            text: Input text

        Returns:
            Embedding as a list of floats
        """
        if not self._ready:
            raise RuntimeError("Embedder not initialized")

        result = self.embed_batch([text])
        return result[0]

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts.

        Args:
            texts: List of input texts

        Returns:
            List of embeddings
        """
        if not self._ready:
            raise RuntimeError("Embedder not initialized")

        if not texts:
            return []

        # Handle edge cases: ensure texts is a list
        if not isinstance(texts, list):
            texts = [texts] if texts else []

        # Flatten if nested list (e.g., [["text1", "text2"]] -> ["text1", "text2"])
        if texts and isinstance(texts[0], list):
            flattened = []
            for item in texts:
                if isinstance(item, list):
                    flattened.extend(item)
                else:
                    flattened.append(item)
            texts = flattened

        # Sanitize texts using clean_text (matches transformers.js BertNormalizer)
        # This removes surrogates, control chars, and normalizes whitespace
        sanitized_texts = []
        for t in texts:
            if t is None:
                sanitized_texts.append("")
            elif not isinstance(t, str):
                sanitized_texts.append(clean_text(str(t)))
            else:
                sanitized_texts.append(clean_text(t))

        if not sanitized_texts:
            return []

        # Tokenize
        encoded = self.tokenizer(
            sanitized_texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="np",
        )

        input_ids = encoded["input_ids"].astype(np.int64)
        attention_mask = encoded["attention_mask"].astype(np.int64)

        # Get input names from model
        input_names = [inp.name for inp in self.session.get_inputs()]

        # Prepare inputs
        ort_inputs = {}
        if "input_ids" in input_names:
            ort_inputs["input_ids"] = input_ids
        if "attention_mask" in input_names:
            ort_inputs["attention_mask"] = attention_mask
        if "token_type_ids" in input_names:
            # Create token_type_ids (all zeros)
            ort_inputs["token_type_ids"] = np.zeros_like(input_ids)

        # Run inference
        outputs = self.session.run(None, ort_inputs)

        # Get token embeddings (usually the first output)
        # Shape: (batch, seq_len, hidden_dim)
        token_embeddings = outputs[0]

        # Apply mean pooling
        pooled = self._mean_pooling(token_embeddings, attention_mask.astype(np.float32))

        # Apply L2 normalization
        normalized = self._l2_normalize(pooled)

        return normalized.tolist()

    def is_e5_model(self) -> bool:
        """Check if using an E5 model that requires prefixes."""
        return "e5" in self.model_id.lower()

    def embed_query(self, query: str) -> List[float]:
        """
        Generate embedding for a search query.
        For E5 models, adds "query: " prefix.
        """
        # Sanitize query using clean_text (matches transformers.js)
        if query is None:
            query = ""
        elif not isinstance(query, str):
            query = str(query)
        query = clean_text(query)
        prefixed = f"query: {query}" if self.is_e5_model() else query
        return self.embed(prefixed)

    def embed_document(self, text: str) -> List[float]:
        """
        Generate embedding for a document/passage.
        For E5 models, adds "passage: " prefix.
        """
        # Sanitize text using clean_text (matches transformers.js)
        if text is None:
            text = ""
        elif not isinstance(text, str):
            text = str(text)
        text = clean_text(text)
        prefixed = f"passage: {text}" if self.is_e5_model() else text
        return self.embed(prefixed)

    def embed_batch_documents(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple documents/passages.
        For E5 models, adds "passage: " prefix to each.
        """
        # Sanitize texts using clean_text (matches transformers.js)
        sanitized = []
        for t in texts:
            if t is None:
                sanitized.append("")
            elif not isinstance(t, str):
                sanitized.append(clean_text(str(t)))
            else:
                sanitized.append(clean_text(t))

        if self.is_e5_model():
            sanitized = [f"passage: {t}" for t in sanitized]
        return self.embed_batch(sanitized)

    def dispose(self) -> None:
        """Release resources."""
        self.session = None
        self.tokenizer = None
        self._ready = False


# ============================================================================
# Main Loop
# ============================================================================

def main():
    """Main JSONL communication loop."""
    # Ensure UTF-8 encoding for stdin/stdout (critical on Windows)
    # This is a safety measure in case PYTHONIOENCODING is not set
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    embedder: Optional[OnnxEmbedder] = None

    log_debug("Python embedder started, waiting for commands...")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            send_error(f"Invalid JSON: {e}")
            continue

        req_type = request.get("type")
        req_id = request.get("id")

        try:
            if req_type == "init":
                # Initialize the embedder
                model = request.get("model", OnnxEmbedder.DEFAULT_MODEL_ID)
                quantization = request.get("quantization", "q8")
                cache_dir = request.get("cache_dir")
                batch_size = request.get("batch_size", 16)

                embedder = OnnxEmbedder(
                    model_id=model,
                    quantization=quantization,
                    cache_dir=cache_dir,
                    batch_size=batch_size,
                )

                def on_progress(stage, progress, message):
                    send_response({
                        "type": "progress",
                        "stage": stage,
                        "progress": progress,
                        "message": message,
                    })

                embedder.initialize(on_progress)

                send_response({
                    "type": "ready",
                    "dimensions": embedder.dimensions,
                    "model": embedder.model_id,
                    "quantization": embedder.quantization,
                })

            elif req_type == "embed":
                if not embedder or not embedder.is_ready():
                    send_error("Embedder not initialized", req_id)
                    continue

                text = request.get("text", "")
                embedding = embedder.embed(text)

                send_response({
                    "type": "embedding",
                    "id": req_id,
                    "embedding": embedding,
                })

            elif req_type == "embed_batch":
                if not embedder or not embedder.is_ready():
                    send_error("Embedder not initialized", req_id)
                    continue

                texts = request.get("texts", [])
                embeddings = embedder.embed_batch(texts)

                send_response({
                    "type": "embeddings",
                    "id": req_id,
                    "embeddings": embeddings,
                })

            elif req_type == "embed_query":
                if not embedder or not embedder.is_ready():
                    send_error("Embedder not initialized", req_id)
                    continue

                query = request.get("text", "")
                embedding = embedder.embed_query(query)

                send_response({
                    "type": "embedding",
                    "id": req_id,
                    "embedding": embedding,
                })

            elif req_type == "embed_document":
                if not embedder or not embedder.is_ready():
                    send_error("Embedder not initialized", req_id)
                    continue

                text = request.get("text", "")
                embedding = embedder.embed_document(text)

                send_response({
                    "type": "embedding",
                    "id": req_id,
                    "embedding": embedding,
                })

            elif req_type == "embed_batch_documents":
                if not embedder or not embedder.is_ready():
                    send_error("Embedder not initialized", req_id)
                    continue

                texts = request.get("texts", [])
                embeddings = embedder.embed_batch_documents(texts)

                send_response({
                    "type": "embeddings",
                    "id": req_id,
                    "embeddings": embeddings,
                })

            elif req_type == "shutdown":
                if embedder:
                    embedder.dispose()
                log_debug("Shutting down")
                break

            else:
                send_error(f"Unknown request type: {req_type}", req_id)

        except Exception as e:
            log_debug(f"Error processing request: {e}")
            send_error(str(e), req_id)

    log_debug("Python embedder exiting")


if __name__ == "__main__":
    main()
