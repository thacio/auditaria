# Auditaria Local Search System - Implementation Plan

**Version:** 1.0 **Status:** Draft **Created:** 2025-12-13

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Design Principles](#3-core-design-principles)
4. [Component Design](#4-component-design)
5. [Database Schema](#5-database-schema)
6. [File Processing Pipeline](#6-file-processing-pipeline)
7. [Search Implementation](#7-search-implementation)
8. [Slash Commands & User Interface](#8-slash-commands--user-interface)
9. [Auto-Sync & File Watching](#9-auto-sync--file-watching)
10. [Implementation Phases](#10-implementation-phases)
11. [Testing Strategy](#11-testing-strategy)
12. [Success Criteria](#12-success-criteria)
13. [Dependencies](#13-dependencies)
14. [File Structure](#14-file-structure)
15. [API Reference](#15-api-reference)

---

## 1. Executive Summary

### Goal

Build a local search system for Auditaria that enables:

- **Fast keyword search** (PostgreSQL Full-Text Search)
- **Semantic search** (vector embeddings with pgvector)
- **Hybrid search** (RRF fusion of keyword + semantic)
- **Multilingual support** (100+ languages via multilingual-e5-small)
- **Document indexing** (PDF, DOCX, PPTX, XLSX, TXT, MD, etc.)
- **OCR support** (for scanned documents, processed in background)
- **Filtering** (by folder, file type, tags, date range)

### Technology Stack

| Component        | Technology                                | Reason                          |
| ---------------- | ----------------------------------------- | ------------------------------- |
| Database         | PGlite (embedded PostgreSQL)              | No server, WASM, portable       |
| Vector Search    | pgvector extension                        | Native PostgreSQL integration   |
| Full-Text Search | PostgreSQL FTS                            | Built-in, powerful              |
| Embeddings       | Transformers.js + multilingual-e5-small   | Local, multilingual, 120MB      |
| Document Parsing | Pluggable (officeParser, pdf-parse, etc.) | Swappable implementations       |
| OCR              | Pluggable (tesseract.js, etc.)            | Optional, background processing |

### Key Features

- **Zero external dependencies for users** - Everything ships with Auditaria
- **Pluggable architecture** - Easy to swap parsers, embedders, etc.
- **Priority queue** - Non-OCR documents indexed first
- **Auto-sync** - Detects file changes on startup
- **Rich filtering** - Folder, type, tags, date, custom metadata

---

## 2. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Auditaria Search System                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│  │   Slash     │    │    Tool     │    │    Auto     │                 │
│  │  Commands   │    │  Interface  │    │    Sync     │                 │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                 │
│         │                  │                  │                         │
│         └──────────────────┼──────────────────┘                         │
│                            │                                            │
│                    ┌───────▼───────┐                                    │
│                    │  SearchEngine │  ◄── Main orchestrator             │
│                    └───────┬───────┘                                    │
│                            │                                            │
│         ┌──────────────────┼──────────────────┐                         │
│         │                  │                  │                         │
│  ┌──────▼──────┐   ┌───────▼───────┐  ┌──────▼──────┐                  │
│  │   Indexer   │   │   Searcher    │  │  FileSync   │                  │
│  └──────┬──────┘   └───────┬───────┘  └──────┬──────┘                  │
│         │                  │                  │                         │
│  ┌──────▼──────────────────▼──────────────────▼──────┐                 │
│  │                    Storage Layer                   │                 │
│  │  ┌─────────────────────────────────────────────┐  │                 │
│  │  │        PGlite + pgvector Database           │  │                 │
│  │  │  ┌─────────┐ ┌─────────┐ ┌───────────────┐  │  │                 │
│  │  │  │Documents│ │ Chunks  │ │ Tags/Metadata │  │  │                 │
│  │  │  └─────────┘ └─────────┘ └───────────────┘  │  │                 │
│  │  └─────────────────────────────────────────────┘  │                 │
│  └───────────────────────────────────────────────────┘                 │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Pluggable Components                         │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │  │
│  │  │ Parsers  │  │ Chunkers │  │Embedders │  │  OCR Providers   │  │  │
│  │  │ Registry │  │ Registry │  │ Registry │  │    Registry      │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Interaction Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Indexing Flow                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  File Discovery ──► Queue ──► Parser ──► Chunker ──► Embedder ──► DB   │
│       │              │          │          │           │          │     │
│       │              │          │          │           │          │     │
│  Respects        Priority    Pluggable  Pluggable  Pluggable   PGlite  │
│  .gitignore      (OCR last)  Interface  Interface  Interface  +pgvector│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        Search Flow                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Query ──► Embed Query ──► Parallel Search ──► RRF Fusion ──► Results  │
│                               │      │                                  │
│                               │      │                                  │
│                            Vector   FTS                                 │
│                            Search  Search                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Design Principles

### 3.1 Plugin Architecture

All major components use a **Registry + Provider** pattern for swappability:

```typescript
// Generic registry pattern
interface Provider<T> {
  name: string;
  priority: number;
  supports(input: unknown): boolean;
  process(input: unknown): Promise<T>;
}

class Registry<T> {
  private providers: Map<string, Provider<T>> = new Map();

  register(provider: Provider<T>): void;
  unregister(name: string): void;
  get(name: string): Provider<T> | undefined;
  getAll(): Provider<T>[];
  findBest(input: unknown): Provider<T> | undefined;
}
```

### 3.2 Dependency Injection

Components receive dependencies via constructor injection:

```typescript
class Indexer {
  constructor(
    private storage: StorageAdapter,
    private parserRegistry: ParserRegistry,
    private chunkerRegistry: ChunkerRegistry,
    private embedderRegistry: EmbedderRegistry,
    private queue: IndexQueue,
    private config: IndexerConfig,
  ) {}
}
```

### 3.3 Event-Driven Communication

Components communicate via events for loose coupling:

```typescript
interface SearchSystemEvents {
  'indexing:started': { documentId: string; filePath: string };
  'indexing:progress': { documentId: string; stage: string; progress: number };
  'indexing:completed': { documentId: string; chunksCreated: number };
  'indexing:failed': { documentId: string; error: Error };
  'sync:detected': { added: string[]; modified: string[]; deleted: string[] };
  'search:completed': {
    queryId: string;
    resultsCount: number;
    duration: number;
  };
}
```

### 3.4 Configuration-Driven Behavior

All behavior is configurable:

```typescript
interface SearchSystemConfig {
  // Database
  database: {
    path: string; // Default: .auditaria/search.db
    maxConnections: number;
  };

  // Indexing
  indexing: {
    ignorePaths: string[]; // Additional ignores beyond .gitignore
    includePaths: string[]; // If set, only index these paths
    fileTypes: string[]; // File extensions to index
    maxFileSize: number; // Skip files larger than this
    ocrEnabled: boolean;
    ocrPriority: 'high' | 'low' | 'skip';
  };

  // Chunking
  chunking: {
    strategy: 'recursive' | 'semantic' | 'fixed';
    maxChunkSize: number;
    chunkOverlap: number;
  };

  // Embeddings
  embeddings: {
    model: string; // Default: 'Xenova/multilingual-e5-small'
    batchSize: number;
    dimensions: number;
  };

  // Search
  search: {
    defaultLimit: number;
    defaultStrategy: 'hybrid' | 'semantic' | 'keyword';
    semanticWeight: number; // 0-1, for hybrid search
    keywordWeight: number; // 0-1, for hybrid search
  };
}
```

---

## 4. Component Design

### 4.1 Parser Registry

```typescript
// packages/search/src/parsers/types.ts

interface ParsedDocument {
  text: string;
  metadata: {
    title?: string;
    author?: string;
    createdAt?: Date;
    modifiedAt?: Date;
    pageCount?: number;
    language?: string;
    [key: string]: unknown;
  };
  requiresOcr: boolean;  // True if document has images/scans needing OCR
  ocrRegions?: OcrRegion[];  // Regions that need OCR processing
}

interface OcrRegion {
  page: number;
  bounds: { x: number; y: number; width: number; height: number };
  imageData?: Buffer;
}

interface DocumentParser {
  name: string;
  supportedExtensions: string[];
  supportedMimeTypes: string[];
  priority: number;

  supports(filePath: string, mimeType?: string): boolean;
  parse(filePath: string, options?: ParserOptions): Promise<ParsedDocument>;
  parseBuffer(buffer: Buffer, options?: ParserOptions): Promise<ParsedDocument>;
}

// Built-in parsers
class OfficeParserAdapter implements DocumentParser { ... }
class PdfParseAdapter implements DocumentParser { ... }
class PlainTextParser implements DocumentParser { ... }
class MarkdownParser implements DocumentParser { ... }

// Parser Registry
class ParserRegistry extends Registry<ParsedDocument> {
  constructor() {
    // Register default parsers
    this.register(new OfficeParserAdapter());
    this.register(new PdfParseAdapter());
    this.register(new PlainTextParser());
    this.register(new MarkdownParser());
  }

  getParserForFile(filePath: string): DocumentParser | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.getAll()
      .filter(p => p.supportedExtensions.includes(ext))
      .sort((a, b) => b.priority - a.priority)[0];
  }
}
```

### 4.2 Chunker Registry

```typescript
// packages/search/src/chunkers/types.ts

interface Chunk {
  id: string;
  text: string;
  index: number;
  startOffset: number;
  endOffset: number;
  metadata: {
    page?: number;
    section?: string;
    heading?: string;
  };
}

interface DocumentChunker {
  name: string;
  priority: number;

  chunk(text: string, options?: ChunkerOptions): Promise<Chunk[]>;
}

interface ChunkerOptions {
  maxChunkSize: number;
  chunkOverlap: number;
  preserveSentences: boolean;
  preserveParagraphs: boolean;
}

// Built-in chunkers
class RecursiveChunker implements DocumentChunker { ... }
class FixedSizeChunker implements DocumentChunker { ... }
class SemanticChunker implements DocumentChunker { ... }  // Uses embeddings
```

### 4.3 Embedder Registry

```typescript
// packages/search/src/embedders/types.ts

interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
  tokenCount: number;
}

interface TextEmbedder {
  name: string;
  modelId: string;
  dimensions: number;
  maxTokens: number;
  isMultilingual: boolean;
  priority: number;

  initialize(): Promise<void>;
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  embedQuery(query: string): Promise<EmbeddingResult>;  // May add "query:" prefix
  embedDocument(text: string): Promise<EmbeddingResult>;  // May add "passage:" prefix
  dispose(): Promise<void>;
}

// Built-in embedders
class TransformersJsEmbedder implements TextEmbedder {
  constructor(modelId: string = 'Xenova/multilingual-e5-small') { ... }
}
```

### 4.4 OCR Registry

```typescript
// packages/search/src/ocr/types.ts

interface OcrResult {
  text: string;
  confidence: number;
  language?: string;
  regions: OcrTextRegion[];
}

interface OcrTextRegion {
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  confidence: number;
}

interface OcrProvider {
  name: string;
  supportedLanguages: string[];
  priority: number;

  initialize(): Promise<void>;
  recognize(image: Buffer, options?: OcrOptions): Promise<OcrResult>;
  recognizeRegions(regions: OcrRegion[]): Promise<OcrResult[]>;
  dispose(): Promise<void>;
}

// Built-in OCR providers
class TesseractJsProvider implements OcrProvider { ... }
// Future: class CloudOcrProvider implements OcrProvider { ... }
```

### 4.5 Storage Adapter

```typescript
// packages/search/src/storage/types.ts

interface Document {
  id: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  fileHash: string; // For change detection
  mimeType: string;
  title?: string;
  author?: string;
  language?: string;
  pageCount?: number;
  status: DocumentStatus;
  ocrStatus: OcrStatus;
  indexedAt?: Date;
  fileModifiedAt: Date;
  metadata: Record<string, unknown>;
  tags: string[];
}

type DocumentStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed';
type OcrStatus =
  | 'not_needed'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
  startOffset: number;
  endOffset: number;
  page?: number;
  section?: string;
  tokenCount: number;
}

interface SearchFilters {
  folders?: string[]; // Filter by folder paths
  fileTypes?: string[]; // Filter by extensions
  tags?: string[]; // Filter by tags
  dateFrom?: Date; // Modified after
  dateTo?: Date; // Modified before
  status?: DocumentStatus[]; // Filter by status
  languages?: string[]; // Filter by detected language
  minScore?: number; // Minimum relevance score
}

interface SearchResult {
  documentId: string;
  chunkId: string;
  filePath: string;
  fileName: string;
  chunkText: string;
  score: number;
  matchType: 'semantic' | 'keyword' | 'hybrid';
  highlights?: string[]; // Highlighted snippets
  metadata: {
    page?: number;
    section?: string;
    tags: string[];
  };
}

interface StorageAdapter {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Documents
  createDocument(doc: Omit<Document, 'id'>): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  getDocumentByPath(filePath: string): Promise<Document | null>;
  updateDocument(id: string, updates: Partial<Document>): Promise<Document>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]>;

  // Chunks
  createChunks(
    documentId: string,
    chunks: Omit<DocumentChunk, 'id' | 'documentId'>[],
  ): Promise<DocumentChunk[]>;
  getChunks(documentId: string): Promise<DocumentChunk[]>;
  deleteChunks(documentId: string): Promise<void>;
  updateChunkEmbeddings(
    chunks: { id: string; embedding: number[] }[],
  ): Promise<void>;

  // Tags
  addTags(documentId: string, tags: string[]): Promise<void>;
  removeTags(documentId: string, tags: string[]): Promise<void>;
  getAllTags(): Promise<{ tag: string; count: number }[]>;

  // Search
  searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]>;
  searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]>;
  searchHybrid(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit?: number,
    weights?: { semantic: number; keyword: number },
  ): Promise<SearchResult[]>;

  // Sync
  getFileHashes(): Promise<Map<string, string>>; // filePath -> hash
  getDocumentsModifiedSince(date: Date): Promise<Document[]>;

  // Stats
  getStats(): Promise<{
    totalDocuments: number;
    totalChunks: number;
    indexedDocuments: number;
    pendingDocuments: number;
    failedDocuments: number;
    ocrPending: number;
    totalTags: number;
    databaseSize: number;
  }>;
}
```

### 4.6 Index Queue

```typescript
// packages/search/src/queue/types.ts

interface QueueItem {
  id: string;
  filePath: string;
  priority: QueuePriority;
  status: QueueItemStatus;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

type QueuePriority = 'high' | 'normal' | 'low' | 'ocr'; // ocr is lowest
type QueueItemStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface IndexQueue {
  enqueue(filePath: string, priority?: QueuePriority): Promise<QueueItem>;
  enqueueBatch(
    filePaths: string[],
    priority?: QueuePriority,
  ): Promise<QueueItem[]>;
  dequeue(): Promise<QueueItem | null>;
  peek(): Promise<QueueItem | null>;
  markCompleted(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  retry(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  getQueue(): Promise<QueueItem[]>;
  getQueueLength(): Promise<number>;
  clear(): Promise<void>;

  // Priority management
  getPendingByPriority(): Promise<Map<QueuePriority, number>>;
  promoteOcrItems(): Promise<void>; // Move OCR items to normal priority
}
```

---

## 5. Database Schema

### 5.1 PGlite Schema

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_hash TEXT NOT NULL,
  mime_type TEXT,
  title TEXT,
  author TEXT,
  language TEXT,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  ocr_status TEXT NOT NULL DEFAULT 'not_needed',
  indexed_at TIMESTAMP,
  file_modified_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB DEFAULT '{}',

  -- Indexes
  CONSTRAINT valid_status CHECK (status IN ('pending', 'parsing', 'chunking', 'embedding', 'indexed', 'failed')),
  CONSTRAINT valid_ocr_status CHECK (ocr_status IN ('not_needed', 'pending', 'processing', 'completed', 'failed', 'skipped'))
);

CREATE INDEX idx_documents_file_path ON documents(file_path);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_ocr_status ON documents(ocr_status);
CREATE INDEX idx_documents_file_extension ON documents(file_extension);
CREATE INDEX idx_documents_file_modified_at ON documents(file_modified_at);

-- Chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(384),  -- For multilingual-e5-small (384 dimensions)
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  page INTEGER,
  section TEXT,
  token_count INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Full-text search vector (auto-generated)
  fts_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(section, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED,

  UNIQUE(document_id, chunk_index)
);

CREATE INDEX idx_chunks_document_id ON chunks(document_id);
CREATE INDEX idx_chunks_fts ON chunks USING GIN(fts_vector);
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw(embedding vector_cosine_ops);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tags_name ON tags(name);

-- Document-Tags junction table
CREATE TABLE IF NOT EXISTS document_tags (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX idx_document_tags_tag_id ON document_tags(tag_id);

-- Index queue table
CREATE TABLE IF NOT EXISTS index_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path TEXT NOT NULL UNIQUE,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  CONSTRAINT valid_priority CHECK (priority IN ('high', 'normal', 'low', 'ocr')),
  CONSTRAINT valid_queue_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX idx_queue_status_priority ON index_queue(status, priority, created_at);

-- Search configuration table
CREATE TABLE IF NOT EXISTS search_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default configuration
INSERT INTO search_config (key, value) VALUES
  ('embedding_model', '"Xenova/multilingual-e5-small"'),
  ('embedding_dimensions', '384'),
  ('chunk_size', '1000'),
  ('chunk_overlap', '200'),
  ('initialized_at', 'null')
ON CONFLICT (key) DO NOTHING;

-- Useful views
CREATE OR REPLACE VIEW document_stats AS
SELECT
  COUNT(*) as total_documents,
  COUNT(*) FILTER (WHERE status = 'indexed') as indexed_documents,
  COUNT(*) FILTER (WHERE status = 'pending') as pending_documents,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_documents,
  COUNT(*) FILTER (WHERE ocr_status = 'pending') as ocr_pending,
  SUM(file_size) as total_file_size
FROM documents;

CREATE OR REPLACE VIEW tag_counts AS
SELECT t.name as tag, COUNT(dt.document_id) as count
FROM tags t
LEFT JOIN document_tags dt ON t.id = dt.tag_id
GROUP BY t.id, t.name
ORDER BY count DESC;
```

### 5.2 Hybrid Search Query

```sql
-- Hybrid search with RRF (Reciprocal Rank Fusion)
WITH params AS (
  SELECT
    $1::vector AS query_embedding,
    $2::text AS query_text,
    $3::int AS result_limit,
    $4::float AS semantic_weight,
    $5::float AS keyword_weight
),
semantic_results AS (
  SELECT
    c.id,
    c.document_id,
    c.text,
    c.page,
    c.section,
    d.file_path,
    d.file_name,
    1 - (c.embedding <=> (SELECT query_embedding FROM params)) AS similarity,
    ROW_NUMBER() OVER (ORDER BY c.embedding <=> (SELECT query_embedding FROM params)) AS rank
  FROM chunks c
  JOIN documents d ON c.document_id = d.id
  WHERE d.status = 'indexed'
    AND c.embedding IS NOT NULL
    -- Optional filters here
  ORDER BY c.embedding <=> (SELECT query_embedding FROM params)
  LIMIT 50
),
keyword_results AS (
  SELECT
    c.id,
    c.document_id,
    c.text,
    c.page,
    c.section,
    d.file_path,
    d.file_name,
    ts_rank(c.fts_vector, plainto_tsquery((SELECT query_text FROM params))) AS similarity,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank(c.fts_vector, plainto_tsquery((SELECT query_text FROM params))) DESC
    ) AS rank
  FROM chunks c
  JOIN documents d ON c.document_id = d.id
  WHERE d.status = 'indexed'
    AND c.fts_vector @@ plainto_tsquery((SELECT query_text FROM params))
    -- Optional filters here
  ORDER BY ts_rank(c.fts_vector, plainto_tsquery((SELECT query_text FROM params))) DESC
  LIMIT 50
),
combined AS (
  SELECT
    COALESCE(s.id, k.id) AS chunk_id,
    COALESCE(s.document_id, k.document_id) AS document_id,
    COALESCE(s.text, k.text) AS chunk_text,
    COALESCE(s.page, k.page) AS page,
    COALESCE(s.section, k.section) AS section,
    COALESCE(s.file_path, k.file_path) AS file_path,
    COALESCE(s.file_name, k.file_name) AS file_name,
    s.similarity AS semantic_similarity,
    k.similarity AS keyword_similarity,
    COALESCE((SELECT semantic_weight FROM params) / (60.0 + s.rank), 0) +
    COALESCE((SELECT keyword_weight FROM params) / (60.0 + k.rank), 0) AS rrf_score,
    CASE
      WHEN s.id IS NOT NULL AND k.id IS NOT NULL THEN 'hybrid'
      WHEN s.id IS NOT NULL THEN 'semantic'
      ELSE 'keyword'
    END AS match_type
  FROM semantic_results s
  FULL OUTER JOIN keyword_results k ON s.id = k.id
)
SELECT
  chunk_id,
  document_id,
  file_path,
  file_name,
  chunk_text,
  page,
  section,
  rrf_score AS score,
  match_type,
  semantic_similarity,
  keyword_similarity
FROM combined
ORDER BY rrf_score DESC
LIMIT (SELECT result_limit FROM params);
```

---

## 6. File Processing Pipeline

### 6.1 Discovery Phase

```typescript
// packages/search/src/discovery/FileDiscovery.ts

interface DiscoveryOptions {
  rootPaths: string[];
  ignorePaths: string[];
  includePatterns: string[];
  excludePatterns: string[];
  respectGitignore: boolean;
  maxFileSize: number;
  fileTypes: string[];
}

interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  size: number;
  modifiedAt: Date;
  hash: string;
}

class FileDiscovery {
  constructor(private options: DiscoveryOptions) {}

  async discover(): AsyncGenerator<DiscoveredFile>;
  async discoverAll(): Promise<DiscoveredFile[]>;

  private async calculateHash(filePath: string): Promise<string>;
  private shouldInclude(filePath: string): boolean;
  private loadGitignore(rootPath: string): Promise<string[]>;
}
```

### 6.2 Processing Pipeline

```typescript
// packages/search/src/pipeline/IndexingPipeline.ts

interface PipelineStage<TInput, TOutput> {
  name: string;
  process(input: TInput, context: PipelineContext): Promise<TOutput>;
  onError?(error: Error, input: TInput, context: PipelineContext): Promise<void>;
}

interface PipelineContext {
  documentId: string;
  filePath: string;
  startTime: Date;
  metadata: Record<string, unknown>;
  emit(event: string, data: unknown): void;
}

class IndexingPipeline {
  private stages: PipelineStage<unknown, unknown>[] = [];

  addStage<TInput, TOutput>(stage: PipelineStage<TInput, TOutput>): this;

  async process(filePath: string): Promise<void> {
    const context = this.createContext(filePath);

    try {
      context.emit('pipeline:started', { filePath });

      let result: unknown = filePath;

      for (const stage of this.stages) {
        context.emit('stage:started', { stage: stage.name });
        result = await stage.process(result, context);
        context.emit('stage:completed', { stage: stage.name });
      }

      context.emit('pipeline:completed', { filePath });
    } catch (error) {
      context.emit('pipeline:failed', { filePath, error });
      throw error;
    }
  }
}

// Pipeline stages
class ParseStage implements PipelineStage<string, ParsedDocument> { ... }
class ChunkStage implements PipelineStage<ParsedDocument, Chunk[]> { ... }
class EmbedStage implements PipelineStage<Chunk[], EmbeddedChunk[]> { ... }
class StoreStage implements PipelineStage<EmbeddedChunk[], void> { ... }
```

### 6.3 OCR Queue Management

```typescript
// packages/search/src/ocr/OcrQueueManager.ts

interface OcrQueueConfig {
  enabled: boolean;
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  processAfterMainQueue: boolean; // Wait for non-OCR items first
}

class OcrQueueManager {
  constructor(
    private storage: StorageAdapter,
    private ocrRegistry: OcrRegistry,
    private config: OcrQueueConfig,
  ) {}

  async enqueue(documentId: string, regions: OcrRegion[]): Promise<void>;
  async processNext(): Promise<void>;
  async processAll(): Promise<void>;

  // Process OCR only after main indexing is done
  async waitForMainQueue(): Promise<void>;

  private async processDocument(documentId: string): Promise<void>;
}
```

---

## 7. Search Implementation

### 7.1 Search Engine

```typescript
// packages/search/src/search/SearchEngine.ts

interface SearchOptions {
  query: string;
  strategy: 'hybrid' | 'semantic' | 'keyword';
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  weights?: {
    semantic: number;
    keyword: number;
  };
  highlight?: boolean;
  highlightTag?: string;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number; // milliseconds
  query: string;
  strategy: string;
  filters: SearchFilters;
}

class SearchEngine {
  constructor(
    private storage: StorageAdapter,
    private embedder: TextEmbedder,
    private config: SearchConfig,
  ) {}

  async search(options: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();

    let results: SearchResult[];

    switch (options.strategy) {
      case 'keyword':
        results = await this.keywordSearch(options);
        break;
      case 'semantic':
        results = await this.semanticSearch(options);
        break;
      case 'hybrid':
      default:
        results = await this.hybridSearch(options);
    }

    if (options.highlight) {
      results = this.addHighlights(
        results,
        options.query,
        options.highlightTag,
      );
    }

    return {
      results,
      total: results.length,
      took: Date.now() - startTime,
      query: options.query,
      strategy: options.strategy,
      filters: options.filters || {},
    };
  }

  private async keywordSearch(options: SearchOptions): Promise<SearchResult[]>;
  private async semanticSearch(options: SearchOptions): Promise<SearchResult[]>;
  private async hybridSearch(options: SearchOptions): Promise<SearchResult[]>;
  private addHighlights(
    results: SearchResult[],
    query: string,
    tag?: string,
  ): SearchResult[];
}
```

### 7.2 Filter Builder

```typescript
// packages/search/src/search/FilterBuilder.ts

class FilterBuilder {
  private conditions: string[] = [];
  private params: unknown[] = [];
  private paramIndex = 1;

  folder(folders: string[]): this {
    if (folders.length > 0) {
      const placeholders = folders
        .map(() => `$${this.paramIndex++}`)
        .join(', ');
      this.conditions.push(`d.file_path LIKE ANY(ARRAY[${placeholders}])`);
      this.params.push(...folders.map((f) => `${f}%`));
    }
    return this;
  }

  fileTypes(extensions: string[]): this {
    if (extensions.length > 0) {
      const placeholders = extensions
        .map(() => `$${this.paramIndex++}`)
        .join(', ');
      this.conditions.push(`d.file_extension IN (${placeholders})`);
      this.params.push(
        ...extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)),
      );
    }
    return this;
  }

  tags(tags: string[]): this {
    if (tags.length > 0) {
      const placeholders = tags.map(() => `$${this.paramIndex++}`).join(', ');
      this.conditions.push(`
        EXISTS (
          SELECT 1 FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE dt.document_id = d.id AND t.name IN (${placeholders})
        )
      `);
      this.params.push(...tags);
    }
    return this;
  }

  dateRange(from?: Date, to?: Date): this {
    if (from) {
      this.conditions.push(`d.file_modified_at >= $${this.paramIndex++}`);
      this.params.push(from);
    }
    if (to) {
      this.conditions.push(`d.file_modified_at <= $${this.paramIndex++}`);
      this.params.push(to);
    }
    return this;
  }

  languages(languages: string[]): this {
    if (languages.length > 0) {
      const placeholders = languages
        .map(() => `$${this.paramIndex++}`)
        .join(', ');
      this.conditions.push(`d.language IN (${placeholders})`);
      this.params.push(...languages);
    }
    return this;
  }

  build(): { where: string; params: unknown[] } {
    return {
      where:
        this.conditions.length > 0
          ? `WHERE ${this.conditions.join(' AND ')}`
          : '',
      params: this.params,
    };
  }
}
```

---

## 8. Slash Commands & User Interface

### 8.1 Command: `/search-init`

Initializes the search database and starts indexing.

```typescript
// packages/cli/src/ui/commands/searchInitCommand.ts

interface SearchInitOptions {
  force?: boolean; // Reinitialize even if exists
  paths?: string[]; // Specific paths to index
  ocrEnabled?: boolean; // Enable OCR processing
}

async function searchInitCommand(options: SearchInitOptions): Promise<void> {
  // 1. Check if database already exists
  const dbPath = path.join(process.cwd(), '.auditaria', 'search.db');
  const exists = await fs.pathExists(dbPath);

  if (exists && !options.force) {
    // Offer to resync instead
    return;
  }

  // 2. Initialize database
  const searchSystem = await SearchSystem.initialize({
    databasePath: dbPath,
    ...options,
  });

  // 3. Discover files
  const files = await searchSystem.discoverFiles();

  // 4. Start background indexing
  await searchSystem.startIndexing(files);

  // 5. Show progress
  searchSystem.on('indexing:progress', (data) => {
    // Update UI
  });
}
```

### 8.2 Command: `/search`

Performs search with various options.

```typescript
// packages/cli/src/ui/commands/searchCommand.ts

interface SearchCommandOptions {
  query: string;
  type?: 'hybrid' | 'semantic' | 'keyword';
  folder?: string[];
  fileType?: string[];
  tag?: string[];
  limit?: number;
}

async function searchCommand(options: SearchCommandOptions): Promise<void> {
  const searchSystem = await SearchSystem.load();

  const results = await searchSystem.search({
    query: options.query,
    strategy: options.type || 'hybrid',
    filters: {
      folders: options.folder,
      fileTypes: options.fileType,
      tags: options.tag,
    },
    limit: options.limit || 10,
  });

  // Display results
  displaySearchResults(results);
}
```

### 8.3 Command: `/search-status`

Shows indexing status and statistics.

```typescript
// packages/cli/src/ui/commands/searchStatusCommand.ts

async function searchStatusCommand(): Promise<void> {
  const searchSystem = await SearchSystem.load();
  const stats = await searchSystem.getStats();

  // Display:
  // - Total documents
  // - Indexed documents
  // - Pending documents
  // - Failed documents
  // - OCR pending
  // - Database size
  // - Last sync time
}
```

### 8.4 Command: `/search-tag`

Manages document tags.

```typescript
// packages/cli/src/ui/commands/searchTagCommand.ts

interface TagCommandOptions {
  action: 'add' | 'remove' | 'list';
  file?: string;
  tags?: string[];
}

async function searchTagCommand(options: TagCommandOptions): Promise<void> {
  const searchSystem = await SearchSystem.load();

  switch (options.action) {
    case 'add':
      await searchSystem.addTags(options.file!, options.tags!);
      break;
    case 'remove':
      await searchSystem.removeTags(options.file!, options.tags!);
      break;
    case 'list':
      const tags = await searchSystem.getAllTags();
      displayTags(tags);
      break;
  }
}
```

---

## 9. Auto-Sync & File Watching

### 9.1 Sync on Startup

```typescript
// packages/search/src/sync/StartupSync.ts

interface SyncResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
  duration: number;
}

class StartupSync {
  constructor(
    private storage: StorageAdapter,
    private discovery: FileDiscovery,
    private queue: IndexQueue,
  ) {}

  async sync(): Promise<SyncResult> {
    const startTime = Date.now();

    // 1. Get current file states from disk
    const currentFiles = await this.discovery.discoverAll();
    const currentMap = new Map(currentFiles.map((f) => [f.absolutePath, f]));

    // 2. Get stored file states from database
    const storedHashes = await this.storage.getFileHashes();

    // 3. Compare and categorize
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    let unchanged = 0;

    // Find added and modified
    for (const [filePath, file] of currentMap) {
      const storedHash = storedHashes.get(filePath);

      if (!storedHash) {
        added.push(filePath);
      } else if (storedHash !== file.hash) {
        modified.push(filePath);
      } else {
        unchanged++;
      }
    }

    // Find deleted
    for (const [filePath] of storedHashes) {
      if (!currentMap.has(filePath)) {
        deleted.push(filePath);
      }
    }

    // 4. Queue changes
    if (added.length > 0) {
      await this.queue.enqueueBatch(added, 'normal');
    }

    if (modified.length > 0) {
      // Delete old chunks first
      for (const filePath of modified) {
        const doc = await this.storage.getDocumentByPath(filePath);
        if (doc) {
          await this.storage.deleteChunks(doc.id);
        }
      }
      await this.queue.enqueueBatch(modified, 'normal');
    }

    if (deleted.length > 0) {
      for (const filePath of deleted) {
        const doc = await this.storage.getDocumentByPath(filePath);
        if (doc) {
          await this.storage.deleteDocument(doc.id);
        }
      }
    }

    return {
      added,
      modified,
      deleted,
      unchanged,
      duration: Date.now() - startTime,
    };
  }
}
```

### 9.2 File Watcher (Optional Real-time)

```typescript
// packages/search/src/sync/FileWatcher.ts

interface FileWatcherConfig {
  enabled: boolean;
  debounceMs: number;
  ignorePaths: string[];
}

class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Map<string, 'add' | 'change' | 'unlink'> = new Map();

  constructor(
    private rootPath: string,
    private queue: IndexQueue,
    private storage: StorageAdapter,
    private config: FileWatcherConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) return;

    this.watcher = chokidar.watch(this.rootPath, {
      ignored: this.config.ignorePaths,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('add', (path) => this.handleChange(path, 'add'))
      .on('change', (path) => this.handleChange(path, 'change'))
      .on('unlink', (path) => this.handleChange(path, 'unlink'));
  }

  stop(): void {
    this.watcher?.close();
  }

  private handleChange(
    filePath: string,
    type: 'add' | 'change' | 'unlink',
  ): void {
    this.pendingChanges.set(filePath, type);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.config.debounceMs);
  }

  private async flush(): Promise<void> {
    const changes = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    for (const [filePath, type] of changes) {
      switch (type) {
        case 'add':
        case 'change':
          await this.queue.enqueue(filePath, 'normal');
          break;
        case 'unlink':
          const doc = await this.storage.getDocumentByPath(filePath);
          if (doc) {
            await this.storage.deleteDocument(doc.id);
          }
          break;
      }
    }
  }
}
```

---

## 10. Implementation Phases

### Phase 1: Core Infrastructure (Foundation)

**Goal:** Establish the foundational architecture with pluggable components.

**Tasks:**

1.1 Create package structure

- [ ] Create `packages/search/` directory
- [ ] Set up TypeScript configuration
- [ ] Set up Jest testing configuration
- [ ] Create package.json with dependencies

1.2 Implement Registry pattern

- [ ] Create generic `Registry<T>` class
- [ ] Create `Provider<T>` interface
- [ ] Add tests for registry operations

1.3 Implement Storage Adapter (PGlite)

- [ ] Initialize PGlite with pgvector
- [ ] Implement schema migration
- [ ] Implement CRUD operations for documents
- [ ] Implement CRUD operations for chunks
- [ ] Implement tag management
- [ ] Add tests for all storage operations

1.4 Implement Configuration system

- [ ] Create config types and defaults
- [ ] Implement config loading from `.auditaria/search.config.json`
- [ ] Add config validation

**Success Criteria:**

- All registry tests pass
- Storage adapter can create, read, update, delete documents
- Config can be loaded and validated
- PGlite initializes with pgvector extension

**Estimated Test Count:** ~30 tests

---

### Phase 2: Document Processing Pipeline

**Goal:** Build the complete document processing pipeline with pluggable
parsers.

**Tasks:**

2.1 Implement Parser Registry

- [ ] Create `DocumentParser` interface
- [ ] Implement `OfficeParserAdapter` (DOCX, PPTX, XLSX)
- [ ] Implement `PdfParseAdapter` (PDF)
- [ ] Implement `PlainTextParser` (TXT, MD, etc.)
- [ ] Add tests for each parser

2.2 Implement Chunker Registry

- [ ] Create `DocumentChunker` interface
- [ ] Implement `RecursiveChunker`
- [ ] Implement `FixedSizeChunker`
- [ ] Add tests for chunking strategies

2.3 Implement File Discovery

- [ ] Implement file walking with glob patterns
- [ ] Implement .gitignore parsing
- [ ] Implement file hash calculation
- [ ] Add tests for discovery

2.4 Implement Index Queue

- [ ] Create queue table schema
- [ ] Implement priority queue operations
- [ ] Implement retry logic
- [ ] Add tests for queue operations

2.5 Implement Indexing Pipeline

- [ ] Create pipeline orchestrator
- [ ] Wire up parse → chunk → store stages
- [ ] Implement progress events
- [ ] Add integration tests

**Success Criteria:**

- Can parse DOCX, PPTX, XLSX, PDF, TXT, MD files
- Chunking produces valid, overlapping chunks
- Queue correctly prioritizes items
- Pipeline successfully indexes a test document end-to-end

**Estimated Test Count:** ~50 tests

---

### Phase 3: Embeddings & Vector Search

**Goal:** Add semantic search capabilities with local embeddings.

**Tasks:**

3.1 Implement Embedder Registry

- [ ] Create `TextEmbedder` interface
- [ ] Implement `TransformersJsEmbedder`
- [ ] Add model download progress reporting
- [ ] Add tests for embedding generation

3.2 Integrate embeddings into pipeline

- [ ] Add embed stage to pipeline
- [ ] Implement batch embedding for efficiency
- [ ] Store embeddings in chunks table
- [ ] Add integration tests

3.3 Implement Semantic Search

- [ ] Implement query embedding
- [ ] Implement vector similarity search
- [ ] Add tests for semantic search

3.4 Implement Keyword Search

- [ ] Implement FTS query building
- [ ] Add ranking and highlighting
- [ ] Add tests for keyword search

3.5 Implement Hybrid Search

- [ ] Implement RRF fusion algorithm
- [ ] Add configurable weights
- [ ] Add tests for hybrid search

**Success Criteria:**

- Embeddings are generated locally (no API calls)
- Model downloads automatically on first use
- Semantic search returns relevant results
- Keyword search returns relevant results
- Hybrid search combines both effectively

**Estimated Test Count:** ~40 tests

---

### Phase 4: Filtering & Tagging

**Goal:** Enable rich filtering and organization capabilities.

**Tasks:**

4.1 Implement Filter Builder

- [ ] Create `FilterBuilder` class
- [ ] Add folder filtering
- [ ] Add file type filtering
- [ ] Add tag filtering
- [ ] Add date range filtering
- [ ] Add language filtering
- [ ] Add tests for filter builder

4.2 Implement Tag Management

- [ ] Implement tag CRUD operations
- [ ] Add auto-tagging based on path patterns
- [ ] Add tests for tag operations

4.3 Integrate filters into search

- [ ] Update all search methods to use filters
- [ ] Add tests for filtered searches

**Success Criteria:**

- Can filter by any combination of criteria
- Tags can be added, removed, listed
- Filtered searches return correct results

**Estimated Test Count:** ~25 tests

---

### Phase 5: Auto-Sync & Slash Commands

**Goal:** Enable automatic synchronization and user-facing commands.

**Tasks:**

5.1 Implement Startup Sync

- [ ] Create `StartupSync` class
- [ ] Detect added files
- [ ] Detect modified files
- [ ] Detect deleted files
- [ ] Add tests for sync detection

5.2 Implement File Watcher (optional)

- [ ] Create `FileWatcher` class
- [ ] Add debouncing
- [ ] Add tests for file watching

5.3 Implement Slash Commands

- [ ] `/search-init` command
- [ ] `/search` command
- [ ] `/search-status` command
- [ ] `/search-tag` command
- [ ] Add command documentation

5.4 Integrate with Auditaria startup

- [ ] Check for existing database on startup
- [ ] Run sync if database exists
- [ ] Show sync results

**Success Criteria:**

- Startup correctly detects file changes
- All slash commands work as expected
- Commands provide helpful feedback

**Estimated Test Count:** ~30 tests

---

### Phase 6: OCR Support

**Goal:** Add OCR capabilities for scanned documents.

**Tasks:**

6.1 Implement OCR Registry

- [ ] Create `OcrProvider` interface
- [ ] Implement `TesseractJsProvider`
- [ ] Add tests for OCR

6.2 Implement OCR Queue Manager

- [ ] Create OCR queue management
- [ ] Process OCR items after main queue
- [ ] Add retry logic
- [ ] Add tests

6.3 Integrate OCR into pipeline

- [ ] Detect documents needing OCR
- [ ] Extract image regions
- [ ] Merge OCR text with document text
- [ ] Add integration tests

**Success Criteria:**

- Scanned PDFs can be processed
- OCR items are processed with lower priority
- Failed OCR doesn't block other indexing

**Estimated Test Count:** ~20 tests

---

### Phase 7: AI Tool Integration

**Goal:** Create tools for AI agents to use the search system.

**Tasks:**

7.1 Implement Search Tool

- [ ] Create `search_documents` tool
- [ ] Support all search types
- [ ] Support all filters
- [ ] Return structured results

7.2 Implement Management Tools

- [ ] Create `search_init` tool
- [ ] Create `search_status` tool
- [ ] Create `search_reindex` tool

7.3 Add to Auditaria tool registry

- [ ] Register tools in config
- [ ] Add tool documentation

**Success Criteria:**

- AI can search documents via tool
- AI can manage search system via tools
- Tools return useful, structured responses

**Estimated Test Count:** ~15 tests

---

## 11. Testing Strategy

### 11.1 Test Structure

```
packages/search/
├── src/
│   ├── __tests__/
│   │   ├── unit/
│   │   │   ├── registry.test.ts
│   │   │   ├── storage.test.ts
│   │   │   ├── parsers/
│   │   │   │   ├── officeParser.test.ts
│   │   │   │   ├── pdfParser.test.ts
│   │   │   │   └── textParser.test.ts
│   │   │   ├── chunkers/
│   │   │   │   ├── recursiveChunker.test.ts
│   │   │   │   └── fixedChunker.test.ts
│   │   │   ├── embedders/
│   │   │   │   └── transformersJs.test.ts
│   │   │   ├── search/
│   │   │   │   ├── filterBuilder.test.ts
│   │   │   │   └── searchEngine.test.ts
│   │   │   └── sync/
│   │   │       └── startupSync.test.ts
│   │   ├── integration/
│   │   │   ├── indexingPipeline.test.ts
│   │   │   ├── searchFlow.test.ts
│   │   │   └── syncFlow.test.ts
│   │   └── fixtures/
│   │       ├── documents/
│   │       │   ├── sample.docx
│   │       │   ├── sample.pdf
│   │       │   ├── sample.pptx
│   │       │   ├── sample.xlsx
│   │       │   ├── sample.txt
│   │       │   └── sample.md
│   │       └── expected/
│   │           └── ...
```

### 11.2 Test Categories

#### Unit Tests

- Test individual functions in isolation
- Mock all dependencies
- Fast execution (<1ms per test)
- High coverage target (>90%)

#### Integration Tests

- Test component interactions
- Use real PGlite (in-memory)
- Use real parsers with fixture files
- Medium execution time (<5s per test)

#### E2E Tests (Optional)

- Test full user flows
- Use temp directories
- Slower execution

### 11.3 Test Fixtures

Create sample documents for testing:

```typescript
// packages/search/src/__tests__/fixtures/createFixtures.ts

const fixtures = {
  'sample.txt': 'This is a plain text document for testing.',
  'sample.md': '# Heading\n\nThis is **markdown** content.',
  // Binary files created separately
};

// DOCX, PDF, PPTX, XLSX fixtures should be created manually
// and committed to the repository
```

### 11.4 Test Utilities

```typescript
// packages/search/src/__tests__/utils/testUtils.ts

export async function createTestStorage(): Promise<StorageAdapter> {
  // Create in-memory PGlite for testing
  const storage = new PGliteStorage({ inMemory: true });
  await storage.initialize();
  return storage;
}

export async function createTestEmbedder(): Promise<TextEmbedder> {
  // Use a mock embedder for fast tests
  return new MockEmbedder();
}

export function createMockDocument(overrides?: Partial<Document>): Document {
  return {
    id: crypto.randomUUID(),
    filePath: '/test/document.txt',
    fileName: 'document.txt',
    fileExtension: '.txt',
    fileSize: 100,
    fileHash: 'abc123',
    status: 'pending',
    ocrStatus: 'not_needed',
    fileModifiedAt: new Date(),
    metadata: {},
    tags: [],
    ...overrides,
  };
}
```

### 11.5 Running Tests

```bash
# Run all tests
npm run test -w packages/search

# Run unit tests only
npm run test:unit -w packages/search

# Run integration tests only
npm run test:integration -w packages/search

# Run with coverage
npm run test:coverage -w packages/search

# Run specific test file
npm run test -- packages/search/src/__tests__/unit/storage.test.ts
```

---

## 12. Success Criteria

### 12.1 Phase 1 Success Criteria

| Criterion             | Metric         | Target |
| --------------------- | -------------- | ------ |
| Registry tests pass   | Test count     | 10/10  |
| Storage tests pass    | Test count     | 15/15  |
| Config tests pass     | Test count     | 5/5    |
| PGlite initialization | Success        | Yes    |
| pgvector enabled      | Query succeeds | Yes    |

### 12.2 Phase 2 Success Criteria

| Criterion           | Metric        | Target |
| ------------------- | ------------- | ------ |
| Parser tests pass   | Test count    | 20/20  |
| Chunker tests pass  | Test count    | 10/10  |
| Queue tests pass    | Test count    | 10/10  |
| Pipeline tests pass | Test count    | 10/10  |
| DOCX parsing        | Extracts text | Yes    |
| PDF parsing         | Extracts text | Yes    |
| PPTX parsing        | Extracts text | Yes    |
| XLSX parsing        | Extracts text | Yes    |

### 12.3 Phase 3 Success Criteria

| Criterion               | Metric           | Target |
| ----------------------- | ---------------- | ------ |
| Embedder tests pass     | Test count       | 15/15  |
| Search tests pass       | Test count       | 25/25  |
| Model downloads         | Auto-download    | Yes    |
| Embedding time          | Per chunk        | <100ms |
| Semantic search quality | Relevant results | Top 3  |
| Hybrid search quality   | Relevant results | Top 3  |

### 12.4 Phase 4 Success Criteria

| Criterion         | Metric          | Target |
| ----------------- | --------------- | ------ |
| Filter tests pass | Test count      | 15/15  |
| Tag tests pass    | Test count      | 10/10  |
| Folder filter     | Works correctly | Yes    |
| Type filter       | Works correctly | Yes    |
| Tag filter        | Works correctly | Yes    |
| Combined filters  | Works correctly | Yes    |

### 12.5 Phase 5 Success Criteria

| Criterion             | Metric     | Target |
| --------------------- | ---------- | ------ |
| Sync tests pass       | Test count | 20/20  |
| Command tests pass    | Test count | 10/10  |
| Detect added files    | Correct    | Yes    |
| Detect modified files | Correct    | Yes    |
| Detect deleted files  | Correct    | Yes    |
| /search-init works    | Success    | Yes    |
| /search works         | Success    | Yes    |

### 12.6 Phase 6 Success Criteria

| Criterion      | Metric            | Target |
| -------------- | ----------------- | ------ |
| OCR tests pass | Test count        | 15/15  |
| OCR priority   | Lower than normal | Yes    |
| Scanned PDF    | Text extracted    | Yes    |
| OCR quality    | Readable          | 80%+   |

### 12.7 Phase 7 Success Criteria

| Criterion             | Metric     | Target |
| --------------------- | ---------- | ------ |
| Tool tests pass       | Test count | 15/15  |
| search_documents tool | Works      | Yes    |
| search_init tool      | Works      | Yes    |
| Tool response format  | Structured | Yes    |

### 12.8 Overall Success Criteria

| Criterion            | Metric        | Target |
| -------------------- | ------------- | ------ |
| Total test count     | Tests passing | ~210   |
| Test coverage        | Line coverage | >85%   |
| No user intervention | Automated     | 100%   |
| Documentation        | Complete      | Yes    |

---

## 13. Dependencies

### 13.1 Production Dependencies

```json
{
  "dependencies": {
    "@electric-sql/pglite": "^0.2.15",
    "@huggingface/transformers": "^3.1.2",
    "officeparser": "^4.2.1",
    "pdf-parse": "^1.1.1",
    "ignore": "^6.0.2",
    "fast-glob": "^3.3.2",
    "xxhash-wasm": "^1.1.0"
  }
}
```

### 13.2 Optional Dependencies

```json
{
  "optionalDependencies": {
    "tesseract.js": "^5.1.1",
    "chokidar": "^4.0.3"
  }
}
```

### 13.3 Dev Dependencies

```json
{
  "devDependencies": {
    "jest": "^29.7.0",
    "@types/jest": "^29.5.14",
    "ts-jest": "^29.2.5"
  }
}
```

### 13.4 Dependency Justification

| Dependency                | Purpose                 | Size        | Alternative       |
| ------------------------- | ----------------------- | ----------- | ----------------- |
| @electric-sql/pglite      | Embedded PostgreSQL     | 3MB         | sqlite-vec        |
| @huggingface/transformers | Local embeddings        | 2MB + model | ONNX Runtime      |
| officeparser              | Office document parsing | 200KB       | mammoth + xlsx    |
| pdf-parse                 | PDF text extraction     | 50KB        | pdf.js-extract    |
| ignore                    | .gitignore parsing      | 20KB        | manual parsing    |
| fast-glob                 | File discovery          | 100KB       | native glob       |
| xxhash-wasm               | Fast file hashing       | 50KB        | crypto.createHash |
| tesseract.js (optional)   | OCR                     | 30MB        | cloud OCR         |
| chokidar (optional)       | File watching           | 100KB       | native fs.watch   |

---

## 14. File Structure

```
packages/search/
├── package.json
├── tsconfig.json
├── jest.config.js
├── README.md
├── src/
│   ├── index.ts                      # Main exports
│   ├── types.ts                      # Shared types
│   ├── config.ts                     # Configuration types and defaults
│   │
│   ├── core/
│   │   ├── Registry.ts               # Generic registry implementation
│   │   ├── EventEmitter.ts           # Event system
│   │   └── SearchSystem.ts           # Main orchestrator
│   │
│   ├── storage/
│   │   ├── types.ts                  # Storage interfaces
│   │   ├── PGliteStorage.ts          # PGlite implementation
│   │   ├── schema.sql                # Database schema
│   │   └── migrations/               # Schema migrations
│   │       └── 001_initial.sql
│   │
│   ├── parsers/
│   │   ├── types.ts                  # Parser interfaces
│   │   ├── ParserRegistry.ts         # Parser registry
│   │   ├── OfficeParserAdapter.ts    # officeparser wrapper
│   │   ├── PdfParseAdapter.ts        # pdf-parse wrapper
│   │   ├── PlainTextParser.ts        # TXT, MD, etc.
│   │   └── MarkdownParser.ts         # Enhanced MD parser
│   │
│   ├── chunkers/
│   │   ├── types.ts                  # Chunker interfaces
│   │   ├── ChunkerRegistry.ts        # Chunker registry
│   │   ├── RecursiveChunker.ts       # Recursive text splitting
│   │   └── FixedSizeChunker.ts       # Fixed-size chunks
│   │
│   ├── embedders/
│   │   ├── types.ts                  # Embedder interfaces
│   │   ├── EmbedderRegistry.ts       # Embedder registry
│   │   └── TransformersJsEmbedder.ts # Transformers.js wrapper
│   │
│   ├── ocr/
│   │   ├── types.ts                  # OCR interfaces
│   │   ├── OcrRegistry.ts            # OCR registry
│   │   ├── TesseractJsProvider.ts    # Tesseract.js wrapper
│   │   └── OcrQueueManager.ts        # OCR queue management
│   │
│   ├── search/
│   │   ├── types.ts                  # Search interfaces
│   │   ├── SearchEngine.ts           # Search orchestrator
│   │   ├── FilterBuilder.ts          # Query filter builder
│   │   └── ResultHighlighter.ts      # Result highlighting
│   │
│   ├── pipeline/
│   │   ├── types.ts                  # Pipeline interfaces
│   │   ├── IndexingPipeline.ts       # Pipeline orchestrator
│   │   └── stages/
│   │       ├── ParseStage.ts
│   │       ├── ChunkStage.ts
│   │       ├── EmbedStage.ts
│   │       └── StoreStage.ts
│   │
│   ├── queue/
│   │   ├── types.ts                  # Queue interfaces
│   │   └── IndexQueue.ts             # Priority queue implementation
│   │
│   ├── discovery/
│   │   ├── types.ts                  # Discovery interfaces
│   │   └── FileDiscovery.ts          # File discovery implementation
│   │
│   ├── sync/
│   │   ├── types.ts                  # Sync interfaces
│   │   ├── StartupSync.ts            # Startup synchronization
│   │   └── FileWatcher.ts            # Real-time file watching
│   │
│   ├── tools/
│   │   ├── searchDocumentsTool.ts    # AI search tool
│   │   ├── searchInitTool.ts         # AI init tool
│   │   └── searchStatusTool.ts       # AI status tool
│   │
│   └── __tests__/
│       ├── unit/
│       ├── integration/
│       ├── fixtures/
│       └── utils/
│
└── cli/                              # CLI command implementations
    ├── searchInitCommand.ts
    ├── searchCommand.ts
    ├── searchStatusCommand.ts
    └── searchTagCommand.ts
```

---

## 15. API Reference

### 15.1 SearchSystem API

```typescript
class SearchSystem {
  // Initialization
  static async initialize(
    config?: Partial<SearchSystemConfig>,
  ): Promise<SearchSystem>;
  static async load(dbPath?: string): Promise<SearchSystem>;

  // Indexing
  async discoverFiles(): Promise<DiscoveredFile[]>;
  async startIndexing(files?: DiscoveredFile[]): Promise<void>;
  async stopIndexing(): Promise<void>;
  async reindexDocument(filePath: string): Promise<void>;
  async reindexAll(): Promise<void>;

  // Search
  async search(options: SearchOptions): Promise<SearchResponse>;
  async searchKeyword(
    query: string,
    filters?: SearchFilters,
  ): Promise<SearchResult[]>;
  async searchSemantic(
    query: string,
    filters?: SearchFilters,
  ): Promise<SearchResult[]>;
  async searchHybrid(
    query: string,
    filters?: SearchFilters,
  ): Promise<SearchResult[]>;

  // Tags
  async addTags(filePath: string, tags: string[]): Promise<void>;
  async removeTags(filePath: string, tags: string[]): Promise<void>;
  async getAllTags(): Promise<{ tag: string; count: number }[]>;

  // Sync
  async sync(): Promise<SyncResult>;

  // Stats
  async getStats(): Promise<SearchStats>;
  async getQueueStatus(): Promise<QueueStatus>;

  // Events
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;

  // Lifecycle
  async close(): Promise<void>;
}
```

### 15.2 AI Tool Schemas

```typescript
// search_documents tool
const searchDocumentsSchema = {
  name: 'search_documents',
  description:
    'Search indexed documents using keyword, semantic, or hybrid search',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      strategy: {
        type: 'string',
        enum: ['hybrid', 'semantic', 'keyword'],
        description: 'Search strategy to use',
        default: 'hybrid',
      },
      folders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter results to specific folders',
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Filter results to specific file types (e.g., .pdf, .docx)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter results to documents with specific tags',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 10,
      },
    },
    required: ['query'],
  },
};

// search_init tool
const searchInitSchema = {
  name: 'search_init',
  description: 'Initialize or reinitialize the document search index',
  parameters: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force reinitialization even if index exists',
        default: false,
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific paths to index (defaults to current directory)',
      },
    },
  },
};

// search_status tool
const searchStatusSchema = {
  name: 'search_status',
  description: 'Get the current status of the document search index',
  parameters: {
    type: 'object',
    properties: {},
  },
};
```

---

## Appendix A: Configuration File Example

```json
// .auditaria/search.config.json
{
  "database": {
    "path": ".auditaria/search.db"
  },
  "indexing": {
    "ignorePaths": ["node_modules", ".git", "dist", "build", "*.log"],
    "fileTypes": [
      ".pdf",
      ".docx",
      ".pptx",
      ".xlsx",
      ".txt",
      ".md",
      ".json",
      ".yaml",
      ".yml"
    ],
    "maxFileSize": 52428800,
    "ocrEnabled": true,
    "ocrPriority": "low"
  },
  "chunking": {
    "strategy": "recursive",
    "maxChunkSize": 1000,
    "chunkOverlap": 200
  },
  "embeddings": {
    "model": "Xenova/multilingual-e5-small",
    "batchSize": 10,
    "dimensions": 384
  },
  "search": {
    "defaultLimit": 10,
    "defaultStrategy": "hybrid",
    "semanticWeight": 0.5,
    "keywordWeight": 0.5
  }
}
```

---

## Appendix B: Glossary

| Term            | Definition                                                  |
| --------------- | ----------------------------------------------------------- |
| BM25            | Best Matching 25, a ranking algorithm for full-text search  |
| Chunk           | A segment of text extracted from a document                 |
| Embedding       | A vector representation of text for semantic similarity     |
| FTS             | Full-Text Search, keyword-based search                      |
| HNSW            | Hierarchical Navigable Small World, an ANN algorithm        |
| Hybrid Search   | Combination of keyword and semantic search                  |
| OCR             | Optical Character Recognition                               |
| pgvector        | PostgreSQL extension for vector similarity search           |
| PGlite          | Embedded PostgreSQL running in WASM                         |
| RRF             | Reciprocal Rank Fusion, algorithm to combine search results |
| Semantic Search | Search based on meaning rather than keywords                |

---

## Appendix C: References

1. [PGlite Documentation](https://pglite.dev/docs/)
2. [pgvector Documentation](https://github.com/pgvector/pgvector)
3. [Transformers.js Documentation](https://huggingface.co/docs/transformers.js/)
4. [Multilingual E5 Paper](https://arxiv.org/abs/2402.05672)
5. [RRF Paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)

---

**Document Version History:**

| Version | Date       | Author | Changes       |
| ------- | ---------- | ------ | ------------- |
| 1.0     | 2025-12-13 | AI     | Initial draft |
