# Auditaria i18n System

A **build-time transformation** approach to internationalization that keeps
source code clean while enabling full translation support.

## Philosophy

Traditional i18n approaches require developers to wrap every string in
translation calls manually:

```tsx
// Traditional approach - verbose and clutters code
<Text>{t('welcome.message', 'Welcome to the app')}</Text>
<Text>{t('help.hint', 'Press /help for assistance')}</Text>
```

To avoid merging conflicts, our approach lets you write **natural, readable
code**:

```tsx
// Our approach - clean, readable source code
<Text>Welcome to the app</Text>
<Text>Press /help for assistance</Text>
```

The build-time transformer automatically converts these to translation calls
during the build process, generating a report of all transformable strings that
can then be translated.

### Key Benefits

1. **Clean source code** - No translation wrappers cluttering the codebase
2. **Easier upstream syncs** - Minimal changes to original code means fewer
   merge conflicts
3. **Automatic string extraction** - No manual cataloging of translatable
   strings
4. **Fallback safety** - English text is always available as the fallback
5. **Rich text support** - Handles styled/nested Text components via `I18nText`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BUILD TIME                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Source Code              ESBuild Plugin           Transformed Code  │
│  ───────────    ────────────────────────────────>  ─────────────────│
│                                                                      │
│  <Text>Hello</Text>       babel-transformer.js     <Text>{t('Hello')}</Text>
│                                    │                                 │
│                                    ▼                                 │
│                           i18n-transform-report.json                 │
│                           (list of all transformed strings)          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      TRANSLATION WORKFLOW                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  i18n-transform-report.json                                          │
│           │                                                          │
│           ▼                                                          │
│  i18n-extract-strings.cjs  ──────>  i18n-pending-translations.json   │
│                                              │                       │
│                                              ▼                       │
│                                     i18n-translate.py (LLM)          │
│                                              │                       │
│                                              ▼                       │
│                                     i18n-completed-translations.json │
│                                              │                       │
│                                              ▼                       │
│  locales/pt.json  <──────────  i18n-merge-translations.cjs           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          RUNTIME                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  t('Hello')  ──────>  i18nManager.translate()  ──────>  "Olá"        │
│                              │                                       │
│                              ▼                                       │
│                       locales/pt.json                                │
│                       { "_exactStrings": { "Hello": "Olá" } }        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
packages/core/src/i18n/
├── index.ts          # Main exports: t(), initI18n(), setLanguage(), etc.
├── loader.ts         # Synchronous translation loader (bundled JSON)
├── types.ts          # TypeScript types for i18n
├── I18nText.tsx      # Component for rich text with nested styling
├── locales/
│   └── pt.json       # Portuguese translations (other languages can be added)
└── README.md         # This file

scripts/
├── i18n-transform/           # Build-time transformation plugin
│   ├── index.js              # ESBuild plugin entry point
│   ├── babel-transformer.js  # AST-based code transformer
│   ├── exclusion-manager.js  # File/pattern exclusions
│   ├── debug-logger.js       # Debug logging utility
│   └── test-transform.mjs    # Test script
├── i18n-extract-strings.cjs  # Extract strings from report
├── i18n-translate.py         # Auto-translate with LLM
├── i18n-merge-translations.cjs # Merge translations into locale
└── i18n-workflow.py          # Unified workflow script
```

## How It Works

### 1. The `t()` Function

The core translation function:

```typescript
import { t } from '@google/gemini-cli-core';

// Basic usage - key is used as English fallback
t('Hello World')  // Returns "Hello World" (en) or "Olá Mundo" (pt)

// With parameters
t('Hello {name}', undefined, { name: 'Alice' })  // "Hello Alice" or "Olá Alice"

// The function signature:
t(key: string, fallback?: string, params?: Record<string, string | number>): string
```

### 2. The `I18nText` Component

For text with nested styling (bold, colors, etc.):

```tsx
import { I18nText } from '@google/gemini-cli-core';

// Original code:
<Text>Press <Text bold>/help</Text> for more info.</Text>

// Transformed to:
<Text>
  <I18nText
    i18nKey="Press <bold>/help</bold> for more info."
    components={{ bold: <Text bold /> }}
  />
