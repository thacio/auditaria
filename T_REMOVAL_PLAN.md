# t() Function Removal Plan

## Objective
Remove all `t()` function calls from the codebase and restore original upstream strings to eliminate i18n-related merge conflicts. The i18n injection system will handle translations automatically without manual `t()` calls.

## Strategy
1. **Batch Processing**: Split 81 files into 6 batches (~13-14 files each)
2. **Upstream Comparison**: For each file, fetch upstream version and restore original strings
3. **Automated Agents**: Use specialized agents to process each batch
4. **Verification**: Build and test after each batch

## File Batches

### Batch 1: Commands Files (14 files)
**Focus**: Slash command implementations

```
packages/cli/src/ui/commands/authCommand.ts
packages/cli/src/ui/commands/compressCommand.ts
packages/cli/src/ui/commands/corgiCommand.ts
packages/cli/src/ui/commands/docsCommand.ts
packages/cli/src/ui/commands/editorCommand.ts
packages/cli/src/ui/commands/fallbackImprovedCommand.ts
packages/cli/src/ui/commands/helpCommand.ts
packages/cli/src/ui/commands/initCommand.test.ts
packages/cli/src/ui/commands/initCommand.ts
packages/cli/src/ui/commands/languageCommand.ts
packages/cli/src/ui/commands/modelCommand.ts
packages/cli/src/ui/commands/permissionsCommand.ts
packages/cli/src/ui/commands/privacyCommand.ts
packages/cli/src/ui/commands/profileCommand.ts
```

**Custom Commands (Skip Upstream Comparison)**:
- `fallbackImprovedCommand.ts` - Custom feature
- `languageCommand.ts` - Custom feature

### Batch 2: Component Files Part 1 (14 files)
**Focus**: UI components (A-L alphabetically)

```
packages/cli/src/ui/components/AboutBox.tsx
packages/cli/src/ui/components/AutoAcceptIndicator.tsx
packages/cli/src/ui/components/ConsentPrompt.tsx
packages/cli/src/ui/components/ConsoleSummaryDisplay.tsx
packages/cli/src/ui/components/ContextSummaryDisplay.tsx
packages/cli/src/ui/components/DebugProfiler.tsx
packages/cli/src/ui/components/DetailedMessagesDisplay.tsx
packages/cli/src/ui/components/DialogManager.tsx
packages/cli/src/ui/components/ExitWarning.tsx
packages/cli/src/ui/components/FolderTrustDialog.tsx
packages/cli/src/ui/components/Help.tsx
packages/cli/src/ui/components/IdeTrustChangeDialog.tsx
packages/cli/src/ui/components/LoadingIndicator.tsx
packages/cli/src/ui/components/LoopDetectionConfirmation.tsx
```

### Batch 3: Component Files Part 2 (14 files)
**Focus**: Message components and more UI components (M-S)

```
packages/cli/src/ui/components/messages/DiffRenderer.tsx
packages/cli/src/ui/components/messages/ModelMessage.tsx
packages/cli/src/ui/components/messages/ToolGroupMessage.tsx
packages/cli/src/ui/components/messages/ToolMessage.tsx
packages/cli/src/ui/components/ModelStatsDisplay.tsx
packages/cli/src/ui/components/PermissionsModifyTrustDialog.tsx
packages/cli/src/ui/components/ProQuotaDialog.tsx
packages/cli/src/ui/components/QueuedMessageDisplay.tsx
packages/cli/src/ui/components/RawMarkdownIndicator.tsx
packages/cli/src/ui/components/SessionSummaryDisplay.tsx
packages/cli/src/ui/components/shared/MaxSizedBox.tsx
packages/cli/src/ui/components/shared/ScopeSelector.tsx
packages/cli/src/ui/components/ShellModeIndicator.tsx
packages/cli/src/ui/components/ShowMoreLines.tsx
```

### Batch 4: Component Files Part 3 (13 files)
**Focus**: Remaining UI components and views

```
packages/cli/src/ui/components/StatsDisplay.tsx
packages/cli/src/ui/components/SuggestionsDisplay.tsx
packages/cli/src/ui/components/ThemeDialog.tsx
packages/cli/src/ui/components/Tips.tsx
packages/cli/src/ui/components/ToolStatsDisplay.tsx
packages/cli/src/ui/components/views/ChatList.tsx
packages/cli/src/ui/privacy/CloudFreePrivacyNotice.tsx
packages/cli/src/ui/privacy/CloudPaidPrivacyNotice.tsx
packages/cli/src/ui/privacy/GeminiPrivacyNotice.tsx
packages/cli/src/ui/IdeIntegrationNudge.tsx
packages/cli/src/ui/constants.ts
packages/cli/src/ui/textConstants.ts
packages/cli/src/utils/dialogScopeUtils.ts
```

### Batch 5: Hooks and Utils (13 files)
**Focus**: Custom hooks and utility functions

