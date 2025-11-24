# I18n Refactoring Plan: Build-Time Transformation

## Executive Summary

This document outlines the plan to refactor the internationalization (i18n)
system in the Auditaria CLI fork to eliminate merge conflicts when syncing with
upstream. The solution implements a build-time transformation that automatically
adds translations without modifying source code.

## Problem Statement

- Current i18n implementation uses `t('key', 'fallback')` throughout the
  codebase
- Creates numerous merge conflicts when syncing with upstream
  google-gemini/gemini-cli
- Maintenance burden increases with each upstream sync
- Need to maintain clean source code while supporting multiple languages

## Solution: Build-Time AST Transformation

### Core Concept

- Source code remains completely clean (no t() functions)
- Build process automatically identifies and wraps user-facing strings
- Uses direct string matching instead of translation keys
- Zero modifications to packages/cli and packages/core source files

## Technology Stack

### Recommended Libraries (Using Existing Robust Solutions)

#### AST Parsing & Transformation

- **[@babel/parser](https://babeljs.io/docs/babel-parser)** (v7.x)
  - Industry-standard parser with full TypeScript/JSX support
  - Handles all modern JavaScript features
  - Battle-tested in millions of projects

- **[@babel/traverse](https://babeljs.io/docs/babel-traverse)** (v7.x)
  - Powerful AST traversal with visitor pattern
  - Built-in scope tracking and path manipulation
  - Excellent TypeScript support

- **[@babel/generator](https://babeljs.io/docs/babel-generator)** (v7.x)
  - Generates code from AST with source map support
  - Preserves formatting where possible
  - Handles all edge cases properly

- **[@babel/types](https://babeljs.io/docs/babel-types)** (v7.x)
  - AST node creation and validation utilities
  - Type guards for safe AST manipulation

#### Alternative: Recast (For Better Formatting Preservation)

- **[recast](https://github.com/benjamn/recast)** (v0.23.x)
  - Preserves original formatting better than Babel
  - Uses Babel parser under the hood
  - Minimal diff in generated code

#### String Matching & Pattern Recognition

- **[micromatch](https://github.com/micromatch/micromatch)** (v4.x)
  - Fast glob matching for file exclusions
  - More features than minimatch
  - Used by many build tools

- **[string-similarity](https://github.com/aceakash/string-similarity)** (v4.x)
  - Fuzzy string matching for pattern detection
  - Helps identify similar strings for translation

#### Build Integration

- **[esbuild](https://esbuild.github.io/)** (existing)
  - Already in use, we'll create a plugin for it
  - Fast and efficient bundling

#### Utilities

- **[chalk](https://github.com/chalk/chalk)** (v5.x)
  - Colorful debug output
  - Already used in the project

- **[debug](https://github.com/debug-js/debug)** (v4.x)
  - Namespace-based debugging
  - Production-ready logging

## Architecture

### File Structure

```
scripts/
  i18n-transform/
    index.js                 # Main esbuild plugin entry
    babel-transformer.js     # Babel-based AST transformation
    pattern-matcher.js       # Pattern matching utilities
    exclusion-manager.js     # File/function exclusion handling
    translation-loader.js    # Load and cache translations
    debug-logger.js         # Debug logging with chalk
    extractors/
      text-component.js     # Extract from React/Ink Text components
      console-methods.js    # Extract from console.* calls
      object-properties.js  # Extract from object literals
      jsx-attributes.js     # Extract from JSX attributes
  i18n-translations/
    en-pt.json             # English to Portuguese
    en-es.json             # English to Spanish (future)
    patterns.json          # Pattern definitions
.i18n-ignore               # Exclusion patterns (like .gitignore)
```

### Translation File Structure

```json
{
  "version": "1.0",
  "exact": {
    "Hello World": "Olá Mundo",
    "Save": "Salvar",
    "Cancel": "Cancelar"
  },
  "patterns": [
    {
      "id": "file-not-found",
      "match": "File {filename} not found",
      "translation": "Arquivo {filename} não encontrado",
      "regex": "^File (.+) not found$"
    },
    {
      "id": "items-selected",
      "match": "{count} items selected",
      "translation": "{count} itens selecionados",
      "regex": "^(\\d+) items selected$"
    }
  ],
  "ignored": ["^DEBUG:", "^\\[System\\]"]
}
```

### Exclusion Configuration (.i18n-ignore)

```gitignore
# Exclude test files
**/*.test.ts
**/*.test.tsx
**/*.spec.ts

# Exclude specific directories
packages/cli/src/zed-integration/
packages/core/src/test-utils/

# Exclude by pattern
**/debug/**
**/mocks/**

# Exclude specific files
packages/cli/src/generated/*.ts
```

## Implementation Phases

### Phase 1: Basic Infrastructure (Week 1)

- [ ] Set up scripts/i18n-transform directory structure
- [ ] Install required dependencies (@babel/\*, recast, micromatch)
- [ ] Create basic esbuild plugin skeleton
- [ ] Implement translation file loader with caching
- [ ] Set up debug logging with chalk and debug modules
- [ ] Add plugin to esbuild.config.js with feature flag

### Phase 2: Simple Text Transformation (Week 1)

- [ ] Implement Babel parser setup for TypeScript/JSX
- [ ] Create visitor for simple `<Text>` components
- [ ] Transform `<Text>Hello</Text>` → `<Text>{t('Hello')}</Text>`
- [ ] Add automatic import injection for t() function
- [ ] Create initial en-pt.json with sample translations
- [ ] Test with a few simple components

### Phase 3: Nested Component Support (Week 2)

- [ ] Handle nested Text components with mixed content
- [ ] Preserve component props (color, bold, etc.)
- [ ] Support conditional rendering inside Text
- [ ] Handle Text components with expressions
- [ ] Maintain source maps for debugging
- [ ] Add unit tests for complex cases

### Phase 4: Pattern Matching (Week 2)

- [ ] Implement pattern detection for template literals
- [ ] Create pattern extraction utilities
- [ ] Build pattern matching engine with regex support
- [ ] Handle variable interpolation
- [ ] Cache compiled patterns for performance
- [ ] Add pattern validation and testing tools

### Phase 5: Exclusion Mechanisms (Week 3)

- [ ] Implement .i18n-ignore file parsing with micromatch
- [ ] Add inline comment directive support (@i18n-ignore)
- [ ] Create smart detection for non-user-facing strings
- [ ] Auto-exclude test files and debug messages
- [ ] Build exclusion override mechanisms
- [ ] Add exclusion reporting for debugging

### Phase 6: Object Property Transformation (Week 3)

- [ ] Transform object properties like `description: 'text'`
- [ ] Handle nested object structures
- [ ] Support computed property names
- [ ] Transform specific patterns (title, label, message, etc.)
- [ ] Preserve object spread operations
- [ ] Add configuration for property names to transform

### Phase 7: Console Method Transformation (Week 4)

- [ ] Transform console.log/error/warn/info calls
- [ ] Handle template literals in console methods
- [ ] Support multiple arguments to console methods
- [ ] Preserve stack traces and error objects
- [ ] Add smart detection for debug vs user messages
- [ ] Create console-specific exclusion rules

### Phase 8: Optimization & Tooling (Week 4)

- [ ] Create extraction script for untranslated strings
- [ ] Build translation coverage reporting tool
- [ ] Implement build-time caching for performance
- [ ] Add incremental compilation support
- [ ] Create migration script from key-based to string-based
- [ ] Set up CI/CD integration for translation validation

## Modified t() Function

```typescript
// packages/core/src/i18n/index.ts
import translations from '../../scripts/i18n-translations/current.json';

export const t = (
  text: string,
  params?: Record<string, string | number>,
): string => {
  // Try exact match first (O(1) lookup)
  const exactTranslation = translations.exact[text];
  if (exactTranslation) {
    return params ? interpolate(exactTranslation, params) : exactTranslation;
  }

  // Try pattern matching if params provided
  if (params) {
    for (const pattern of translations.patterns) {
      if (pattern.regex && new RegExp(pattern.regex).test(text)) {
        return interpolate(pattern.translation, params);
      }
    }
  }

  // Fallback to original text with interpolation
  return params ? interpolate(text, params) : text;
};

const interpolate = (
  template: string,
  params: Record<string, string | number>,
): string => {
  return template.replace(/\{([^}]+)\}/g, (_, key) =>
    String(params[key] ?? `{${key}}`),
  );
};
```

## Babel Visitor Example

```javascript
// Example visitor for Text component transformation
const textComponentVisitor = {
  JSXElement(path) {
    if (path.node.openingElement.name.name !== 'Text') return;

    const children = path.node.children;
    if (children.length === 1 && t.isJSXText(children[0])) {
      const text = children[0].value.trim();
      if (shouldTranslate(text)) {
        // Replace with {t('text')}
        path.node.children = [
          t.jsxExpressionContainer(
            t.callExpression(t.identifier('t'), [t.stringLiteral(text)]),
          ),
        ];
        fileNeedsImport = true;
      }
    }
  },
};
```

## Debug Mode

Set environment variables for debugging:

```bash
# Enable verbose transformation logging
I18N_DEBUG=true npm run build

# Enable specific namespaces
DEBUG=i18n:transform,i18n:pattern npm run build

# Write transformation report
I18N_REPORT=true npm run build
```

## Migration Strategy

### Step 1: Preparation

1. Extract all current t() calls and their fallbacks
2. Build en-pt.json from existing locale files
3. Create patterns.json from parameterized strings
4. Set up .i18n-ignore with initial exclusions

### Step 2: Parallel Running

1. Keep existing t() function working with keys
2. Add new string-based t() as t2() temporarily
3. Run both systems in parallel for testing
4. Validate translations match

### Step 3: Cutover

1. Remove key-based lookup from t() function
2. Remove all t() calls from source code
3. Enable build-time transformation
4. Delete old locale files with keys

### Step 4: Cleanup

1. Remove temporary t2() function
2. Update documentation
3. Train team on new system
4. Set up automated translation workflows

## Performance Considerations

- **Build Time Impact**: Target <15% increase
- **Caching Strategy**:
  - Cache parsed ASTs between builds
  - Cache translation lookups
  - Use incremental compilation where possible
- **Bundle Size**: Minimal impact (~2KB for t() function)
- **Runtime Performance**: O(1) for exact matches, O(n) for patterns

## Success Metrics

| Metric               | Target        | Measurement             |
| -------------------- | ------------- | ----------------------- |
| Merge Conflicts      | <5% of files  | Git conflict statistics |
| Build Time           | <15% increase | CI/CD metrics           |
| Translation Coverage | >95%          | Automated reporting     |
| Developer Experience | Positive      | Team feedback           |
| Maintenance Time     | 80% reduction | Time tracking           |

## Risks & Mitigations

| Risk                   | Impact | Mitigation                                 |
| ---------------------- | ------ | ------------------------------------------ |
| Complex AST edge cases | High   | Use battle-tested Babel, extensive testing |
| Build time regression  | Medium | Implement caching, incremental builds      |
| Missing translations   | Low    | Fallback to English, automated detection   |
| Developer resistance   | Medium | Clear documentation, gradual rollout       |

## Testing Strategy

### Unit Tests

- AST transformation for each visitor type
- Pattern matching algorithms
- Exclusion rule processing
- Translation loading and caching

### Integration Tests

- Full component transformation
- Build process with plugin enabled
- Source map preservation
- Import injection

### End-to-End Tests

- Complete build and run
- Language switching
- Fallback behavior
- Performance benchmarks

## Documentation

### Developer Guide

- How the transformation works
- Adding new translations
- Debugging transformation issues
- Writing exclusion rules

### Translator Guide

- File format specification
- Pattern syntax
- Testing translations
- Using automated tools

## Timeline

- **Week 1**: Phases 1-2 (Infrastructure & Basic Transformation)
- **Week 2**: Phases 3-4 (Complex Components & Patterns)
- **Week 3**: Phases 5-6 (Exclusions & Object Properties)
- **Week 4**: Phases 7-8 (Console Methods & Tooling)
- **Week 5**: Testing & Migration
- **Week 6**: Documentation & Training

## Conclusion

This build-time transformation approach elegantly solves the i18n maintenance
problem while keeping the codebase clean. By leveraging robust existing
libraries like Babel, we avoid reinventing the wheel and benefit from
battle-tested code. The solution is scalable, maintainable, and achieves the
primary goal of eliminating merge conflicts when syncing with upstream.

## Appendix: Example Transformations

### Before (Source Code)

```tsx
// Clean source code - no t() functions
export const MyComponent = () => (
  <Box>
    <Text bold>Welcome to Auditaria</Text>
    <Text>Processing {count} files...</Text>
  </Box>
);

console.log('Operation completed successfully');

const config = {
  title: 'Settings',
  description: 'Configure your preferences',
};
```

### After (Built Code)

```tsx
import { t } from '@google/gemini-cli-core';

export const MyComponent = () => (
  <Box>
    <Text bold>{t('Welcome to Auditaria')}</Text>
    <Text>{t('Processing {count} files...', { count })}</Text>
  </Box>
);

console.log(t('Operation completed successfully'));

const config = {
  title: t('Settings'),
  description: t('Configure your preferences'),
};
```
