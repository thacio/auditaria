/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Web Search Query Parser for FTS5
 *
 * Converts Google-style search syntax to SQLite FTS5 query syntax.
 * Mimics PostgreSQL's websearch_to_tsquery behavior.
 *
 * Google-style syntax:
 *   - "quoted phrase" → exact phrase match
 *   - word1 word2 → both words required (implicit AND)
 *   - word1 OR word2 → either word
 *   - -word → exclude word
 *   - -"phrase" → exclude phrase
 *
 * FTS5 syntax:
 *   - "quoted phrase" → phrase match (same!)
 *   - word1 word2 → implicit AND (same!)
 *   - word1 OR word2 → OR operator (same!)
 *   - NOT word → exclusion
 */

/**
 * Token types produced by the lexer
 */
export type TokenType =
  | 'PHRASE' // "quoted phrase"
  | 'OR' // OR operator
  | 'NOT' // - prefix (negation)
  | 'TERM'; // regular word

export interface Token {
  type: TokenType;
  value: string;
  negated?: boolean; // true if preceded by -
}

/**
 * Characters that have special meaning in FTS5 and need escaping
 * when they appear in search terms (not as operators)
 * Note: Don't use global flag with .test() to avoid lastIndex issues
 */
const FTS5_SPECIAL_CHARS = /[*+:^(){}\[\]]/;

/**
 * Escape special FTS5 characters in a term
 */
function escapeFTS5Term(term: string): string {
  // If term contains special chars, wrap in quotes
  if (FTS5_SPECIAL_CHARS.test(term)) {
    // Escape internal quotes
    return `"${term.replace(/"/g, '""')}"`;
  }
  return term;
}

/**
 * Tokenize a Google-style search query
 *
 * Handles:
 * - Quoted phrases: "hello world"
 * - Negation: -word, -"phrase"
 * - OR operator (case-insensitive)
 * - Regular terms
 */
export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  // Skip whitespace
  const skipWhitespace = () => {
    while (pos < query.length && /\s/.test(query[pos])) pos++;
  };

  while (pos < query.length) {
    skipWhitespace();
    if (pos >= query.length) break;

    const char = query[pos];

    // Check for negation prefix
    let negated = false;
    if (char === '-' && pos + 1 < query.length) {
      const nextChar = query[pos + 1];
      // Negation must be followed by a quote or word character
      if (nextChar === '"' || /\w/.test(nextChar)) {
        negated = true;
        pos++;
      }
    }

    const currentChar = query[pos];

    // Quoted phrase
    if (currentChar === '"') {
      pos++; // skip opening quote
      let phrase = '';
      while (pos < query.length) {
        if (query[pos] === '"') {
          // Check for escaped quote ("")
          if (pos + 1 < query.length && query[pos + 1] === '"') {
            phrase += '"';
            pos += 2;
          } else {
            pos++; // skip closing quote
            break;
          }
        } else {
          phrase += query[pos];
          pos++;
        }
      }
      if (phrase.trim()) {
        tokens.push({
          type: 'PHRASE',
          value: phrase.trim(),
          negated,
        });
      }
    }
    // Check for OR keyword (case-insensitive)
    else if (
      query.slice(pos, pos + 2).toUpperCase() === 'OR' &&
      (pos + 2 >= query.length || /\s/.test(query[pos + 2]))
    ) {
      // Make sure it's not part of a word (e.g., "ORder")
      const prevPos = pos - 1;
      const isPrevBoundary =
        prevPos < 0 || /\s/.test(query[prevPos]) || query[prevPos] === '"';
      if (isPrevBoundary) {
        tokens.push({ type: 'OR', value: 'OR' });
        pos += 2;
      } else {
        // It's part of a word, treat as term
        let term = '';
        while (pos < query.length && !/\s/.test(query[pos]) && query[pos] !== '"') {
          term += query[pos];
          pos++;
        }
        if (term) {
          tokens.push({ type: 'TERM', value: term, negated });
        }
      }
    }
    // Regular term
    else if (/\S/.test(currentChar)) {
      let term = '';
      while (pos < query.length && !/\s/.test(query[pos]) && query[pos] !== '"') {
        term += query[pos];
        pos++;
      }
      if (term) {
        // Check if the term itself is "OR" (after collecting it)
        if (term.toUpperCase() === 'OR' && !negated) {
          tokens.push({ type: 'OR', value: 'OR' });
        } else {
          tokens.push({ type: 'TERM', value: term, negated });
        }
      }
    } else {
      pos++;
    }
  }

  return tokens;
}

