# Auditaria Knowledge Search

A powerful, local-first search system that provides **keyword**, **semantic**,
and **hybrid** search capabilities across your working directory. Supports
multiple storage backends with PGlite as the default.

See [Multimodal knowledge search](MULTIMODAL.md) for EmbeddingGemma 2 setup,
OCR-free media retrieval, PGlite version compatibility, and test results.

## Features

- **Hybrid Search**: Combines keyword (BM25/FTS) and semantic (vector) search
  using Reciprocal Rank Fusion (RRF)
- **Multiple Storage Backends**: PGlite (default), SQLite+Vectorlite, LibSQL,
  and LanceDB
- **Local Embeddings**: Uses ONNX models via Transformers.js or Python (no
  external API calls)
- **Memory Management**: SearchSystemSupervisor with automatic process restart
  to prevent WASM memory bloat
- **OCR Support**: Extracts text from images and scanned PDFs using Tesseract.js
  or Scribe.js
- **Multi-format Support**: PDFs, Office documents, images, code files, and more
- **GPU Acceleration**: Optional DirectML (Windows) or CUDA (Linux) support

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      SearchSystemSupervisor (Optional)                   │
│  (Wraps SearchSystem, manages process restarts for memory control)      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           SearchSystem                                   │
│  (Orchestrates all components, provides public API)                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ FileDiscovery │         │ IndexingPipeline │         │  SearchEngine   │
│               │         │ + StartupSync    │         │ + FilterBuilder │
└───────────────┘         └─────────────────┘         └─────────────────┘
        │                           │                           │
        │                    ┌──────┴──────┐                    │
        │                    ▼             ▼                    │
        │           ┌─────────────┐ ┌───────────┐               │
        │           │   Parsers   │ │  Chunkers │               │
        │           └─────────────┘ └───────────┘               │
        │                    │                                  │
        │                    ▼                                  │
        │           ┌─────────────────┐                         │
        │           │    Embedders    │                         │
        │           │ (Python/JS/GPU) │                         │
        │           └─────────────────┘                         │
        │                    │                                  │
        └────────────────────┼──────────────────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │  StorageAdapter │
                    │   (Interface)   │
                    └────────┬────────┘
                             │
        ┌────────────┬───────┴───────┬────────────┐
        ▼            ▼               ▼            ▼
┌─────────────┐ ┌─────────────┐ ┌─────────┐ ┌─────────┐
│LibSQLStorage│ │SQLiteVector-│ │ PGlite  │ │ LanceDB │
│  (Default)  │ │liteStorage  │ │ Storage │ │ Storage │
└─────────────┘ └─────────────┘ └─────────┘ └─────────┘
```

### Child Process Architecture (Memory Management)

Optionally, indexing can run in **child processes** to solve the fundamental
WebAssembly memory limitation: WASM memory can only grow, never shrink. When a
child process exits after processing a batch of documents, the OS completely
releases ALL its memory, including WASM heaps.

**Note:** This is different from SearchSystemSupervisor - child process indexing
spawns workers per batch, while the supervisor restarts the entire SearchSystem.

Each worker uses the same `IndexingPipeline` as in-process indexing:

1. The first worker discovers files and persists the queue.
2. Each worker processes a bounded batch and reports progress over JSONL.
3. The parent waits for the worker to exit before starting another worker.
4. Subsequent workers resume the queue without rediscovering failed files.

Child indexing requires persistent storage. With PGlite and LanceDB, the parent
closes its connection before starting a worker and reopens it after indexing.
Search requests during that transfer return an unavailable error and can be
retried after indexing completes. The SQLite backends retain a read connection.

**Configuration:** Child process indexing is disabled by default
(`useChildProcess: false`). Enable via indexing config when WASM memory
accumulation is a concern.

### SearchSystemSupervisor (Process Restart for Memory Management)

For very large indexing jobs, the SearchSystemSupervisor provides automatic
process restarts to completely reclaim WASM memory. This is a wrapper around
SearchSystem that exposes the same API.

```
SearchServiceManager
        │
        ▼
SearchSystemSupervisor (optional)
        │
        ├── InProcessStrategy (close→GC→reinit, ~60-80% memory recovery)
        │
        └── ChildProcessStrategy (fork→kill→respawn, 100% memory recovery)
                │
                ▼
        SearchSystem (actual implementation)
```

**Restart Strategies:**

| Strategy        | Memory Recovery | Overhead   | Use Case                 |
| --------------- | --------------- | ---------- | ------------------------ |
| `in-process`    | 60-80%          | Minimal    | General use (default)    |
| `child-process` | 100%            | ~1-5ms IPC | Large corpus (10k+ docs) |
| `none`          | N/A             | None       | Disable restarts         |

**Configuration:**

- `supervisorStrategy`: `'in-process'` | `'child-process'` | `'none'`
- `supervisorRestartThreshold`: Documents before restart (default: 0 = disabled)
- `supervisorMemoryThresholdMb`: Memory threshold for early restart (default:
  4000 MB)

Automatic restarts are disabled when `restartThreshold` is zero or storage is in
memory. When enabled, the supervisor completes a bounded batch before
restarting, resumes the persisted queue, and returns aggregate counts only when
the requested work finishes. It owns process lifetime, so its normal indexing
path does not spawn an additional layer of batch workers.

## Quick Start

```typescript
import { SearchSystem } from '@thacio/auditaria-search';

