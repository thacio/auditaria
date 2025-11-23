# Agent Instructions for t() Removal

## Your Role
You are a specialized agent tasked with removing `t()` internationalization function calls from a specific batch of files. You will restore original upstream strings while preserving custom features.

## What You Will Receive
- A list of file paths to process
- Classification of which files are custom vs upstream
- These instructions

## Step-by-Step Workflow

### Step 1: Understand the Context (READ FIRST)

The codebase uses two i18n approaches:
1. **OLD (being removed)**: Manual `t('key', 'fallback')` function calls
2. **NEW (already working)**: Automatic injection via ink component patching

Your job: Remove #1 completely. The new system handles everything automatically.

### Step 2: For Each File - Read and Analyze

```typescript
// Example of what you'll find:
import { t } from '@thacio/auditaria-cli-core';

function MyComponent() {
  return <Text>{t('welcome.message', 'Welcome to Auditaria')}</Text>;
}
```

```typescript
// What it should become:
// (no import line)

function MyComponent() {
  return <Text>Welcome to Auditaria</Text>;
}
```

### Step 3: Classification - Upstream vs Custom Files

#### Upstream Files (Compare with upstream):
- Exist in `google-gemini/gemini-cli` repository
- Need comparison to ensure we match upstream strings
- Process: Fetch upstream version, extract original strings

#### Custom Files (No upstream comparison):
- Don't exist in upstream (our fork additions)
- Process: Just remove t() calls using fallback strings
- List of custom files:
  - `fallbackImprovedCommand.ts`
  - `languageCommand.ts`
  - `setupSkillCommand.ts`
  - `stayProCommand.ts`
  - `webCommand.ts`
  - `useWebCommands.ts`

### Step 4: Processing Upstream Files

For each upstream file:

```bash
# 1. Fetch upstream version to temp file
git show upstream/main:packages/cli/src/ui/commands/helpCommand.ts > /tmp/upstream_helpCommand.ts

# 2. Read both files
# - Current fork version (has t() calls)
# - Upstream version (has original strings)

# 3. Compare and identify differences
# - Most differences will be t() wrapper calls
# - Some might be legitimate custom features (preserve these)
```

**Replacement Rules**:

```typescript
// Pattern 1: Simple string
t('key', 'fallback')
// Becomes:
'fallback'

// Pattern 2: With parameters (no params object)
t('key', 'Hello {name}')
// Check upstream for exact string, use that

// Pattern 3: With parameters (params object used)
t('key', 'Hello {name}', { name: userName })
// Becomes template literal:
`Hello ${userName}`

// Pattern 4: Multi-line
t('key', `Line 1
Line 2
Line 3`)
// Becomes:
`Line 1
Line 2
Line 3`
```

### Step 5: Processing Custom Files

For custom files (no upstream):

```typescript
// Simple approach - use fallback string
t('custom.feature', 'This is a custom feature')
// Becomes:
'This is a custom feature'

// With params:
t('custom.feature', 'User: {name}', { name: user })
// Becomes:
`User: ${user}`
```

### Step 6: Remove Import Statement

Remove this line from EVERY file:
```typescript
import { t } from '@thacio/auditaria-cli-core';
```

If there are other imports from the same package, keep them:
```typescript
// Before:
import { Config, t } from '@thacio/auditaria-cli-core';

// After:
import { Config } from '@thacio/auditaria-cli-core';
```

### Step 7: Preserve Important Code

**DO NOT CHANGE** these elements:

1. **Package Names**:
   ```typescript
   // KEEP AS IS - don't change to @google/gemini-cli
   import { Config } from '@thacio/auditaria-cli-core';
   ```

2. **WEB_INTERFACE Markers**:
   ```typescript
   // WEB_INTERFACE_START: Description
   // ... custom code ...
   // WEB_INTERFACE_END
   ```

3. **Custom Feature Logic**:
   - Retry strategies
   - Web interface code
   - Language selection
   - Context management
   - Any code not in upstream

### Step 8: Verification Checklist

Before considering a file complete:

