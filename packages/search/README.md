# Auditaria Knowledge Search

A powerful, local-first search system that provides **keyword**, **semantic**,
and **hybrid** search capabilities across your working directory. Built with
PGlite (PostgreSQL-compatible) and pgvector for vector storage.

## Features

- **Hybrid Search**: Combines keyword (BM25/FTS) and semantic (vector) search
  using Reciprocal Rank Fusion (RRF)
- **Local Embeddings**: Uses ONNX models via Transformers.js or Python (no
  external API calls)
- **OCR Support**: Extracts text from images and scanned PDFs using Tesseract.js
  or Scribe.js
- **Multi-format Support**: PDFs, Office documents, images, code files, and more
- **Real-time Sync**: File watching for automatic re-indexing on changes
- **GPU Acceleration**: Optional DirectML (Windows) or CUDA (Linux) support

## Architecture Overview

```
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
                    │  PGliteStorage  │
                    │ (SQLite+pgvector)│
                    │  + Backup/Recovery│
                    └─────────────────┘
```

## Quick Start

```typescript
import { SearchSystem } from '@thacio/auditaria-cli-search';

// Initialize the search system
const search = await SearchSystem.initialize({
  rootPath: '/path/to/index',
  config: {
    embeddings: {
      model: 'Xenova/multilingual-e5-small',
      preferPythonEmbedder: true,
    },
  },
});

// Index files
await search.indexAll();

// Search
const results = await search.search('your query', {
  strategy: 'hybrid', // 'keyword' | 'semantic' | 'hybrid'
  limit: 10,
});

// Cleanup
await search.dispose();
```

---

## Core Components

### Configuration (`src/config.ts`)

The system uses a hierarchical configuration with sensible defaults:

```typescript
interface SearchSystemConfig {
  database: {
    path: string; // Default: '.auditaria/search.db'
    inMemory: boolean; // Default: false
    backupEnabled: boolean; // Default: true - auto-backup on close
  };

  indexing: {
    ignorePaths: string[]; // Patterns to skip (node_modules, .git, etc.)
    fileTypes: string[]; // Extensions to index
    maxFileSize: number; // Default: 50MB
    respectGitignore: boolean;
    prepareWorkers: number; // Parallel parsing workers (default: 1)
  };

  chunking: {
    strategy: 'recursive' | 'fixed';
    maxChunkSize: number; // Default: 1000 chars
    chunkOverlap: number; // Default: 200 chars
  };

  embeddings: {
    model: string; // Default: 'Xenova/multilingual-e5-small'
    device: 'auto' | 'cpu' | 'dml' | 'cuda';
    quantization: 'q8' | 'fp16' | 'fp32' | 'q4';
    preferPythonEmbedder: boolean; // Default: false
    useWorkerThread: boolean; // Default: true
    batchSize: number; // Default: 8
    workerHeapSizeMb: number; // Default: 4096 (4GB)
    cacheDir: string; // Default: '~/.auditaria/models'
  };

  search: {
    defaultStrategy: 'hybrid' | 'semantic' | 'keyword';
    semanticWeight: number; // Default: 0.5
    keywordWeight: number; // Default: 0.5
  };

  ocr: {
    enabled: boolean;
    autoDetectLanguage: boolean;
    defaultLanguages: string[];
    concurrency: number; // Default: 2
  };
}
```

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

| Model                          | Dimensions | Best For              |
| ------------------------------ | ---------- | --------------------- |
| `Xenova/multilingual-e5-small` | 384        | General use (default) |
| `Xenova/multilingual-e5-base`  | 768        | Better quality        |
| `Xenova/multilingual-e5-large` | 1024       | Best quality          |

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

### Producer-Consumer Model

- **Prepare workers** (producers): Parse and chunk files in parallel
- **Embed loop** (consumer): Generates embeddings and stores results
- **Backpressure control**: Producers wait if buffer is full

### Memory Optimization

- Periodic storage reconnects every 500 files
- Checkpoints every 100 files
- Event loop yielding to prevent blocking

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
WHERE fts_vector @@ plainto_tsquery(query)
ORDER BY ts_rank(fts_vector, plainto_tsquery(query)) DESC
```

- Uses PostgreSQL's built-in FTS with GIN index
- Falls back to ILIKE pattern matching if needed

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

const results = await search.search('query', { filters });
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

### PGliteStorage

PostgreSQL-compatible SQLite with pgvector extension:

```typescript
// Database location
.auditaria/search.db

// Vector dimensions
384 (for multilingual-e5-small)
```

### Database Schema

#### documents table

- File metadata (path, name, size, hash, MIME type)
- Content metadata (title, author, language, page count)
- Status tracking (pending/indexed/failed, OCR status)

#### chunks table

- Document text chunks
- `embedding vector(384)` - pgvector for semantic search
- `fts_vector tsvector` - PostgreSQL FTS for keyword search

#### index_queue table

- Priority queue for document indexing
- Status tracking with retry mechanism

### Indexes

- **GIN index** on `fts_vector` for fast full-text search
- **HNSW index** on `embedding` for fast vector search (m=16,
  ef_construction=64)

### Memory Management

```typescript
storage.checkpoint(); // Flush WAL, run VACUUM/ANALYZE
storage.vacuum(); // Reclaim space
storage.reconnect(); // Release all WASM memory
```

### Backup & Recovery

The storage layer provides automatic backup and crash recovery. See
`src/storage/PGliteStorage.ts` for implementation.

**Backup** (`.auditaria/search.db.backup/`):

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
- Timeout protection per cleanup step (10s each, 5s for PGlite)
- Creates backup before closing (skipped if shutdown interrupted indexing)

---

## File Discovery & Sync (`src/discovery/`, `src/sync/`)

> **Note**: Real-time file watching (FileWatcher) was removed to prevent
> database corruption issues. Use `StartupSync` or manual `syncAndQueue()` calls
> instead.

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
  query: 'audit methodology',
  strategy: 'hybrid',
  folders: ['docs/reports'],
  file_types: ['pdf'],
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

A singleton service that wraps `SearchSystem` to provide persistent background
indexing capabilities for the CLI. It manages the search system lifecycle and
coordinates background queue processing.

### Features

- **Singleton pattern**: Single shared instance across the application
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

1. **Service starts** → Loads or initializes SearchSystem
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
  static exists(rootPath: string): Promise<boolean>;

  // Indexing
  indexAll(): Promise<void>;
  indexFile(path: string): Promise<void>;
  syncAndQueue(): Promise<SyncResult>;

  // Search
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  // Management
  getStats(): Promise<Stats>;
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

1. **Use Python embedder** for large indexing jobs (better memory)
2. **Keep `useWorkerThread: true`** to maintain CLI responsiveness
3. **Use `q8` quantization** (2.2x faster than fp16 with same quality)
4. **Use CPU for small models** (6.5x faster than GPU due to transfer overhead)
5. **Adjust `prepareWorkers`** for parallel parsing on multi-core systems
6. **Use hybrid search** for best results (combines keyword precision + semantic
   understanding)

---

## License

Part of the Auditaria CLI project.