// Initialize the search system
// Configuration is loaded automatically from .auditaria/knowledge-base.config.json
const search = await SearchSystem.initialize({
  rootPath: '/path/to/index',
});

// Index files
await search.indexAll();

// Search
const { results } = await search.search({
  query: 'your query',
  strategy: 'hybrid', // 'keyword' | 'semantic' | 'hybrid'
  limit: 10,
});

// Cleanup
await search.close();
```

---

## User Configuration

Users can customize search system defaults via a configuration file at
`.auditaria/knowledge-base.config.json`. This allows changing settings without
modifying code.

### Configuration Priority

When `SearchSystem.initialize()` is called, configuration is loaded from
multiple sources with the following priority (highest to lowest):

1. **Database metadata** (`db-config.json`) - For existing databases,
   schema-defining fields (backend, model, dimensions, vector index settings)
   are locked to ensure data consistency
2. **User config file** (`.auditaria/knowledge-base.config.json`) - User
   preferences override code defaults
3. **Code defaults** - Built-in sensible defaults

### Schema-Defining vs Runtime Fields

- **Schema-defining fields** (locked for existing databases): `backend`,
  `embeddings.model`, `embeddings.dimensions`, `vectorIndex.type`,
  `vectorIndex.useHalfVec`
- **Runtime fields** (can always be changed): search weights, batch sizes,
  logging, OCR settings, etc.

### Example Configuration File

Most projects only need to choose which files to include, how to search, and
whether to enable OCR. The generated sample contains these settings. Existing
backend, model, and performance options remain supported for advanced use.

The project's config now keeps nine preferences: database backend, embedding
model, include/ignore patterns, parsing concurrency, search strategy and limit,
and OCR enablement and languages. Other effective settings use code defaults.
Both the slash command and the `knowledge_search` tool honor search defaults
unless the caller supplies an override.

Legacy files still load, with a warning for these removed, ineffective settings:
`indexing.ocrEnabled`, `indexing.ocrPriority`,
`indexing.childProcessMemoryThresholdMb`, `chunking.strategy`,
`chunking.preserveSentences`, `chunking.preserveParagraphs`,
`embeddings.queryPrefix`, `embeddings.documentPrefix`, and
`search.hybridStrategy`. OCR is controlled by `ocr.enabled`; document chunking,
model prefixes and hybrid fusion are managed automatically.
`ocr.defaultLanguages` selects languages directly when `autoDetectLanguage` is
false, or preferred languages within the detected script when it is true.
`ocr.minConfidence` controls whether recognized text is indexed.

```json
{
  "$version": "1.0.0",
  "config": {
    "indexing": {
      "ignorePaths": ["**/archive/**"]
    },
    "search": {
      "defaultStrategy": "hybrid",
      "defaultLimit": 10
    },
    "ocr": {
      "enabled": true,
      "defaultLanguages": ["pt", "en"]
    }
  }
}
```

### Database Metadata

When a database is created, its schema-defining configuration is saved to
`db-config.json` inside the database directory. This ensures:

- Consistency when reopening the database
- Portability when sharing databases between machines
- Protection against accidental misconfiguration

---

## Directory Structure

```
packages/search/src/
├── core/              # Core utilities (Logger, EventEmitter, Registry)
├── config/            # User configuration and backend options
│   ├── user-config.ts          # Load/save knowledge-base.config.json
│   └── backend-options.ts      # Backend-specific storage options
├── storage/           # Storage backends
│   ├── LibSQLStorage.ts
│   ├── SQLiteVectorliteStorage.ts
│   ├── PGliteStorage.ts        # Default backend
│   ├── LanceDBStorage.ts
│   ├── StorageFactory.ts       # Backend selection logic
│   ├── metadata.ts             # Database metadata (db-config.json)
│   └── types.ts                # StorageAdapter interface
├── supervisor/        # Process restart management
│   ├── SearchSystemSupervisor.ts
│   ├── strategies/             # InProcess, ChildProcess, None
│   └── ipc/                    # Inter-process communication
├── indexing/          # Indexing pipeline and child process management
├── embedders/         # Embedding providers (Worker, Python, TransformersJS)
├── search/            # Search engine and FilterBuilder
├── parsers/           # File format parsers
├── chunkers/          # Text chunking strategies
├── ocr/               # OCR providers (Tesseract, Scribe)
├── discovery/         # File discovery
├── sync/              # Startup sync
└── config.ts          # Configuration types and defaults
```

---

## Core Components

### Configuration (`src/config.ts`, `src/config/`)

The system uses a hierarchical configuration with sensible defaults. Users can
override defaults via `.auditaria/knowledge-base.config.json` (see
[User Configuration](#user-configuration) section above).

```typescript
interface SearchSystemConfig {
  database: {
    backend: 'libsql' | 'sqlite' | 'pglite' | 'lancedb';
    path: string;
    inMemory: boolean;
    backupEnabled: boolean;
  };

