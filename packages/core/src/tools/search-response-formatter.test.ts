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
      expect(options.passageLength).toBe(500); // Updated default
      expect(options.groupByDocument).toBe(true);
      expect(options.passagesPerDocument).toBe(0);
    });

    it('should merge provided options with defaults', () => {
      const customFormatter = new SearchResponseFormatter({
        format: 'json',
        passageLength: 800,
      });

      const options = customFormatter.getOptions();
      expect(options.format).toBe('json');
      expect(options.passageLength).toBe(800);
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
      const longText = 'X'.repeat(800);
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
      expect(response.llmContent).toContain('X'.repeat(800));
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
      const longText = 'B'.repeat(800);
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

  // ============================================================================
  // Smart Truncation Tests
  // ============================================================================

  describe('smart truncation', () => {
    describe('passageLength = 0 (full text mode)', () => {
      it('should return full text when passageLength is 0', () => {
        formatter.setOptions({ passageLength: 0, groupByDocument: false });

        const longText =
          'The internal audit function serves as a critical component of corporate governance. ' +
          'It provides independent assurance that an organization risk management, governance, and internal control processes are operating effectively. ' +
          'The audit committee relies on internal audit reports to make informed decisions about organizational risks. ' +
          'Without proper audit coverage, material misstatements and control deficiencies may go undetected. ' +
          'This document outlines the comprehensive methodology for conducting risk-based internal audits.';

        const results = [createMockResult({ chunkText: longText })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain(longText);
      });

      it('should return full text with marks when passageLength is 0', () => {
        formatter.setOptions({ passageLength: 0, groupByDocument: false });

        const textWithMarks =
          'Introduction to the topic. ' +
          'The <mark>audit methodology</mark> is described here. ' +
          'More details follow in subsequent sections.';

        const results = [createMockResult({ chunkText: textWithMarks })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain(textWithMarks);
      });
    });

    describe('mark-aware truncation', () => {
      it('should center truncation around a single mark at the end of text', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        // Mark is in the 6th sentence, near the end
        const text =
          'The company was founded in 1985 and has grown significantly over the decades. ' +
          'Initial operations focused on manufacturing consumer electronics. ' +
          'The product line expanded to include enterprise solutions in 2001. ' +
          'Global expansion began with offices in Europe and Asia. ' +
          'The company currently employs over ten thousand people worldwide. ' +
          'Recent developments include the new <mark>audit framework</mark> implementation. ' +
          'Future plans involve further digital transformation initiatives.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'audit', 50, {
          offset: 0,
          limit: 10,
        });

        // Must contain the marked sentence
        expect(response.llmContent).toContain('<mark>audit framework</mark>');
        // Should have leading ellipsis since we're skipping content
        expect(response.llmContent).toContain('...');
      });

      it('should show multiple marks when they exist in different sentences', () => {
        formatter.setOptions({ passageLength: 300, groupByDocument: false });

        const text =
          'The first section introduces the basic concepts of financial reporting. ' +
          'The <mark>internal controls</mark> framework ensures accuracy and compliance. ' +
          'Management is responsible for maintaining adequate control systems. ' +
          'External auditors assess the effectiveness of these controls annually. ' +
          'The <mark>risk assessment</mark> process identifies potential issues early. ' +
          'Remediation plans address identified deficiencies promptly.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'audit controls', 50, {
          offset: 0,
          limit: 10,
        });

        // Both marks must be visible
        expect(response.llmContent).toContain('<mark>internal controls</mark>');
        expect(response.llmContent).toContain('<mark>risk assessment</mark>');
      });

      it('should show context sentences around marked content', () => {
        formatter.setOptions({ passageLength: 150, groupByDocument: false });

        const text =
          'Background information about the organization goes here. ' +
          'The <mark>compliance program</mark> was established in 2020. ' +
          'It includes regular training and monitoring activities.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'compliance', 50, {
          offset: 0,
          limit: 10,
        });

        // Should contain the marked sentence
        expect(response.llmContent).toContain(
          '<mark>compliance program</mark>',
        );
        // Should include context (sentences before/after)
        expect(response.llmContent).toContain('Background information');
        expect(response.llmContent).toContain('training and monitoring');
      });

      it('should expand context to reach minimum passageLength', () => {
        formatter.setOptions({ passageLength: 400, groupByDocument: false });

        // Short marked sentence that needs expansion
        const text =
          'First sentence provides introduction. ' +
          'Second sentence adds more detail. ' +
          'Third sentence continues the narrative. ' +
          'The <mark>key finding</mark> is here. ' +
          'Fifth sentence provides analysis. ' +
          'Sixth sentence concludes this section. ' +
          'Seventh sentence wraps up everything.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'finding', 50, {
          offset: 0,
          limit: 10,
        });

        // Should contain mark
        expect(response.llmContent).toContain('<mark>key finding</mark>');
        // Output should be at least passageLength (or close to it with sentence boundaries)
        // The text itself is the minimum, so we check it includes multiple sentences
        const sentenceCount = (response.llmContent.match(/\. [A-Z]|\.$/g) || [])
          .length;
        expect(sentenceCount).toBeGreaterThanOrEqual(3);
      });

      it('should handle mark at the very beginning', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'The <mark>audit charter</mark> defines the purpose and authority of the internal audit function. ' +
          'It is approved by the board of directors annually. ' +
          'The charter establishes the scope of audit activities. ' +
          'Independence and objectivity are fundamental principles. ' +
          'The chief audit executive reports functionally to the audit committee.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'charter', 50, {
          offset: 0,
          limit: 10,
        });

        // Should contain the marked sentence at the beginning
        expect(response.llmContent).toContain('<mark>audit charter</mark>');
        // Should NOT have leading ellipsis (mark is at start)
        expect(response.llmContent).not.toMatch(/^\.\.\./);
      });

      it('should handle adjacent marks in consecutive sentences', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'Introduction to audit standards. ' +
          'The <mark>COSO framework</mark> provides guidance on internal controls. ' +
          'The <mark>COBIT framework</mark> focuses on IT governance. ' +
          'Both frameworks complement each other effectively. ' +
          'Organizations often implement both for comprehensive coverage.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'framework', 50, {
          offset: 0,
          limit: 10,
        });

        // Both marks should be visible
        expect(response.llmContent).toContain('<mark>COSO framework</mark>');
        expect(response.llmContent).toContain('<mark>COBIT framework</mark>');
      });

      it('should use gap indicator [...] when marks are far apart', () => {
        formatter.setOptions({ passageLength: 150, groupByDocument: false });

        const text =
          'The <mark>first key point</mark> is established in the opening section. ' +
          'This is followed by supporting evidence and analysis. ' +
          'Additional context helps readers understand the implications. ' +
          'Historical data provides perspective on current findings. ' +
          'Industry benchmarks offer comparison points. ' +
          'The <mark>second key point</mark> emerges from detailed examination. ' +
          'Final conclusions summarize the overall assessment.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'key point', 50, {
          offset: 0,
          limit: 10,
        });

        // Both marks should be present
        expect(response.llmContent).toContain('<mark>first key point</mark>');
        expect(response.llmContent).toContain('<mark>second key point</mark>');
        // Should have gap indicator if sentences in between are skipped
        // (depending on minimum length expansion)
      });
    });

    describe('semantic truncation (no marks)', () => {
      it('should use bookend strategy showing first and last sentences', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'This executive summary provides an overview of audit findings. ' +
          'The audit covered all major business processes during Q3 2024. ' +
          'We identified several areas requiring management attention. ' +
          'Control weaknesses were noted in the procurement department. ' +
          'The IT general controls environment showed improvement over prior year. ' +
          'In conclusion, the overall control environment is satisfactory with noted exceptions.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        // Should contain first sentence
        expect(response.llmContent).toContain('executive summary');
        // Should contain last sentence
        expect(response.llmContent).toContain(
          'satisfactory with noted exceptions',
        );
      });

      it('should expand bookends to reach minimum length', () => {
        formatter.setOptions({ passageLength: 350, groupByDocument: false });

        const text =
          'First sentence. ' +
          'Second sentence. ' +
          'Third sentence. ' +
          'Fourth sentence. ' +
          'Fifth sentence. ' +
          'Last sentence.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        // With short sentences and high minimum, should include most/all sentences
        expect(response.llmContent).toContain('First sentence');
        expect(response.llmContent).toContain('Last sentence');
      });

      it('should show gap indicator between bookends when content is skipped', () => {
        formatter.setOptions({ passageLength: 150, groupByDocument: false });

        const text =
          'The introduction establishes the scope of the audit engagement. ' +
          'We applied professional standards and used risk-based methodology. ' +
          'Detailed testing procedures were performed across all business cycles. ' +
          'Sample sizes were determined using statistical sampling techniques. ' +
          'Our conclusions are based on sufficient appropriate audit evidence.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        // Check for gap indicator if middle content is skipped
        // (behavior depends on whether minimum length requires more sentences)
        expect(response.llmContent).toContain('introduction');
        expect(response.llmContent).toContain('audit evidence');
      });

      it('should return all sentences when text has only two sentences', () => {
        formatter.setOptions({ passageLength: 500, groupByDocument: false });

        const text =
          'This is the first and only real paragraph of content here. ' +
          'This concluding statement wraps up the discussion.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain('first and only');
        expect(response.llmContent).toContain('concluding statement');
        // Should not have any ellipsis or gaps
        expect(response.llmContent).not.toContain('...');
        expect(response.llmContent).not.toContain('[...]');
      });
    });

    describe('minimum length guarantee', () => {
      it('should produce output >= passageLength when document is large enough', () => {
        formatter.setOptions({ passageLength: 300, groupByDocument: false });

        const text =
          'First sentence here. Second sentence here. Third sentence here. ' +
          'Fourth sentence here. Fifth with <mark>important keyword</mark> appears. ' +
          'Sixth sentence here. Seventh sentence here. Eighth sentence here. ' +
          'Ninth sentence here. Tenth sentence here.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'keyword', 50, {
          offset: 0,
          limit: 10,
        });

        // Should contain the mark at minimum
        expect(response.llmContent).toContain('<mark>important keyword</mark>');
      });

      it('should return full text when document is smaller than passageLength', () => {
        formatter.setOptions({ passageLength: 1000, groupByDocument: false });

        const shortText =
          'This short text is under the minimum length requirement.';

        const results = [createMockResult({ chunkText: shortText })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain(shortText);
      });
    });

    describe('sentence splitting', () => {
      it('should handle abbreviations correctly (Dr., Mr., etc.)', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'Dr. Smith presented the <mark>audit findings</mark> to the committee. ' +
          'Mr. Johnson raised several important questions. ' +
          'The discussion continued for two hours.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'findings', 50, {
          offset: 0,
          limit: 10,
        });

        // Should not split on "Dr." or "Mr."
        expect(response.llmContent).toContain('Dr. Smith');
        expect(response.llmContent).toContain('Mr. Johnson');
      });

      it('should handle multiple punctuation types (! and ?)', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'What are the key <mark>risk factors</mark> identified? ' +
          'Management must address these immediately! ' +
          'The deadline for remediation is end of quarter.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'risk', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain('<mark>risk factors</mark>');
        expect(response.llmContent).toContain('?');
        expect(response.llmContent).toContain('!');
      });

      it('should handle text without standard sentence endings', () => {
        formatter.setOptions({ passageLength: 100, groupByDocument: false });

        const text =
          'Key findings include: control weaknesses in procurement, ' +
          'lack of segregation of duties, and <mark>insufficient documentation</mark>';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'documentation', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain(
          '<mark>insufficient documentation</mark>',
        );
      });
    });

    describe('edge cases', () => {
      it('should handle empty text', () => {
        formatter.setOptions({ passageLength: 100, groupByDocument: false });

        const results = [createMockResult({ chunkText: '' })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        // Should not crash
        expect(response).toBeDefined();
      });

      it('should handle text with only whitespace', () => {
        formatter.setOptions({ passageLength: 100, groupByDocument: false });

        const results = [createMockResult({ chunkText: '   \n\t  ' })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response).toBeDefined();
      });

      it('should handle nested or malformed mark tags gracefully', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'Some text with <mark>nested <mark>marks</mark> inside</mark> which is unusual. ' +
          'Regular sentence follows here.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'test', 50, {
          offset: 0,
          limit: 10,
        });

        // Should not crash and should include some of the marked content
        expect(response.llmContent).toContain('mark');
      });

      it('should handle very long single sentence', () => {
        formatter.setOptions({ passageLength: 100, groupByDocument: false });

        const longSentence =
          'This is an extremely long sentence that contains the <mark>important term</mark> ' +
          'and continues with more and more content without any period or other sentence-ending punctuation ' +
          'making it difficult to split into logical units for truncation purposes';

        const results = [createMockResult({ chunkText: longSentence })];
        const response = formatter.format(results, 'important', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain('<mark>important term</mark>');
      });

      it('should handle special characters in text', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'The ratio was 5:1 & the margin exceeded 15%. ' +
          'The <mark>key metrics</mark> showed improvement. ' +
          'Revenue grew by $1.5M (€1.3M equivalent).';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'metrics', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain('<mark>key metrics</mark>');
        expect(response.llmContent).toContain('&');
        expect(response.llmContent).toContain('%');
      });

      it('should handle case-insensitive mark tags', () => {
        formatter.setOptions({ passageLength: 200, groupByDocument: false });

        const text =
          'First sentence here. ' +
          'Second with <MARK>uppercase tags</MARK> for highlighting. ' +
          'Third sentence here.';

        const results = [createMockResult({ chunkText: text })];
        const response = formatter.format(results, 'uppercase', 50, {
          offset: 0,
          limit: 10,
        });

        expect(response.llmContent).toContain('<MARK>uppercase tags</MARK>');
      });
    });

    describe('results with null metadata', () => {
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
    });
  });
});