</Text>
```

The translation file can contain:

```json
{
  "_exactStrings": {
    "Press <bold>/help</bold> for more info.": "Pressione <bold>/help</bold> para mais informações."
  }
}
```

### 3. Build-Time Transformation

The ESBuild plugin transforms code at build time:

| Pattern                                   | Transformation                                                 |
| ----------------------------------------- | -------------------------------------------------------------- |
| `<Text>Hello</Text>`                      | `<Text>{t('Hello')}</Text>`                                    |
| `<Text>Hello {name}</Text>`               | `<Text>{t('Hello {name}', undefined, { name })}</Text>`        |
| `<Text><Text bold>Hi</Text> there</Text>` | `<Text><I18nText i18nKey="<bold>Hi</bold> there" .../></Text>` |
| `{ title: 'Settings' }`                   | `{ title: t('Settings') }`                                     |
| `{ description: 'Help text' }`            | `{ description: t('Help text') }`                              |

### 4. Locale File Structure

Translations are stored in `_exactStrings` where the key is the original English
text:

```json
{
  "_exactStrings": {
    "Hello": "Olá",
    "Press <bold>/help</bold> for info.": "Pressione <bold>/help</bold> para informações.",
    "Found {count} results": "Encontrados {count} resultados"
  }
}
```

## Usage Guide

### Building with i18n Transformation

```bash
# Enable transformation and generate report
I18N_TRANSFORM=true I18N_REPORT=true npm run bundle

# Or on Windows PowerShell:
$env:I18N_TRANSFORM="true"; $env:I18N_REPORT="true"; npm run bundle
```

This generates:

- `i18n-transform-report.json` - Detailed report of all transformations
- `i18n-transform-report.txt` - Human-readable summary

### Configuration

Create `i18n.config.js` in project root:

```javascript
export default {
  enabled: true, // Enable transformation (default: false)
  debug: false, // Verbose logging (default: false)
  report: true, // Generate reports (default: false)
};
```

Environment variables override config file:

- `I18N_TRANSFORM=true|false`
- `I18N_DEBUG=true|false`
- `I18N_REPORT=true|false`

### Excluding Files/Patterns

Create `.i18n-ignore` in project root:

```gitignore
# Exclude test files (already excluded by default)
**/*.test.ts
**/*.spec.tsx