  indexing: {
    ignorePaths: string[]; // Patterns to skip (node_modules, .git, etc.)
    fileTypes: string[]; // Extensions to index
    maxFileSize: number;
    respectGitignore: boolean;
    prepareWorkers: number; // Parallel parsing workers
    useChildProcess: boolean;
    childProcessBatchSize: number;
    // Supervisor options
    supervisorStrategy: 'in-process' | 'child-process' | 'none';
    supervisorRestartThreshold: number; // 0 = disabled
    supervisorMemoryThresholdMb: number;
  };

  chunking: {
    maxChunkSize: number;
    chunkOverlap: number;
  };

  embeddings: {
    model: string; // E5 multilingual models recommended
    device: 'auto' | 'cpu' | 'dml' | 'cuda';
    quantization: 'q8' | 'fp16' | 'fp32' | 'q4';
    preferPythonEmbedder: boolean;
    useWorkerThread: boolean;
    batchSize: number;
    workerHeapSizeMb: number;
    cacheDir: string;
  };

  search: {
    defaultStrategy: 'hybrid' | 'semantic' | 'keyword';
    semanticWeight: number;
    keywordWeight: number;
    defaultLimit: number;
    rrfK: number;
  };

  vectorIndex: {
    type: 'hnsw' | 'ivfflat' | 'none';
    useHalfVec: boolean; // 50% storage reduction
    deferIndexCreation: boolean;
    createIndex: boolean;
  };

  ocr: {
    enabled: boolean;
    autoDetectLanguage: boolean;
    defaultLanguages: string[];
    concurrency: number;
  };
}
```

See `src/config.ts` for current default values.

### Registry Pattern (`src/core/Registry.ts`)

All pluggable components (parsers, chunkers, embedders, OCR providers) use a
generic registry pattern:

```typescript
class Registry<T extends Provider> {
  register(provider: T): void;
  get(name: string): T | undefined;
  findBest(input: TInput): T | undefined; // Priority-based selection
}
```

### Event System (`src/core/EventEmitter.ts`)

Type-safe event emitter for progress tracking and debugging:

```typescript
// Events emitted during indexing
'indexing:started' |
  'indexing:progress' |
  'indexing:completed' |
  'indexing:failed';
'sync:started' | 'sync:detected' | 'sync:completed';
('search:completed');
'queue:item:added' | 'queue:item:started' | 'queue:item:completed';
```

### Logger (`src/core/Logger.ts`)

Production-grade structured logging:

```typescript
const log = globalLogger.child('MyModule');
log.info('Indexing started', { fileCount: 100 });
log.startTimer('embedding');
// ... work ...
log.endTimer('embedding');
```

---

## Embedders (`src/embedders/`)

Three embedding strategies are available:

### 1. PythonEmbedder (Recommended)

- Uses Python subprocess with ONNX Runtime
- Better memory management for large indexing jobs
- **Bit-identical** embeddings to JavaScript implementation
- Communicates via JSONL protocol over stdin/stdout

```bash
# Install Python dependencies
pip install onnxruntime transformers numpy huggingface_hub
```

### 2. WorkerEmbedder (Default for Node.js)

- Runs Transformers.js in a worker thread
- Non-blocking (keeps CLI responsive)
- Configurable heap size (default: 4GB)

### 3. TransformersJsEmbedder (Direct)

- Runs in main thread (blocks during inference)
- Supports GPU acceleration (DirectML/CUDA)
- Best for one-off embeddings

### Embedder Selection Logic

```
preferPythonEmbedder=true?
  ├─ Yes → Python available?
  │         ├─ Yes → Use PythonEmbedder
  │         └─ No  → Fall back to WorkerEmbedder
  └─ No  → Use WorkerEmbedder (or TransformersJsEmbedder if worker disabled)
