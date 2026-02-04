/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  convertToFTS5Query,
  validateFTS5Query,
  type Token,
} from './web-search-parser.js';

describe('web-search-parser', () => {
  describe('tokenize', () => {
    it('should tokenize simple terms', () => {
      const tokens = tokenize('hello world');
      expect(tokens).toEqual([
        { type: 'TERM', value: 'hello', negated: false },
        { type: 'TERM', value: 'world', negated: false },
      ]);
    });

    it('should tokenize quoted phrases', () => {
      const tokens = tokenize('"hello world"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'hello world', negated: false },
      ]);
    });

    it('should handle mixed terms and phrases', () => {
      const tokens = tokenize('foo "hello world" bar');
      expect(tokens).toEqual([
        { type: 'TERM', value: 'foo', negated: false },
        { type: 'PHRASE', value: 'hello world', negated: false },
        { type: 'TERM', value: 'bar', negated: false },
      ]);
    });

    it('should tokenize OR operator', () => {
      const tokens = tokenize('hello OR world');
      expect(tokens).toEqual([
        { type: 'TERM', value: 'hello', negated: false },
        { type: 'OR', value: 'OR' },
        { type: 'TERM', value: 'world', negated: false },
      ]);
    });

    it('should tokenize OR case-insensitively', () => {
      expect(tokenize('hello or world')).toEqual([
        { type: 'TERM', value: 'hello', negated: false },
        { type: 'OR', value: 'OR' },
        { type: 'TERM', value: 'world', negated: false },
      ]);

      expect(tokenize('hello Or world')).toEqual([
        { type: 'TERM', value: 'hello', negated: false },
        { type: 'OR', value: 'OR' },
        { type: 'TERM', value: 'world', negated: false },
      ]);
    });

    it('should NOT treat OR as operator when part of a word', () => {
      const tokens = tokenize('ORder');
      expect(tokens).toEqual([{ type: 'TERM', value: 'ORder', negated: false }]);
    });

    it('should tokenize negated terms', () => {
      const tokens = tokenize('-hello');
      expect(tokens).toEqual([{ type: 'TERM', value: 'hello', negated: true }]);
    });

    it('should tokenize negated phrases', () => {
      const tokens = tokenize('-"hello world"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'hello world', negated: true },
      ]);
    });

    it('should handle complex queries', () => {
      const tokens = tokenize('signal -"segmentation fault"');
      expect(tokens).toEqual([
        { type: 'TERM', value: 'signal', negated: false },
        { type: 'PHRASE', value: 'segmentation fault', negated: true },
      ]);
    });

    it('should handle OR with phrases', () => {
      const tokens = tokenize('"sad cat" OR "fat rat"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'sad cat', negated: false },
        { type: 'OR', value: 'OR' },
        { type: 'PHRASE', value: 'fat rat', negated: false },
      ]);
    });

    it('should handle escaped quotes in phrases', () => {
      const tokens = tokenize('"say ""hello"" world"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'say "hello" world', negated: false },
      ]);
    });

    it('should handle unclosed quotes gracefully', () => {
      const tokens = tokenize('"hello world');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'hello world', negated: false },
      ]);
    });

    it('should handle empty query', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize('   ')).toEqual([]);
    });

    it('should handle hyphenated words (not negation)', () => {
      // A hyphen in the middle of a word is not negation
      const tokens = tokenize('well-known fact');
      expect(tokens).toEqual([
        { type: 'TERM', value: 'well-known', negated: false },
        { type: 'TERM', value: 'fact', negated: false },
      ]);
    });

    it('should handle lone hyphen', () => {
      const tokens = tokenize('- hello');
      // Lone hyphen followed by space should be ignored
      expect(tokens).toEqual([
        { type: 'TERM', value: '-', negated: false },
        { type: 'TERM', value: 'hello', negated: false },
      ]);
    });
  });

  describe('convertToFTS5Query', () => {
    describe('simple mode (useWebSearchSyntax = false)', () => {
      it('should AND all terms', () => {
        expect(convertToFTS5Query('hello world', false)).toBe(
          'hello AND world',
        );
      });

      it('should handle single term', () => {
        expect(convertToFTS5Query('hello', false)).toBe('hello');
      });

      it('should handle multiple whitespace', () => {
        expect(convertToFTS5Query('hello   world  foo', false)).toBe(
          'hello AND world AND foo',
        );
      });

      it('should handle empty query', () => {
        expect(convertToFTS5Query('', false)).toBe('');
        expect(convertToFTS5Query('   ', false)).toBe('');
      });
    });

    describe('web search syntax mode', () => {
      it('should convert simple terms to AND', () => {
        expect(convertToFTS5Query('hello world')).toBe('hello AND world');
      });

      it('should preserve quoted phrases', () => {
        expect(convertToFTS5Query('"hello world"')).toBe('"hello world"');
      });

      it('should convert negated terms to NOT', () => {
        expect(convertToFTS5Query('-hello')).toBe('NOT hello');
        expect(convertToFTS5Query('world -hello')).toBe('world NOT hello');
      });

      it('should convert negated phrases to NOT', () => {
        expect(convertToFTS5Query('-"hello world"')).toBe(
          'NOT "hello world"',
        );
        expect(convertToFTS5Query('foo -"hello world"')).toBe(
          'foo NOT "hello world"',
        );
      });

      it('should preserve OR operator', () => {
        expect(convertToFTS5Query('hello OR world')).toBe('hello OR world');
      });

      it('should handle OR with phrases', () => {
        expect(convertToFTS5Query('"sad cat" OR "fat rat"')).toBe(
          '"sad cat" OR "fat rat"',
        );
      });

      it('should handle complex queries like PostgreSQL websearch_to_tsquery', () => {
        // "supernovae stars" -crab → 'supernova' <-> 'star' & !'crab'
        // FTS5 equivalent: "supernovae stars" NOT crab
        expect(convertToFTS5Query('"supernovae stars" -crab')).toBe(
          '"supernovae stars" NOT crab',
        );

        // "sad cat" or "fat rat" → 'sad' <-> 'cat' | 'fat' <-> 'rat'
        expect(convertToFTS5Query('"sad cat" or "fat rat"')).toBe(
          '"sad cat" OR "fat rat"',
        );

        // signal -"segmentation fault" → 'signal' & !('segment' <-> 'fault')
        expect(convertToFTS5Query('signal -"segmentation fault"')).toBe(
          'signal NOT "segmentation fault"',
        );
      });

      it('should handle multiple OR operators', () => {
        expect(convertToFTS5Query('a OR b OR c')).toBe('a OR b OR c');
      });

      it('should handle mixed AND and OR', () => {
        // a b OR c → (a AND b) OR c in FTS5 precedence
        // But websearch treats: a (b OR c)
        // Let's follow the simpler approach: just emit as-is and let FTS5 handle precedence
        expect(convertToFTS5Query('a b OR c')).toBe('a AND b OR c');
      });

      it('should handle multiple negations', () => {
        expect(convertToFTS5Query('hello -foo -bar')).toBe(
          'hello NOT foo NOT bar',
        );
      });

      it('should escape special FTS5 characters in terms', () => {
        // Characters like * + : ^ need to be quoted
        expect(convertToFTS5Query('c++')).toBe('"c++"');
        expect(convertToFTS5Query('file:test')).toBe('"file:test"');
        expect(convertToFTS5Query('prefix*')).toBe('"prefix*"');
      });

      it('should handle escaped quotes in output phrases', () => {
        expect(convertToFTS5Query('"say ""hello"" world"')).toBe(
          '"say ""hello"" world"',
        );
      });
    });
  });

  describe('validateFTS5Query', () => {
    it('should return null for valid queries', () => {
      expect(validateFTS5Query('hello world')).toBeNull();
      expect(validateFTS5Query('"hello world"')).toBeNull();
      expect(validateFTS5Query('hello OR world')).toBeNull();
      expect(validateFTS5Query('hello NOT world')).toBeNull();
    });

    it('should detect unbalanced quotes', () => {
      expect(validateFTS5Query('"hello world')).toBe(
        'Unbalanced quotes in query',
      );
    });

    it('should detect empty NOT', () => {
      expect(validateFTS5Query('hello NOT')).toBe(
        'NOT operator without operand',
      );
    });

    it('should detect empty OR', () => {
      expect(validateFTS5Query('hello OR')).toBe(
        'OR operator without both operands',
      );
      expect(validateFTS5Query('OR hello')).toBe(
        'OR operator without both operands',
      );
    });

    it('should handle escaped quotes', () => {
      expect(validateFTS5Query('"say ""hi"""')).toBeNull();
    });
  });

  describe('real-world examples', () => {
    it('should handle audit-related searches', () => {
      expect(convertToFTS5Query('auditoria interna')).toBe(
        'auditoria AND interna',
      );
      expect(convertToFTS5Query('"auditoria interna" TCU')).toBe(
        '"auditoria interna" AND TCU',
      );
      expect(convertToFTS5Query('controle interno OR externo')).toBe(
        'controle AND interno OR externo',
      );
      expect(convertToFTS5Query('achados -irrelevante')).toBe(
        'achados NOT irrelevante',
      );
    });

    it('should handle Portuguese phrases', () => {
      expect(convertToFTS5Query('"base de apoio"')).toBe('"base de apoio"');
      expect(convertToFTS5Query('"controle de gestão" -obsoleto')).toBe(
        '"controle de gestão" NOT obsoleto',
      );
    });

    it('should handle technical searches', () => {
      expect(convertToFTS5Query('error handling')).toBe('error AND handling');
      expect(convertToFTS5Query('"null pointer" OR "undefined reference"')).toBe(
        '"null pointer" OR "undefined reference"',
      );
      expect(convertToFTS5Query('typescript -javascript')).toBe(
        'typescript NOT javascript',
      );
    });
  });

  // ==========================================================================
  // COMPLEX SCENARIOS - Robustness Tests
  // ==========================================================================

  describe('complex nested queries', () => {
    it('should handle multiple phrases with multiple operators', () => {
      expect(
        convertToFTS5Query('"hello world" "foo bar" OR "baz qux"'),
      ).toBe('"hello world" AND "foo bar" OR "baz qux"');
    });

    it('should handle phrases mixed with negations and OR', () => {
      expect(
        convertToFTS5Query('"audit report" OR "inspection report" -draft'),
      ).toBe('"audit report" OR "inspection report" NOT draft');
    });

    it('should handle multiple consecutive negations with phrases', () => {
      expect(
        convertToFTS5Query('document -"work in progress" -obsolete -archived'),
      ).toBe('document NOT "work in progress" NOT obsolete NOT archived');
    });

    it('should handle complex OR chains with terms', () => {
      expect(convertToFTS5Query('a OR b OR c OR d OR e')).toBe(
        'a OR b OR c OR d OR e',
      );
    });

    it('should handle alternating AND and OR patterns', () => {
      expect(convertToFTS5Query('a b OR c d OR e f')).toBe(
        'a AND b OR c AND d OR e AND f',
      );
    });

    it('should handle phrases at different positions', () => {
      // Phrase at start
      expect(convertToFTS5Query('"first phrase" term1 term2')).toBe(
        '"first phrase" AND term1 AND term2',
      );
      // Phrase at middle
      expect(convertToFTS5Query('term1 "middle phrase" term2')).toBe(
        'term1 AND "middle phrase" AND term2',
      );
      // Phrase at end
      expect(convertToFTS5Query('term1 term2 "last phrase"')).toBe(
        'term1 AND term2 AND "last phrase"',
      );
    });

    it('should handle negated phrases with OR', () => {
      expect(
        convertToFTS5Query('report -"confidential" OR -"restricted"'),
      ).toBe('report NOT "confidential" OR NOT "restricted"');
    });

    it('should handle complex legal/audit queries', () => {
      // Real-world audit search
      expect(
        convertToFTS5Query(
          '"internal control" OR "risk assessment" -draft -"work paper"',
        ),
      ).toBe(
        '"internal control" OR "risk assessment" NOT draft NOT "work paper"',
      );
    });
  });

  describe('edge cases - unicode and special characters', () => {
    it('should handle unicode characters in terms', () => {
      expect(convertToFTS5Query('café résumé')).toBe('café AND résumé');
      expect(convertToFTS5Query('日本語 中文')).toBe('日本語 AND 中文');
      expect(convertToFTS5Query('München Zürich')).toBe('München AND Zürich');
    });

    it('should handle unicode in phrases', () => {
      expect(convertToFTS5Query('"São Paulo" OR "北京市"')).toBe(
        '"São Paulo" OR "北京市"',
      );
    });

    it('should handle accented characters with negation', () => {
      expect(convertToFTS5Query('relatório -rascunho')).toBe(
        'relatório NOT rascunho',
      );
    });

    it('should handle numbers as terms', () => {
      expect(convertToFTS5Query('2024 report')).toBe('2024 AND report');
      expect(convertToFTS5Query('"Q1 2024" OR "Q2 2024"')).toBe(
        '"Q1 2024" OR "Q2 2024"',
      );
    });

    it('should handle mixed alphanumeric terms', () => {
      expect(convertToFTS5Query('ISO9001 certification')).toBe(
        'ISO9001 AND certification',
      );
      expect(convertToFTS5Query('v2.0 release -beta')).toBe(
        'v2.0 AND release NOT beta',
      );
    });

    it('should handle email-like patterns', () => {
      expect(convertToFTS5Query('user@example.com')).toBe('user@example.com');
    });

    it('should handle URL-like patterns', () => {
      // URLs contain special chars that should be quoted
      expect(convertToFTS5Query('https://example.com')).toBe(
        '"https://example.com"',
      );
    });

    it('should handle file paths', () => {
      expect(convertToFTS5Query('/usr/local/bin')).toBe('/usr/local/bin');
      // Windows paths with : are quoted because : is special in FTS5
      expect(convertToFTS5Query('C:\\Users\\docs')).toBe('"C:\\Users\\docs"');
    });

    it('should handle parentheses and brackets in input (special FTS5 chars)', () => {
      // Parentheses and brackets have special meaning in FTS5, should be quoted
      expect(convertToFTS5Query('function()')).toBe('"function()"');
      expect(convertToFTS5Query('array[0]')).toBe('"array[0]"');
      expect(convertToFTS5Query('dict{key}')).toBe('"dict{key}"');
    });

    it('should handle curly braces', () => {
      expect(convertToFTS5Query('object{}')).toBe('"object{}"');
    });
  });

  describe('edge cases - whitespace and formatting', () => {
    it('should handle multiple spaces between terms', () => {
      expect(convertToFTS5Query('hello    world')).toBe('hello AND world');
    });

    it('should handle tabs and newlines', () => {
      expect(convertToFTS5Query('hello\tworld')).toBe('hello AND world');
      expect(convertToFTS5Query('hello\nworld')).toBe('hello AND world');
    });

    it('should handle leading and trailing whitespace', () => {
      expect(convertToFTS5Query('  hello world  ')).toBe('hello AND world');
    });

    it('should handle whitespace around operators', () => {
      expect(convertToFTS5Query('hello   OR   world')).toBe('hello OR world');
      expect(convertToFTS5Query('hello  -world')).toBe('hello NOT world');
    });

    it('should handle whitespace inside phrases', () => {
      // Internal whitespace in phrases is preserved (but trimmed at edges)
      expect(convertToFTS5Query('"hello   world"')).toBe('"hello   world"');
      expect(convertToFTS5Query('"  hello world  "')).toBe('"hello world"');
    });

    it('should handle empty phrases', () => {
      // Empty phrase should be ignored
      const result = convertToFTS5Query('"" hello');
      expect(result).toBe('hello');
    });

    it('should handle phrase with only whitespace', () => {
      const result = convertToFTS5Query('"   " hello');
      expect(result).toBe('hello');
    });
  });

  describe('edge cases - single characters and short inputs', () => {
    it('should handle single character terms', () => {
      expect(convertToFTS5Query('a')).toBe('a');
      expect(convertToFTS5Query('a b c')).toBe('a AND b AND c');
    });

    it('should handle single character with negation', () => {
      expect(convertToFTS5Query('-a')).toBe('NOT a');
      expect(convertToFTS5Query('b -a')).toBe('b NOT a');
    });

    it('should handle single term', () => {
      expect(convertToFTS5Query('hello')).toBe('hello');
    });

    it('should handle single phrase', () => {
      expect(convertToFTS5Query('"single phrase"')).toBe('"single phrase"');
    });

    it('should handle single negation', () => {
      expect(convertToFTS5Query('-excluded')).toBe('NOT excluded');
    });
  });

  describe('stress tests - many terms and long queries', () => {
    it('should handle many terms (10+)', () => {
      const query = 'a b c d e f g h i j k l m n o';
      const expected =
        'a AND b AND c AND d AND e AND f AND g AND h AND i AND j AND k AND l AND m AND n AND o';
      expect(convertToFTS5Query(query)).toBe(expected);
    });

    it('should handle many phrases', () => {
      const query = '"phrase one" "phrase two" "phrase three" "phrase four"';
      const expected =
        '"phrase one" AND "phrase two" AND "phrase three" AND "phrase four"';
      expect(convertToFTS5Query(query)).toBe(expected);
    });

    it('should handle many negations', () => {
      const query = 'keep -a -b -c -d -e';
      const expected = 'keep NOT a NOT b NOT c NOT d NOT e';
      expect(convertToFTS5Query(query)).toBe(expected);
    });

    it('should handle many OR operators', () => {
      const query = 'a OR b OR c OR d OR e OR f OR g';
      expect(convertToFTS5Query(query)).toBe('a OR b OR c OR d OR e OR f OR g');
    });

    it('should handle long phrase', () => {
      const longPhrase = '"this is a very long phrase with many words in it"';
      expect(convertToFTS5Query(longPhrase)).toBe(longPhrase);
    });

    it('should handle complex mixed query with many elements', () => {
      const query =
        '"audit report" internal OR external -draft -"work paper" 2024 compliance';
      const expected =
        '"audit report" AND internal OR external NOT draft NOT "work paper" AND 2024 AND compliance';
      expect(convertToFTS5Query(query)).toBe(expected);
    });
  });

  describe('malformed input handling', () => {
    it('should handle unclosed quote at end', () => {
      expect(convertToFTS5Query('"unclosed phrase')).toBe('"unclosed phrase"');
    });

    it('should handle unclosed quote in middle', () => {
      expect(convertToFTS5Query('"unclosed phrase more')).toBe(
        '"unclosed phrase more"',
      );
    });

    it('should handle multiple unclosed quotes', () => {
      // Parser should handle this gracefully
      const result = convertToFTS5Query('"first "second');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should handle only operators', () => {
      // OR alone is treated as a term by the tokenizer (edge case)
      // This is acceptable - FTS5 will handle it or error appropriately
      expect(convertToFTS5Query('OR')).toBe('OR');
      expect(convertToFTS5Query('OR OR')).toBe('OR OR');
    });

    it('should handle consecutive OR operators', () => {
      // Consecutive ORs are passed through - FTS5 handles them
      // This is acceptable behavior for malformed input
      expect(convertToFTS5Query('a OR OR b')).toBe('a OR OR b');
    });

    it('should handle trailing negation', () => {
      // -at end without term
      expect(convertToFTS5Query('hello -')).toBe('hello AND -');
    });

    it('should handle only negation', () => {
      expect(convertToFTS5Query('-')).toBe('-');
    });

    it('should handle empty string', () => {
      expect(convertToFTS5Query('')).toBe('');
    });

    it('should handle only whitespace', () => {
      expect(convertToFTS5Query('   ')).toBe('');
      expect(convertToFTS5Query('\t\n')).toBe('');
    });

    it('should handle only quotes', () => {
      expect(convertToFTS5Query('""')).toBe('');
      expect(convertToFTS5Query('" "')).toBe('');
    });

    it('should handle consecutive quotes', () => {
      expect(convertToFTS5Query('"a" "b"')).toBe('"a" AND "b"');
    });

    it('should handle quote immediately followed by term', () => {
      expect(convertToFTS5Query('"phrase"term')).toBe('"phrase" AND term');
    });
  });

  describe('complex real-world scenarios', () => {
    it('should handle legal document searches', () => {
      expect(
        convertToFTS5Query(
          '"breach of contract" OR "contractual violation" damages -dismissed',
        ),
      ).toBe(
        '"breach of contract" OR "contractual violation" AND damages NOT dismissed',
      );
    });

    it('should handle financial audit searches', () => {
      expect(
        convertToFTS5Query(
          '"material misstatement" OR "significant deficiency" -remediated fiscal 2024',
        ),
      ).toBe(
        '"material misstatement" OR "significant deficiency" NOT remediated AND fiscal AND 2024',
      );
    });

    it('should handle IT security searches', () => {
      expect(
        convertToFTS5Query(
          '"SQL injection" OR "XSS" OR "CSRF" vulnerability -patched -resolved',
        ),
      ).toBe(
        '"SQL injection" OR "XSS" OR "CSRF" AND vulnerability NOT patched NOT resolved',
      );
    });

    it('should handle medical/clinical searches', () => {
      expect(
        convertToFTS5Query(
          '"adverse event" OR "side effect" treatment -placebo -"phase 1"',
        ),
      ).toBe(
        '"adverse event" OR "side effect" AND treatment NOT placebo NOT "phase 1"',
      );
    });

    it('should handle academic paper searches', () => {
      expect(
        convertToFTS5Query(
          '"machine learning" OR "deep learning" classification -survey -review 2023 OR 2024',
        ),
      ).toBe(
        '"machine learning" OR "deep learning" AND classification NOT survey NOT review AND 2023 OR 2024',
      );
    });

    it('should handle code search queries', () => {
      expect(
        convertToFTS5Query(
          'function async -deprecated -"test file" export OR import',
        ),
      ).toBe(
        'function AND async NOT deprecated NOT "test file" AND export OR import',
      );
    });

    it('should handle multi-language document searches', () => {
      expect(
        convertToFTS5Query(
          '"contrato de prestação" OR "service agreement" -rascunho -draft',
        ),
      ).toBe(
        '"contrato de prestação" OR "service agreement" NOT rascunho NOT draft',
      );
    });

    it('should handle government/regulatory searches', () => {
      expect(
        convertToFTS5Query(
          '"compliance requirement" OR "regulatory mandate" effective 2024 -proposed -draft',
        ),
      ).toBe(
        '"compliance requirement" OR "regulatory mandate" AND effective AND 2024 NOT proposed NOT draft',
      );
    });
  });

  describe('operator precedence edge cases', () => {
    it('should handle NOT before OR correctly', () => {
      // "a -b OR c" should mean: (a NOT b) OR c
      expect(convertToFTS5Query('a -b OR c')).toBe('a NOT b OR c');
    });

    it('should handle multiple OR with single negation', () => {
      expect(convertToFTS5Query('a OR b OR c -d')).toBe('a OR b OR c NOT d');
    });

    it('should handle negation between ORs', () => {
      expect(convertToFTS5Query('a OR -b OR c')).toBe('a OR NOT b OR c');
    });

    it('should handle phrase negation with OR', () => {
      expect(convertToFTS5Query('"a b" OR -"c d"')).toBe('"a b" OR NOT "c d"');
    });

    it('should handle all negations with OR', () => {
      expect(convertToFTS5Query('-a OR -b OR -c')).toBe('NOT a OR NOT b OR NOT c');
    });
  });

  describe('tokenize complex scenarios', () => {
    it('should tokenize complex query with all features', () => {
      const tokens = tokenize('"phrase one" term -excluded OR "alt phrase" -"neg phrase"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'phrase one', negated: false },
        { type: 'TERM', value: 'term', negated: false },
        { type: 'TERM', value: 'excluded', negated: true },
        { type: 'OR', value: 'OR' },
        { type: 'PHRASE', value: 'alt phrase', negated: false },
        { type: 'PHRASE', value: 'neg phrase', negated: true },
      ]);
    });

    it('should tokenize query with special characters', () => {
      const tokens = tokenize('hello@world test');
      expect(tokens.length).toBe(2);
      expect(tokens[0].value).toBe('hello@world');
    });

    it('should tokenize consecutive phrases', () => {
      // When phrases are directly adjacent without space, "" is treated as escaped quote
      // This follows PostgreSQL behavior: "a""b" = phrase containing literal quote
      // Users should add space for separate phrases: "first" "second"
      const tokens = tokenize('"first""second"');
      expect(tokens).toEqual([
        { type: 'PHRASE', value: 'first"second', negated: false },
      ]);

      // With space, they're separate phrases
      const spacedTokens = tokenize('"first" "second"');
      expect(spacedTokens).toEqual([
        { type: 'PHRASE', value: 'first', negated: false },
        { type: 'PHRASE', value: 'second', negated: false },
      ]);
    });

    it('should handle OR surrounded by phrases', () => {
      const tokens = tokenize('"a"OR"b"');
      // OR should be treated as part of the adjacent content since no spaces
      expect(tokens.length).toBeGreaterThan(0);
    });
  });
});
