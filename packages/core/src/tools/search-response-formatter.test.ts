/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SearchResponseFormatter,
  createSearchResponseFormatter,
  type SearchResultInput,
  type JsonSearchOutput,
} from './search-response-formatter.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockResult(
  overrides: Partial<SearchResultInput> = {},
): SearchResultInput {
  return {
    documentId: 'doc_001',
    chunkId: 'chunk_001',
    filePath: '/docs/test-document.pdf',
    fileName: 'test-document.pdf',
    chunkText:
      'This is the chunk text content that would typically be longer and contain relevant information.',
    score: 0.85,
    matchType: 'hybrid',
    highlights: ['chunk text <mark>content</mark>'],
    metadata: {
      page: 1,
      section: 'Introduction',
      tags: ['audit', 'report'],
    },
    ...overrides,
  };
}

function createMultipleResults(): SearchResultInput[] {
  return [
    createMockResult({
      documentId: 'doc_001',
      chunkId: 'chunk_001',
      filePath: '/docs/audit-guide.pdf',
      fileName: 'audit-guide.pdf',
      chunkText:
        'The audit methodology encompasses risk assessment and control testing procedures.',
      score: 0.92,
      metadata: { page: 12, section: 'Chapter 3', tags: ['audit'] },
    }),
    createMockResult({
      documentId: 'doc_001',
      chunkId: 'chunk_002',
      filePath: '/docs/audit-guide.pdf',
      fileName: 'audit-guide.pdf',
      chunkText:
        'Methodology should be documented and approved by management before implementation.',
      score: 0.78,
      metadata: { page: 15, section: 'Chapter 3', tags: ['audit'] },
    }),
    createMockResult({
      documentId: 'doc_002',
      chunkId: 'chunk_003',
      filePath: '/reports/2024-q1.docx',
      fileName: '2024-q1.docx',
      chunkText:
        'Following the established audit methodology, we identified several control gaps.',
      score: 0.76,
      matchType: 'semantic',
      metadata: { page: null, section: 'Executive Summary', tags: ['report'] },
    }),
    createMockResult({
      documentId: 'doc_002',
      chunkId: 'chunk_004',
      filePath: '/reports/2024-q1.docx',
      fileName: '2024-q1.docx',
      chunkText:
        'The methodology applied was consistent with industry best practices.',
      score: 0.65,
      matchType: 'keyword',
      metadata: { page: null, section: 'Methodology', tags: ['report'] },
    }),
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('SearchResponseFormatter', () => {
  let formatter: SearchResponseFormatter;

  beforeEach(() => {
    formatter = new SearchResponseFormatter();
  });

  describe('constructor and options', () => {
    it('should use default options when none provided', () => {
      const options = formatter.getOptions();
      expect(options.format).toBe('markdown');
      expect(options.detail).toBe('summary');
      expect(options.passageLength).toBe(300);
      expect(options.groupByDocument).toBe(true);
      expect(options.passagesPerDocument).toBe(3);
    });

    it('should merge provided options with defaults', () => {
      const customFormatter = new SearchResponseFormatter({
        format: 'json',
        passageLength: 500,
      });

      const options = customFormatter.getOptions();
      expect(options.format).toBe('json');
      expect(options.passageLength).toBe(500);
      expect(options.detail).toBe('summary'); // default
      expect(options.groupByDocument).toBe(true); // default
    });

    it('should allow updating options', () => {
      formatter.setOptions({ format: 'json', detail: 'full' });

      const options = formatter.getOptions();
      expect(options.format).toBe('json');
      expect(options.detail).toBe('full');
    });
  });

  describe('createSearchResponseFormatter factory', () => {
    it('should create a formatter instance', () => {
      const instance = createSearchResponseFormatter();
      expect(instance).toBeInstanceOf(SearchResponseFormatter);
    });

    it('should pass options to the formatter', () => {
      const instance = createSearchResponseFormatter({ format: 'json' });
      expect(instance.getOptions().format).toBe('json');
    });
  });

  describe('empty results', () => {
    it('should format empty results as markdown', () => {
      const response = formatter.format([], 'test query', 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toBe(
        'No results found for query: "test query"',
      );
      expect(response.returnDisplay).toBe('No results found for "test query"');
    });

    it('should format empty results as JSON', () => {
      formatter.setOptions({ format: 'json' });

      const response = formatter.format([], 'test query', 50, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      expect(parsed.meta.query).toBe('test query');
      expect(parsed.meta.total_hits).toBe(0);
      expect(parsed.results).toEqual([]);
    });
  });

  describe('markdown formatting', () => {
    beforeEach(() => {
      // Use flat results for markdown formatting tests
      formatter.setOptions({ groupByDocument: false });
    });

    it('should format single result correctly', () => {
      const results = [createMockResult()];
      const response = formatter.format(results, 'chunk content', 100, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('Found 1 result(s)');
      expect(response.llmContent).toContain('/docs/test-document.pdf');
      expect(response.llmContent).toContain('[doc_001]'); // document_id always included
      expect(response.llmContent).toContain('score: 0.85');
      expect(response.llmContent).toContain('Section: Introduction');
      // Note: page is not shown (not reliably populated by chunkers)
    });

    it('should format multiple results correctly', () => {
      const results = createMultipleResults();
      const response = formatter.format(results, 'audit methodology', 234, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('Found 4 result(s)');
      expect(response.llmContent).toContain('/docs/audit-guide.pdf');
      expect(response.llmContent).toContain('/reports/2024-q1.docx');
      expect(response.llmContent).toContain('234ms');
    });

    it('should show pagination info when has_more is true', () => {
      const results = createMultipleResults().slice(0, 2);
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 2,
        totalAvailable: 10,
      });

      expect(response.llmContent).toContain('showing 1-2');
      expect(response.llmContent).toContain('more available');
    });

    it('should show offset in pagination info', () => {
      const results = createMultipleResults().slice(0, 2);
      const response = formatter.format(results, 'test', 100, {
        offset: 5,
        limit: 2,
        totalAvailable: 10,
      });

      expect(response.llmContent).toContain('showing 6-7');
    });

    it('should truncate text at passage_length', () => {
      const longText = 'A'.repeat(500);
      const results = [createMockResult({ chunkText: longText })];

      formatter.setOptions({ passageLength: 100 });
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('A'.repeat(100) + '...');
      expect(response.llmContent).not.toContain('A'.repeat(101));
    });

    it('should exclude text for minimal detail (flat) but include document_id', () => {
      formatter.setOptions({ detail: 'minimal', groupByDocument: false });
      const results = [createMockResult()];
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('/docs/test-document.pdf');
      expect(response.llmContent).toContain('[doc_001]'); // document_id ALWAYS included
      expect(response.llmContent).toContain('score: 0.85');
      // Should NOT contain the text content
      expect(response.llmContent).not.toContain('chunk text content');
      // Should NOT contain section info
      expect(response.llmContent).not.toContain('Section:');
    });

    it('should exclude passages for minimal detail (grouped) but include document_id', () => {
      formatter.setOptions({ detail: 'minimal', groupByDocument: true });
      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('/docs/audit-guide.pdf');
      expect(response.llmContent).toContain('[doc_001]'); // document_id ALWAYS included
      expect(response.llmContent).toContain('2 matches');
      // Should NOT contain passage text
      expect(response.llmContent).not.toContain('audit methodology');
      expect(response.llmContent).not.toContain('Chapter 3');
    });

    it('should show full text for full detail', () => {
      const longText = 'X'.repeat(500);
      const results = [createMockResult({ chunkText: longText })];

      formatter.setOptions({
        detail: 'full',
        passageLength: 100,
        groupByDocument: false,
      });
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      // Full detail should NOT truncate
      expect(response.llmContent).toContain('X'.repeat(500));
    });
  });

  describe('JSON formatting', () => {
    beforeEach(() => {
      // Use flat results for JSON formatting tests (test grouping separately)
      formatter.setOptions({ format: 'json', groupByDocument: false });
    });

    it('should produce valid JSON', () => {
      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      expect(() => JSON.parse(response.llmContent)).not.toThrow();
    });

    it('should include correct meta fields', () => {
      const results = createMultipleResults();
      const response = formatter.format(results, 'audit query', 150, {
        offset: 5,
        limit: 10,
        totalAvailable: 20,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      expect(parsed.meta.query).toBe('audit query');
      expect(parsed.meta.took_ms).toBe(150);
      expect(parsed.meta.offset).toBe(5);
      expect(parsed.meta.limit).toBe(10);
      expect(parsed.meta.total_hits).toBe(20);
      expect(parsed.meta.returned_hits).toBe(4);
      expect(parsed.meta.has_more).toBe(true);
    });

    it('should include all result fields for summary detail', () => {
      const results = [createMockResult()];
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const result = parsed.results[0] as unknown as Record<string, unknown>;

      expect(result.document_id).toBe('doc_001');
      expect(result.chunk_id).toBe('chunk_001');
      expect(result.file_path).toBe('/docs/test-document.pdf');
      expect(result.score).toBe(0.85);
      expect(result.match_type).toBe('hybrid');
      expect(result.text).toBeDefined();
      expect(result.highlights).toBeDefined();
      expect(result.section).toBe('Introduction');
      // Note: page is not included in output (not reliably populated by chunkers)
    });

    it('should exclude text fields for minimal detail', () => {
      formatter.setOptions({ format: 'json', detail: 'minimal' });

      const results = [createMockResult()];
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const result = parsed.results[0] as unknown as Record<string, unknown>;

      expect(result.document_id).toBe('doc_001');
      expect(result.score).toBe(0.85);
      expect(result.text).toBeUndefined();
      expect(result.highlights).toBeUndefined();
      expect(result.section).toBeUndefined();
    });

    it('should not truncate text for full detail', () => {
      const longText = 'B'.repeat(500);
      const results = [createMockResult({ chunkText: longText })];

      formatter.setOptions({
        format: 'json',
        detail: 'full',
        passageLength: 100,
      });
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const result = parsed.results[0] as unknown as Record<string, unknown>;

      expect(result.text).toBe(longText);
    });

    it('should infer strategy from result match types', () => {
      const semanticOnly = [createMockResult({ matchType: 'semantic' })];
      const keywordOnly = [createMockResult({ matchType: 'keyword' })];
      const hybrid = [
        createMockResult({ matchType: 'semantic' }),
        createMockResult({ matchType: 'keyword' }),
      ];

      const semanticResponse = formatter.format(semanticOnly, 'test', 50, {
        offset: 0,
        limit: 10,
      });
      const keywordResponse = formatter.format(keywordOnly, 'test', 50, {
        offset: 0,
        limit: 10,
      });
      const hybridResponse = formatter.format(hybrid, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      expect(
        (JSON.parse(semanticResponse.llmContent) as JsonSearchOutput).meta
          .strategy,
      ).toBe('semantic');
      expect(
        (JSON.parse(keywordResponse.llmContent) as JsonSearchOutput).meta
          .strategy,
      ).toBe('keyword');
      expect(
        (JSON.parse(hybridResponse.llmContent) as JsonSearchOutput).meta
          .strategy,
      ).toBe('hybrid');
    });
  });

  describe('document grouping', () => {
    beforeEach(() => {
      formatter.setOptions({ groupByDocument: true });
    });

    it('should group chunks from same document', () => {
      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      // Should mention doc_001 once with multiple passages
      expect(response.llmContent).toContain('audit-guide.pdf');
      expect(response.llmContent).toContain('2 matches');
    });

    it('should order groups by best score', () => {
      formatter.setOptions({ format: 'json', groupByDocument: true });

      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const groups = parsed.results as Array<{
        document_id: string;
        best_score: number;
      }>;

      // doc_001 has best_score 0.92, doc_002 has 0.76
      expect(groups[0].document_id).toBe('doc_001');
      expect(groups[1].document_id).toBe('doc_002');
    });

    it('should limit passages per document', () => {
      formatter.setOptions({
        format: 'json',
        groupByDocument: true,
        passagesPerDocument: 1,
      });

      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const groups = parsed.results as Array<{ passages: unknown[] }>;

      // Each group should have max 1 passage
      groups.forEach((group) => {
        expect(group.passages.length).toBeLessThanOrEqual(1);
      });
    });

    it('should include correct fields in grouped JSON', () => {
      formatter.setOptions({ format: 'json', groupByDocument: true });

      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      expect(parsed.grouped).toBe(true);

      const firstGroup = parsed.results[0] as unknown as Record<
        string,
        unknown
      >;
      expect(firstGroup.document_id).toBeDefined();
      expect(firstGroup.file_path).toBeDefined();
      expect(firstGroup.file_name).toBeDefined();
      expect(firstGroup.best_score).toBeDefined();
      expect(firstGroup.match_count).toBeDefined();
      expect(firstGroup.passages).toBeDefined();
      expect(Array.isArray(firstGroup.passages)).toBe(true);
    });

    it('should sort passages within a group by score', () => {
      formatter.setOptions({
        format: 'json',
        groupByDocument: true,
        passagesPerDocument: 10,
      });

      const results = createMultipleResults();
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 10,
      });

      const parsed = JSON.parse(response.llmContent) as JsonSearchOutput;
      const firstGroup = parsed.results[0] as {
        passages: Array<{ score: number }>;
      };

      // Passages should be sorted by score descending
      for (let i = 1; i < firstGroup.passages.length; i++) {
        expect(firstGroup.passages[i - 1].score).toBeGreaterThanOrEqual(
          firstGroup.passages[i].score,
        );
      }
    });
  });

  describe('returnDisplay', () => {
    it('should provide concise display text', () => {
      const results = createMultipleResults();
      const response = formatter.format(results, 'audit', 123, {
        offset: 0,
        limit: 10,
      });

      expect(response.returnDisplay).toContain('Found 4 result(s)');
      expect(response.returnDisplay).toContain('123ms');
      expect(response.returnDisplay).toContain('hybrid');
    });

    it('should indicate more results available', () => {
      const results = createMultipleResults().slice(0, 2);
      const response = formatter.format(results, 'test', 100, {
        offset: 0,
        limit: 2,
        totalAvailable: 10,
      });

      expect(response.returnDisplay).toContain('more available');
    });
  });

  describe('edge cases', () => {
    it('should handle results with null metadata', () => {
      const results = [
        createMockResult({
          metadata: { page: null, section: null, tags: [] },
        }),
      ];

      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).not.toContain('Section:');
      expect(response.llmContent).not.toContain('Page:');
    });

    it('should handle very long queries', () => {
      const longQuery = 'word '.repeat(100);
      const results = [createMockResult()];

      const response = formatter.format(results, longQuery, 50, {
        offset: 0,
        limit: 10,
      });

      expect(response.llmContent).toContain('Found 1 result(s)');
    });

    it('should handle zero passage length gracefully', () => {
      formatter.setOptions({ passageLength: 0 });
      const results = [createMockResult()];

      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      // Should truncate to 0 + '...'
      expect(response.llmContent).toContain('...');
    });

    it('should handle special characters in text', () => {
      const specialText = 'Test with <html> & "quotes" and newlines\n\nhere';
      const results = [createMockResult({ chunkText: specialText })];

      formatter.setOptions({ format: 'json' });
      const response = formatter.format(results, 'test', 50, {
        offset: 0,
        limit: 10,
      });

      // Should produce valid JSON even with special chars
      expect(() => JSON.parse(response.llmContent)).not.toThrow();
    });
  });
});
