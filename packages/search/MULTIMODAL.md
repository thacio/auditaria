# Multimodal knowledge search

You can select EmbeddingGemma 2 to search images, PDF pages, audio, and video
directly from text queries. Inference runs locally. PGlite is the default
database for new knowledge bases; existing databases retain their backend and
embedding model.

## Enable EmbeddingGemma 2

The optional runtime uses Python 3.10 or newer, PyTorch, Sentence Transformers,
and Transformers. The first run downloads the model weights. Subsequent runs can
use the cached weights offline.

1. Install the runtime into your preferred Python environment:

   ```sh
   python -m pip install -r packages/search/python/requirements-gemma.txt
   ```

2. Install FFmpeg and make both `ffmpeg` and `ffprobe` available on `PATH` if
   you want audio or video indexing. For GPU inference, install the appropriate
   CUDA build of PyTorch and Torchvision in the same Python environment.

3. Set `.auditaria/knowledge-base.config.json` before initializing a new index:

   ```json
   {
     "config": {
       "database": {
         "backend": "pglite",
         "path": ".auditaria/knowledge-base-gemma.db"
       },
       "embeddings": {
         "model": "google/embeddinggemma-2",
         "device": "auto",
         "quantization": "fp32",
         "multimodal": true,
         "batchSize": 2
       }
     }
   }
   ```

4. Run `/knowledge-base init` and search with `/knowledge-base search` or the
   `knowledge_search` tool. `embeddings.pythonCommand` can select a Python
   executable in a virtual environment; use an executable path, without shell
   arguments.

The separate path in this example preserves your previous index. Embeddings from
different models aren't interchangeable, even when their dimensions match.
Existing index metadata takes precedence over a newly selected model.