```

### Supported Models

| Model                          | Dimensions | Best For             |
| ------------------------------ | ---------- | -------------------- |
| `Xenova/multilingual-e5-small` | 384        | Faster, lower memory |
| `Xenova/multilingual-e5-base`  | 768        | Balanced             |
| `Xenova/multilingual-e5-large` | 1024       | Best quality         |

See `src/config.ts` for the current default model.

### Streaming Embeddings

All embedders implement `embedBatchDocumentsStreaming()`, an async generator
that yields embeddings batch-by-batch instead of accumulating all results in
memory:

```typescript
// Memory-efficient: yields batches, doesn't accumulate
for await (const {
  startIndex,
  embeddings,
} of embedder.embedBatchDocumentsStreaming(texts, batchSize)) {
  // Process and store each batch immediately
  await storage.updateChunkEmbeddings(updates);
  // Memory released after each iteration
}
```

This prevents memory exhaustion when indexing large documents with thousands of
chunks (e.g., a 50MB document with 50,000 chunks stays bounded to ~12KB of
embeddings in memory instead of ~150MB).

### GPU Detection

- **Windows**: DirectML (built into Windows 10+)
- **Linux**: CUDA (requires toolkit)
- **macOS**: CPU only (no GPU support)
- Auto-fallback to CPU if GPU initialization fails

---

## Parsers (`src/parsers/`)

Priority-based parser selection for different file formats:

| Parser              | Priority | Formats                                 | Library         |
| ------------------- | -------- | --------------------------------------- | --------------- |
| ImageParser         | 250      | PNG, JPG, GIF, BMP, TIFF, WEBP          | (marks for OCR) |
| OfficeParserAdapter | 200      | DOCX, PPTX, XLSX, ODT, ODP, ODS         | `officeparser`  |
| PdfParseAdapter     | 200      | PDF                                     | `pdf-parse`     |
| MarkitdownParser    | 100      | PDF, DOCX, CSV, XML, images, audio, ZIP | `markitdown-ts` |
| PlainTextParser     | 1        | Any text file                           | (built-in)      |

### Parser Selection

- Higher priority parsers are tried first
- Falls back to lower priority if higher fails
- PlainTextParser catches all unhandled text files

### Metadata Extraction

All parsers extract relevant metadata:

- **PDF**: Author, creation date, page count
- **Office**: Word count, character count
- **Images**: EXIF data (via markitdown)

---

## OCR (`src/ocr/`)

Two OCR providers with automatic selection:

### TesseractJsProvider (Priority 100)

- Best for images (PNG, JPG, etc.)
- Local processing via `tesseract.js`
- ~30MB language data per language

### ScribeJsProvider (Priority 150)

- Best for PDFs (native PDF support)
- Higher accuracy than vanilla Tesseract
- Uses `scribe.js-ocr`

### Language Detection

Automatic script detection using Tesseract OSD:

```
Latin    → eng, por, spa, fra, deu, ita, nld
Cyrillic → rus, ukr, bel, bul, srp
Arabic   → ara, fas, urd
Han      → chi_sim, chi_tra, jpn
```

### OCR Queue

- Runs after main indexing queue is empty
- Parallel processing (default: 2 jobs)
- Retry logic (3 attempts with 5s delay)

---

## Indexing Pipeline (`src/indexing/`)

### Pipeline Architecture

```
Discovery → Queue → Parser → Chunker → Embedder → Storage
               │
               ▼
        Priority Queue
        (text > markup > pdf > image > ocr)
```

### File Priority Classification

| Priority | Category | Examples                     |
| -------- | -------- | ---------------------------- |
| 1        | text     | .txt, .md, .json, .yaml      |
| 2        | markup   | .docx, .xlsx, .html          |
| 3        | pdf      | Small PDFs or PDFs with text |
| 4        | image    | .png, .jpg (require OCR)     |
| 5        | ocr      | Large scanned PDFs           |

### Bounded processing

Queued indexing, direct file indexing, and reindexing share one preparation and
embedding path. Each batch owns its queue claims until they are completed,
failed, or returned to pending during shutdown.

- Preparation runs in parallel up to the smaller of `prepareWorkers` and
  `preparedBufferSize`. Embedding and publication run serially.
- New passages and vectors are prepared before replacing published content. SQL
  backends replace chunks in a transaction; LanceDB uses a single table merge. A
  parsing or inference failure keeps the last indexed version and tags.
- Streaming embedding responses are validated for count, ordering, dimensions,
  and finite values before publication.
- The pipeline checks the file hash again before publication. Files changed
  during inference are retried instead of publishing mismatched content.
- Queue claims count each attempt once. Transient errors retry up to the
  configured limit; missing, oversized, invalid, or timed-out files fail without
  endless retries. Startup recovers claims left processing after an interrupted
  session.

### Memory and shutdown

The scheduler retains only one bounded batch. Streaming inference limits model
batch size, while all vectors for a document are retained until publication so
an inference failure cannot erase its old passages.

Checkpoints and backup hooks run between batches every 200 successful documents
and at the end of a run. Maintenance does not reconnect storage underneath
active work. Optional process isolation remains available for model/native
memory that cannot be reclaimed within a process.

`stop()` waits for the active batch and returns unfinished claims to the queue.
`waitForIdle()` includes persistence and propagates infrastructure failures.

---

## Chunking (`src/chunkers/`)

### RecursiveChunker (Default)

Hierarchical splitting that preserves semantic boundaries:

```
Separator hierarchy:
\n\n\n → \n\n → \n → ". " → "! " → "? " → "; " → ", " → " " → character
```

Features:

- Section/heading detection (Markdown, underlined, chapter markers)
- Smart merging of small parts
- Overlap between chunks for context continuity

### FixedSizeChunker

Simple fixed-size splitting:

- Paragraph preservation (looks for `\n\n`)
- Sentence boundary preservation
- Fast and predictable

### Configuration

```typescript
{
  maxChunkSize: 1000,    // Characters per chunk
  chunkOverlap: 200,     // Overlap between chunks
  preserveSentences: true,
  preserveParagraphs: true,
  trackSections: true,   // Extract section headings
}
```

---

## Search Engine (`src/search/`)

### Search Strategies

#### 1. Keyword Search (Full-Text Search)

```sql
-- Default mode (plainto_tsquery): All terms AND'ed
WHERE fts_vector @@ plainto_tsquery('simple', query)
ORDER BY ts_rank(fts_vector, plainto_tsquery('simple', query)) DESC

