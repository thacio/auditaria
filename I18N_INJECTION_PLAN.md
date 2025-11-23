# i18n Injection Implementation Plan

## ✅ STATUS: COMPLETED AND WORKING

Last Updated: 2025-11-23

## Overview
Non-invasive internationalization solution for Auditaria CLI using ink component patching to automatically translate UI strings without manual code modifications.

**IMPLEMENTATION STATUS**: Successfully implemented and tested. Translations working, memory issues resolved.

## Problem Statement
- Current t() function approach is invasive and causes merge conflicts with upstream
- Manual wrapping of every string is tedious and error-prone
- Need automatic translation that doesn't modify source files
- Must work with global npm installations
- Should not translate chat messages or tool outputs

## Solution Architecture

### Core Approach
- Patch ink's Text component directly using patch-package
- Intercept text rendering at the lowest level
- Translate strings based on en-pt.json mappings
- Use exact matching → pattern matching → fuzzy matching fallback
- Exclude chat messages and tool outputs from translation

### Directory Structure
```
packages/cli/src/i18n-injection/
├── TranslationManager.ts       # Core translation logic
├── ink-patcher.ts             # Ink Text component patch logic
├── console-wrapper.ts          # Console output interception
├── migration-script.ts         # Convert old format to new
├── types.ts                   # TypeScript definitions
├── debug.ts                   # Debug logging utilities
└── index.ts                   # Main entry point

packages/cli/dist/i18n-injection/
└── en-pt.json                 # Bundled translation mappings
```

### Translation File Format (en-pt.json)
```json
{
  "metadata": {
    "version": "1.0",
    "generated": "ISO-8601 timestamp",
    "exact_count": 877,
    "pattern_count": 210
  },
  "exact": {
    "English string": "Portuguese translation",
    "Opening browser": "Abrindo navegador"
  },
  "patterns": [
    {
      "pattern": "^Loaded (\\d+) files$",
      "replacement": "Carregados $1 arquivos",
      "flags": "i"
    }
  ],
  "exclusions": {
    "prefixes": ["[Tool:", "User:", "Assistant:", "Error:"],
    "components": ["ChatMessage", "ToolOutput"],
    "contexts": ["chat", "tool", "function"]
  }
}
```

## Implementation Steps

### Phase 1: Infrastructure Setup
1. **Install patch-package**
   - Add as devDependency
   - Configure postinstall script
   - Create patches directory

2. **Create i18n-injection structure**
   - Set up TypeScript files
   - Configure module exports
   - Add to build process

### Phase 2: Translation System
3. **TranslationManager Implementation**
   - Singleton pattern for global access
   - Language detection from settings
   - Efficient caching with WeakMap
   - Debug logging capabilities

4. **Migration Script**
   - Parse existing en.json and pt.json
   - Extract translation pairs
   - Generate en-pt.json with exact and pattern sections
   - Handle parameterized strings

### Phase 3: Component Patching
5. **Ink Text Component Patch**
   - Override Text component's render method
   - Intercept children prop
   - Apply translations conditionally
   - Handle exclusions properly

6. **Exclusion Detection**
   - Check component hierarchy
   - Identify chat/tool contexts
   - Use markers for system messages
   - Preserve original text when needed

### Phase 4: Console Interception
7. **Console Wrapper**
   - Intercept console.log, console.error, console.warn
   - Translate output strings
   - Preserve formatting and colors
   - Handle multi-argument calls

### Phase 5: Build Integration
8. **Global Installation Support**
   - Bundle en-pt.json in dist
   - Handle path resolution
   - Support both local and global contexts
   - Add to build scripts

### Phase 6: Testing & Validation
9. **Performance Testing**
   - Memory usage profiling
   - Translation latency measurement
   - Cache hit ratio analysis
   - Stress testing with large conversations

10. **Functional Testing**
    - Verify UI string translation
    - Confirm chat message exclusion
    - Test with different languages
    - Validate global installation

## Technical Details

### Translation Algorithm
```typescript
function translateString(text: string): string {
  // 1. Check cache
  if (cache.has(text)) return cache.get(text);

  // 2. Check if excluded
  if (isExcluded(text)) return text;

  // 3. Try exact match
  if (exactMatches[text]) {
    return cache.set(text, exactMatches[text]);
  }

  // 4. Try pattern matching
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      return cache.set(text, text.replace(pattern.regex, pattern.replacement));
    }
  }

  // 5. Return original (fallback)
  return text;
}
```

### Memory Optimization
- Use WeakMap for automatic garbage collection
- Implement LRU cache with size limits
- Clear cache on language changes
- Monitor memory usage in debug mode

### Debug Logging
```
[i18n-inject] System initialized
[i18n-inject] Language: pt
[i18n-inject] Loaded 877 exact, 210 patterns
[i18n-inject] Translating: "Save file" → "Salvar arquivo"
[i18n-inject] Cache stats: 95% hit rate (1423/1498)
[i18n-inject] Memory: 12.3 MB used
```

## Risk Mitigation

### Potential Issues & Solutions
1. **Memory leaks**
   - Solution: WeakMap caching, memory monitoring

2. **Infinite recursion**
   - Solution: Recursion depth tracking, circuit breaker

3. **Performance degradation**
   - Solution: Efficient caching, lazy loading

4. **Chat message translation**
   - Solution: Context detection, exclusion rules

5. **Build/installation issues**
   - Solution: Robust path resolution, bundling strategy

## Success Criteria
- ✅ Zero manual t() function calls required
- ✅ All UI strings automatically translated
- ✅ Chat messages remain untranslated
- ✅ Memory overhead < 50MB
- ✅ Translation latency < 1ms
- ✅ Works with npm install -g
- ✅ No upstream merge conflicts
- ✅ Comprehensive debug logging
- ✅ Graceful fallback on errors

## Maintenance Guide

### Adding Translations
1. Update en.json and pt.json
2. Run migration script
3. Rebuild and test

### Updating Ink Patch
1. Make changes to ink interception
2. Run `npx patch-package ink`
3. Commit patch file

### Debugging Issues
1. Enable debug mode: `DEBUG_I18N=true`
2. Check console logs for translation attempts
3. Verify en-pt.json is loaded correctly
4. Monitor memory usage

## Benefits Over Current System
- **Non-invasive**: No source code modifications
- **Automatic**: No manual wrapping needed
- **Maintainable**: Single patch file to manage
- **Performant**: Efficient caching strategy
- **Compatible**: Works with global installations
- **Debuggable**: Comprehensive logging
- **Future-proof**: Easy to update and maintain

## Timeline
- Phase 1-2: Core infrastructure (Day 1)
- Phase 3-4: Patching implementation (Day 1)
- Phase 5-6: Testing and validation (Day 1)

## Notes
- Old t() function remains for build compatibility but is not used
- Solution designed for minimal upstream conflicts
- All i18n code isolated in dedicated directory
- Patch-package ensures consistent behavior across installations