# Exclude specific directories
**/debug/**
**/internal/**

# Exclude specific files
src/legacy/oldComponent.tsx
```

### Inline Exclusions

Use comments to skip specific lines:

```tsx
// @i18n-ignore
<Text>Debug: internal message</Text>

<Text>This will be translated</Text>  // @i18n-skip
```

## Translation Scripts

### Prerequisites

For automated translation with LLM:

```bash
# Install Python dependencies
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121
pip install huggingface-hub

# Requires: NVIDIA GPU with 16GB+ VRAM for 27B model
# Smaller models available for less VRAM (12B, 4B)
```

### Option 1: Unified Workflow (Recommended)

The `i18n-workflow.py` script runs all steps automatically:

```bash
# Full workflow: build → extract → translate → merge
python scripts/i18n-workflow.py --lang=pt

# Skip build step (use existing report)
python scripts/i18n-workflow.py --lang=pt --skip-build

# Force re-translate all strings (even if already in locale)
python scripts/i18n-workflow.py --lang=pt --force

# Dry run (show what would be done)
python scripts/i18n-workflow.py --dry-run

# Use smaller model (less VRAM required)
python scripts/i18n-workflow.py --lang=pt --model=unsloth/gemma-3-12b-it-GGUF
```

### Option 2: Individual Scripts

Run each step manually for more control:

#### Step 1: Build with Transformation

```bash
I18N_TRANSFORM=true I18N_REPORT=true npm run bundle
```

#### Step 2: Extract Untranslated Strings

```bash
node scripts/i18n-extract-strings.cjs --lang=pt

# Options:
#   --lang=LANG      Target language (default: pt)
#   --output=FILE    Output file (default: i18n-pending-translations.json)
#   --report=FILE    Input report (default: i18n-transform-report.json)
```

Output: `i18n-pending-translations.json` with strings needing translation.

#### Step 3: Translate with LLM

```bash
python scripts/i18n-translate.py --lang=pt

# Options:
#   --lang=LANG, -l        Target language (default: pt)
#   --input=FILE, -i       Input file (default: i18n-pending-translations.json)
#   --output=FILE, -o      Output file (default: i18n-completed-translations.json)
#   --model=REPO, -m       Model to use (default: unsloth/gemma-3-27b-it-GGUF)
#   --batch-size=N, -b     Strings per batch (default: 5)
#   --resume, -r           Resume from checkpoint
#   --force                Re-translate all strings
#   --dry-run              Show what would be translated
#   --n-gpu-layers=N       GPU layers (-1 = all, default: -1)
#   --n-ctx=N              Context size (default: 4096)
#   --verbose, -v          Verbose output
#   --list-models          Show available models
```

Output: `i18n-completed-translations.json` with translations.

#### Step 4: Merge into Locale File

```bash
node scripts/i18n-merge-translations.cjs --locale=pt

# Options:
#   --input=FILE     Input file (default: i18n-completed-translations.json)
#   --locale=LANG    Target locale (default: pt)
#   --backup         Create backup before merge (disabled by default, use git)
#   --dry-run        Show changes without writing
```

### Available Models

| Model                         | VRAM   | Quality | Speed  |
| ----------------------------- | ------ | ------- | ------ |
| `unsloth/gemma-3-27b-it-GGUF` | ~16GB  | Best    | Slower |
| `unsloth/gemma-3-12b-it-GGUF` | ~8GB   | Good    | Medium |
| `unsloth/gemma-3-4b-it-GGUF`  | ~4.5GB | Basic   | Fast   |

Models are downloaded to `models/` directory on first use.

### Translation Validation

The translation scripts validate:

- Parameters preserved (e.g., `{name}` must remain `{name}`)
- No new placeholders introduced
- Length ratio sanity check (0.1x to 5x)

Failed validations trigger single-string retry before marking as failed.

## Adding a New Language

1. **Create locale file**: `packages/core/src/i18n/locales/{lang}.json`

```json
{
  "_exactStrings": {}
}
```

2. **Register in loader.ts**:

```typescript
import frTranslations from './locales/fr.json' with { type: 'json' };

const bundledTranslations: Record<string, TranslationData> = {
  en: { _exactStrings: {} } as TranslationData,
  pt: ptTranslations as TranslationData,
  fr: frTranslations as TranslationData, // Add new language
};
```

3. **Update types.ts**:

```typescript
export type SupportedLanguage = 'en' | 'pt' | 'fr';
```

4. **Add language config** in Python scripts:

```python
LANGUAGE_CONFIG = {
    'pt': { ... },
    'fr': {
        'name': 'French',
        'code': 'fr',
        'form': 'informal "tu"',
        'instructions': 'Use informal "tu" form. Be concise.',
    },
}
```

5. **Run translation workflow**:

```bash
python scripts/i18n-workflow.py --lang=fr
```

## Runtime Language Selection

```typescript
import { setLanguage, getCurrentLanguage } from '@google/gemini-cli-core';

// Get current language
const lang = getCurrentLanguage(); // 'en' | 'pt' | ...

// Change language
await setLanguage('pt');
```

Language is auto-detected from:

1. `AUDITARIA_LANG` environment variable
2. System locale (`LANG`, `LC_ALL`, `LANGUAGE`)
3. Default: `'en'`

## Transformation Patterns

### Simple Text

```tsx
// Before
<Text>Welcome to Auditaria</Text>

// After
<Text>{t('Welcome to Auditaria')}</Text>
```

### Parameterized Text

```tsx
// Before
<Text>Found {count} results</Text>

// After
<Text>{t('Found {count} results', undefined, { count })}</Text>
```

### Nested Styled Text

```tsx
// Before
<Text>Press <Text bold>/help</Text> for info.</Text>

// After
<Text>
  <I18nText
    i18nKey="Press <bold>/help</bold> for info."
    components={{ bold: <Text bold /> }}
  />
</Text>
```

### Ternary Expressions

```tsx
// Before
<Text>{isActive ? 'Active' : 'Inactive'}</Text>

// After
<Text>{isActive ? t('Active') : t('Inactive')}</Text>
```

### Object Properties

```tsx
// Before
const config = {
  title: 'Settings',
  description: 'Configure your preferences',
};

// After
const config = {
  title: t('Settings'),
  description: t('Configure your preferences'),
};
```

Transformed properties: `title`, `label`, `description`, `message`,
`placeholder`, `text`

## Troubleshooting

### Build Issues

**"t is not defined"**

- The transformer adds imports automatically, but ensure
  `@google/gemini-cli-core` is available

**Transformation not working**

- Check `I18N_TRANSFORM=true` is set
- Verify file is not excluded in `.i18n-ignore`
- Check for `// @i18n-ignore` comments

### Translation Issues

**Model not loading**

- Ensure enough VRAM (check with `nvidia-smi`)
- Try smaller model: `--model=unsloth/gemma-3-12b-it-GGUF`

**Validation failures**

- Check placeholders are preserved in translation
- Review failed strings in output file

**Checkpoint recovery**

```bash
python scripts/i18n-translate.py --lang=pt --resume
```

### Runtime Issues

**Translations not showing**

- Verify locale file is properly formatted
- Check language detection: `console.log(getCurrentLanguage())`
- Ensure string exists in `_exactStrings`

## Best Practices

1. **Keep translations simple** - Avoid complex nested structures
2. **Use parameters** - `{count} items` instead of concatenation
3. **Preserve formatting** - Keep `<bold>`, `{param}` unchanged in translations
4. **Test thoroughly** - Run app in target language to verify
5. **Review auto-translations** - LLM translations may need human review
6. **Commit locale files** - Version control your translations
7. **Don't translate**:
   - Slash commands (`/help`, `/settings`)
   - Technical terms (API, CLI, JSON, URL)
   - Brand names (Gemini, Auditaria)

## Contributing

When adding new user-facing strings:

1. Write natural English in source code
2. Build with `I18N_TRANSFORM=true I18N_REPORT=true`
3. Run extraction and translation scripts
4. Review and commit locale file updates