-- Web search syntax mode (websearch_to_tsquery): Google-style
WHERE fts_vector @@ websearch_to_tsquery('simple', query)
ORDER BY ts_rank(fts_vector, websearch_to_tsquery('simple', query)) DESC
```

**Query Syntax Modes:**

| Mode       | Function               | Syntax           | Use Case               |
| ---------- | ---------------------- | ---------------- | ---------------------- |
| Default    | `plainto_tsquery`      | All terms AND'ed | AI agent queries       |
| Web Search | `websearch_to_tsquery` | Google-style     | User-facing interfaces |

**Web Search Syntax (when `useWebSearchSyntax: true`):**

- `"quoted phrase"` - exact phrase search (words must appear adjacent and in
  order)
- `word1 word2` - both words required (any order)
- `word1 OR word2` - either word
- `-word` - exclude word

**Examples:**

```typescript
// Exact phrase search
await searchSystem.search({
  query: '"error handling"',
  strategy: 'keyword',
  useWebSearchSyntax: true,
});

// Multiple required terms
await searchSystem.search({
  query: 'database connection',
  strategy: 'keyword',
  useWebSearchSyntax: true,
});

// OR search with exclusion
await searchSystem.search({
  query: 'typescript OR javascript -deprecated',
  strategy: 'keyword',
  useWebSearchSyntax: true,
});
```

**Backend Implementations:**

- **PGlite**: Uses PostgreSQL's `websearch_to_tsquery()` with GIN index
- **LibSQL/SQLite**: Uses FTS5 with a custom Google-style query parser that
  converts web search syntax to FTS5 format (matching PostgreSQL behavior)
- All backends fall back to LIKE/ILIKE pattern matching if FTS fails

**Web Search Parser (LibSQL/SQLite):**

The `convertToFTS5Query()` function converts Google-style queries to FTS5
syntax:

```typescript
import { convertToFTS5Query } from '@thacio/auditaria-search';

// Simple terms → AND
convertToFTS5Query('hello world'); // → 'hello AND world'

// Quoted phrases preserved
convertToFTS5Query('"exact phrase"'); // → '"exact phrase"'

// OR operator preserved
convertToFTS5Query('cat OR dog'); // → 'cat OR dog'

// Negation converted
convertToFTS5Query('hello -world'); // → 'hello AND NOT world'
convertToFTS5Query('-"bad phrase"'); // → 'NOT "bad phrase"'

// Complex query
convertToFTS5Query('signal -"segmentation fault"');
// → 'signal AND NOT "segmentation fault"'
```

#### 2. Semantic Search (Vector Search)

```sql
WHERE embedding IS NOT NULL
ORDER BY embedding <=> query_embedding
```

- Uses pgvector's HNSW index for fast ANN search
- Cosine distance for similarity scoring

#### 3. Hybrid Search (RRF Fusion)

Combines both using Reciprocal Rank Fusion:

```
score = (semantic_weight / (k + semantic_rank)) + (keyword_weight / (k + keyword_rank))
```

Where `k = 60` (RRF constant)

### Result Diversity

Prevents single documents from dominating results. Configured via `diversity`
option in search. See `src/search/SearchEngine.ts` for implementation.

**Strategies** (`diversity.strategy`):

- `score_penalty` (default): Decay factor on subsequent passages from same doc
- `cap_then_fill`: Hard cap per document with round-robin distribution
- `none`: Pure relevance ranking

**Semantic Deduplication** (`diversity.semanticDedup`): Merges near-duplicate
passages across files using cosine similarity. Merged results include
`additionalSources` showing "Also found in: file1, file2".

### Filter Builder

Fluent API for building search filters:

```typescript
const filters = new FilterBuilder()
  .folder(['/docs', '/reports'])
  .fileTypes(['.pdf', '.docx'])
  .tags(['important'])
  .dateFrom(new Date('2024-01-01'))
  .build();