```
packages/cli/src/ui/hooks/useMemoryMonitor.ts
packages/cli/src/ui/hooks/usePrivacySettings.ts
packages/cli/src/ui/hooks/useThemeCommand.ts
packages/cli/src/ui/hooks/useWebCommands.ts
packages/cli/src/ui/utils/commandUtils.ts
packages/cli/src/utils/handleAutoUpdate.ts
packages/cli/src/utils/readStdin.ts
packages/cli/src/utils/relaunch.ts
packages/cli/src/utils/startupWarnings.ts
packages/cli/src/utils/userStartupWarnings.ts
packages/cli/src/ui/commands/quitCommand.ts
packages/cli/src/ui/commands/settingsCommand.ts
packages/cli/src/ui/commands/setupSkillCommand.ts
```

**Custom Commands (Skip Upstream Comparison)**:
- `setupSkillCommand.ts` - Custom feature

### Batch 6: Remaining Files (13 files)
**Focus**: Top-level commands, extensions, MCP

```
packages/cli/src/ui/commands/statsCommand.ts
packages/cli/src/ui/commands/stayProCommand.ts
packages/cli/src/ui/commands/terminalSetupCommand.ts
packages/cli/src/ui/commands/themeCommand.ts
packages/cli/src/ui/commands/toolsCommand.ts
packages/cli/src/ui/commands/vimCommand.ts
packages/cli/src/ui/commands/webCommand.ts
packages/cli/src/commands/extensions.tsx
packages/cli/src/commands/mcp.ts
packages/cli/src/commands/mcp/remove.ts
packages/cli/src/ui/auth/ApiAuthDialog.tsx
packages/cli/src/ui/auth/AuthDialog.tsx
packages/cli/src/ui/auth/AuthInProgress.tsx
```

**Custom Commands (Skip Upstream Comparison)**:
- `stayProCommand.ts` - Custom feature
- `webCommand.ts` - Custom feature

## Agent Instructions Template

### For Each Batch:

1. **Pre-Processing**:
   - Read the batch file list
   - Identify custom vs upstream files

2. **For Each Upstream File**:
   ```bash
   # Fetch upstream version
   git show upstream/main:packages/cli/src/[path] > temp_upstream_[filename]

   # Compare with current version
   diff temp_upstream_[filename] packages/cli/src/[path]
   ```

3. **Restoration Process**:
   - Read FULL current file
   - Read FULL upstream file
   - Identify all `t()` function calls
   - Replace `t('key', 'Original String')` with `'Original String'`
   - Remove `import { t } from '@thacio/auditaria-cli-core';` line
   - Preserve WEB_INTERFACE markers and custom code sections
   - Keep package name as `@thacio/auditaria-cli-core` (not `@google/gemini-cli`)

4. **For Custom Files** (no upstream):
   - Read FULL file
   - Replace all `t('key', 'fallback')` with just `'fallback'`
   - Remove import line
   - Keep all custom logic intact

5. **Verification**:
   - Ensure no `t()` calls remain
   - Ensure no `import { t }` remains
   - Ensure file still compiles (no syntax errors)

## Critical Rules

### DO NOT CHANGE:
- Package names (`@thacio/auditaria-cli-core` stays as is)
- WEB_INTERFACE markers and code
- Custom feature implementations
- File structure or logic

### ONLY CHANGE:
- Remove `import { t } from '@thacio/auditaria-cli-core';`
- Replace `t('key', 'fallback')` with `'fallback'`
- Replace `t('key', 'fallback', params)` with template literals using params

### FILES TO SKIP UPSTREAM COMPARISON:
These files are custom features and don't exist in upstream:
- `fallbackImprovedCommand.ts`
- `languageCommand.ts`
- `setupSkillCommand.ts`
- `stayProCommand.ts`
- `webCommand.ts`
- `useWebCommands.ts`

For these files, just remove t() calls and imports without comparing to upstream.

## Quality Checks

After each batch:
1. ✅ All files in batch processed
2. ✅ No `import { t }` lines remain
3. ✅ No `t()` function calls remain
4. ✅ TypeScript compilation succeeds
5. ✅ Git diff shows only i18n removal (no logic changes)

## Post-Processing

After all batches:
1. Run full build: `npm run build`
2. Check for any remaining t() imports: `grep -r "import { t }" packages/`
3. Check for any remaining t() calls: `grep -r "\\bt(" packages/`
4. Test application: `npm start`

## Progress Tracking

- [ ] Batch 1: Commands Files (14 files)
- [ ] Batch 2: Component Files Part 1 (14 files)
- [ ] Batch 3: Component Files Part 2 (14 files)
- [ ] Batch 4: Component Files Part 3 (13 files)
- [ ] Batch 5: Hooks and Utils (13 files)
- [ ] Batch 6: Remaining Files (13 files)
- [ ] Final Build Verification
- [ ] Application Testing

## Notes

- The i18n injection system will automatically translate strings via ink component patching
- No manual t() calls are needed anymore
- This removes the main source of merge conflicts with upstream
- Custom features remain intact, only i18n calls are removed
