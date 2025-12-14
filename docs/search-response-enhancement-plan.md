# Search Response Enhancement Plan

**Version:** 1.0 **Status:** Implemented **Created:** 2025-12-14 **Completed:**
2025-12-14

## Overview

Enhance the `search_documents` tool response to be more useful and versatile for
AI agents, inspired by Elasticsearch patterns but focused on what's practical
for LLM consumption.

## Current State

**File:** `packages/core/src/tools/search-documents.ts`

Current response format:

- Markdown text output
- Fixed 300 character text truncation
- No document deduplication (one doc can occupy all results)
- No pagination metadata
- No way to retrieve full document content
- Basic highlights array

## Goals

1. **Flexible output format**: Switch between markdown and JSON
2. **Document deduplication**: Group results by document with best passages
3. **Configurable detail level**: minimal, summary, full
4. **Document retrieval**: Allow fetching full document content by ID
5. **Pagination metadata**: total hits, has_more, offset
6. **Configurable passage length**: Allow longer snippets when needed

## Design Decisions

### Single Tool vs Separate Tool

**Decision:** Extend `search_documents` with additional parameters (not a
separate `get_document` tool)

**Rationale:**

- Follows existing codebase patterns (`search_index`, `context_management` use
  action/mode params)
- AI only needs to learn one search-related tool
- Can combine search + retrieval in workflow
- Shared response formatter and validation

### Response Formatter Architecture

**Decision:** Create a generic `SearchResponseFormatter` class that can output
markdown or JSON

**Location:** `packages/core/src/tools/search-response-formatter.ts`

## Implementation

### Phase 1: Response Formatter

Create a pluggable response formatter:

```typescript
// packages/core/src/tools/search-response-formatter.ts

export type OutputFormat = 'markdown' | 'json';
export type DetailLevel = 'minimal' | 'summary' | 'full';

export interface FormatterOptions {
  format: OutputFormat;
  detail: DetailLevel;
  passageLength: number;
  groupByDocument: boolean;
  passagesPerDocument: number;
}

export interface FormattedSearchResponse {
  llmContent: string; // Formatted for AI consumption
  returnDisplay: string; // Short display for user
}

export class SearchResponseFormatter {
  format(
    results: SearchResult[],
    query: string,
    took: number,
    options: FormatterOptions,
  ): FormattedSearchResponse;
}
```

### Phase 2: Enhanced Tool Parameters

Add new parameters to `SearchDocumentsToolParams`:

```typescript
export interface SearchDocumentsToolParams {
  // Existing
  query: string;
  strategy?: 'hybrid' | 'semantic' | 'keyword';
  folders?: string[];
  file_types?: string[];
  tags?: string[];
  limit?: number;

  // New parameters
  /** Filter to specific document by ID (from previous search) */
  document_id?: string;

  /** Output format: 'markdown' (default) or 'json' */
  format?: 'markdown' | 'json';

  /** Detail level: 'minimal', 'summary' (default), 'full' */
  detail?: 'minimal' | 'summary' | 'full';

  /** Max characters per passage (default: 300, max: 2000) */
  passage_length?: number;

  /** Group results by document (default: false) */
  group_by_document?: boolean;

  /** Passages per document when grouped (default: 3, max: 10) */
  passages_per_document?: number;

  /** Pagination offset (default: 0) */
  offset?: number;
}
```

### Phase 3: Document Grouping Logic

When `group_by_document: true`:

```typescript
interface GroupedDocumentResult {
  document_id: string;
  file_path: string;
  file_name: string;
  best_score: number;
  match_count: number; // Total chunks matched
  passages: Array<{
    chunk_id: string;
    score: number;
    text: string;
    highlights: string[];
    page?: number;
    section?: string;
  }>;
}
```

### Phase 4: Pagination Metadata

Add to response:

```typescript
interface PaginationMeta {
  query: string;
  strategy: string;
  took_ms: number;
  total_hits: number;
  returned_hits: number;
  offset: number;
  limit: number;
  has_more: boolean;
}
```

## Output Formats