const { results } = await search.search({
  query: 'query',
  strategy: 'hybrid',
  filters,
});
```

### Available Filters

- `folder(paths)` - Filter by directory
- `fileTypes(extensions)` - Filter by file type
- `tags(tags)` / `tagsAny(tags)` - Filter by tags (AND/OR)
- `dateFrom(date)` / `dateTo(date)` - Date range
- `status(statuses)` - Document status
- `language(languages)` - Document language

---

## Storage (`src/storage/`)

All storage backends implement the `StorageAdapter` interface, enabling seamless
swapping without code changes. The `StorageFactory` handles instantiation and
detects existing databases to prevent backend switching corruption.

### Available Backends

| Backend                 | Library                           | Default | Best For                        |
| ----------------------- | --------------------------------- | ------- | ------------------------------- |
| LibSQLStorage           | `libsql` (Turso)                  | No      | General use, crash-safe vectors |
| SQLiteVectorliteStorage | `better-sqlite3` + `vectorlite`   | No      | Native performance, single-user |
| **PGliteStorage**       | `@electric-sql/pglite` + pgvector | **Yes** | PostgreSQL compatibility        |
| LanceDBStorage          | `@lancedb/lancedb`                | No      | Vector-heavy workloads          |

### LibSQLStorage

- SQLite fork from Turso with native vector support
- Vectors stored directly in the database file (crash-safe)
- FTS5 for full-text search with Google-style web search syntax
- Query parser converts Google-style queries to FTS5 format (matching
  PostgreSQL's `websearch_to_tsquery` behavior)

### SQLiteVectorliteStorage

- Native SQLite via `better-sqlite3`
- Optional `vectorlite` extension for vector operations
- Cross-platform, excellent performance
- Same Google-style web search parser as LibSQLStorage

### PGliteStorage (Default)

- PostgreSQL compiled to WASM
- pgvector extension for vector operations
- Full PostgreSQL SQL compatibility

### LanceDBStorage

- Specialized columnar vector database
- Tantivy for full-text search
- Optimized for semantic search workloads

### Database Schema

All backends share a common schema:

**documents table**: File metadata (path, name, size, hash, MIME type), content
metadata (title, author, language, page count), status tracking

**chunks table**: Document text chunks, vector embeddings, FTS vectors

**index_queue table**: Priority queue for indexing with retry mechanism

### Backend Selection

```
Existing database? → Use metadata to determine backend
                ↓ No
Config specified? → Use config.backend
                ↓ No
Default → 'libsql'
```

### Storage Operations

- `checkpoint()` - Flush WAL to disk, run VACUUM/ANALYZE
- `vacuum()` - Reclaim disk space
- `reconnect()` - Close and reopen database (useful for long-running processes)

### Backup & Recovery

The storage layer provides automatic backup and crash recovery. See
`src/storage/PGliteStorage.ts` for implementation.

**Backup** (`.auditaria/knowledge-base.db.backup/`):

- Auto-created on `close()` when `backupEnabled: true` (default)
- Only if: database modified (dirty flag), not empty, size < 300MB, passes
  integrity checks
- Methods: `createBackup()`, `backupExists()`, `restoreFromBackup()`

**Corruption Recovery**:

- Detects corruption on initialization (PGlite errors)
- Auto-restores from backup if available
- Clear error messages guide manual recovery if backup fails

**Integrity Checks** (`checkIntegrity()`):

- Structural integrity via amcheck extension (B-tree indexes)
- Data consistency (tables readable, no orphans)

**Crash Recovery** (`recoverStuckDocuments()`):

- Recovers documents stuck in `parsing`/`chunking`/`embedding` status
- Resets to `pending` and re-queues for indexing

### Graceful Shutdown

`SearchSystem.close()` ensures data integrity on exit:

- Sets `closing` flag so ongoing operations exit at next checkpoint
- Joins indexing, OCR, and active API operations before releasing storage
- Disposes each shared model once; concurrent close calls share one promise
- Waits for PGlite to close before transferring database ownership
- Reports resource cleanup failures to the caller

---

## File Discovery & Sync (`src/discovery/`, `src/sync/`)

`SearchSystem.sync()` and `indexAll()` use the pipeline's shared change
detector. The exported `StartupSync` utility uses the same comparison rules.
File hashes are streaming SHA-256 content hashes, so edits are detected even if
file size and modification time are unchanged. Existing indexes using older
hashes are reindexed once on the next sync; no database reset is required.

The optional `FileWatcher` serializes change flushes, preserves published
content while queuing replacements, and waits for active queue claims before
changing those rows. It is not automatically enabled by `SearchSystem`.

### FileDiscovery

Discovers files using glob patterns:

```typescript
const discovery = new FileDiscovery({
  rootPath: '/path/to/index',
  ignorePaths: ['node_modules', '.git'],
  fileTypes: ['.pdf', '.docx', '.txt'],
  maxFileSize: 50 * 1024 * 1024, // 50MB
  respectGitignore: true,
});