The adapter uses normalized, 768-dimensional FP32 embeddings for both queries
and documents. It uses Google's query and document task prefixes for text and
embeds media without those prefixes. FP16 is unsafe for this model. Quantized
ONNX variants are a separate runtime and aren't selected by this integration.
See the
[EmbeddingGemma 2 model card](https://huggingface.co/google/embeddinggemma-2).

## How files become searchable

The media adapter prepares small source references, then decodes and embeds one
source at a time. File names and display labels aren't used as substitutes for
media embeddings.

| Input                     | Indexed unit                                | Search reference                   |
| ------------------------- | ------------------------------------------- | ---------------------------------- |
| Text and office documents | Existing text chunks                        | Existing offsets/sections          |
| Image                     | First image frame                           | File path                          |
| PDF                       | Rendered page                               | File path and page number          |
| Audio                     | Up to 30 seconds, mono at 16 kHz            | File path and seconds in `section` |
| Video                     | Up to 10 seconds, sampled at 1 frame/second | File path and seconds in `section` |
| Video audio track         | Separate audio segments                     | File path and seconds in `section` |

PDFs retain existing embedded text for keyword search. Images and scanned PDF
pages become semantically searchable without OCR. Their search excerpts are
explicit source labels, not transcriptions. Exact quotations and keyword
matching on scanned content still require text extraction or OCR.

Set `multimodal: false` to use the existing parsing/OCR path with text-only
Gemma and omit the vision/audio encoders. Other embedding models retain their
existing parsing and OCR behavior. Media indexing doesn't silently fall back to
text or another embedding model when decoding or inference fails.

Default discovery includes audio and video when Gemma's multimodal mode is
enabled. An explicit `indexing.fileTypes` list remains authoritative. Existing
file-size and ignore rules still apply.

The repository's sample configuration explicitly lists file types. Remove its
`indexing.fileTypes` override to use the model defaults, or add the audio and
video extensions you want to index.

Rendering uses at most 1,600 pixels on the longest PDF page edge. Video frames
fit in a padded 384-by-384 image. These settings bound memory use but can miss
small print and brief visual events. The initial validation below is a smoke
test, not an evaluation of recall on a large audit corpus.

## PGlite and vector extensions

New indexes use PGlite `0.5.10` (PostgreSQL `18.6`) and the separately published
pgvector package `0.0.11` (pgvector `0.8.7`). Both exact vector search and the
existing HNSW/IVFFlat options remain available.

Existing PostgreSQL 17 data directories use a pinned PGlite `0.3.16`
compatibility runtime. The application reads `PG_VERSION` before opening an
index; it doesn't open old files with a PostgreSQL 18 engine or implicitly
migrate them. To use PostgreSQL 18 for an existing knowledge base, initialize
another index at a new path. Session timestamps use UTC on both runtimes.

The executable builders embed both PostgreSQL runtimes, the new `initdb.wasm`,
and their matching vector extensions. A compiled Bun smoke test verified both
versions and preservation of an existing PostgreSQL 17 table. The Gemma Python
workers are also embedded; Python and its optional ML dependencies must still be
installed separately. Real text-only Gemma inference was verified from a
compiled Bun executable.

`pg_vectorsearch` is a different extension from `pgvector`. Its first tag was
released on October 13, 2026, but it has no published PGlite WASM package as
checked on October 20, 2026. A real `CREATE EXTENSION pg_vectorsearch` against
PGlite `0.5.10` returned SQLSTATE `0A000`, extension not available. No
unsupported backend option is advertised. See the
[extension releases](https://github.com/timescale/pg_vectorsearch/releases) and
[PGlite extension catalog](https://pglite.dev/extensions/).

## Validation and repeatable tests

The October 20, 2026 local smoke test used an NVIDIA RTX 4090 Laptop GPU with 16
GB VRAM, CUDA PyTorch `2.10.0`, Transformers `5.20.2`, and Sentence Transformers
`6.1.0`. The test exercised the Python worker, TypeScript adapter, indexing
pipeline, and PGlite vector retrieval together.

| Check                              | Result                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| Portuguese duplicate-payment query | Relevant audit text scored 0.861; unrelated text 0.591 |
| Cat photograph                     | Correct image ranked first; score 0.746                |
| Speech recording                   | Correct audio ranked first; score 0.770                |
| Turtle video                       | Correct video ranked first; score 0.749                |
| Synthetic scanned audit PDF        | Correct PDF ranked first; score 0.772; page 1 retained |
| OCR calls for these media files    | Zero                                                   |
| PostgreSQL 17 reopen               | Stored data preserved; major version unchanged         |

In this small test, indexing each media file took approximately 0.2–1.4 seconds
after model loading. Text-query embedding plus retrieval took approximately
40–106 milliseconds. These are single-run observations on four media items, not
comparative performance benchmarks. `pg_vectorsearch` speed wasn't tested
because its extension cannot be loaded in PGlite.

Run the ordinary regression tests from the repository root:

```sh
npm test -w @thacio/auditaria-search -- --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --testTimeout=30000 src/storage/pglite-runtime.test.ts src/indexing/media-indexing.test.ts src/embedders/EmbeddingGemmaEmbedder.test.ts
python -m unittest discover -s packages/search/python -p test_media_inputs.py
```

For real inference, put `cats.jpg`, `jfk.wav`, and `sea-turtle.mp4` from the
[Transformers.js example dataset](https://huggingface.co/datasets/Xenova/transformers.js-docs/tree/main)
into a fixture directory. Add a one-page scanned PDF named `audit-scan.pdf`
containing a duplicate-payment audit finding. Then run:

```sh
npm run test:multimodal -w @thacio/auditaria-search -- --fixtures /absolute/fixtures --python /absolute/python --device auto
```

This opt-in test uses an in-memory database and doesn't alter your knowledge
base. It fails if a media item doesn't rank first for its expected query.

## Boundaries for the later refactor

The new pieces have separate responsibilities:

- `embedders/PythonJsonlClient.ts` owns process lifecycle and request framing.
- `embedders/EmbeddingGemmaEmbedder.ts` owns the model adapter and validation.
- `embedders/media.ts` defines the optional media capability and typed sources.
- `python/media_inputs.py` handles page rendering, decoding, and segmentation.
- `indexing/media-content.ts` connects media units to existing chunks.
- `storage/pglite-runtime.ts` selects a compatible PostgreSQL runtime.
- `storage/pglite-assets.ts` and `embedders/gemma-worker-path.ts` load packaged
  assets independently of storage and inference.

The database schema is unchanged. Persistent references currently use the
existing file path, page, and section fields. A future schema can persist typed
media locators and add image/audio queries without coupling decoders to storage.
Corpus-level recall tests, configurable sampling/overlap, and Matryoshka
dimension selection remain useful next steps.
