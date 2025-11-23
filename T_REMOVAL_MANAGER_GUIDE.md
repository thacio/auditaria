# t() Removal - Manager Guide

## Your Role as Manager

You are orchestrating the removal of all `t()` internationalization function calls from 81 files across the Auditaria CLI codebase. Your job is to:

1. **Assign batches to agents** with clear instructions
2. **Review agent work** for correctness
3. **Run verification** after each batch
4. **Coordinate fixes** if issues arise
5. **Track progress** in T_REMOVAL_STATUS.md
6. **Ensure quality** throughout the process

## Management Workflow

### Phase 1: Batch Assignment

For each batch (1-6):

1. **Spawn Agent**:
   ```
   Create Task agent with:
   - Batch file list (from batch_N_*.txt)
   - AGENT_INSTRUCTIONS.md reference
   - Clear success criteria
   ```

2. **Agent Prompt Template**:
   ```
   Your task is to remove all t() internationalization function calls from Batch N.

   **Files to Process**: Read batch_N_*.txt for the complete list

   **Instructions**: Read AGENT_INSTRUCTIONS.md for the detailed workflow

   **Key Requirements**:
   - Read FULL file before making changes
   - For upstream files: Compare with upstream/main to get original strings
   - For custom files: Use fallback strings from t() calls
   - Remove all t() function calls
   - Remove import { t } statements
   - Use Edit tool (not Write) to preserve formatting
   - Verify no syntax errors introduced

   **Upstream vs Custom**:
   - Upstream files: Fetch original with `git show upstream/main:[path]`
   - Custom files: Listed in batch file, no upstream comparison needed

   **Report Format**:
   After completion, provide:
   - Total files processed
   - Total t() calls removed
   - Total import lines modified
   - Any issues encountered
   - Verification that no t() remains in batch

   Begin with the first file in your batch.
   ```

### Phase 2: Agent Monitoring

While agent works:

1. **Watch for questions**: Answer uncertainties promptly
2. **Check progress**: Ensure agent follows instructions
3. **Spot-check work**: Randomly verify a few files
4. **Note issues**: Track any problems for documentation

### Phase 3: Batch Verification

After agent completes batch:

1. **Run Verification Script**:
   ```bash
   # Check the specific batch files
   grep "import.*\bt\b.*from '@thacio/auditaria-cli-core'" [batch files] || echo "✓ No imports"
   grep "\bt(" [batch files] | grep -v "//" || echo "✓ No calls"
   ```

2. **TypeScript Check**:
   ```bash
   npm run typecheck
   ```

3. **Review Changes**:
   ```bash
   git diff packages/cli/src/ui/commands/  # for batch 1
   git diff packages/cli/src/ui/components/ # for batches 2-4
   # etc.
   ```

4. **Verify Quality**:
   - ✅ No t() imports remain
   - ✅ No t() calls remain
   - ✅ Strings match upstream (for upstream files)
   - ✅ No syntax errors introduced
   - ✅ Custom code preserved (WEB_INTERFACE markers, etc.)
   - ✅ Package names still @thacio/auditaria-cli-core

### Phase 4: Issue Resolution

If verification fails:

1. **Identify Issues**:
   - Remaining t() calls?
   - Syntax errors?
   - Wrong strings?
   - Custom code accidentally modified?

2. **Fix Strategy**:
   - Minor issues: Fix yourself
   - Major issues: Respawn agent with specific fix instructions
   - Systematic issues: Update AGENT_INSTRUCTIONS.md and restart batch

3. **Re-verify**: Run verification again after fixes

### Phase 5: Progress Tracking

After each batch completion:

1. **Update T_REMOVAL_STATUS.md**:
   - Mark batch as ✅ Completed
   - Update file checkboxes
   - Update overall progress percentage
   - Note any issues encountered

2. **Commit Changes** (optional, but recommended):
   ```bash
   git add packages/cli/src/ui/commands/  # or relevant directory
   git commit -m "Remove t() calls from Batch N: [batch name]"
   ```