for await (const file of discovery.discover()) {
  console.log(file.absolutePath, file.hash);
}
```

### Default Ignored Paths

```
node_modules, .git, .auditaria, dist, build, .next, .nuxt, .cache,
coverage, __pycache__, .pytest_cache, venv, .venv, *.log, *.lock
```

### StartupSync

Reconciles database with disk state:

```typescript
const sync = new StartupSync(storage, discovery);

// Quick check if sync needed
if (await sync.needsSync()) {
  const result = await sync.sync();
  console.log(`Added: ${result.added.length}`);
  console.log(`Modified: ${result.modified.length}`);
  console.log(`Deleted: ${result.deleted.length}`);
}
```

---

## Python Embedder (`python/`)

A standalone Python implementation that produces **bit-identical** embeddings to
the JavaScript version.

### Installation

```bash
cd packages/search/python
pip install -r requirements.txt
```

### Requirements

- Python 3.8+
- `onnxruntime>=1.16.0`
- `transformers>=4.30.0`
- `numpy>=1.24.0`
- `huggingface_hub>=0.20.0`

### Communication Protocol

JSONL over stdin/stdout:

```jsonl
# Request (Node.js → Python)
{"type": "init", "model": "Xenova/multilingual-e5-small", "quantization": "q8"}
{"type": "embed_batch", "id": "req_1", "texts": ["text1", "text2"]}

# Response (Python → Node.js)
{"type": "ready", "dimensions": 384, "model": "Xenova/multilingual-e5-small"}
{"type": "embeddings", "id": "req_1", "embeddings": [[0.1, -0.2, ...], [0.3, 0.4, ...]]}
```

### Why Python?

1. **Better memory management** for large indexing jobs
2. **Shared model cache** with Node.js (same HuggingFace cache)
3. **Corporate firewall friendly** (easier package installation)
4. **Identical results** - same ONNX models, same preprocessing

---

## CLI Tool Integration

The search system is exposed to the AI agent through two tools in
`packages/core/src/tools/`:

### knowledge_index

Manages the knowledge base lifecycle:

| Action    | Description                                  |
| --------- | -------------------------------------------- |
| `init`    | Initialize/update the index (background)     |
| `status`  | Check index health, stats, queue, OCR status |
| `reindex` | Re-index a specific file by path             |

```typescript
// Example: Initialize with force rebuild
knowledge_index({ action: 'init', force: true });

// Example: Check status
knowledge_index({ action: 'status' });
```

### knowledge_search

Search the indexed documents:

| Parameter               | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `query`                 | Search query (required unless `document_id`)    |
| `strategy`              | `hybrid` (default), `semantic`, or `keyword`    |
| `folders`               | Filter by directories (partial match)           |
| `file_types`            | Filter by extension (e.g., `["pdf", "docx"]`)   |
| `document_id`           | Retrieve all chunks for a specific document     |
| `format`                | `markdown` (default) or `json`                  |
| `detail`                | `minimal`, `summary` (default), or `full`       |
| `limit` / `offset`      | Pagination (default: 30, max: 200)              |
| `group_by_document`     | Group passages by document (default: true)      |
| `passages_per_document` | Max passages per document (0 = no limit)        |
| `passage_length`        | Max chars per passage (default: 300, max: 2000) |

```typescript
// Example: Hybrid search with filters
knowledge_search({
  query: 'installation guide',
  strategy: 'hybrid',
  folders: ['docs'],
  file_types: ['pdf', 'md'],
  limit: 10,
});

// Example: Retrieve full document
knowledge_search({
  document_id: 'doc_xxx',
  detail: 'full',
});
```

### SearchResponseFormatter

Formats search results for AI consumption (`search-response-formatter.ts`):

- **Smart truncation**: Centers around `<mark>` tags, preserves sentence
  boundaries
- **Deduplication**: Removes duplicate chunks by text content
- **Grouping**: Groups results by document with best score
- **Output formats**: Markdown (human-readable) or JSON (structured)
- **Detail levels**: `minimal` (IDs only), `summary` (truncated), `full`
  (complete)

---

## SearchServiceManager (`packages/core/src/services/search-service.ts`)

A singleton service that wraps `SearchSystem` (optionally via
`SearchSystemSupervisor`) to provide persistent background indexing capabilities
for the CLI. It manages the search system lifecycle and coordinates background
queue processing.

**Note:** The service does not pass configuration overrides to `SearchSystem`.
Instead, it lets `SearchSystem.initialize()` load user configuration from
`.auditaria/knowledge-base.config.json` with the proper priority order (see
[User Configuration](#user-configuration)).

### Features

- **Singleton pattern**: Single shared instance across the application
- **Supervisor integration**: Can use SearchSystemSupervisor for automatic
  process restarts during large indexing jobs
- **Background queue processor**: Processes indexing queue at regular intervals
- **Progress tracking**: Real-time indexing progress via `IndexingProgress`
- **Auto-index support**: Optionally starts indexing on startup based on config
- **Event forwarding**: Subscribes to SearchSystem events for progress updates

### Usage

```typescript
import { getSearchService } from '@google/gemini-cli-core';

