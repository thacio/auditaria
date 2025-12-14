/**
 * Filter builder for constructing SQL WHERE clauses.
 * Provides a fluent API for building search filters.
 */

import type { SearchFilters } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of building filters.
 */
export interface FilterBuildResult {
  /** SQL WHERE clause (without the WHERE keyword) */
  where: string;
  /** Parameter values for the query */
  params: unknown[];
  /** Starting parameter index (for chaining with other queries) */
  nextParamIndex: number;
}

// ============================================================================
// FilterBuilder
// ============================================================================

/**
 * Builds SQL WHERE clauses from SearchFilters.
 * Uses parameterized queries to prevent SQL injection.
 */
export class FilterBuilder {
  private conditions: string[] = [];
  private params: unknown[] = [];
  private paramIndex: number;

  /**
   * Create a new FilterBuilder.
   * @param startParamIndex - Starting index for parameters ($1, $2, etc.)
   */
  constructor(startParamIndex = 1) {
    this.paramIndex = startParamIndex;
  }

  /**
   * Add a folder filter (documents in these folders).
   */
  folder(folders: string[] | undefined): this {
    if (!folders || folders.length === 0) return this;

    const conditions = folders.map(() => {
      const placeholder = `$${this.paramIndex++}`;
      return `d.file_path LIKE ${placeholder}`;
    });

    this.conditions.push(`(${conditions.join(' OR ')})`);
    this.params.push(...folders.map((f) => `${f}%`));

    return this;
  }

  /**
   * Add a file type filter (documents with these extensions).
   */
  fileTypes(extensions: string[] | undefined): this {
    if (!extensions || extensions.length === 0) return this;

    const placeholders = extensions
      .map(() => `$${this.paramIndex++}`)
      .join(', ');
    this.conditions.push(`d.file_extension IN (${placeholders})`);
    this.params.push(
      ...extensions.map((e) =>
        e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
      ),
    );

    return this;
  }

  /**
   * Add a tag filter (documents with all of these tags).
   */
  tags(tags: string[] | undefined): this {
    if (!tags || tags.length === 0) return this;

    // Documents must have ALL specified tags
    for (const tag of tags) {
      const placeholder = `$${this.paramIndex++}`;
      this.conditions.push(`
        EXISTS (
          SELECT 1 FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE dt.document_id = d.id AND t.name = ${placeholder}
        )
      `);
      this.params.push(tag);
    }

    return this;
  }

  /**
   * Add a tag filter for any of the tags (OR).
   */
  tagsAny(tags: string[] | undefined): this {
    if (!tags || tags.length === 0) return this;

    const placeholders = tags.map(() => `$${this.paramIndex++}`).join(', ');
    this.conditions.push(`
      EXISTS (
        SELECT 1 FROM document_tags dt
        JOIN tags t ON dt.tag_id = t.id
        WHERE dt.document_id = d.id AND t.name IN (${placeholders})
      )
    `);
    this.params.push(...tags);

    return this;
  }

  /**
   * Add a date range filter (modified after this date).
   */
  dateFrom(date: Date | undefined): this {
    if (!date) return this;

    const placeholder = `$${this.paramIndex++}`;
    this.conditions.push(`d.file_modified_at >= ${placeholder}`);
    this.params.push(date);

    return this;
  }

  /**
   * Add a date range filter (modified before this date).
   */
  dateTo(date: Date | undefined): this {
    if (!date) return this;

    const placeholder = `$${this.paramIndex++}`;
    this.conditions.push(`d.file_modified_at <= ${placeholder}`);
    this.params.push(date);

    return this;
  }

  /**
   * Add a status filter (documents with these statuses).
   */
  status(statuses: string[] | undefined): this {
    if (!statuses || statuses.length === 0) return this;

    const placeholders = statuses.map(() => `$${this.paramIndex++}`).join(', ');
    this.conditions.push(`d.status IN (${placeholders})`);
    this.params.push(...statuses);

    return this;
  }

  /**
   * Add a language filter (documents in these languages).
   */
  languages(languages: string[] | undefined): this {
    if (!languages || languages.length === 0) return this;

    const placeholders = languages
      .map(() => `$${this.paramIndex++}`)
      .join(', ');
    this.conditions.push(`d.language IN (${placeholders})`);
    this.params.push(...languages);

    return this;
  }

  /**
   * Add a minimum score filter.
   * Note: This is typically applied after scoring, not in the WHERE clause.
   */
  minScore(_score: number | undefined): this {
    // Score filtering is done in post-processing, not SQL
    return this;
  }

  /**
   * Require documents to be indexed.
   */
  requireIndexed(): this {
    this.conditions.push(`d.status = 'indexed'`);
    return this;
  }

  /**
   * Add a custom condition.
   */
  custom(condition: string, ...params: unknown[]): this {
    // Replace $N placeholders with incremented param indices
    let adjustedCondition = condition;
    for (let i = params.length; i > 0; i--) {
      const placeholder = `$${this.paramIndex++}`;
      adjustedCondition = adjustedCondition.replace(
        new RegExp(`\\$${i}\\b`, 'g'),
        placeholder,
      );
    }

    // Re-adjust to proper order
    let finalCondition = adjustedCondition;
    const startIndex = this.paramIndex - params.length;
    for (let i = 0; i < params.length; i++) {
      const oldPlaceholder = `$${startIndex + params.length - 1 - i}`;
      const newPlaceholder = `$${startIndex + i}`;
      if (oldPlaceholder !== newPlaceholder) {
        finalCondition = finalCondition.replace(
          new RegExp(oldPlaceholder.replace('$', '\\$'), 'g'),
          newPlaceholder,
        );
      }
    }

    this.conditions.push(adjustedCondition);
    this.params.push(...params);

    return this;
  }

  /**
   * Apply all filters from a SearchFilters object.
   */
  applyFilters(filters: SearchFilters | undefined): this {
    if (!filters) return this;

    return this.folder(filters.folders)
      .fileTypes(filters.fileTypes)
      .tags(filters.tags)
      .dateFrom(filters.dateFrom)
      .dateTo(filters.dateTo)
      .status(filters.status)
      .languages(filters.languages)
      .minScore(filters.minScore);
  }

  /**
   * Build the filter result.
   */
  build(): FilterBuildResult {
    return {
      where: this.conditions.length > 0 ? this.conditions.join(' AND ') : '1=1',
      params: this.params,
      nextParamIndex: this.paramIndex,
    };
  }

  /**
   * Build a complete WHERE clause.
   */
  buildWhereClause(): string {
    const result = this.build();
    return result.where === '1=1' ? '' : `WHERE ${result.where}`;
  }

  /**
   * Get the parameter values.
   */
  getParams(): unknown[] {
    return this.params;
  }

  /**
   * Get the next parameter index.
   */
  getNextParamIndex(): number {
    return this.paramIndex;
  }

  /**
   * Reset the builder.
   */
  reset(startParamIndex = 1): this {
    this.conditions = [];
    this.params = [];
    this.paramIndex = startParamIndex;
    return this;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new FilterBuilder instance.
 * @param startParamIndex - Starting index for parameters
 */
export function createFilterBuilder(startParamIndex = 1): FilterBuilder {
  return new FilterBuilder(startParamIndex);
}