### Markdown Format (Current Style, Enhanced)

```markdown
Found 15 result(s) for "audit methodology" in 234ms (showing 1-10, 5 more
available)

**1. /docs/audit-guide.pdf** (score: 0.89, hybrid, 3 passages) Page: 12 |
Section: Chapter 3 ...the audit methodology encompasses risk assessment, control
testing...

Page: 15 | Section: Chapter 3 ...methodology should be documented and approved
by management...

**2. /reports/2024-q1.docx** (score: 0.76, semantic, 2 passages) Section:
Executive Summary ...following the established audit methodology, we
identified...
```

### JSON Format (For AI Reasoning)

```json
{
  "meta": {
    "query": "audit methodology",
    "strategy": "hybrid",
    "took_ms": 234,
    "total_hits": 15,
    "returned_hits": 10,
    "offset": 0,
    "limit": 10,
    "has_more": true
  },
  "documents": [
    {
      "document_id": "doc_abc123",
      "file_path": "/docs/audit-guide.pdf",
      "file_name": "audit-guide.pdf",
      "best_score": 0.89,
      "match_count": 3,
      "passages": [
        {
          "chunk_id": "chunk_xyz",
          "score": 0.89,
          "text": "...the audit methodology encompasses...",
          "highlights": [
            "<mark>audit</mark> <mark>methodology</mark> encompasses"
          ],
          "page": 12,
          "section": "Chapter 3"
        }
      ]
    }
  ]
}
```

### Detail Levels

| Level     | Includes                                                |
| --------- | ------------------------------------------------------- |
| `minimal` | document_id, file_path, score only                      |
| `summary` | + truncated text (passage_length), highlights, metadata |
| `full`    | + complete chunk text (no truncation)                   |

## Document Retrieval Workflow

AI workflow to get full document:

1. **Search**: `search_documents(query: "audit methodology")`
   - Returns documents with passages (summary detail)

2. **Get Full**: `search_documents(document_id: "doc_abc123", detail: "full")`
   - Returns all chunks for that document with full text
   - No query needed when document_id is provided

## Files to Create/Modify

### New Files

1. `packages/core/src/tools/search-response-formatter.ts`
   - `SearchResponseFormatter` class
   - Format interfaces and types
   - Markdown and JSON formatters
   - Document grouping logic

2. `packages/core/src/tools/search-response-formatter.test.ts`
   - Unit tests for all formatter functions

### Modified Files

1. `packages/core/src/tools/search-documents.ts`
   - Add new parameters to interface
   - Add parameter validation
   - Integrate response formatter
   - Handle document_id retrieval mode

## Testing Strategy

### Unit Tests (search-response-formatter.test.ts)

1. **Markdown formatting**
   - Basic results
   - Grouped results
   - Empty results
   - Different detail levels

2. **JSON formatting**
   - Valid JSON output
   - All fields present
   - Correct types

3. **Document grouping**
   - Multiple chunks same document → grouped
   - Respects passages_per_document limit
   - Correct score ordering

4. **Pagination metadata**
   - has_more calculation
   - Offset handling

### Integration Tests

1. **Full search flow with formatter**
   - Search → get results
   - Document retrieval by ID
   - Format switching

## Implementation Order

1. Create `SearchResponseFormatter` class with tests
2. Add markdown formatter (preserve current behavior)
3. Add JSON formatter
4. Add document grouping logic
5. Modify `search-documents.ts` to use formatter
6. Add new parameters and validation
7. Add document_id retrieval logic
8. Run all tests

## Success Criteria

- [x] All existing search functionality preserved
- [x] Markdown format matches current output (backwards compatible)
- [x] JSON format produces valid, parseable JSON
- [x] Document grouping correctly deduplicates
- [x] Document retrieval by ID works
- [x] All tests pass (29 tests)
- [x] No user intervention needed during testing
- [x] Build and bundle successful

## Notes

- Skip page_range for PDFs (indexing structure unclear)
- Focus on AI utility over Elasticsearch feature parity
- Keep backwards compatible (default to current behavior)
