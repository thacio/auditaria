# t() Removal - Quick Start

## What We're Doing
Removing all 81 instances of `import { t } from '@thacio/auditaria-cli-core'` and their associated `t()` function calls. The i18n injection system will handle translations automatically.

## Files Created
1. **T_REMOVAL_PLAN.md** - Overall strategy and batch definitions
2. **AGENT_INSTRUCTIONS.md** - Detailed workflow for agents
3. **T_REMOVAL_MANAGER_GUIDE.md** - Guide for managing the process
4. **T_REMOVAL_STATUS.md** - Progress tracking
5. **batch_1_commands.txt** through **batch_6_remaining.txt** - File lists for each batch
6. **verify_t_removal.js** - Verification script

## Quick Batch Launch

### Batch 1 - Commands (14 files)
```bash
# Files in: packages/cli/src/ui/commands/
# Custom files: fallbackImprovedCommand.ts, languageCommand.ts
# Ready to process
```

### How to Launch an Agent

Use the Task tool with this prompt template:

```
Your task is to remove all t() internationalization function calls from Batch 1.

**Files to Process**: Read batch_1_commands.txt for the complete list (14 files)

**Instructions**: Read AGENT_INSTRUCTIONS.md in full for the detailed workflow

**Key Requirements**:
1. Read FULL file before making changes
2. For upstream files: Fetch original with `git show upstream/main:[path]`
3. For custom files (fallbackImprovedCommand.ts, languageCommand.ts): Use fallback strings
4. Remove all t() function calls, replacing with proper strings
5. Remove import { t } statements
6. Use Edit tool (not Write) to preserve formatting
7. Verify no syntax errors introduced

**Process**:
- For each file, read it completely
- Check if it's upstream or custom (see batch_1_commands.txt)
- If upstream: Compare with upstream to get original strings
- If custom: Extract fallback strings from t() calls
- Make surgical edits to remove t() calls
- Remove import line
- Verify syntax

**Report Format**:
After completion, provide:
- Total files processed: X/14
- Total t() calls removed: X
- Total import lines modified: X
- Any issues encountered
- Verification: No t() remains in processed files

Begin with the first file: packages/cli/src/ui/commands/authCommand.ts
```

## Verification After Each Batch

```bash
# Run verification script
node verify_t_removal.js

# Manual checks
grep "import.*\bt\b.*from '@thacio/auditaria-cli-core'" packages/cli/src/ui/commands/*.ts
npm run typecheck
```

## Process Flow

1. **Launch Agent** for Batch 1
2. **Monitor Progress** - answer agent questions
3. **Verify Completion** - run checks
4. **Fix Issues** if any
5. **Update Status** - mark batch complete in T_REMOVAL_STATUS.md
6. **Repeat** for Batches 2-6
7. **Final Build** - npm run build && npm start

## Current Status

- ✅ Management scripts created
- ✅ Batch definitions ready
- ✅ Agent instructions prepared
- ⏳ Ready to process Batch 1

## Next Step

Launch agent for Batch 1 using the prompt template above.