- [ ] Read ENTIRE file to understand context
- [ ] For upstream files: Compare with `git show upstream/main:[path]`
- [ ] Remove ALL `t()` function calls
- [ ] Remove `import { t }` (or just `t` from multi-import)
- [ ] Verify no syntax errors (check brackets, quotes, commas)
- [ ] Ensure strings match upstream (for upstream files)
- [ ] Preserve all WEB_INTERFACE markers
- [ ] Preserve all custom feature code
- [ ] Use Edit tool for changes (not Write, to preserve formatting)

### Step 9: Example Transformations

#### Example 1: Simple Command File

**Before** (packages/cli/src/ui/commands/quitCommand.ts):
```typescript
import { t } from '@thacio/auditaria-cli-core';

export function quitCommand() {
  return {
    name: 'quit',
    description: t('commands.quit.desc', 'Exit the application'),
    execute: () => {
      console.log(t('commands.quit.goodbye', 'Goodbye!'));
      process.exit(0);
    }
  };
}
```

**After**:
```typescript
export function quitCommand() {
  return {
    name: 'quit',
    description: 'Exit the application',
    execute: () => {
      console.log('Goodbye!');
      process.exit(0);
    }
  };
}
```

#### Example 2: Component with Parameters

**Before**:
```typescript
import { t } from '@thacio/auditaria-cli-core';

function UserGreeting({ name }: { name: string }) {
  return <Text>{t('user.greeting', 'Hello, {name}!', { name })}</Text>;
}
```

**After**:
```typescript
function UserGreeting({ name }: { name: string }) {
  return <Text>{`Hello, ${name}!`}</Text>;
}
```

#### Example 3: Multi-import Statement

**Before**:
```typescript
import { Config, Settings, t } from '@thacio/auditaria-cli-core';

const message = t('app.ready', 'Application ready');
```

**After**:
```typescript
import { Config, Settings } from '@thacio/auditaria-cli-core';

const message = 'Application ready';
```

### Step 10: Reporting

After processing your batch, report:

1. **Summary**:
   - Total files processed: X
   - Upstream files: X
   - Custom files: X
   - Total t() calls removed: X
   - Import lines removed: X

2. **Issues Found** (if any):
   - Files with syntax errors
   - Files where upstream comparison failed
   - Files with ambiguous replacements

3. **Verification**:
   ```bash
   # Show that no t() remains in your batch
   grep "\\bt(" [list of files] || echo "✓ No t() calls found"

   # Show that no import { t } remains
   grep "import.*\\bt\\b.*from '@thacio/auditaria-cli-core'" [list of files] || echo "✓ No t imports found"
   ```

## Common Pitfalls to Avoid

❌ **DON'T**:
- Change package names to @google/gemini-cli
- Remove WEB_INTERFACE markers
- Change custom feature logic
- Use Write tool (loses formatting) - use Edit instead
- Skip reading the full file
- Skip comparing with upstream
- Introduce syntax errors

✅ **DO**:
- Read ENTIRE file before making changes
- Compare with upstream for non-custom files
- Use Edit tool for surgical changes
- Preserve exact formatting and indentation
- Double-check string replacements
- Test that file has no syntax errors
- Report any uncertainties

## Tools You Should Use

1. **Bash**: For git commands to fetch upstream versions
2. **Read**: To read full current and upstream files
3. **Edit**: To make precise replacements (NOT Write)
4. **Grep**: To search for patterns and verify completion

## Success Criteria

Your batch is complete when:
- ✅ Every file has been processed
- ✅ No `import { t }` statements remain in your batch
- ✅ No `t()` function calls remain in your batch
- ✅ All files are syntactically valid TypeScript/TSX
- ✅ Upstream files match upstream strings (verified by comparison)
- ✅ Custom files use fallback strings
- ✅ No custom feature code was accidentally modified
- ✅ You provided a completion report with statistics

## Questions?

If you encounter:
- **Ambiguous string replacement**: Report it, don't guess
- **Upstream file not found**: It might be custom, report it
- **Complex t() usage**: Show the example, ask for guidance
- **Syntax errors after changes**: Revert and report the issue

Your goal is accuracy and preservation of functionality, not speed.