## Batch Order and Dependencies

Process batches in order 1→6:

1. **Batch 1** (Commands): Independent, safe to start
2. **Batch 2** (Components 1): Depends on no shared utilities changed
3. **Batch 3** (Components 2): Independent of batches 1-2
4. **Batch 4** (Components 3): Independent of batches 1-3
5. **Batch 5** (Hooks/Utils): May affect batches 1-4, but changes are minimal
6. **Batch 6** (Remaining): Independent

**Recommendation**: Process sequentially and verify after each batch to catch issues early.

## Quality Checkpoints

### After Each Batch:
- [ ] All files in batch processed
- [ ] No t() imports remain in batch
- [ ] No t() calls remain in batch
- [ ] TypeScript compiles without errors
- [ ] Git diff shows only i18n removal (no logic changes)
- [ ] T_REMOVAL_STATUS.md updated

### After All Batches:
- [ ] Run full verification: `node verify_t_removal.js`
- [ ] TypeScript: `npm run typecheck`
- [ ] Lint: `npm run lint`
- [ ] Build: `npm run build`
- [ ] Test application: `npm start`
- [ ] Verify i18n injection still works with DEBUG_I18N=true

## Common Issues and Solutions

### Issue: Agent changes package names to @google/gemini-cli
**Solution**: Reject changes, remind agent to keep @thacio/auditaria-cli-core

### Issue: Agent removes WEB_INTERFACE markers
**Solution**: Reject changes, restore markers, remind agent to preserve them

### Issue: Agent uses Write instead of Edit
**Solution**: Formatting may be lost, review carefully or ask agent to redo with Edit

### Issue: Upstream file doesn't exist
**Solution**: It's probably a custom file, treat as custom (no upstream comparison)

### Issue: Agent can't determine correct string replacement
**Solution**: Provide guidance by checking upstream yourself:
```bash
git show upstream/main:packages/cli/src/[path] | grep -A 5 -B 5 "search term"
```

### Issue: TypeScript errors after batch
**Solution**:
1. Check error messages
2. Usually missing imports or wrong string syntax
3. Fix manually or respawn agent with specific fix task

## Emergency Procedures

### Batch Goes Wrong
```bash
# Reset batch directory
git checkout packages/cli/src/[batch-directory]/

# Restart batch with updated instructions
```

### Build Completely Broken
```bash
# Reset everything
git checkout packages/cli/src/

# Start over with lessons learned
# Update AGENT_INSTRUCTIONS.md with new guidelines
```

## Success Metrics

You'll know the project is complete when:

1. ✅ All 81 files processed (T_REMOVAL_STATUS.md shows 100%)
2. ✅ `grep -r "import.*\bt\b.*from '@thacio/auditaria-cli-core'" packages/cli/src` returns nothing
3. ✅ `npm run typecheck` succeeds
4. ✅ `npm run build` succeeds
5. ✅ `npm start` launches application
6. ✅ Application shows Portuguese translations (with AUDITARIA_LANGUAGE=pt)
7. ✅ No t() calls remain in codebase
8. ✅ All custom features still work

## Time Estimates

- **Batch 1**: ~30-45 minutes (commands are straightforward)
- **Batch 2**: ~45-60 minutes (components have more complex JSX)
- **Batch 3**: ~45-60 minutes (message components)
- **Batch 4**: ~45-60 minutes (remaining components)
- **Batch 5**: ~30-45 minutes (hooks and utils)
- **Batch 6**: ~45-60 minutes (mixed files)
- **Verification**: ~15 minutes per batch
- **Final build & test**: ~20 minutes

**Total Estimated Time**: 5-7 hours with agent assistance

## Ready to Start?

1. ✅ Read this guide completely
2. ✅ Review AGENT_INSTRUCTIONS.md
3. ✅ Check T_REMOVAL_PLAN.md
4. ✅ Verify git status is clean
5. ✅ Spawn first agent for Batch 1

**First Agent Prompt**: See "Agent Prompt Template" in Phase 1 above.

Good luck! 🚀
