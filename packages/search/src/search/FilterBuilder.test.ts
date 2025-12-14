/**
 * Tests for FilterBuilder.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FilterBuilder } from './FilterBuilder.js';

describe('FilterBuilder', () => {
  let builder: FilterBuilder;

  beforeEach(() => {
    builder = new FilterBuilder();
  });

  describe('constructor', () => {
    it('should start with param index 1 by default', () => {
      expect(builder.getNextParamIndex()).toBe(1);
    });

    it('should allow custom starting param index', () => {
      const customBuilder = new FilterBuilder(5);
      expect(customBuilder.getNextParamIndex()).toBe(5);
    });
  });

  describe('folder', () => {
    it('should add folder filter conditions', () => {
      builder.folder(['path/to/folder']);

      const result = builder.build();
      expect(result.where).toContain('d.file_path LIKE $1');
      expect(result.params).toEqual(['path/to/folder%']);
    });

    it('should handle multiple folders with OR', () => {
      builder.folder(['folder1', 'folder2']);

      const result = builder.build();
      expect(result.where).toContain('d.file_path LIKE $1');
      expect(result.where).toContain('d.file_path LIKE $2');
      expect(result.where).toContain(' OR ');
      expect(result.params).toEqual(['folder1%', 'folder2%']);
    });

    it('should ignore undefined or empty folders', () => {
      builder.folder(undefined);
      builder.folder([]);

      const result = builder.build();
      expect(result.where).toBe('1=1');
      expect(result.params).toEqual([]);
    });
  });

  describe('fileTypes', () => {
    it('should add file type filter', () => {
      builder.fileTypes(['.pdf', '.docx']);

      const result = builder.build();
      expect(result.where).toContain('d.file_extension IN ($1, $2)');
      expect(result.params).toEqual(['.pdf', '.docx']);
    });

    it('should normalize extensions without dots', () => {
      builder.fileTypes(['pdf', 'docx']);

      const result = builder.build();
      expect(result.params).toEqual(['.pdf', '.docx']);
    });

    it('should lowercase extensions', () => {
      builder.fileTypes(['.PDF', '.DOCX']);

      const result = builder.build();
      expect(result.params).toEqual(['.pdf', '.docx']);
    });
  });

  describe('tags', () => {
    it('should add tag filter with EXISTS subquery', () => {
      builder.tags(['important']);

      const result = builder.build();
      expect(result.where).toContain('EXISTS');
      expect(result.where).toContain('t.name = $1');
      expect(result.params).toEqual(['important']);
    });

    it('should require ALL tags (AND logic)', () => {
      builder.tags(['important', 'urgent']);

      const result = builder.build();
      // Should have two separate EXISTS clauses
      const existsCount = (result.where.match(/EXISTS/g) || []).length;
      expect(existsCount).toBe(2);
      expect(result.params).toEqual(['important', 'urgent']);
    });
  });

  describe('tagsAny', () => {
    it('should add tag filter with OR logic', () => {
      builder.tagsAny(['important', 'urgent']);

      const result = builder.build();
      expect(result.where).toContain('IN ($1, $2)');
      expect(result.params).toEqual(['important', 'urgent']);
    });
  });

  describe('dateFrom', () => {
    it('should add date from filter', () => {
      const date = new Date('2024-01-01');
      builder.dateFrom(date);

      const result = builder.build();
      expect(result.where).toContain('d.file_modified_at >= $1');
      expect(result.params).toEqual([date]);
    });
  });

  describe('dateTo', () => {
    it('should add date to filter', () => {
      const date = new Date('2024-12-31');
      builder.dateTo(date);

      const result = builder.build();
      expect(result.where).toContain('d.file_modified_at <= $1');
      expect(result.params).toEqual([date]);
    });
  });

  describe('status', () => {
    it('should add status filter', () => {
      builder.status(['indexed', 'pending']);

      const result = builder.build();
      expect(result.where).toContain('d.status IN ($1, $2)');
      expect(result.params).toEqual(['indexed', 'pending']);
    });
  });

  describe('languages', () => {
    it('should add language filter', () => {
      builder.languages(['en', 'pt']);

      const result = builder.build();
      expect(result.where).toContain('d.language IN ($1, $2)');
      expect(result.params).toEqual(['en', 'pt']);
    });
  });

  describe('requireIndexed', () => {
    it('should add indexed status requirement', () => {
      builder.requireIndexed();

      const result = builder.build();
      expect(result.where).toContain("d.status = 'indexed'");
    });
  });

  describe('applyFilters', () => {
    it('should apply all filters from SearchFilters object', () => {
      builder.applyFilters({
        folders: ['docs/'],
        fileTypes: ['.pdf'],
        tags: ['review'],
        dateFrom: new Date('2024-01-01'),
        status: ['indexed'],
        languages: ['en'],
      });

      const result = builder.build();
      expect(result.where).toContain('d.file_path LIKE');
      expect(result.where).toContain('d.file_extension IN');
      expect(result.where).toContain('EXISTS');
      expect(result.where).toContain('d.file_modified_at >=');
      expect(result.where).toContain('d.status IN');
      expect(result.where).toContain('d.language IN');
    });

    it('should handle undefined filters', () => {
      builder.applyFilters(undefined);

      const result = builder.build();
      expect(result.where).toBe('1=1');
    });
  });

  describe('chaining', () => {
    it('should support fluent chaining', () => {
      const result = builder
        .folder(['docs/'])
        .fileTypes(['.pdf'])
        .requireIndexed()
        .build();

      expect(result.where).toContain('d.file_path LIKE');
      expect(result.where).toContain('d.file_extension IN');
      expect(result.where).toContain("d.status = 'indexed'");
      expect(result.where).toContain(' AND ');
    });

    it('should increment param indices correctly', () => {
      builder.folder(['folder1']).fileTypes(['.pdf', '.docx']).tags(['tag1']);

      const result = builder.build();
      expect(result.params).toEqual(['folder1%', '.pdf', '.docx', 'tag1']);
      expect(result.nextParamIndex).toBe(5);
    });
  });

  describe('buildWhereClause', () => {
    it('should return empty string when no conditions', () => {
      const clause = builder.buildWhereClause();
      expect(clause).toBe('');
    });

    it('should return WHERE clause with conditions', () => {
      builder.requireIndexed();
      const clause = builder.buildWhereClause();
      expect(clause.startsWith('WHERE ')).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      builder.folder(['docs/']).fileTypes(['.pdf']);

      builder.reset();

      const result = builder.build();
      expect(result.where).toBe('1=1');
      expect(result.params).toEqual([]);
      expect(result.nextParamIndex).toBe(1);
    });

    it('should allow custom starting index on reset', () => {
      builder.folder(['docs/']);
      builder.reset(10);

      expect(builder.getNextParamIndex()).toBe(10);
    });
  });
});