/**
 * Convert tokens to FTS5 query string
 *
 * FTS5 operators:
 * - AND: implicit between adjacent terms, or explicit
 * - OR: disjunction
 * - NOT: binary operator (a NOT b means "a but not b")
 *
 * IMPORTANT: In FTS5, NOT is a binary operator, NOT a prefix!
 * - CORRECT: "a NOT b" (a but not b)
 * - WRONG: "a AND NOT b" (syntax error!)
 */
function tokensToFTS5(tokens: Token[]): string {
  if (tokens.length === 0) return '';

  const parts: string[] = [];
  let prevWasOr = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isNegated = token.type !== 'OR' && token.negated;

    // Add AND between adjacent terms/phrases (unless OR is between them)
    // BUT: Don't add AND before negated terms - NOT is already a binary operator in FTS5
    if (
      parts.length > 0 &&
      token.type !== 'OR' &&
      !prevWasOr &&
      !parts[parts.length - 1].endsWith('OR') &&
      !isNegated // Don't add AND before NOT - FTS5 uses "a NOT b", not "a AND NOT b"
    ) {
      parts.push('AND');
    }

    if (token.type === 'OR') {
      // Replace last AND with OR if present
      if (parts.length > 0 && parts[parts.length - 1] === 'AND') {
        parts.pop();
      }
      parts.push('OR');
      prevWasOr = true;
    } else if (token.type === 'PHRASE') {
      // Escape internal quotes in phrase
      const escapedPhrase = token.value.replace(/"/g, '""');
      const phrase = `"${escapedPhrase}"`;
      if (token.negated) {
        parts.push(`NOT ${phrase}`);
      } else {
        parts.push(phrase);
      }
      prevWasOr = false;
    } else if (token.type === 'TERM') {
      const term = escapeFTS5Term(token.value);
      if (token.negated) {
        parts.push(`NOT ${term}`);
      } else {
        parts.push(term);
      }
      prevWasOr = false;
    }
  }

  return parts.join(' ');
}

/**
 * Convert a Google-style web search query to FTS5 query syntax.
 *
 * This mimics PostgreSQL's websearch_to_tsquery behavior:
 * - "quoted phrase" → phrase search
 * - word1 word2 → both required (AND)
 * - word1 OR word2 → either word
 * - -word → exclude word
 * - -"phrase" → exclude phrase
 *
 * @param query - The user's search query in Google-style syntax
 * @param useWebSearchSyntax - If false, simply AND all terms
 * @returns FTS5 query string
 *
 * @example
 * convertToFTS5Query('hello world') // → 'hello AND world'
 * convertToFTS5Query('"hello world"') // → '"hello world"'
 * convertToFTS5Query('hello OR world') // → 'hello OR world'
 * convertToFTS5Query('hello -world') // → 'hello AND NOT world'
 * convertToFTS5Query('"fat rat" -cat') // → '"fat rat" AND NOT cat'
 * convertToFTS5Query('signal -"segmentation fault"') // → 'signal AND NOT "segmentation fault"'
 */
export function convertToFTS5Query(
  query: string,
  useWebSearchSyntax = true,
): string {
  // Just trim - don't normalize whitespace as it breaks phrase preservation
  const trimmed = query.trim();
  if (!trimmed) return '';

  if (!useWebSearchSyntax) {
    // Simple mode: AND all terms (no special syntax parsing)
    const terms = trimmed.split(/\s+/).filter((t) => t.length > 0);
    return terms.map((t) => escapeFTS5Term(t)).join(' AND ');
  }

  // Web search syntax mode
  const tokens = tokenize(trimmed);
  return tokensToFTS5(tokens);
}

/**
 * Validate that an FTS5 query is well-formed.
 * Returns null if valid, or an error message if invalid.
 *
 * Note: FTS5 is quite forgiving, but this catches obvious issues.
 */
export function validateFTS5Query(query: string): string | null {
  // Check for unbalanced quotes
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    if (query[i] === '"') {
      // Check for escaped quote
      if (i + 1 < query.length && query[i + 1] === '"') {
        i++; // skip escaped quote
      } else {
        inQuote = !inQuote;
      }
    }
  }
  if (inQuote) {
    return 'Unbalanced quotes in query';
  }

  // Check for empty NOT
  if (/\bNOT\s*$/.test(query)) {
    return 'NOT operator without operand';
  }

  // Check for empty OR
  if (/\bOR\s*$/.test(query) || /^\s*OR\b/.test(query)) {
    return 'OR operator without both operands';
  }

  return null;
}