const searchService = getSearchService();

// Start the service with indexing enabled
await searchService.start('/path/to/project', { startIndexing: true });

// Check if service is running
if (searchService.isRunning()) {
  // Check if indexing service (queue processor) is active
  if (searchService.isIndexingEnabled()) {
    console.log('Indexing service is online');
  }

  // Trigger a sync to process new/changed files
  await searchService.triggerSync({ force: false });

  // Get indexing progress
  const progress = searchService.getIndexingProgress();
  console.log(`${progress.processedFiles}/${progress.totalFiles} files`);
}

// Access the underlying SearchSystem
const searchSystem = searchService.getSearchSystem();
if (searchSystem) {
  const results = await searchSystem.search({ query: 'my query' });
}

// Stop the service
await searchService.stop();
```

### Key Methods

| Method                     | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `start(rootPath, options)` | Start the service, optionally with indexing enabled                     |
| `stop()`                   | Stop the service and cleanup resources                                  |
| `isRunning()`              | Check if service state is 'running'                                     |
| `isIndexingEnabled()`      | Check if queue processor is active (indexing service online)            |
| `enableIndexing()`         | Start queue processor if service is running but indexing wasn't enabled |
| `triggerSync(options)`     | Discover and index new/changed files                                    |
| `getSearchSystem()`        | Get the underlying SearchSystem instance                                |
| `getIndexingProgress()`    | Get current indexing progress (status, files processed, etc.)           |
| `getState()`               | Get service state (status, rootPath, timestamps, errors)                |

### Start Options

```typescript
interface SearchServiceStartOptions {
  forceReindex?: boolean; // Force full reindex even if index exists
  skipInitialSync?: boolean; // Skip initial sync for faster startup
  startIndexing?: boolean; // Start queue processor (used by /knowledge-base init)
}
```

### Indexing Progress

```typescript
interface IndexingProgress {
  status:
    | 'idle'
    | 'discovering'
    | 'syncing'
    | 'indexing'
    | 'completed'
    | 'failed';
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  currentFile: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}
```

### How It Works

1. **Service starts** → Initializes SearchSystem (which loads user config from
   `knowledge-base.config.json`)
2. **If `startIndexing: true` or `autoIndex` config** → Starts queue processor
3. **Queue processor** → Polls every 5 seconds for pending items
4. **`triggerSync()`** → Discovers files, queues them, processes via
   `indexAll()`
5. **Progress events** → SearchSystem emits `indexing:progress`, service updates
   `IndexingProgress`

---

## API Reference

### SearchSystem

```typescript
class SearchSystem {
  // Factory methods
  static initialize(options: InitOptions): Promise<SearchSystem>;
  static load(rootPath: string): Promise<SearchSystem>;
  static exists(rootPath: string): boolean;

  // Indexing
  indexAll(options?: {
    force?: boolean;
    useChildProcess?: boolean;
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }>;
  indexFile(path: string): Promise<boolean>;
  processQueue(options?: {
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }>;
  sync(options?: { dryRun?: boolean }): Promise<SyncResult>;

  // Search
  search(options: SearchOptions): Promise<SearchResponse>;

  // Management
  getStats(): Promise<SearchStats>;
  close(): Promise<void>; // Graceful shutdown with backup
}
```

### SearchOptions

```typescript
interface SearchOptions {
  query: string;
  strategy?: 'hybrid' | 'semantic' | 'keyword';
  limit?: number;
  offset?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minScore?: number;
  filters?: FilterResult;
  highlight?: boolean;
  diversity?: DiversityOptions; // See "Result Diversity" section
}
```

### SearchResult

```typescript
interface SearchResult {
  chunk: {
    id: string;
    documentId: string;
    text: string;
    chunkIndex: number;
    section?: string;
  };
  document: {
    id: string;
    filePath: string;
    fileName: string;
    extension: string;
    title?: string;
  };
  score: number;
  matchType: 'hybrid' | 'semantic' | 'keyword';
  highlights?: string[];
  additionalSources?: AdditionalSource[]; // From semantic dedup - "Also found in"
}
```

---

## Performance Tips

1. **Enable SearchSystemSupervisor** for large corpus indexing (10k+ docs) -
   configure `supervisorRestartThreshold` to prevent memory bloat
2. **Use Python embedder** for additional memory isolation (runs in separate
   process)
3. **Keep `useWorkerThread: true`** to maintain CLI responsiveness during search
4. **Use `q8` quantization for E5 models**; use `fp32` for EmbeddingGemma 2
5. **Use CPU for small models** (6.5x faster than GPU due to transfer overhead)
6. **Adjust `prepareWorkers`** for parallel parsing on multi-core systems
7. **Use hybrid search** for best results (combines keyword precision + semantic
   understanding)
8. **LibSQL backend** provides crash-safe vectors with good performance

---

## License

Part of the Auditaria project.
