# Auditaria CLI - Fork Information

**EXTREMELY IMPORTANT AND UNFORGETTABLE**: NEVER co-author! It's bad and it's
bragging, people already know you co-author.

## Overview

This is a fork of the upstream `google-gemini/gemini-cli` repository with custom
features and modifications.

**Repository**: https://github.com/thacio/auditaria.git
**Upstream**: https://github.com/google-gemini/gemini-cli.git
**Package Name**: `@thacio/auditaria-cli`
**Binary Name**: `auditaria`

## Package Renaming

**IMPORTANT**: This fork has renamed all packages from the upstream to avoid
conflicts and establish proper fork identity:

### Package Name Changes

- `@google/gemini-cli` → `@thacio/auditaria-cli`
- `@google/gemini-cli-core` stays the same, to reduce merge conflicts

### Key Areas Affected

- **Binary references**: Command name changed from `gemini` to `auditaria`

### Sync Considerations

## User's instructions for syncing with upstream

**CRITICAL**: These are the user's exact instructions when syncing with
upstream. Follow them precisely.

Your task is to get this repository synced with the upstream using a controlled
merge strategy that maintains proper Git history. This avoids the cherry-pick
approach that changes commit hashes and makes GitHub think we're still behind
upstream.

## User Observations

- Be extra careful, look at each new commit individually before continuing.
- Correct any conflicts maintaining both upstream's intended features AND our
  custom features.
- See "Development Notes" section for coding principles (KISS, DRY, YAGNI,
  minimal invasion).

## Sync Process Steps

### 1. Preparation

```bash
# Ensure you're on main branch and it's clean
git checkout main
git reset --hard origin/main
git status  # Should be clean

# Fetch latest upstream changes
git fetch upstream

# Check commits in chronological order (oldest first)
git log --reverse --oneline upstream/main ^main
```

### 2. Quick Safety Check + Fast Merge

**Recommended: Use the sync script** (auto-merges until conflict):

```bash
# Sync all pending commits:
  ./scripts/sync-upstream.sh

# Sync first N commits (e.g., 10):
./scripts/sync-upstream.sh 10

# Check safety only (no merge):
./scripts/sync-upstream.sh -c

# List pending commits:
./scripts/sync-upstream.sh -l

# Show help:
./scripts/sync-upstream.sh --help
```

The script auto-merges commits one by one and **STOPS** when:
1. A commit would DELETE/RENAME files we modified (stops BEFORE that commit)
2. A merge conflict occurs (stops for manual resolution)
3. All commits merged successfully (done!)

After resolving, run again to continue from where it stopped. If the user asks for you to sync a X amount of commits, you should 
decreasing the number of automatic syncs after resolving conflicts.
For example, user asked to sync 30 commits. You ran `./scripts/sync-upstream.sh 30`, it auto synced 8 commits, and had a conflict in the 9th. You resolved the 9th and commited it. Thus, there are still 21 commits to go, so you will try to auto-sync the remaining 21 with `./scripts/sync-upstream.sh 21`.

**How the script works internally:**

1. **Validates environment**: Checks you're on `main` branch with clean working
   directory
2. **Fetches upstream**: `git fetch upstream`
3. **Identifies our modified files**: `git diff base..HEAD --name-only`
4. **Auto-merge loop**: For each commit in chronological order:
   - **BEFORE merging**: Checks if this commit deletes/renames any of our files
   - If dangerous: STOPS before merging, shows affected files
   - If safe: Runs `git merge <commit>` (preserves original commit hash)
   - If conflict: Stops and provides resolution instructions
5. **On completion**: Shows summary and next steps (verify build, push)

**Script options:**

| Option | Description |
|--------|-------------|
| `N` | Sync only first N commits (e.g., `./scripts/sync-upstream.sh 10`) |
| `-c, --check` | Scan for dangerous commits (lists which ones, no merge) |
| `-l, --list` | List pending commits in chronological order |
| `-h, --help` | Show help message |

**What happens in different scenarios:**

- **No pending commits**: Script exits with "Already up to date"
- **Dangerous commit detected**: Stops BEFORE that commit, shows files affected
- **Merge conflict**: Stops, shows conflict details, instructions to resolve
- **All merges succeed**: Shows success message and next steps

**When script stops for DANGEROUS COMMIT:**

1. **Examine the commit**: `git show <commit-hash>` to understand what upstream
   did
2. **Evaluate the impact**:
   - Is our feature still needed, or did upstream obsolete it?
   - Can our modifications be migrated to a different file?
   - Is upstream's deletion legitimate for our use case?
3. **Decide action**:
   - **If feature obsolete**: Let upstream's change proceed, remove our code
   - **If feature still needed**: Merge and recreate/relocate our code
   - **If uncertain**: Consult user before proceeding
4. **Apply the commit**: `git merge <commit-hash>`
5. **Resolve and preserve**: Keep our features functioning
6. **Complete merge**: `git add . && git commit -m "Merge Commit '<hash>': <title>"`
7. **Continue**: Run script again to process remaining commits

**Manual approach** (if needed):

First, check if any file we modified was deleted or renamed by upstream (silent
feature loss):

```bash
# Check ALL commits:
BASE=$(git merge-base HEAD upstream/main) || { echo "ERROR: merge-base failed"; exit 1; }; \
comm -12 <(git diff $BASE..HEAD --name-only | sort) \
         <(git diff $BASE..upstream/main --diff-filter=DR --name-only | sort)

# Check only first N commits (e.g., N=8):
N=8; BASE=$(git merge-base HEAD upstream/main) || { echo "ERROR"; exit 1; }; \
TARGET=$(git log --reverse --format=%H upstream/main ^main | head -n $N | tail -1); \
comm -12 <(git diff $BASE..HEAD --name-only | sort) \
         <(git diff $BASE..$TARGET --diff-filter=DR --name-only | sort)
```

Note: `--diff-filter=DR` catches both **D**eletions and **R**enames.

**If output is empty** → Safe to proceed with Commit-by-Commit Strategy (Section
3).

**If output shows files** → Those files contain our features but upstream
deleted/renamed them. Use Commit-by-Commit Strategy (Section 3) to find and
handle the specific commits that delete/rename those files.

### 3. Commit-by-Commit Strategy

Use this for manual syncing, or when the safety check found dangerous deletions.

```bash
# List commits in chronological order (oldest first) - ALWAYS apply in this order
git log --reverse --oneline upstream/main ^main

# For each commit:
git show <commit-hash>              # ALWAYS examine first
git merge <commit-hash>             # Apply (fast-forwards, preserves original commit)
# If conflicts, resolve them, then: git add . && git commit
```

### 4. Conflict Resolution

After running the merge command, Git will stop before committing if there are
conflicts. Now you must:

1. **Check merge status**: `git status` to see all changed files
2. **Resolve conflicts**: Handle any merge conflicts carefully
   - **package-lock.json conflicts**: Always resolve by regenerating the file
     automatically:
     ```bash
     # Accept upstream version and regenerate
     git checkout --theirs package-lock.json
     npm install  # This regenerates package-lock.json with current dependencies
     git add package-lock.json
     ```
   - **Web Interface conflicts**: Look for `WEB_INTERFACE_START` and
     `WEB_INTERFACE_END` markers
     - Preserve all code between these markers
     - If upstream modifies the same area, integrate changes carefully
     - New files marked with `WEB_INTERFACE_FEATURE` header should be kept
       entirely
  - **Custom Features conflicts**: When a file contains our custom features
    (marked with `// AUDITARIA:` or `// WEB_INTERFACE:` comments, or unmarked
    features you identify), preserve our features while integrating upstream
    changes.
3. **Review the entire commit diff**: **MANDATORY** - Use
   `git show <commit-hash>` to see ALL changes in the commit
4. **Determine relevance**: See "Decision Rules for Skipping Commits" in
   Section 6 - almost all commits should be applied
5. **Update package imports**: Change `@google/gemini-cli` imports to
   `@thacio/auditaria-cli` on package.json
6. **Update branding**: Change "Gemini CLI" to "Auditaria CLI" in user-facing
   strings and documentation
   - **README.md changes**: If upstream modifies README.md, read both our
     complete README and theirs to properly merge changes while maintaining our
     branding and features
7. **Test critical features**: Ensure our custom features still work

**NOTE**: i18n is handled automatically at build time - no manual string
extraction needed. See "Internationalization (i18n)" section below.

### 5. Complete the Merge

**Commit message format differs based on merge type:**

```bash
# AUTO-MERGED (no conflicts) - handled by sync script automatically:
# Format: Merge(Auto) Commit '<hash>': <title>
git commit -m "Merge(Auto) Commit '<7-char-hash>': <COMMIT_TITLE_WITHOUT_PR_REF>"

# MANUAL MERGE (had conflicts) - use this format when resolving conflicts:
# Format: Merge Commit '<hash>': <title>
git add .
git commit -m "Merge Commit '<7-char-hash>': <COMMIT_TITLE_WITHOUT_PR_REF>"

# Example: upstream title "Add settings config (#3498)" becomes:
git commit -m "Merge Commit '04eb3f2': Add settings config"
# CRITICAL: Strip PR references like (#1234) from the title to avoid GitHub back-linking
# GitHub auto-links PR refs, exposing your fork activity on upstream's PR pages
```

**Why differentiate?** The "Merge(Auto)" vs "Merge" prefix helps identify:
- `Merge(Auto)` - No conflicts, merged cleanly by script
- `Merge` - Required manual conflict resolution

This is useful for code review and debugging merge issues.

**IMPORTANT COMMIT RULES:**

- **Strip PR references**: Remove `(#1234)` patterns from titles to prevent
  GitHub back-linking to upstream PRs (e.g., "feat: add X (#1234)" → "feat: add X")
- **Auto vs Manual**: Script uses "Merge(Auto)"; manual merges use "Merge"
- **No co-authored lines**: Do not add "Co-Authored-By: Claude" or similar lines
- **No additional details**: Keep commit message clean and simple for
  maintainability

### 6. Verify Build

```bash
# npm install only if package.json changed, else use `npm run build`
npm install && npm run build
```

Optionally run `npm run lint && npm run typecheck` for full verification.

**Key Rules:**

- Preserve both upstream functionality AND our custom features in conflicts
- If upstream bumps version, bump our version too (stay synced)
- Apply commits in chronological order (preserves 1-1 history)
- See "Development Notes" for coding principles

**Decision Rules for Skipping Commits:**

- **RULE OF THUMB**: Never skip commits just because they seem irrelevant. Our
  fork mirrors upstream, except for our features and branding. Assume all
  commits are relevant unless they meet skip criteria below.
- **GitHub Actions**: Mirror upstream (may need adaptation for our repo)
- **Release-only commits**: Skip ONLY if the commit contains NOTHING but version
  bumps in package.json (no code, tests, docs, or config changes)

## Custom Features (DO NOT REMOVE)

### 1. Internationalization (i18n) - Build-Time Transformation

- **Approach**: Automatic build-time transformation - NO manual `t()` wrapping
  needed in source code
- **How it works**: ESBuild plugin transforms `<Text>Hello</Text>` →
  `<Text>{t('Hello')}</Text>` at build time
- **Location**:
  - Runtime: `packages/core/src/i18n/`
  - Build plugin: `scripts/i18n-transform/`
  - Translation scripts: `scripts/i18n-*.py`, `scripts/i18n-*.cjs`
- **Translation files**: `packages/core/src/i18n/locales/pt.json` (English is
  the source, used as fallback)
- **Documentation**: See `packages/core/src/i18n/README.md` for full details
- **Build with i18n**: `I18N_TRANSFORM=true I18N_REPORT=true npm run bundle`
- **Translation workflow**: `python scripts/i18n-workflow.py --lang=pt`
- **Language components**:
  - `packages/cli/src/ui/components/LanguageSelectionDialog.tsx`
  - `packages/cli/src/ui/hooks/useLanguageCommand.ts`
  - `packages/cli/src/ui/hooks/useLanguageSettings.ts`

**Conflict Resolution for i18n:**

- **ESBuild config conflicts**: KEEP our i18n-transform plugin configuration
- The build-time transformer handles all i18n automatically - source code should
  stay clean

### 2. Disabled External Telemetry

- External telemetry collection has been disabled
- Keep internal metrics for functionality

### 3. TODO Tools

- **Implementation**: Complete TODO management system
- **Recent commits**:
  - `59adfe43 feat: implemented TODO tool`
  - `677637ae prompt improvement`

### 4. Custom Slash Commands

- `/language` - change language preference
- `/web` - open web interface in browser
- `/knowledge-base init` - initialize or update the knowledge base index
- `/knowledge-base search [some params] <query>` - search the knowledge base
- `/knowledge-base status` - show knowledge base status and statistics
- `/telegram start|stop|allow|remove|status` - manage Telegram bot integration
- `/discord start|stop|allow|remove|status` - manage Discord bot integration
- `/teams start|stop|webhook|allow|remove|mode|status` - manage Teams
  integration

### 5. Web Interface Feature

- **Implementation**: Complete web interface for browser-based interaction,
  including an advanced editor, file browser, and real-time collaboration tools.
- **Commits**: `7e9a8a559`, `2fb3530cc`, `af916c715`, `59ae9b942`, `55e3e6bab`,
  `d1fc0b105`, `f9ce59093`, `5c0eb215b`
- **Port**: 8629 (fixed port for consistency), random port if it's occupied
- **Launch**: `auditaria --web` or use `/web` command
- **Key Components**:
  - **Monaco Editor**: The same editor engine that powers VS Code is integrated
    for a rich file editing experience.
  - **File Browser**: A live-updating file tree that automatically reflects
    changes on the file system (creations, deletions, renames).
  - **File Previewers**: Built-in support to preview a wide range of files
    directly in the browser, including PDFs, images (PNG, JPG, etc.), videos,
    audio, and HTML.
  - **Collaborative Writing Mode**: A real-time file tracking mode that notifies
    the agent of external changes made by the user, allowing for seamless
    pair-programming and co-writing sessions.
- **Architecture** (refactored September 2026 from one 4000-line
  `WebInterfaceService.ts` into `packages/cli/src/services/web/`; the wire
  protocol and the CLI-facing API are unchanged):
  - `WebInterfaceService.ts` — the facade the CLI talks to (`start`/`stop`,
    `broadcast*`, `set*Handler`). A typed `EventEmitter<WebInterfaceEventMap>`
    emitting `started {port}` / `stopped` / `clients count` /
    `terminal_input` / `model_change_request`; a `stop()` racing an in-flight
    `start()` is detected and the partial start is torn down. Composes the
    transport core + one `WebFeature` per capability. Import from
    `services/web/index.js`.
  - `ui/contexts/WebInterfaceContext.tsx` — React side: owns the one service
    instance and MIRRORS its `started`/`stopped`/`clients` events into state
    (no polling, no duplicated lifecycle flags; `service` is non-null).
    Auto-start (`--web`) runs once per mount and stops on unmount.
  - `protocol.ts` — single source of truth for the message vocabulary
    (`ServerMessageType` / `ClientMessageType` unions, envelope
    `{type,data,sequence,timestamp,ephemeral?}`, `LATEST_ONLY_MESSAGE_TYPES`,
    payload guards `readString/readNumber/readBoolean`, `webSafeReplacer`).
    Adding a message type = one line here.
  - `core/` — transport, core-free (logger injected) so it unit-tests without
    loading core: `httpServer.ts` (Express + port fallback requested→+4→random,
    `closeAllConnections` on stop), `webSocketHub.ts` (ws server, `:param`
    path-routed `WsEndpoint`s, chat clients, ack/resync/force_resync),
    `clientRegistry.ts` (connected chat clients + per-client replay buffer,
    connect/disconnect listeners), `broadcaster.ts` (sequencing, envelopes,
    `broadcast`/`send`/`sendTo`/`sendRaw`, drops dead sockets), `inboundRouter.ts`
    (type→handler map, one owner per type, error isolation),
    `messageBuffer.ts` (ring buffer), `webFeature.ts` (feature base class:
    `attach(ctx)`/`detach()`, `sendInitialState(ws)`,
    `onClientDisconnected(ws)`; `broadcast` is a no-op while detached so state
    set before `/web` starts is kept for late joiners).
  - `http/` — `appRoutes.ts` (static client root resolution, `/api/health`),
    `previewFile.ts` (`/preview-file/*`: MIME table in `mimeTypes.ts`, byte
    ranges, HTML link rewriting).
  - `features/` — `ChatFeature` (session snapshot + user_message/interrupt/
    confirmation/terminal_input/set_model), `FileBrowserFeature` (tree, search,
    CRUD, per-client file watches, directory watcher), `DocxParserFeature`
    (parse + WYSIWYG AST bridge), `KnowledgeBaseFeature`, 
    `CollaborativeWritingFeature`, `ProviderTerminalFeature` (PTY mirror +
    Live-screen snapshots + webTerminalBridge), `BrowserAgentFeature`
    (`/stream/browser/:id` + `/control/agent/:id` sockets).
  - **Adding a capability** (e.g. artifacts hosting): one new `WebFeature`
    that registers inbound handlers via `ctx.inbound.on`, HTTP routes via
    `ctx.http.mount`, WS endpoints via `ctx.ws.addEndpoint`; add its message
    types to `protocol.ts`; append it to the `features` array in the facade.
  - **Tests**: `npx vitest run --config vitest.web.config.ts` in
    `packages/cli` (72 tests; lean config like the hive one because the
    default cli config cannot load core). Live e2e was validated by spawning
    `bundle/gemini.js --web` in a PTY and driving HTTP + WebSocket.
- **Code Marking**: All web interface code is marked with `WEB_INTERFACE`
  comments to simplify upstream merges.

### 6. Ripgrep Dependency Handling — OBSOLETE (removed in upstream `5562023`)

- **Status**: REMOVED. Upstream now bundles pre-built ripgrep binaries directly
  at `packages/core/vendor/ripgrep/`, eliminating the runtime/install-time
  download from `@lvce-editor/ripgrep` (later `@joshua.litt/get-ripgrep`) that
  triggered firewall failures. Our workaround is no longer needed.
- **Original issue**: `@lvce-editor/ripgrep` could not be installed behind
  corporate firewalls.
- **Original commit**: `f898e1a84` (fork-side workaround)
- **Resolution commit**: `5562023` (upstream `feat: bundle ripgrep binaries
  into SEA for offline support`) — bundled binaries via `getRipgrepPath()`
  checking `vendor/ripgrep/` paths.

### 7. Audit-Focused Features

- **System prompt modifications** for audit tasks
- **Custom branding**: Changed from "gemini-cli" to "auditaria-cli"
- **Command name**: `auditaria` instead of `gemini`

### 8. Context Management Tools

- **Implementation**: Complete context inspection and management system
- **Commit**: `6b697db`
- **Philosophy**: Uses "forget/restore" terminology instead of "hide/unhide" to
  emphasize LLM amnesia - when content is forgotten, the AI has COMPLETE AMNESIA
  about it
- **Tools**:
  - `context_inspect` - Inspect conversation history to identify forgettable
    content
  - `context_forget` - Erase selected content from LLM memory (permanent amnesia
    until restored)
  - `context_restore` - Restore previously forgotten content to conversation
- **Features**:
  - Automatic backup of conversation history
  - Intelligent content filtering (>3000 char threshold for responses)
  - Attachment management (images, files, PDFs)
  - Token usage statistics and optimization suggestions
  - Auto-forget context_inspect output after successful forget operations
  - Strong warnings about multi-step instructions and active work content
- **Key Components & Integration Points**:
  - `packages/core/src/tools/context-management.ts`: Main implementation of the
    tools.
  - `packages/core/src/config/config.ts`: Registration of the new context tools.
  - `packages/cli/src/ui/commands/clearCommand.ts`: Integration for cleaning up
    context backups.
  - `packages/core/src/core/client.ts` & `geminiChat.ts`: Updates to the core
    chat history and token tracking logic.
  - `packages/core/src/core/logger.ts`: Integration with the checkpointing
    system to handle context companion files.
- **Configuration**:
  - `AUTO_FORGET_INSPECT_AFTER_FORGET` - Controls auto-forgetting behavior
    (default: true)
  - `MIN_FORGETTABLE_RESPONSE_CHARS` - Minimum size threshold (default: 3000)
- **Usage Pattern**:
  1. Use `context_inspect` to see forgettable content and token statistics
  2. Use `context_forget` with selected IDs and detailed summaries (be VERY
     selective)
  3. Use `context_restore` to restore content when needed
  4. Forgotten content can also be restored by re-running original commands
- **Critical Warnings Built-in**:
  - Never forget multi-step instructions until ALL steps are complete
  - Never forget content needed for current or future tasks
  - "I remember it" is an illusion - once forgotten, complete amnesia occurs

### 9. Agent Skills System

- **Implementation**: A modular system to extend the agent's capabilities with
  domain-specific knowledge.
- **Commit**: `267340fba`
- **Discovery**: Skills are automatically discovered from the
  `.auditaria/skills/` directory.
- **Installation**: The `/setup-skill <skill-name>` command downloads and
  installs new skills.
- **First Skill**: The first implemented skill is `docx-writing-skill`, which
  adds the ability to parse a custom Markdown format into a TCU-compliant
  `.docx` file, a key feature for auditing workflows.
- **Key Components**:
  - `packages/cli/src/services/SkillSetupService.ts` - Generic service to
    download and install any skill.
  - `packages/cli/src/services/DocxParserService.ts` - Service providing the
    specific logic for the DOCX skill.
  - `packages/cli/src/ui/commands/setupSkillCommand.ts` - The user-facing slash
    command.

### 10. Browser Agent (AI-Driven Browser Automation)

- **Implementation**: Complete browser automation system using Stagehand
  (Playwright-based) with AI control
- **Commit**: `e644682` - feat(browser-agent): implemented browser-agent
- **Documentation**: See `browser-agent-implementation-plan.md` for full
  technical details (2501 lines)
- **Package**: `packages/browser-agent/` - Separate package for browser
  automation logic
- **Tool Name**: `browser_agent`
- **Actions**: `start`, `navigate`, `act`, `extract`, `screenshot`, `observe`,
  `agent_task`, `stop`
- **Key Features**:
  - **Live Browser Streaming**: Real-time CDP screencast to web interface
  - **Execution Control**: Pause/Resume/Stop during agent tasks
  - **Takeover Mode**: User can take manual control of browser during execution
  - **Screenshots**: Multiple modes (viewport, full page, clip, element, mask)
  - **Autonomous Tasks**: Multi-step browsing with `agent_task` action
  - **Authentication**: Supports OAuth, Gemini API key, and Vertex AI
- **Files Created** (packages/browser-agent/):
  ```
  packages/browser-agent/
  ├── index.ts                           # Package entry point
  ├── package.json                       # Package configuration
  ├── tsconfig.json                      # TypeScript config
  └── src/
      ├── index.ts                       # Exports
      ├── browser-agent-tool.ts          # Main tool class (682 lines)
      ├── stagehand-adapter.ts           # Stagehand wrapper (1054 lines)
      ├── session-manager.ts             # Session state management (705 lines)
      ├── credential-bridge.ts           # Auth integration (282 lines)
      ├── types.ts                       # Type definitions (379 lines)
      ├── errors.ts                      # Error types (46 lines)
      ├── logger.ts                      # Debug logger (44 lines)
      └── streaming/
          ├── index.ts                   # Streaming exports
          ├── types.ts                   # Stream types (114 lines)
          ├── stream-provider.ts         # Abstract base (123 lines)
          ├── stream-manager.ts          # Session/client mgmt (302 lines)
          └── cdp-stream-provider.ts     # CDP screencast (358 lines)
  ```
- **Files Created** (packages/web-client/):
  ```
  packages/web-client/src/components/
  ├── BrowserStreamViewer.js             # Canvas stream viewer (554 lines)
  ├── BrowserAgentControls.js            # Control panel UI (219 lines)
  ├── BrowserAgentControls.css           # Control styles (271 lines)
  └── agentControlsFactory.js            # Control factory (236 lines)
  ```
- **Files Created** (packages/cli/):
  ```
  packages/cli/src/ui/components/messages/
  └── BrowserStepDisplay.tsx             # CLI step display (194 lines)
  ```
- **Files Modified** (minimal invasion):
  - `packages/core/src/tools/tool-names.ts` - Added `BROWSER_AGENT_TOOL_NAME`
  - `packages/core/src/config/config.ts` - Tool registration (4 lines)
  - `packages/core/src/index.ts` - Export tool name (2 lines)
  - `packages/core/package.json` - Added @thacio/browser-agent dependency
  - `packages/cli/package.json` - Added stagehand/playwright dependencies
  - `packages/cli/src/services/WebInterfaceService.ts` - WebSocket handlers
    (+342 lines)
  - `packages/cli/src/ui/components/messages/ToolResultDisplay.tsx` - Browser
    step detection (+42 lines)
  - `packages/web-client/src/components/ToolRenderer.js` - Stream/controls
    (+270 lines)
  - `packages/web-client/src/style.css` - Browser styles (+449 lines)
  - `esbuild.config.js` - Mark stagehand/playwright as external (+5 lines)
- **Stagehand Fork**: Requires custom Stagehand fork at `stagehand/` with:
  - `CodeAssistClient` for OAuth support (bypasses @google/genai SDK)
  - `onStep` callback for real-time progress updates
  - `checkPauseState` for pause/resume control
- **Build Notes**:
  - Stagehand and Playwright marked as external in esbuild
  - Dynamic import to prevent worker thread crashes
  - Dependencies in `packages/cli/package.json` for global install support

### 11. Knowledge Search (Local Semantic Search)

- **Implementation**: Complete local search system with keyword, semantic, and
  hybrid search capabilities
- **Package**: `packages/search/` - Separate package for all search logic
- **Tools**: `knowledge_index`, `knowledge_search`
- **Documentation**: See `packages/search/README.md` for full technical details
- **Key Features**:
  - **Hybrid Search**: Combines BM25 keyword + vector semantic search via RRF
  - **Local Embeddings**: ONNX models via Python or Transformers.js (no API calls)
  - **OCR Support**: Tesseract.js and Scribe.js for images and scanned PDFs
  - **Multi-format**: PDF, DOCX, XLSX, PPTX, images, code files, and more
  - **Real-time Sync**: File watching for automatic re-indexing
- **Architecture**:
  - `PGliteStorage` - PostgreSQL-compatible SQLite with pgvector
  - `IndexingPipeline` - Priority queue (text→markup→pdf→image→ocr)
  - `SearchEngine` - Keyword/semantic/hybrid with FilterBuilder
  - `PythonEmbedder` - Bit-identical embeddings via Python subprocess
- **Key Components**:
  - `packages/search/src/` - Core TypeScript implementation
  - `packages/search/python/` - Python embedder (ONNX Runtime)
  - `packages/core/src/tools/knowledge-index.ts` - Index management tool
  - `packages/core/src/tools/knowledge-search.ts` - Search tool
  - `packages/core/src/tools/search-response-formatter.ts` - Result formatting
  - `packages/core/src/services/search-service.ts` - Service manager
- **Database**: `.auditaria/search.db` (PGlite with pgvector extension)

### 12. Alternative LLM Providers (Claude Code Integration)

- **Implementation**: Provider abstraction that allows switching between Gemini
  and Claude Code at runtime via the `/model` menu. All Auditaria tools work
  regardless of provider.
- **Architecture**: `packages/core/src/providers/` — provider-agnostic
  abstraction with PTY-based interactive driver for Claude
- **Plan file**: `.auditaria/claude-provider-plan.md` for full technical details
- **How it works**:
  - 5-line interception at top of `GeminiClient.sendMessageStream()` in
    `client.ts` — when Claude is active, all Gemini-specific code is bypassed
  - Claude PTY driver spawns `claude` in interactive TUI mode via node-pty
    (NOT `--output-format stream-json` — switched to PTY for subscription
    billing parity, AskUserQuestion support, and the web-terminal mirror)
  - PTY persists across turns until `dispose()` (see "Persistent PTY"
    below). Each `sendMessage` types the prompt into Claude's existing
    input box and drains hook events.
  - Events are adapted to `ServerGeminiStreamEvent` so the UI renders them
    natively
  - All conversation history is mirrored to `GeminiChat.history` so context
    management, compression, and provider switching work seamlessly
- **Key Features**:
  - **Runtime switching**: `/model` menu with Claude submenu (Auto, Opus,
    Opus 1M, Sonnet, Sonnet 1M, Haiku, Fable)
  - **Persistent PTY**: Claude stays alive across turns. Spawned lazily on
    first sendMessage via `ensurePtySpawned`, killed in `dispose()`. Abort
    sends Ctrl+C (\x03) instead of killing — preserves the session.
  - **AskUserQuestion modal**: When Claude's TUI calls AskUserQuestion,
    the driver surfaces `InteractivePromptStart` events; UI renders
    `AskUserDialog`; user answers are replayed as Down+Enter keystrokes
    through the PTY's picker (single + multi-question + "Type something"
    free-text). Bypass via `AUDITARIA_CLAUDE_INTERACTIVE_UI=0`.
  - **Web terminal mirror**: Live xterm.js viewer in the web client that
    bidirectionally mirrors Claude's PTY. Show/hide button, modal mode,
    PiP mode with drag + corner-resize, position/size/mode persisted to
    localStorage. Bus generalized July 2026 to
    `providers/terminal/ptyMirror.ts` (`providerPtyMirror`, shared with
    Copilot — see Section 22).
  - **Background hook watcher**: When the user types a turn directly into
    the live PTY via the web terminal, a `setInterval(150ms)` watcher
    drains hook events + transcript delta and emits user-message,
    assistant-text, tool markers, errors, and compaction summary
    incrementally to the chat UI via providerManager's `onBackground*`
    methods. Paused while a chat-initiated sendMessage is running.
  - **/tui fullscreen auto-enabled**: After SessionStart we send
    `/tui fullscreen\r` to dodge the xterm scrollback-duplication bug in
    Claude Code 2.1.x (anthropics/claude-code#49086, #51828). Opt-out
    via `AUDITARIA_CLAUDE_TUI_INLINE=1`. NOTE (August 2026,
    user-confirmed): the duplication leak is a CLAUDE CODE emission bug —
    fullscreen dodges it only PARTIALLY, it reproduces on macOS/Linux and
    under other emulators (tmux/kitty have similar issue reports), and no
    terminal/PTY swap fully fixes it (a rewritten-ConPTY backend was built,
    tested, and DISCARDED for this reason — see memory
    terminal-backend.md).
  - **Redundant turn-completion detection (3 channels)**: The Stop hook is
    silently droppable (relay/appendFileSync EBUSY/EPERM race on Windows,
    `--settings` regressions, hook timeouts) — a missed Stop used to hang the
    turn until the 30-min ceiling. `processTurnEvents` now checks three
    channels each tick, first-to-finalize wins (deduped naturally by the
    generator returning):
    1. **Hook** (unchanged, fastest, checked first).
    2. **Transcript-tail** (`scanTranscriptForTurn` + pure `scanTranscriptDelta`):
       tails the session JSONL with its OWN byte cursor (never touches
       `transcriptLineOffset`), finds the last NON-sidechain assistant
       `stop_reason`, and finalizes on a terminal reason
       (end_turn/stop_sequence/max_tokens) that has SETTLED
       (`TRANSCRIPT_TAIL_SETTLE_MS=600ms` byte-stable). Also redundantly
       surfaces/resolves AskUserQuestion (deduped vs the PreToolUse hook by
       `tool_use_id`). Kill switch: `AUDITARIA_CLAUDE_TRANSCRIPT_CHANNEL_DISABLED=1`.
    3. **PTY-scrape idle fallback** (Phase 4, last resort for the transcript-
       regression / TUI-slash-command case): after `NO_SIGNAL_IDLE_MS=20s` of
       no progress, gated on `turnOpenToolIds.size===0` AND
       `pendingPrompts.size===0` (never finalize mid-tool or mid-modal → no
       dangling functionCall / orphaned prompt) AND the PTY showing the input
       prompt (`❯`, last-3-lines check; `recentPtyOutput` reset per turn). Kill
       switch: `AUDITARIA_CLAUDE_PTY_SCRAPE_DISABLED=1`.
    The background (web-terminal) watcher gets the same transcript-completion
    trigger (runs every tick, even with no new hook bytes). The hook relay now
    retries `appendFileSync` on EBUSY/EPERM/EACCES. The post-turn backfill keys
    its tool_result skip on "result already emitted" (not "tool_use streamed"),
    so a dropped PostToolUse hook no longer leaves a dangling functionCall.
  - **Context injection**: Audit context, memory, and skills passed via
    `--append-system-prompt-file` on every call
  - **Tool bridging**: Auditaria's custom tools (knowledge search, browser
    agent, etc.) automatically exposed to Claude via MCP bridge
  - **Context compaction**: Captures Claude's compaction summary as
    `<state_snapshot>` in mirrored history for Gemini compatibility
  - **Provider switching**: History sanitization preserves attachments and known
    tool calls when switching between providers
  - **Token estimation**: Heuristic-based context usage display in footer
- **Files Created** (all in `packages/core/src/providers/`):
  - `types.ts` — Provider-agnostic interfaces and event types
  - `eventAdapter.ts` — Translates provider events to Gemini stream events
  - `providerManager.ts` — Main orchestrator (~845 lines, plus the
    background-event channel `backgroundEmitter` + `onBackground*` API)
  - `claude/types.ts` — Claude stream-json message types
  - `claude/claudeCLIDriver.ts` — PTY-based driver (persistent PTY,
    AskUserQuestion picker driver, background hook watcher, web mirror
    integration)
  - `claude/claudeSessionManager.ts` — Session ID tracking
  - `terminal/ptyMirror.ts` — Singleton publish/subscribe bus for the
    web-terminal mirror (`emitData` / `writeInput` / `resize` /
    `onActive`; was `claude/claudePtyMirror.ts`, generalized July 2026 —
    Section 22)
  - `claude/interactivePromptSupport.ts` — PendingPromptStore + hook relay
    (PtyWriteQueue moved to `terminal/ptyWriteQueue.ts`, re-exported here)
  - `mcp-bridge/toolExecutorServer.ts` — HTTP API for tool bridging
  - `mcp-bridge/mcpBridgeServer.ts` — MCP stdio bridge (bundled separately)
  - Test files: `eventAdapter.test.ts`, `claudeCLIDriver.test.ts`,
    `claudeSessionManager.test.ts`, `providerManager.test.ts`,
    `useClaudeInteractivePromptDialog.test.ts`
- **Files Created (CLI side)**:
  - `cli/src/ui/hooks/useClaudeInteractivePromptDialog.tsx` —
    AskUserQuestion modal bridge
  - `cli/src/ui/hooks/claudeInteractivePromptTranslators.ts` — Pure
    translators between InteractivePromptStartEvent and AskUserDialog
- **Files Created (web client)**:
  - `web-client/src/components/ProviderTerminalViewer.js` — xterm.js viewer
    with modal/PiP modes, drag + corner-resize, localStorage persistence
    (was `ClaudePtyViewer.js`; renamed + label-aware in July 2026 —
    Section 22)
- **Files Modified** (minimal, all marked with `AUDITARIA_CLAUDE_PROVIDER`):
  - `config/config.ts` — `setProviderConfig()`, `clearProviderConfig()`,
    `buildExternalProviderContext()`
  - `core/client.ts` — 5-line interception + provider session reset after
    `/compress`
  - `index.ts` — Provider exports + `providerPtyMirror` singleton
  - `prompts/snippets.ts` — Shared `AUDIT_*` constants
  - `tools/context-management.ts` — History modification notification
  - `core/turn.ts` + `agent/event-translator.ts` — InteractivePromptStart/
    Resolved event types in GeminiEventType
  - `cli/src/ui/AppContainer.tsx` — Custom dialog escape hatch +
    background-turn subscription effect
  - `cli/src/ui/components/ModelDialog.tsx` — Claude submenu
  - `cli/src/ui/modelCatalog.ts` — Claude submenu entries (Opus/Opus 1M/
    Sonnet/Sonnet 1M/Haiku/Fable)
  - `cli/src/ui/hooks/useGeminiStream.ts` — Inline tool call display +
    InteractivePromptStart/Resolved wiring
  - `cli/src/services/WebInterfaceService.ts` — Subscribes to
    providerPtyMirror, broadcasts `provider_pty_data` / `provider_pty_state`
    (with provider `label`), handles incoming `provider_pty_input` /
    `provider_pty_resize` messages
- **Code Marking**: All changes use `// AUDITARIA_CLAUDE_PROVIDER` or
  `_START/_END` block markers for upstream sync safety

### 13. Alternative LLM Providers (OpenAI Codex Integration)

- **Implementation**: Third provider option alongside Gemini and Claude, using
  OpenAI Codex CLI (`codex exec --json`) with the same provider abstraction
- **Architecture**: `packages/core/src/providers/codex/` — CLI driver mirroring
  the Claude driver pattern
- **How it works**:
  - Codex CLI driver spawns `codex exec --json` subprocess with JSONL streaming
  - Item-based event model: `item.started` → `item.updated` → `item.completed`
  - Text deltas computed from accumulated text (Codex emits full text, not
    deltas)
  - MCP tools exposed via `~/.codex/config.toml` injection (not `-c` flags —
    cmd.exe mangles TOML arrays)
  - System context via `-c model_instructions_file=<path>` on every call
- **Key Features**:
  - **Runtime switching**: `/model` menu with a Codex submenu built from the
    Codex CLI's OWN catalog — `$CODEX_HOME/models_cache.json` (default
    `~/.codex`), `visibility: "list"` entries only, ordered by Codex's
    `priority`. Ids, display names, descriptions and per-model reasoning tiers
    all come from that file (`providers/codex/codexModelCatalog.ts`), so a
    model OpenAI ships appears with no code change; the static
    `CODEX_FALLBACK_OPTIONS` / `CODEX_MODEL_IDS` tables are the offline
    fallback when Codex isn't installed or the cache can't be read.
  - **Tool bridging**: Same MCP bridge as Claude — all Auditaria tools available
  - **Context compaction**: Detects `contextCompaction` items, captures summary
  - **Session resume**: Thread ID from `thread.started` event, resumes via
    `codex exec resume`
  - **Token limits**: GPT-5.x Codex→400K context, o-series→200K context
- **Known behavior**: Codex truncates tool outputs to ~10K tokens (middle
  truncation with marker). Mirrored history may overestimate token usage.
- **Files Created** (all in `packages/core/src/providers/codex/`):
  - `types.ts` — Codex JSONL event types
  - `codexCLIDriver.ts` — CLI driver with config.toml MCP injection
  - `codexCLIDriver.test.ts` — 19 unit tests
- **Files Modified** (minimal, all marked with `AUDITARIA_CODEX_PROVIDER`):
  - `providers/types.ts` — Added `'codex-cli'` to type union
  - `providers/providerManager.ts` — `case 'codex-cli'` + `codex-code:` prefix
  - `core/tokenLimits.ts` — `codexTokenLimit()` function
  - `cli/src/ui/components/ModelDialog.tsx` — Codex submenu
- **Code Marking**: All changes use `// AUDITARIA_CODEX_PROVIDER` or
  `_START/_END` block markers for upstream sync safety

### 14. Alternative LLM Providers (GitHub Copilot Integration)

- **Implementation**: Fourth provider, with TWO drivers since July 2026:
  - **Interactive PTY driver (default, main session)** —
    `copilot/copilotPtyDriver.ts` drives the real Copilot TUI in a PTY
    (Claude-style): live bidirectional web-terminal mirror, TUI slash
    commands, turns typed directly into the terminal surface in chat.
    Built on the provider-terminal abstraction (Section 22).
  - **ACP driver (fallback + headless)** — `copilot/copilotCLIDriver.ts`,
    JSON-RPC 2.0 over NDJSON via `copilot --acp --stdio --allow-all`.
    Forced with `AUDITARIA_COPILOT_ACP=1`; always used for sub-agent
    sessions and Teams threads (and it's the only one supporting inline
    image attachments + refreshing the model-list cache).
- **PTY driver mechanics (validated live on Copilot CLI 1.0.67)**:
  - Spawn the real `copilot.exe` (resolved through the npm `.cmd` shim —
    `shared.ts:resolveCopilotExecutable`) with `--session-id <uuid>`
    (PRE-ASSIGNED id → session-state path known before spawn; respawns
    use `--resume <uuid>`, same events file, appending).
  - Read channel: tail `~/.copilot/session-state/<id>/events.jsonl`
    (written LIVE by the TUI): `user.message`, `assistant.turn_start/_end`,
    `assistant.message` (full text + model + outputTokens + toolRequests),
    `tool.execution_start/_complete` (args + results), `session.*`.
    The file is CREATED on first prompt submission — readiness detection
    must scrape the PTY (footer marker `? help` / `/ commands`), not the
    events file.
  - **Turn completion**: `assistant.turn_end` fires per INFERENCE STEP
    (turnId increments after tool calls; the next turn_start follows
    within ms). Final = a turn_end whose last assistant.message had NO
    toolRequests and no tool still open, settled `TURN_SETTLE_MS=1200ms`
    event-quiet.
  - **Prompt-acceptance confirmation**: `user.message` in events.jsonl
    positively confirms the TUI took the typed prompt; echo-verified
    closed-loop typing with recovery (double-Esc clear + retype → one
    respawn resuming the same session → error) — a channel the Claude
    driver doesn't have.
  - **CRITICAL — focus reporting (mode 1004)**: Copilot's input box
    IGNORES Enter while it believes the terminal is unfocused. The web
    viewer (xterm.js) sends focus-out (`\x1b[O`) when the user clicks
    from the mirrored terminal back to the chat box — so the driver
    asserts focus-in (`\x1b[I`) before EVERY typed prompt. Input clears
    with DOUBLE-Esc (single Esc only arms "esc again to clear input";
    Ctrl+U is not a Copilot binding).
  - **ask_user → provider terminal routing** (parity with Claude's
    AskUserQuestion): `tool.execution_start` with toolName `ask_user`
    (args `{question, choices[], allow_freeform}`, probe-validated) is
    surfaced as `InteractivePromptStart` (Resolved on
    `tool.execution_complete`, result.content = "User selected: X"). The
    provider-generic `useClaudeInteractivePromptDialog` hook then: web
    client connected → `webTerminalBridge.requestOpenTerminal()`
    (broadcasts `provider_pty_open`; viewer opens + focuses xterm) + INFO
    chat message; CLI-only + driver without `respondToPrompt`
    (`ProviderManager.canRespondToPrompts()`) → INFO pointing at /web (no
    dead-end modal). The picker accepts Down+Enter keystrokes (validated
    through the mirror), so a Claude-style modal auto-driver
    (respondToPrompt) is feasible as a follow-up. openToolIds keeps the
    turn open (no completion/idle finalize) while the picker waits.
  - Abort = Esc (cancels generation, TUI survives); persistent PTY across
    turns; background watcher surfaces web-terminal-typed turns via the
    same duck-typed `onBackground*` API as Claude.
  - Slash-command prompts (never produce user.message) idle-finalize after
    20s of event quiet; `/compact` completes on the REAL
    `session.compaction_start/_complete` events (Compacted emitted from
    compaction_complete with preCompactionTokens; never fabricated — on
    silence, compactNative falls back to Gemini-side compression).
  - **Hardening (post adversarial review)**: PtySession.kill() flags
    `killRequested` so isAlive() is false immediately (fixes the
    resetSession→sendMessage race that typed into a dying PTY and lost the
    conversation summary); `spawnReady` gate (a spawn whose ready-wait
    failed is torn down, never reused with an unpositioned events tail);
    `useResume` set only after readiness (a startup crash no longer poisons
    respawns with `--resume` of a virgin id — fresh id instead); abort
    listener attached BEFORE typing + `eventsTail.seekToEnd()` on abort (no
    ghost background replay of the cancelled turn); fail-fast on
    `session.error` (3s settle); last-resort idle finalize after 180s of
    event silence with no open tools (Esc-in-terminal / dead-CLI case);
    JsonlFileTail buffers partial lines AS BYTES (no U+FFFD corruption of
    multi-byte UTF-8 split across reads) and serialises concurrent drains
    (no cursor rewind); `supportsImages()` returns false for copilot-cli
    unless `AUDITARIA_COPILOT_ACP=1` (Telegram/Discord warn instead of
    failing the turn).
- **Copilot CLI HAS a hooks system (VALIDATED LIVE, currently unused by our
  driver — planned redundant channel)**:
  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
  — events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`,
  `preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`,
  `subagentStart/Stop`, `errorOccurred`, `preCompact`, `notification`,
  `permissionRequest`. Config: JSON (`"version":1`) at repo
  `.github/hooks/*.json`, user `~/.copilot/hooks/*.json`, inline in
  settings.json, plugins; loaded at CLI START only (no per-invocation flag
  like Claude's `--settings`). Hooks can emit progress lines, inject
  `additionalContext`, modify tool results, and `agentStop` can block/force
  another turn.
  **Empirically validated on Windows (CLI 1.0.68):**
  - Fired in our PTY sessions with a user-level hook file + `node` relay:
    `userPromptSubmitted` (+0ms, carries the prompt → instant
    prompt-acceptance), `sessionStart` (readiness beacon — solves
    "events.jsonl only exists after first prompt"), `postToolUse`,
    **`agentStop` (`stopReason:"end_turn"`, `transcriptPath`) fired ONCE at
    the true turn end** while events.jsonl had 2 per-inference turn_ends —
    a definitive completion signal needing no toolRequests-inference or
    settle window.
  - The docs' PowerShell-7 prerequisite is soft: `powershell.exe` 5.1 ran
    the hooks — but the `powershell` command string MUST use the call
    operator (`& "node.exe" "relay.cjs" event`); plain `"exe" "args"` is a
    PS parse error. Provide both `bash` and `powershell` keys; the
    cross-platform `command` key inherits the same quoting trap.
  - **DANGER: `preToolUse` command hooks are FAIL-CLOSED** — our broken
    probe hook DENIED the model's tool calls ("execution failed
    (fail-closed)" in `~/.copilot/logs/process-*.log`). Never install
    observational preToolUse hooks; other events are fail-open.
  - Scoping for the GLOBAL `~/.copilot/hooks/` file: relay script no-ops
    (exit 0) unless `AUDITARIA_COPILOT_HOOK_FILE` env is set — only our
    spawned PTYs set it, the user's own copilot sessions are unaffected.
    Hook execution errors are visible in `~/.copilot/logs/process-*.log`.
- **Shared between both drivers** (`copilot/shared.ts`): MCP tools via
  `--additional-mcp-config @~/.auditaria/copilot-mcp-{port}.json`, system
  context via `AGENTS.md` marked section, executable resolution. Dynamic
  model discovery (cached to `~/.auditaria/copilot-models.json`, usage
  multipliers in UI) is ACP-only — the PTY driver reads the existing cache.
- **Files Created**: `copilot/types.ts`, `copilot/copilotCLIDriver.ts`,
  `copilot/copilotPtyDriver.ts` (+ `.test.ts`, 11 tests), `copilot/shared.ts`
- **Code Marking**: `// AUDITARIA_COPILOT_PROVIDER` or `_START/_END` blocks

### 15. External Agent Sessions (Multi-Agent Delegation)

- **Implementation**: Tool that allows the main agent to spawn and manage
  sessions with any LLM provider (including itself) as external sub-agents.
  Sub-agents are not limited to coding — they can serve any role (critic,
  designer, brainstormer, domain expert, etc.)
- **Tool Name**: `external_agent_session`
- **Actions**: `create`, `send`, `list`, `kill`
- **Key Features**:
  - **Any-provider delegation**: Main agent spawns sub-agents of any provider,
    including its own (Claude→Claude, Gemini→Gemini, Codex→Codex, or any cross
    combination)
  - **Model selection**: AI can choose specific models (opus, sonnet, haiku,
    gpt-5.3-codex, etc.) or omit for auto. Model IDs defined as DRY constants
    in `providers/types.ts` (`CLAUDE_MODEL_IDS`, `CODEX_MODEL_IDS`)
  - **Permission modes**: `work` (full access) or `consult` (read-only)
  - **Multi-turn sessions**: Sub-agents maintain conversation context
  - **MCP tool bridging**: Sub-agents access Auditaria tools via shared
    ToolExecutorServer. User MCP servers are NOT passed to sub-agents
  - **Tool filtering**: `--exclude` flags on MCP bridge prevent recursion
  - **Codex isolation**: Each Codex sub-agent gets its own config directory
  - **Configurable recursion**: `allow_sub_agents` parameter enables chains
- **Files Created**:
  - `providers/agent-session-manager.ts` — Session lifecycle, driver creation
  - `tools/agent-session.ts` — Tool + Invocation classes, schema
- **Files Modified** (minimal, all marked with `AUDITARIA_AGENT_SESSION`):
  - `tools/tool-names.ts` — `EXTERNAL_AGENT_SESSION_TOOL_NAME`
  - `config/config.ts` — Import, register tool, manager field+getter, dispose
  - `providers/types.ts` — `CLAUDE_MODEL_IDS`, `CODEX_MODEL_IDS` constants
  - `providers/providerManager.ts` — `getToolBridgeInfo()` for server sharing
  - `providers/mcp-bridge/mcpBridgeServer.ts` — `--exclude` flag parsing
  - `providers/claude/types.ts` — `toolBridgeExclude` in config
  - `providers/claude/claudeCLIDriver.ts` — Append `--exclude` to bridge args
  - `providers/codex/types.ts` — `toolBridgeExclude`, `codexConfigHome`,
    `sandboxMode`
  - `providers/codex/codexCLIDriver.ts` — Config home, env, sandbox, exclude
  - `index.ts` — Export `CLAUDE_MODEL_IDS`, `CODEX_MODEL_IDS`
  - `cli/src/ui/modelCatalog.ts` — Import DRY model ID constants
- **Code Marking**: All changes use `// AUDITARIA_AGENT_SESSION` markers

### 16. Telegram Bot Integration

- **Implementation**: Bidirectional Telegram bot using grammY (long polling),
  shared CLI GeminiClient session, mutex-based processing, edit-in-place
  streaming
- **Dependency**: `grammy`
- **CLI Command**: `/telegram start|stop|allow|remove|status`
- **Config**: `~/.auditaria/telegram.json`, env `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_ALLOW_FROM`, flags `--telegram`, `--telegram-token`
- **Key Features**: Shared session with CLI, image attachments (5MB), group chat
  with `requireMention`, user allowlist, autostart, single-instance lock,
  bidirectional CLI↔Telegram display sync, slash command injection
- **Files Created**: `packages/cli/src/services/telegram/` (TelegramService,
  TelegramBot, TelegramFormatter, TelegramBridge, TelegramSessionManager,
  types), `ui/commands/telegramCommand.ts`
- **Files Modified**: `gemini.tsx`, `AppContainer.tsx`, `config.ts`,
  `BuiltinCommandLoader.ts`
- **Code Marking**: `// AUDITARIA_TELEGRAM_FEATURE` or `_START/_END` blocks

### 17. Discord Bot Integration

- **Implementation**: Bidirectional Discord bot using discord.js (gateway),
  shared CLI GeminiClient session, same architecture as Telegram
- **Dependency**: `discord.js`
- **CLI Command**: `/discord start|stop|allow|remove|status`
- **Config**: `~/.auditaria/discord.json`, env `DISCORD_BOT_TOKEN`,
  `DISCORD_ALLOW_FROM`, flags `--discord`, `--discord-token`
- **Key Features**: Shared session with CLI, image attachments (max 5/msg),
  guild + DM support with `requireMention`, user allowlist, autostart,
  single-instance lock, built-in `!help`/`!status` commands, bidirectional
  CLI↔Discord display sync
- **Files Created**: `packages/cli/src/services/discord/` (DiscordService,
  DiscordBot, DiscordFormatter, DiscordBridge, types),
  `ui/commands/discordCommand.ts`
- **Files Modified**: `gemini.tsx`, `AppContainer.tsx`, `config.ts`,
  `BuiltinCommandLoader.ts`
- **Code Marking**: `// AUDITARIA_DISCORD_FEATURE` or `_START/_END` blocks

### 18. Microsoft Teams Integration (Power Automate)

- **Implementation**: HTTP webhook server with per-thread session isolation,
  HMAC-SHA256 validation, ngrok tunnel management, and pluggable response
  strategies — connected to Teams via Power Automate
- **Documentation**: `bundle/docs/teams-power-automate-setup.md`
- **CLI Command**: `/teams start|stop|webhook|allow|remove|mode|status`
- **Config**: `~/.auditaria/teams.json`, env `TEAMS_HMAC_SECRET`,
  `TEAMS_ALLOW_FROM`
- **Key Features**: Per-thread isolated GeminiClient (unlike Telegram/Discord
  shared model), response modes (`sync`, `async`, `labeled-async`, `pull`,
  `hybrid`), auto ngrok tunneling, memoryless mode for group chats, per-thread
  concurrency, external provider support (per-thread drivers), auto-compaction
  at 40 turns, idle session cleanup (30min)
- **Files Created**: `packages/cli/src/services/teams/` (TeamsWebhookServer,
  TeamsService, TeamsSessionManager, TeamsFormatter, TeamsBridge, types),
  `ui/commands/teamsCommand.ts`,
  `bundle/docs/teams-power-automate-setup.md`
- **Files Modified**: `gemini.tsx`, `useHistoryManager.ts`,
  `BuiltinCommandLoader.ts`
- **Code Marking**: `// AUDITARIA_TEAMS_FEATURE` or `_START/_END` blocks

### 19. WYSIWYG Markdown Editor (Web) + Password-Protected Skill Setup

- **Implementation**: Word-like WYSIWYG editor for `.md` files in the web
  client, as dedicated view modes ("WYSIWYG" / "Split WYSIWYG" toolbar buttons
  alongside Code/Preview/Split — the normal marked.js preview is unchanged).
  Ported from the proven spike at
  `python_md_to_docx_parser/tcu-writing/editor/`.
- **Architecture**: ONE renderer = the Python parser (`parser.exe`). The web
  client knows ZERO markdown syntax. Load: buffer `.md` → `--emit-ast` → AST →
  TipTap editor. Save: editor AST → `--ast-to-md` (stdin) → `.md` → Monaco
  buffer (source of truth; Ctrl+S saves normally). Same binary as the docx
  parse; conversions go over WebSocket with requestId correlation.
- **Gating**: parser installed + binary answers `--emit-spec` (probed, cached,
  generation-counted on refresh) + not disabled via `AUDITARIA_WYSIWYG_DISABLED=1`.
  Flag rides on the existing `parser_status` message (`wysiwyg: boolean`).
- **Echo-loop prevention** (the hard part): `applyingToModel` flag +
  `lastSetValue` comparison (post-EOL-normalization via `model.getValue()`) +
  debounces (save-back 700ms, external reload 500ms) + `pendingChanges`
  last-writer-wins + mount tokens (`mountSeq`) + save sequencing (`saveSeq`).
  Round-trips are canonical (md_ast normalizes like Prettier), so comparisons
  are never against the user's original text.
- **Extras**: zoom is owned by the editor **core** (it builds its own Zoom
  ribbon group + Ctrl+wheel on the editing surface — the shell adds none, or
  controls/handlers would double up); panel maximize toggle (auditaria-only,
  shell-side); comments review panel + track changes (fully working, from the
  spike); `.docx → .md` import button on the unsupported-file overlay
  (`--docx-to-md`); floating/locked images with text wrap + Word captions;
  KaTeX formulas.
- **Editor modules** in `packages/web-client/src/utils/preview/wysiwyg/`
  (`ast-bridge.js`, `ui.js`, `extensions.js`, `editor-core.js`) are
  **byte-identical copies of the spike — NEVER edit them here**; fix upstream
  in the spike and re-copy (round-trip suite:
  `python editor/tests/run.py` in the parser repo).
- **Password skill setup**: `/setup-skill docx-writing-skill [password]` —
  optional password extracts ZipCrypto-protected release zips via `unzipper`
  (AES not supported); without password, extract-zip path unchanged.
- **Multi-OS install layout** (shared cloud folders, e.g. Windows + macOS on
  the same project): setup no longer renames `parser-{platform}/` away — each
  OS keeps its binaries in `docx-writing-skill/parser-{windows|macos|linux}/`
  and setup replaces only its own platform's subfolder. Shared content
  (SKILL.md, templates/, assets/, docs — any zip entry NOT named `parser*`)
  is copied to the skill root. Detection prefers `parser-{os}/parser(.exe)`
  and falls back to the legacy root binary until users re-run setup.
- **Files Created**:
  - `packages/web-client/src/utils/preview/WysiwygMarkdownPreview.js` — shell:
    mount/teardown, bidirectional sync, zoom, comments panel wiring
  - `packages/web-client/src/utils/preview/wysiwyg/` — the 4 spike modules
  - `packages/web-client/src/styles/wysiwyg-preview.css` — scoped port of the
    spike CSS (canvas under `.wysiwyg-preview-root`; body-appended `.pop`/
    `.dlg-overlay` global with z-index 12000/12100; spike CSS vars scoped to
    those roots because they collide with themes.css)
- **Files Modified**:
  - `packages/cli/src/services/DocxParserService.ts` — `probeWysiwygSupport`,
    `emitSpec`, `mdToAst` (temp file), `astToMd` (stdin), `docxToMd`;
    `openDocxFile` hardened to execFile arrays (command-injection fix)
  - `packages/cli/src/services/WebInterfaceService.ts` — 4 WS handlers
    (`ast_spec_request`, `md_to_ast_request`, `ast_to_md_request`,
    `docx_to_md_request` → `*_response`/`ast_error`), `isWysiwygEnabled()`,
    `wysiwyg` in parser_status, probe warm-up + re-probe on refresh
  - `packages/cli/src/services/SkillSetupService.ts` — optional password +
    `extractZipWithPassword` (zip-slip safe via path.relative)
  - `packages/cli/src/ui/commands/setupSkillCommand.ts` — `[password]` arg
    (parent + subcommand paths), usage hint in description
  - `packages/web-client/src/managers/EditorManager.js` — `wysiwygAvailable`,
    cached spec, Promise-based `requestAstSpec/requestMdToAst/requestAstToMd/
    requestDocxToMd` with requestId correlation
  - `packages/web-client/src/components/EditorPanel.js` — WYSIWYG/Split-WYSIWYG
    buttons + mode state machine + `leaveWysiwygModes()` + maximize +
    docx-import button on unsupported overlay
  - `packages/web-client/src/index.html` — TipTap esm.sh import-map entries
    (pinned, `?external=` for single ProseMirror copy), katex CSS, stylesheet
- **Parser flags** (already in `parser.py`, bundled in `parser.exe`):
  `--emit-spec`, `--emit-ast FILE.md`, `--ast-to-md` (stdin), `--docx-to-md`.
  stdout is clean JSON/md; stderr carries DEBUG noise — key on exit code.

### 20. Alternative LLM Providers (Google Antigravity / `agy`)

- **Implementation**: Fifth provider alongside Gemini, Claude, Codex, and
  Copilot, driving Google's **Antigravity CLI** (`agy`) — the gemini-cli
  successor. Available in the `/model` menu and as an `external_agent_session`
  sub-agent provider.
- **WHY THIS MATTERS NOW — Google discontinued Gemini CLI OAuth for consumer
  subscriptions (effective June 18, 2026)**: On 2026-06-18 Google's upstream
  Gemini CLI (and the Gemini Code Assist IDE extensions) **stopped serving
  requests over the "Sign in with Google" OAuth path** for **Google AI Pro**
  subscribers, **Google AI Ultra** subscribers, and free **"Gemini Code Assist
  for individuals"** users. Google pushed all of these users to the
  closed-source **Antigravity CLI** (`agy`) as the replacement (see the Google
  Developers Blog: "Transitioning Gemini CLI to Antigravity CLI"). What this
  means for Auditaria:
  - Auditaria's **default Gemini provider** uses that same OAuth (Code Assist)
    login. After 2026-06-18 that login **no longer returns model access** for
    AI Pro / AI Ultra / free-individual accounts — users hit auth/eligibility
    errors, not model output.
  - **Still works (unchanged)**: orgs on a **Gemini Code Assist Standard or
    Enterprise** license, and Gemini Code Assist for GitHub via Google Cloud.
  - **Alternative Gemini auth still valid**: a **Gemini API key** (Google AI
    Studio) or **Vertex AI** — these are independent of the OAuth subscription
    path. (Separately, from 2026-06-19 the Gemini API rejects *unrestricted*
    standard API keys; keys with explicit restrictions keep working.)
  - **Migration for affected users**: (1) switch the Gemini provider to an API
    key / Vertex AI, OR (2) use this **`agy` provider** (same Google account,
    official successor), OR (3) switch to **Claude / Codex / Copilot**.
- **Architecture**: `packages/core/src/providers/agy/` — a PTY-to-run +
  transcript-to-read driver (NOT JSON streaming).
- **Plan/notes**: `.auditaria/agy-provider-plan.md` (reverse-engineered from the
  olx-jogos `agy.py` backend + validated live against agy 1.0.8).
- **How it works** (agy's two hard quirks shape the driver):
  1. **`agy --print` produces ZERO stdout without a real TTY** (its "text drip"
     renderer only flushes to a terminal). So we spawn `agy` through node-pty
     (`@lydell/node-pty` via `utils/getPty.ts`, same backend as Claude). The
     PTY output is only used as a scrape FALLBACK.
  2. **No JSON mode, but agy writes a clean structured JSONL transcript** at
     `~/.gemini/antigravity-cli/brain/<cascadeId>/.system_generated/logs/transcript_full.jsonl`
     carrying user input, model text + `thinking`, and `tool_calls` + their
     results. The driver TAILS this transcript live and maps entries to
     ProviderEvents (`PLANNER_RESPONSE`→Content/Thinking/ToolUse,
     `LIST_DIRECTORY`/`VIEW_FILE`/`RUN_COMMAND`/…→ToolResult, FIFO-paired).
- **Key empirical findings (validated live, do not relearn)**:
  - **`--print <prompt>` MUST be the LAST arg.** If a bare bool flag
    (`--dangerously-skip-permissions`) immediately follows the prompt value,
    agy absorbs the FLAG NAME as the prompt. buildArgs puts all flags first,
    `--print <prompt>` last.
  - **Conversation id discovery = dir-diff only, never the cache.**
    `cache/last_conversations.json` is keyed by cwd and rewritten by EVERY agy
    process (the "poisoning race") — using it locks onto another run's
    conversation. We diff `conversations/*.db` against a pre-spawn snapshot and
    pick the newest by mtime. The id == `cascade_id` == `--conversation` arg ==
    our native session id.
  - **Resume** = `agy --conversation <id> --print "<prompt>"`. The transcript
    accumulates across turns in one file, so per-turn extraction is a
    `step_index` delta.
  - **System context**: agy has no `--append-system-prompt`, so on the FIRST
    turn the context is prepended to the prompt; if it would blow the Windows
    ~32K argv cap it's spilled to `.auditaria/.agy-system-context.md` for agy to
    read. Resumed turns already carry it.
  - **MCP**: agy reads the GLOBAL `~/.gemini/config/mcp_config.json` and
    supports stdio servers. We MERGE an `auditaria-tools` stdio entry in and
    remove only that key on dispose — never clobbering the user's own servers
    (e.g. a shared `pricecharting` entry).
  - **Errors** (quota/auth) are buried in `~/.gemini/antigravity-cli/log/cli-*.log`
    with empty stdout — classified from the cli-log tail.
- **No native compact** (agy emits no compaction events) → uses Gemini-side
  mirrored compaction. Token usage = heuristic estimation (per-family window:
  Gemini→1M, Claude→200K, GPT-OSS→128K).
- **Models** (separate Antigravity quota pools per family): Gemini 3.5 Flash
  Low/Medium/High, Gemini 3.1 Pro Low/High, Claude Sonnet 4.6, Claude Opus 4.6,
  GPT-OSS 120B (no vision).
- **Native image generation/editing** (agy-only superpower): agy has a built-in
  `generate_image` tool (params: `Prompt`, `ImageName`, optional `ImagePaths` =
  up to 3 input images for editing/combining). Output is a JPEG fixed at ~1024px
  — there is NO resolution/size/aspect-ratio param, so dimensions are not
  configurable (only the prompt text can hint at framing). High-fidelity
  single-attribute edits. Surfaced in the `external_agent_session` tool
  description so the main agent delegates image tasks to an `agy` sub-agent. See
  memory `agy-image-generation.md`.
- **CLI menu fix**: `ModelDialog.tsx` now always opens on the `main` view (was
  forced to the gemini-only `manual` view for users without pro-model access,
  which trapped them there and hid ALL provider entries — Claude/Codex/Copilot/
  Agy — on the CLI; the web menu was unaffected). Escape from `manual`→`main` no
  longer requires pro access.
- **Auth hardening**: an expired agy token makes agy print an OAuth URL to the
  terminal; the driver classifies that as an auth ERROR (re-auth message) rather
  than emitting the URL as the model's answer.
- **Files Created**: `providers/agy/types.ts`, `providers/agy/agyCLIDriver.ts`,
  `providers/agy/agyCLIDriver.test.ts` (14 tests).
- **Files Modified** (all marked `// AUDITARIA_AGY_PROVIDER`): `providers/types.ts`
  (`agy-cli` + `AGY_MODEL_IDS`), `providerManager.ts` (driver switches + getModel),
  `agent-session-manager.ts`, `tools/agent-session.ts`, `core/tokenLimits.ts`,
  `config/models.ts`, `config/config.ts`, `utils/providerAvailability.ts`,
  `index.ts`, `cli/src/config/config.ts`, `cli/src/ui/modelCatalog.ts`,
  `cli/src/ui/components/ModelDialog.tsx`, `cli/src/ui/AppContainer.tsx`.
- **Code Marking**: `// AUDITARIA_AGY_PROVIDER` or `_START/_END` blocks.

### 21. Provider-Only Mode (Skip Google Authentication)

- **Why**: After Google discontinued "Sign in with Google" for consumer Gemini
  subscriptions (see Section 20), users with only a Claude/Codex/Copilot/agy
  subscription (or just a Gemini API key) were **trapped** at the auth gate —
  the app refused to start without a *defined* `security.auth.selectedType`,
  and every selectable type was a Google/Gemini one. This feature lets a user
  **totally skip Google authentication** and run Auditaria purely on an external
  provider (or add a Gemini API key later).
- **Core finding**: The app never needed working Gemini *credentials* for an
  external provider — when a provider is active, `sendMessageStream()` is
  intercepted before touching the Gemini content generator, and the
  `ProviderManager` is rehydrated from the persisted `model.name` prefix
  (`claude-code:` / …) with zero auth. The *only* blocker was UI/validation
  gates keyed on `selectedType` being undefined.
- **Design**: New `AuthType.PROVIDER_ONLY = 'provider-only'` sentinel. Selecting
  it satisfies every `selectedType`-keyed gate with no per-site edits, and
  `refreshAuth(PROVIDER_ONLY)` early-returns *without* building a Gemini content
  generator (records `contentGeneratorConfig.authType` only). It **bypasses
  `enforcedType`** (external providers are always allowed).
- **AuthDialog "Skip Google sign-in" option**: The first-run auth dialog adds a
  single "Skip Google sign-in — use Claude Code, Codex, Copilot or Antigravity"
  entry. Highlighting it shows a description (`getSkipLoginDescription`) listing
  the providers with live install status (`config.getProviderAvailability()`) and
  how to set them up. Selecting it persists `selectedType = PROVIDER_ONLY` (no
  provider activated here) and lands at the prompt; the user then chooses a
  provider with `/model` (which persists it via `model.name` for next launch).
  The "Sign in with Google" entry shows a contextual warning
  (`getGoogleOAuthDiscontinuedNote`) that it no longer serves consumer
  subscriptions (since 2026-06-18) and what the alternatives are.
- **Actionable wrong-provider errors** (`providers/providerPreflight.ts`): a
  pre-send guard in `client.sendMessageStream()` runs for **every** entry point
  (CLI, web, Telegram, Discord, Teams). If the active provider's CLI is missing
  it re-checks once (catches "installed after launch") then blocks with
  install/login guidance; if provider-only is set with no provider active it
  guides the user to `/model` or `/auth`. Dead Gemini-OAuth send failures get a
  migration nudge appended in `useGeminiStream` (`augmentGoogleAuthError`).
- **Shared copy** in `utils/providerAvailability.ts`:
  `getProviderDisplayName`, `getProviderTagline`, `getProviderUnavailableMessage`,
  `getNoProviderActiveMessage`, `getGoogleOAuthDiscontinuedNote` (DRY across the
  dialog, preflight, and send-error nudge).
- **Files Created**: `core/src/providers/providerPreflight.ts` (+ `.test.ts`,
  8 tests).
- **Files Modified** (all marked `// AUDITARIA_PROVIDER_ONLY` or `_START/_END`):
  `core/src/core/contentGenerator.ts` (enum), `core/src/config/config.ts`
  (`refreshAuth` guard), `core/src/utils/providerAvailability.ts` (copy helpers),
  `core/src/core/client.ts` (pre-send guard), `core/src/index.ts` (export),
  `cli/src/config/auth.ts`, `cli/src/ui/auth/useAuth.ts`,
  `cli/src/validateNonInterActiveAuth.ts`, `cli/src/ui/auth/AuthDialog.tsx`,
  `cli/src/ui/components/Tips.tsx`, `cli/src/ui/hooks/useGeminiStream.ts`.
- **Code Marking**: `// AUDITARIA_PROVIDER_ONLY` or `_START/_END` blocks.

### 22. Provider Terminal Abstraction (PTY drivers + web mirror)

- **Why**: The Claude provider pioneered "drive the real CLI TUI in a PTY and
  mirror it live to the web client". That plumbing was Claude-named/-coupled
  (claudePtyMirror, claude_pty_* WS messages, ClaudePtyViewer). This
  abstraction makes the terminal machinery provider-agnostic so other CLI
  TUIs plug in elegantly — **Copilot first (done, Section 14)**, Codex and
  agy later. The common shape: **PTY to drive + JSONL file to read + web
  mirror to watch** (Claude: hooks+transcript; Copilot: events.jsonl;
  Codex: session rollout JSONL; agy: brain transcript).
- **Module**: `packages/core/src/providers/terminal/`
  - `ptyMirror.ts` — `providerPtyMirror` singleton bus (was
    `claude/claudePtyMirror.ts`). Now **source-guarded**
    (`emitData(source, bytes)` drops bytes from a non-registered source →
    two live PTYs can never interleave in the viewer) and **labeled**
    (`setActive(source, label)` → viewer title "Claude Code Terminal" /
    "GitHub Copilot Terminal").
  - `ptySession.ts` — `PtySession`: generic TUI runner (spawn via getPty,
    rolling output buffer, write-queue serialisation, mirror registration,
    `typeSubmit` body+gap+CR, resize, kill, exit tracking). First consumer:
    CopilotPtyDriver. The Claude driver keeps its own battle-tested wiring
    (shares mirror + write queue only) — migrate opportunistically.
  - `ptyWriteQueue.ts` — PtyWriteQueue moved here (claude/
    interactivePromptSupport.ts re-exports for compat).
  - `jsonlTail.ts` — `JsonlFileTail`: incremental byte-cursor JSONL reader
    (partial-line-safe) for transcript/event files (+ 6 tests).
  - `textUtils.ts` — `summariseToolArgs` for "↪ Calling X: …" markers.
  - `screenMirror.ts` — **"Live screen" oracle** (August 2026):
    `ProviderScreenMirror`, a headless terminal (`@xterm/headless` +
    `@xterm/addon-serialize`, both core deps) that absorbs the raw PTY
    stream server-side with `scrollback: 0` and serves ANSI viewport
    snapshots. WHY: Claude Code's inline-mode redraw leak
    (anthropics/claude-code#49086, #51828) emits duplicated frames that any
    faithful raw-stream viewer accumulates in scrollback (reproduces across
    emulators/platforms — no PTY/terminal swap fixes it, see memory
    terminal-backend.md); the visible GRID however always converges to the
    correct screen, so snapshotting the grid and discarding scrollback is
    duplication-immune BY DESIGN. Wiring: `WebInterfaceService` feeds it
    from `providerPtyMirror.onData` (always, so the grid stays current),
    resets it on active-transitions, resizes it in lock-step with
    `provider_pty_resize`, and broadcasts `provider_screen_data`
    (base64 ANSI + cols/rows, 80ms trailing throttle, client-gated) beside
    the existing raw `provider_pty_data`. New unicast
    `provider_pty_refresh` message re-sends both representations (mode
    toggle / panel reopen) — unicast because broadcasting the raw replay
    would append duplicate history into other raw-mode viewers.
    `ProviderTerminalViewer.js` gained a Live/Raw header toggle (default
    **Live**, persisted in localStorage): Live repaints each frame with a
    single ordered `'\x1bc' + snapshot` write (RIS through the write queue
    — a synchronous `term.reset()` races xterm's ASYNC parser and
    still-queued bytes resurrect after it; this bit us in testing), no
    scrollback; Raw is the pre-existing stream behavior, unchanged.
    8 unit tests (`screenMirror.test.ts`, incl. duplication-immunity and
    the reset-ordering case); e2e-validated against the real Claude TUI
    (double snapshot repaint → exactly one coherent screen copy).
- **Mirror suppression**: drivers accept `mirrorPty?: boolean`. Headless
  contexts pass `false` — providerManager `createDriver()` (Teams threads)
  and agent-session-manager (sub-agents). This FIXED a latent bug where a
  Claude sub-agent's PTY hijacked/interleaved the main web terminal.
- **Web protocol rename**: WS messages are now `provider_pty_data` /
  `provider_pty_state` (carries `label`) / `provider_pty_open` /
  `provider_pty_input` / `provider_pty_resize` (server+client ship
  together; old `claude_pty_*` names are gone). Viewer:
  `web-client/src/components/ProviderTerminalViewer.js` (localStorage key
  migrated from the old ClaudePtyViewer key).
- **Adding a future terminal provider (Codex/agy) checklist**:
  1. **RESEARCH FIRST — send an agent to check the web/official docs**
     before assuming CLI capabilities. Lesson learned: we assumed Copilot
     CLI had no hooks system; it DOES (see Section 14, GitHub docs). For
     each new CLI verify: (a) hooks/plugin system and its events, (b) the
     session/event/transcript file location + format + whether it's written
     live, (c) resume/session-id flags, (d) whether the TUI enables focus
     reporting (mode 1004) and how it treats Enter when "unfocused",
     (e) input-clear keybinding (Copilot = double-Esc, NOT Ctrl+U),
     (f) abort/cancel key (Copilot = Esc; Ctrl+C may exit the TUI),
     (g) known TUI bugs affecting xterm.js mirroring. Then validate the
     findings empirically (scratchpad PTY probes) before writing the
     driver — docs and reality diverge.
  2. Compose `PtySession` (mirror label), tail the CLI's session/event
     file via `JsonlFileTail`, implement readiness scrape + echo-verified
     prompt typing (assert focus-in `\x1b[I` before typing — the web
     viewer sends focus-out when the user clicks away) + turn detection
     with settle windows and idle/error fallbacks.
  3. Expose `onBackground*` for terminal-typed turns; keep the existing
     headless driver for sub-agents/Teams (`mirrorPty: false`).
  4. End-to-end validate through the REAL app: spawn `auditaria --web` in
     a PTY, drive it over the WebSocket (`user_message`,
     `provider_pty_input` incl. focus/mouse events, `provider_pty_resize`),
     and judge restarts by `provider_pty_state` transitions — NOT by TUI
     banner text (the banner re-renders on every resize).
- **Code Marking**: `// AUDITARIA_PROVIDER_TERMINAL` or `_START/_END` blocks.

### 23. Hive Mind (Multi-Machine Agent Messaging)

- **Implementation**: Several Auditaria instances belonging to the SAME user —
  on the same or different machines — discover each other and exchange messages
  **hands-free** (no human relaying). Foreign agent CLIs (Claude Code, Codex,
  Gemini CLI, Copilot) join the same hive via a small stdio MCP shim. Zero
  hosting cost, no account (Mode A). Full design in `hive-mind-plan.md`; user
  docs in `docs/hive.md`.
- **Topology (Mode A, v1)**: hub-and-spoke. One node runs an embedded relay
  (`HiveHub`, in-process `node:http` + `ws`) fronted by a **cloudflared quick
  tunnel** (`https://<rand>.trycloudflare.com`). The hub machine is also a
  normal peer (its own `HiveService` connects over loopback). Mode B (a
  Cloudflare Worker+DO for a stable URL) is a documented later phase, not built.
- **Trust default is `open`** (`trustPolicy: 'open'`): passphrase possession
  grants FULL trust — the right setting for private same-user testing. Stricter
  `invite` (single-use tokens carrying a trust level) and `manual` policies
  exist via `~/.auditaria/hive.json`.
- **The hard tool gate (the safety boundary, §7.3)**: hive-triggered turns run
  in `HiveService`'s own headless agent loop (the Telegram/Teams pattern) with
  its OWN `Scheduler`. A **deterministic in-code check** — not prompt
  engineering — declines state-changing tool calls (Kind Edit/Delete/Move/
  Execute, plus browser/agent-session/collab-writing, plus unknown-provenance
  MCP tools) for turns triggered by a NON-trusted (`consult`) peer, synthesizing
  a "not permitted — local approval required" functionResponse. Messaging,
  replies, reads, searches are NEVER gated. Trusted peers bypass the gate
  entirely (fully hands-free). When an external provider drives the session,
  tool execution is inside that CLI where the gate can't reach — so non-trusted
  peers wait for `/hive deliver` there.
- **Hive objects (August 2026)**: hub-authoritative shared/private state
  records (resources, checklists, roadmaps, notes) — the structured
  alternative to negotiating in chat. `hive_object` tool (native Bridgeable +
  shim) with actions create/update/get/list/history/delete; free-form `type`,
  `status`, agent-defined JSON `attributes` (8KB, shallow-merge, null deletes
  a key), and a capped per-object history where every change records
  who/when/what + an observation `note`. Deliberately QUIET: object changes
  never generate hive mail or wake watchers (announce via hive_send when
  urgent). Mutations need full trust; structural changes + delete are
  owner-only; private = owner-only visibility. Engine is pure/core-free in
  `services/hive/hiveObjects.ts` (applyObjectOp + shared formatters, 10 unit
  tests); hub persists `hub/objects.json` and handles the new `obj` wire op
  (`obj-result`); `HiveWireClient.object()`; `/hive objects` lists for
  humans. Live-validated: real Sonnet agent created the GPU resource, a
  second peer freed it with a note, Sonnet read the v1→v2 history back.
- **start/join split + non-blocking start (August 2026)**: `/hive start` now
  ONLY hosts the hub (no self-join, no instance lock) and returns
  immediately — tunnel startup runs in the background and the invite line
  arrives as an async info message (pushHiveToCliDisplay). `/hive join` (now
  also arg-less: joins the saved/local hive, preferring loopback via
  hub-info) is the explicit act of participating; new `joined` config flag
  (grandfathered true when undefined) drives autoconnect (hub restart and
  peer rejoin are independent intents), `/hive leave`/`reset` clear it.
  Invites + status work hub-only (`/hive status` shows "hosting, not a
  peer" + roster).
- **Turn-boundary delivery (the receive path, §6.1)**: inbound messages are
  fsynced to a local JSONL inbox (custody chain), then handed to the model only
  at a genuine boundary — UI `StreamingState.Idle` (published from
  `AppContainer` via `HiveBridge.publishStreamingIdle`) AND
  `ProviderManager.isTurnActive() === false` (covers turns typed directly into
  a live provider PTY, invisible to StreamingState) AND the service's own mutex
  free. `hive_check` lets the model drain its inbox mid-turn (drained ==
  processed, never delivered twice).
- **Reliability / custody chain (§5.2)**: sender spool → relay queue → receiver
  inbox, each durably owned by exactly one party. Append-only JSONL + fsync (NO
  Maildir renames — Windows-antivirus-safe). At-least-once + persisted ULID
  dedup (retention outlives max TTL); idempotent acks; relay-assigned per-
  recipient sequence for ordering; per-peer queue depth cap → DLQ; relay-clock
  TTL sweep + receiver-side TTL; hub restart restores queues from disk.
- **Transport auth (§7.1)**: DSS-ported PBKDF2-SHA256(600k)→HKDF→AES-256-GCM
  mutual challenge-response over an unguessable URL token, static per-hive salt
  with cached master key, per-connection challenge freshness, IP-keyed lockout
  (loopback exempt), capped concurrent unauthenticated conns. Identity:
  per-node ed25519 keypair, relay TOFU-binds `nodeId ↔ fingerprint`; the
  relay's own fingerprint is pinned client-side on first join and verified on
  every reconnect (survives Mode A's changing URL).
- **Envelope** designed for chat AND structured interactions (votes/polls) from
  day one; `to:"*"` broadcast doubles as the hive chat (human via
  `/hive send *`); replies to broadcasts are direct by default (no cascade);
  `fromAgent`/`toAgent` present so sub-agent exposure (later phase) needs no
  wire break.
- **Files Created** (all new, no upstream conflicts):
  - `packages/cli/src/services/hive/`: `types.ts`, `HiveCrypto.ts`,
    `HiveStore.ts`, `HiveTunnel.ts`, `HiveHub.ts`, `HiveWireClient.ts`,
    `HiveService.ts`, `HiveBridge.ts`, `hivePolicy.ts` (core-import-free invite
    parsing + tool-gate decision, for isolated testing), `hiveShim.ts`
    (core-free per-instance shim state — August 2026) + tests
    (`HiveCrypto.test.ts`, `HiveStore.test.ts`, `HiveService.test.ts`,
    `HiveHub.test.ts`, `hiveShim.test.ts`, `hiveShimE2e.test.ts` — 78 tests,
    incl. real hub↔client and spawned-shim e2e suites)
  - `packages/cli/src/ui/commands/hiveCommand.ts` — the `/hive` command +
    `autoConnectHive` / `stopHiveIfRunning`
  - `packages/cli/src/hive-mcp/hiveMcpMain.ts` → `bundle/hive-mcp.js` — the
    foreign-client shim. **Reworked August 2026 — foreign agents are
    first-class peers**: per-instance identity/nickname/credentials/inbox at
    `~/.auditaria/hive/shim/<key>` (cwd-keyed like Auditaria peers; `--instance`
    flag / `AUDITARIA_HIVE_INSTANCE` override; PID-lock fallback to `<key>_2`
    for a second session in the same dir — the hub displaces duplicate
    nodeIds, so distinct identities are mandatory). Registration needs NO args
    (`claude mcp add --scope user hive -- node …/hive-mcp.js`); the agent joins
    at runtime via `hive_join_local` (ZERO config on any machine where the
    hive runs — discovers the hub-info file + local Auditaria instances'
    saved connections, prefers the hub-hosting instance, swaps in the
    loopback URL; same-user filesystem = same trust domain) or `hive_connect`
    (invite line pasted into chat, for remote hives; credentials persist per
    instance, auto-rejoin next session; env-sourced passphrases never
    persisted). Tools: `hive_join_local`/`hive_connect`/`hive_status`/
    `hive_send` (now with `wait_for_reply_sec` ≤600s, mirroring the native
    tool's reply-waiter semantics)/`hive_check`/blocking `hive_wait`/
    `hive_describe`/`hive_leave` + one-shot `--check` hook nudge (safe beside a
    live shim: read-only inbox peek instead of stealing the hub connection).
    **Monitoring**: `--watch` mode — silent read-only inbox poll beside the
    live shim that EXITS printing "HIVE: N unread…" the moment any
    message/broadcast/vote lands (exit-on-mail wakes agents whose harness
    notifies on background-command completion, e.g. Claude Code Bash
    run_in_background/Monitor; never claims the instance, self-ends when the
    live shim dies); the MCP Server `instructions` field teaches agents the
    watcher recipe with the exact per-instance command. Per-instance state
    helpers in core-free `services/hive/hiveShim.ts` (+ 16 unit tests);
    PID-lock primitives moved to `hivePaths.ts` (shared with hiveCommand) and
    hardened to atomic 'wx'-exclusive create (the old check-then-write raced
    on simultaneous starts → shared identity/nickname); real-spawn e2e in
    `hiveShimE2e.test.ts` (2 shims + real hub: runtime join, ping/pong with
    wait_for_reply, `_2` fallback, persisted rejoin, watcher exit-on-mail,
    served instructions). Validated live with real `claude -p` sessions
    (distinct cwd-keyed identities, offline queue, cross-agent
    wait_for_reply Q&A, 4-way same-folder lock fallback)
  - `packages/core/src/tools/hive.ts` — `hive_connect`/`hive_send`/
    `hive_status`/`hive_check` tools (`Bridgeable=true`) + the module-level
    `registerHiveTransport(cb)` core→cli seam (precedent: `providerPtyMirror`).
    `hive_wait` is deliberately shim-only (a blocking tool in the core registry
    would hang main-session turns).
  - `packages/cli/vitest.hive.config.ts` — lean config to run the hive suites
    in isolation (the default cli config's `test-setup.ts` imports core, which
    currently fails to load under plain ESM via a pre-existing
    core→browser-agent→core circular import; the hive modules import no core
    code, so they run cleanly without it).
  - `docs/hive.md` — per-mode user instructions.
- **Files Modified** (minimal, all marked `// AUDITARIA_HIVE_FEATURE` or
  `_START/_END`):
  - `core/src/tools/tool-names.ts` — `HIVE_*_TOOL_NAME` constants
  - `core/src/config/config.ts` — import + `maybeRegister` the four hive tools
  - `core/src/index.ts` — export `registerHiveTransport`/`getHiveTransport` +
    the `Hive*Params`/`HiveTransport` types
  - `core/src/providers/providerManager.ts` — `isTurnActive()` (turnActive flag
    set in `handleSendMessage` + `compactNative`, plus a 15s recent-background-
    activity window for PTY-typed turns)
  - `core/src/providers/agent-session-manager.ts` — hive tools added to
    `ALWAYS_EXCLUDED_TOOLS` (sub-agents can't speak as the node itself)
  - `cli/src/services/BuiltinCommandLoader.ts` — register `hiveCommand`
  - `cli/src/gemini.tsx` — `autoConnectHive` + cleanup
  - `cli/src/ui/AppContainer.tsx` — hive display callback + the idle-signal
    `useEffect` (`StreamingState.Idle` → `publishStreamingIdle`)
  - `cli/src/services/telegram/TelegramService.ts` — corrected the misleading
    "mutex blocks CLI turns" doc-comments (drive-by; the mutex only serializes
    Telegram's own turns — the reason the hive needed its own idle signal)
  - `esbuild.config.js` — `bundle/hive-mcp.js` entry (non-fatal)
- **Reliability hardening (3-lens adversarial review, July 2026)**: the
  reliability lens found a critical custody-chain hole (drainNext acked the
  inbox entry BEFORE running the turn → loss on crash-mid-turn, duplicate on
  crash-after-turn). Fixed to process-FIRST → durable `processedSeen`
  (`processed.jsonl`) → inbox ack → processed ack, with an in-memory
  `inProgress` guard so a mid-turn `hive_check` can't re-surface the active
  message (and crash still reprocesses, at-least-once). Also fixed: reply
  waiter now matches thread AND expected sender; `flushOutbox` acks only on
  delivered/queued (was unconditional → spooled-message loss); dedup re-ack
  respects the processed level; hub broadcast processed-receipts fire per-peer;
  `send()` returns success so `tryDeliver` can't strand an in-flight entry;
  sweeps skip in-flight/in-progress entries; `canDeliverNow` also yields while
  Telegram/Discord/Teams are mid-turn (shared GeminiClient).
- **Security + turn-boundary review (2nd round, Opus 4.8)**: hub binds
  127.0.0.1 (was 0.0.0.0); loopback lockout-exemption keys on the real socket
  address, not the spoofable `cf-connecting-ip`; pre-auth WS `maxPayload` cap;
  prompt fence hardened (validated `kind`, `sanitizeInline` on `from`/`thread`,
  `data` moved inside the fence, `trust` attribute); `/hive remove` documents
  passphrase rotation for real revocation; consult-reads/secret-exfil residual
  documented in `docs/hive.md` (prefer `AUDITARIA_HIVE_PASSPHRASE` env).
  Turn-boundary: `isHiveProcessing()` was dead — Telegram/Discord now defer to
  it; dangling-functionCall backfill in `processEnvelope`; `drainNext`
  restructured (lock-leak fix, `approvedOnce` consumed post-guard, hold-gate +
  trust re-validated against the actual post-lock entry via the live roster);
  reply-waiter matches only chat/response; `stop()` aborts a turn mid-stream.
  47 hive tests green (`vitest.hive.config.ts`), build + bundle + typecheck +
  lint clean.
- **Code Marking**: `// AUDITARIA_HIVE_FEATURE` or `_START/_END` blocks.

### 24. Artifacts (Claude-Code-compatible published pages, self-hosted)

- **Implementation**: The agent publishes HTML/Markdown pages as
  **artifacts** hosted by Auditaria's own web server, mirroring Claude
  Code's Artifact tool 1:1 (same tool actions and parameter names, the same
  page runtime `window.claude.use(name)`, the same authoring rules) so a
  page written for either host publishes on the other unchanged. User docs:
  `docs/artifacts.md`. Research + decisions: `.auditaria/artifacts-research/`
  (`00-requirements-matrix.md`, `09-empirical-probe.md` = what Claude's
  host verifiably does, `13-final-plan.md`).
- **Tool**: `artifact` (`packages/core/src/tools/artifact.ts`, Bridgeable →
  every provider gets it). Actions publish (default) / list / read / status /
  watch / unwatch / delete / comments / reply / resolve / read_db / write_db /
  upload_asset / list_assets / read_asset / delete_asset; `list_types` and
  `resume_replies` answer with guidance. Session-scoped file-path→artifact
  map (same path = redeploy), base-version tracking, compare-and-set
  conflicts that hand back the live source, `force`, favicon/title/
  description/label rules, JSON-string card sentinel for the UIs. Prompts
  on first publish per session, capability change and force; reads never.
  `AUDITARIA_DISABLE_ARTIFACT=1` removes it; `AUDITARIA_ARTIFACT_AUTO_OPEN=0`
  stops the first-publish browser open.
- **Hosting**: each artifact on its OWN origin `http://art-<id>.localhost:<port>/`
  (browsers resolve `*.localhost` to loopback without DNS → isolated
  storage). Transport core gained **virtual hosts** (`WebHttpServer.mountHost`,
  first middleware, console routes never fall through), a **host-aware
  WebSocket upgrade policy** (`judgeUpgrade` in `webSocketHub.ts`: the chat
  socket is unreachable from an artifact origin; console upgrades need a
  loopback `Origin` on the bound port — closes DNS rebinding), **dual
  loopback bind** (`localhost` = 127.0.0.1 AND ::1), `WebFeature.onListening`,
  a sandbox CSP on `/preview-file`, `frame-ancestors 'self'` on the console.
  Documents are the stored fragment wrapped at SERVE time with Claude's
  exact skeleton + a head-first `<!-- frame-runtime -->` block and Claude's
  live CSP header verbatim (`frame-ancestors` → our console origins);
  `AUDITARIA_ARTIFACT_CDN=0` drops the script CDNs for fully-offline use.
- **Store**: per project `<config dir>/artifacts/<id>/` — `artifact.jsonl`
  (append-only history), write-once `versions/<n>.html|md`, `db.jsonl`,
  `comments.jsonl`, `assets/` (+manifest). No native deps; the JSONL +
  fsync + write-once pattern is Windows-safe. Soft delete → 7-day trash.
  Owner identity `~/.auditaria/artifacts-owner.json`. Core module
  `packages/core/src/artifacts/` (types, artifactPaths, journal, htmlShell,
  artifactStore, identity, artifactService [per-Config state + core→CLI
  host seam], dbEngine [pure contract: path grammar, bodies, merge, query,
  rules lattice, leases], dbStore, comments, assets, sampleExecutor).
- **Runtime capabilities** (served): `artifact`/`self` (page publishes a
  new version, CAS on the loaded version), `db` (Firestore-like store with
  live `onSnapshot` over ONE per-page WebSocket `/__runtime/live`, viewer
  rules + `{self}` privacy applied on every call, ≤64 subscriptions/view,
  5,000 docs, batches atomic), `user`, `assets` (`/__assets/<id>`),
  `downloads` (server-mediated: page → offer → console Save/Decline →
  one-time `/__downloads/<token>` attachment; standalone tabs save
  themselves), `sample` (headless tool-less one-shot through the active
  provider — Gemini content generator or a consult sub-agent session —
  gated by a per-artifact owner consent bar; `AUDITARIA_ARTIFACT_SAMPLE=0`
  refuses). `room`/`mcp` accepted in declarations, `use()` → null.
  Page runtime: `packages/web-client/src/artifacts/runtime/claude.js`
  (non-writable `window.claude` with only `use`, frozen null-proto
  namespaces, sync throws → rejections, `window.auditaria` alias).
- **Sharing (Publish button)**: `services/web/artifacts/shareSession.ts` —
  an in-memory `ShareSession` per artifact: its own Express listener on
  `127.0.0.1:0` knowing ONE artifact, fronted by the hive's cloudflared
  quick tunnel; `/s/<token>` mints an HttpOnly cookie, everything else is
  404 without it; no capability grants (read-only). Nothing persists (only
  the tunnel ORIGIN is journaled, never the token); torn down on Unpublish,
  stop and process exit (`registerCleanup`). The viewer states plainly that
  the link lasts only for this session. Test gotcha: this LAN's resolver
  returns no A record for a fresh `*.trycloudflare.com` name for minutes —
  tests reach the tunnel via the apex's anycast IPv4 + SNI.
- **UIs**: web (`web-client/src/artifacts/{ArtifactsManager,ArtifactsPanel}.js`,
  `styles/artifacts.css`, rail button, tool card in ToolRenderer): gallery
  (search, pin, copy, delete), viewer (iframe sandbox exactly
  `allow-scripts allow-same-origin allow-forms`, version picker, restore,
  open in tab, copy link, Publish/Unpublish + share bar, Comments sidebar,
  download-offer and model-consent bars; the frame is KEPT across chrome
  refreshes — `renderedFrameBase`/`refreshViewerChrome`). The address the
  tool prints and every UI copies is the VIEWER deep link
  `http://localhost:<port>/artifact/<id>[?v=N]` (served as the console
  shell by a route in `WebInterfaceService`; `client.js` opens the viewer
  from the path once connected), so a direct link carries the chrome like
  Claude's; the bare page URL is named beside it. CLI: a session strip
  under the footer (`ui/components/ArtifactStrip.tsx`, mounted in
  `Composer.tsx`: this session's artifacts as OSC-8 links, `ctrl+]` opens
  the most recent; follows `ArtifactService.onSessionChange`),
  `/artifacts` picker after Claude Code's (`enter attach · o open · c copy
  url · s share · d delete · p pin · / search · esc`) + subcommands
  list/open/copy/attach/share/unshare/delete/restore
  (`ui/commands/artifactsCommand.tsx`; share goes through the core→CLI
  `ArtifactHost.share/unshare/shareUrlOf` seam), Ink card
  `ArtifactCardDisplay.tsx`, notices (page republish, comments sent) as
  info items via `WebInterfaceService` `artifact_notice`. Tool extras past
  Claude's contract, from an agent's review: `publish` takes `assets`
  (files attached in the same call, referenced as `/__assets/<file name>`
  from the first version), `read` takes `out_dir`, results name the base
  version, `list` shows capabilities and STALE bases; the description is
  compact and the action reference lives in the schema's parameter
  descriptions (MCP consumers see those in full).
- **Wire protocol** (`protocol.ts`): server `artifact_list/_event/
  _versions_response/_open/_share_state/_comments_response/_comment_event/
  _download_offer/_sample_consent_request`; client `artifact_list/_versions/
  _update(op: rename|pin|pin_version|restore_version|sample_consent)/
  _delete/_restore/_share(op: start|stop)/_comments/_comment(op: create|
  reply|activate|resolve|reopen)_request`, `artifact_download_decision`.
- **Skills**: built-in `artifact-design` + `artifact-capabilities`
  (`packages/core/src/skills/builtin/`, copied to `bundle/builtin`).
- **Files Modified** (minimal, all marked `// AUDITARIA_ARTIFACTS` or
  `_START/_END`): `core/tools/tool-names.ts`, `core/config/config.ts`
  (`getArtifactService()` + sampler, `getArtifactAutoOpen()`, registration),
  `core/index.ts` (exports), `cli/services/web/{WebInterfaceService.ts,
  protocol.ts, core/*}` (transport foundations, marked WEB_INTERFACE),
  `cli/ui/AppContainer.tsx` (service handoff + notices),
  `cli/ui/components/messages/ToolResultDisplay.tsx`,
  `cli/services/BuiltinCommandLoader.ts`, `web-client/src/{index.html,
  client.js, components/ToolRenderer.js}`.
- **Tests**: core unit (`src/artifacts/*.test.ts`, `src/tools/artifact.test.ts`),
  cli web unit (`vitest.web.config.ts`, incl. transport policy + share
  session), and three live checks through the bundled app kept in the
  session scratchpad pattern: server e2e (PTY + tool executor + WebSocket,
  incl. a REAL tunnel round trip), Playwright/Chrome gallery-viewer-runtime
  check (incl. a real download), and a PTY `/artifacts` check.
- **Code Marking**: `// AUDITARIA_ARTIFACTS` or `_START/_END` blocks in
  cli/core; new web files carry the `WEB_INTERFACE_FEATURE` header.

## Web Interface Code Marking System

To facilitate merges with upstream and potential feature removal, all web
interface code is marked with special comments:

### Marking Types

1. **New Files** (entire file is for web interface):
   ```typescript
   // WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
   ```
2. **Modified Files** (specific sections):

   ```typescript
   // WEB_INTERFACE_START: Description of what this section does
   ... web interface code ...
   // WEB_INTERFACE_END
   ```

3. **Modified Files** (single line):
   ```typescript
   ... web interface code ... // WEB_INTERFACE: Description of what this section does
   ```
   **These markers should be used when changing /cli or /core files. They should
   _NOT_ be used when changing /web-server or /web-client, since we already know
   they are web implementation**

### Files with Web Interface Code

- **New files**: WebInterfaceService.ts, webCommand.ts, WebInterfaceContext.tsx,
  useWebCommands.ts, browserUtils.ts, all Context files
- **Modified files**: package.json, config.ts, gemini.tsx, AppContainer.tsx,
  App.tsx, Footer.tsx, LoadingIndicator.tsx, and various hooks

### During Merges

When merging with upstream:

1. You can search for `WEB_INTERFACE` to quickly identify all web-related code
   in case of conflicts
2. Preserve all marked sections during conflict resolution
3. If upstream modifies areas near web interface code, integrate carefully

## Major Architectural Changes

### AppContainer Refactoring (Commit 885af07 - January 2025)

A significant architectural refactoring was merged from upstream that
fundamentally changed how the application is initialized and structured:

**What Changed:**

1. **New AppContainer Component** (`packages/cli/src/ui/AppContainer.tsx`):
   - Centralizes all state management previously scattered across `App.tsx`
   - Contains all React context providers (UIContext, UIStateContext,
     UIActionsContext, ConfigContext, etc.)
   - Manages application lifecycle and initialization results

2. **Pre-render Initialization System**:
   - `packages/cli/src/core/initializer.ts` - Orchestrates startup tasks before
     React renders
   - `packages/cli/src/core/auth.ts` - Handles authentication flow before UI
   - Returns `InitializationResult` passed to `AppContainer`

3. **Provider Hierarchy Changes**:
   - **Before**: All providers inside `App.tsx`, web interface embedded within
   - **After**: Providers in `AppContainer.tsx`, web interface wraps from
     outside in `gemini.tsx`
   - **Pattern**: `WebInterfaceProvider` → `KeypressProvider` →
     `SessionStatsProvider` → `VimModeProvider` → `AppContainer`

4. **Context System**:
   - New `UIContext` provides centralized UI state and actions via `useUI()`
     hook
   - `UIStateContext` - Read-only UI state
   - `UIActionsContext` - UI state modification functions
   - Replaces prop drilling throughout component tree

**Impact on Our Fork:**

- Web interface integration point moved from inside `App.tsx` to wrapping
  `AppContainer` in `gemini.tsx`
- `WebInterfaceProvider` must wrap the entire provider chain
- Web interface parameters (webEnabled, webOpenBrowser, webPort) now passed to
  `AppContainer`
- Language selection hook `useLanguageCommand` integrated into `AppContainer`

**Migration Notes:**

- If adding new providers, add them inside `AppContainer.tsx` or in the wrapper
  chain in `gemini.tsx`
- State management should use `UIContext` system, not direct prop drilling
- Web interface state syncing now uses context from `WebInterfaceProvider`

## Important Development Rules

### 1. Sync Process

- **Use sync script**: `./scripts/sync-upstream.sh [N]` for automated syncing
- **Script handles**: Safety check + auto-merge until conflict
- **Preserve all custom features** during conflict resolution
- **Follow KISS, DRY, YAGNI principles** for minimal invasive changes
- **Version bumps**: Always apply to keep synced with upstream
- **Verify build** after sync: `npm install && npm run build`

### 2. i18n Guidelines (Build-Time Transformation)

- **No manual wrapping**: Don't add `t()` calls to source code - the build
  transformer does this automatically
- **Keep source clean**: Write natural English text in JSX:
  `<Text>Hello World</Text>`
- **ESBuild config**: Preserve i18n-transform plugin in build configuration
- **Documentation**: See `packages/core/src/i18n/README.md` for full details

### 3. Build Commands

- **Lint**: `npm run lint`
- **Type check**: `npm run typecheck`
- **Build**: `npm run build`
- **Test**: `npm run test`

### 4. Planning the new feature

When the user tells you to add a new feature and asks for planning, these are the instructions for planning you will follow:
```planning instructions
You are going to investigate our code to figure our the best, most elegant way to implement this.  

Then, before starting your task, you will read the related files and plan how to achieve it, following our development principles.
You should have a planning phase and an execution phase.
These are the rules for you planning phase.
Begin by enclosing all thoughts within <thinking> tags, exploring multiple angles and approaches.
Break down the solution into clear steps within <step> tags. Start with a 20-step budget, requesting more for complex problems if needed.
Use <count> tags after each step to show the remaining budget. Stop when reaching 0.
Continuously adjust your reasoning based on intermediate results and reflections, adapting your strategy as you progress.
Regularly evaluate progress using <reflection> tags. Be critical and honest about your reasoning process.
Assign a quality score between 0.0 and 1.0 using <reward> tags after each reflection. Use this to guide your approach:

0.8+: Continue current approach
0.5-0.7: Consider minor adjustments
Below 0.5: Seriously consider backtracking and trying a different approach

If unsure or if reward score is low, backtrack and try a different approach, explaining your decision within <thinking> tags.
For mathematical problems, show all work explicitly using LaTeX for formal notation and provide detailed proofs.
Explore multiple solutions individually if possible, comparing approaches in reflections.
Use thoughts as a scratchpad, writing out all calculations and reasoning explicitly.
Synthesize the final answer within <answer> tags, providing a clear, concise summary.
Conclude with a final reflection on the overall solution, discussing effectiveness, challenges, and solutions. Assign a final reward score.

Then, give me the full steps you are going to need to do you task.

This ends the planning phase.
You will stop after the planning phase so I can approve your plan.
After that, in the execution phase, write the codes with your implementation.
```

## File Structure

### Key Directories

- `packages/cli/` - Main CLI package
- `packages/cli/src/core/` - Core initialization logic (auth, theme,
  initializer)
- `packages/cli/src/ui/` - UI components and React code
- `packages/cli/src/ui/contexts/` - React context providers
- `packages/core/` - Core functionality package
- `packages/core/src/providers/` - Alternative LLM provider abstraction (Claude,
  Codex)
- `packages/core/src/i18n/` - Internationalization files
- `packages/browser-agent/` - Browser automation package (Stagehand-based)
- `packages/search/` - Knowledge search package (indexing, embeddings, search)
- `packages/web-client/` - Web interface client (React)
- `packages/cli/src/services/telegram/` - Telegram bot integration
- `packages/cli/src/services/discord/` - Discord bot integration
- `packages/cli/src/services/teams/` - Microsoft Teams webhook integration
- `stagehand/` - Forked Stagehand with OAuth and pause/resume support
- `docs/` - Documentation

### Important Files

- `package.json` - Root package configuration
- `packages/cli/package.json` - CLI package configuration
- `packages/cli/src/gemini.tsx` - Main entry point with provider wrapping
- `packages/cli/src/ui/AppContainer.tsx` - Core app container with state
  management
- `packages/cli/src/core/initializer.ts` - Pre-render initialization
- `packages/cli/src/ui/App.tsx` - Main UI component
- `packages/core/src/i18n/locales/pt.json` - Portuguese translations (English is
  source/fallback)
- `packages/core/src/i18n/README.md` - i18n system documentation
- `scripts/i18n-transform/` - Build-time i18n transformation plugin (directory)
- `scripts/sync-upstream.sh` - Automated upstream sync script (safety check +
  auto-merge)
- `packages/core/src/tools/context-management.ts` - Context management tools
  implementation
- `packages/browser-agent/src/browser-agent-tool.ts` - Browser agent tool
  implementation
- `packages/browser-agent/src/stagehand-adapter.ts` - Stagehand abstraction
  layer
- `browser-agent-implementation-plan.md` - Full browser agent technical
  documentation
- `packages/core/src/providers/providerManager.ts` - LLM provider orchestrator
- `packages/core/src/providers/claude/claudeCLIDriver.ts` - Claude CLI driver
- `packages/core/src/providers/codex/codexCLIDriver.ts` - Codex CLI driver
- `.auditaria/claude-provider-plan.md` - Claude provider technical plan

## Development Notes

### On coding tasks, follow these principles

**Core Principles:**

- **DRY (Don't Repeat Yourself)**: Extract common logic into reusable functions.
  Avoid copy-pasting code blocks.
- **KISS (Keep It Simple, Stupid)**: Prefer simple, readable solutions over
  clever ones. If a solution feels complex, step back and look for simpler
  alternatives.
- **YAGNI (You Aren't Gonna Need It)**: Don't implement features "just in case".
  Only build what's currently needed.
- **Minimal invasion principle**: Make minimal changes to `/cli` and `/core`
  packages. This reduces merge conflicts when syncing with upstream. When adding
  features:
  1. Implement 99% of logic in NEW files with distinct names
  2. Only add minimal integration points to existing files
  3. Mark integration points with `// AUDITARIA:`, `// AUDITARIA_FEATURE: description` `// WEB_INTERFACE:` comments, or blocks of `// AUDITARIA_FEATURE_START` AND `// AUDITARIA_END` so we can identify them
  4. You don't mark files on the web-server and web-client, since they are our own implementation.
- **File creation balance**: New files don't cause merge conflicts, but minimize
  file count where reasonable. One well-organized file is better than five tiny
  files.
- **Best location principle**: Place new files in appropriate directories
  following the existing structure. Study where similar functionality lives in
  upstream.

**Code Quality Standards:**

- **Analyze alternatives**: Before implementing, consider 2-3 different
  approaches. Evaluate trade-offs (complexity, performance, maintainability) and
  choose the best fit.
- **Modularity**: Design code as independent, self-contained modules that can be
  tested and modified in isolation.
- **Reusability**: Write functions and components that can be reused across the
  codebase. Avoid hardcoding values that could be parameters.
- **Maintainability**: Write code that future developers (including AI) can
  easily understand and modify. Prioritize clarity over brevity.
- **Follow existing patterns**: Study the upstream codebase style and patterns.
  Match naming conventions, file organization, error handling patterns, and
  coding style used in similar files.

**Before Writing Code:**

1. Read and understand the relevant existing code
2. Identify the best approach considering the principles above
3. Identify best practices of the area, analyze comprehensively and compare them, with pros and cons, and giving suggestions
4. Consider how upstream changes might affect your implementation
5. Plan for minimal integration points with existing code

**Before Writing Code:**

1. Read and understand the relevant existing code
2. Identify the best approach considering the principles above
3. Consider how upstream changes might affect your implementation
4. Plan for minimal integration points with existing code

### When Syncing Upstream

1. **Use the sync script**: `./scripts/sync-upstream.sh [N]` (recommended)
2. **Script auto-merges** commits one by one, preserving 1-1 history
3. **Script stops** when: dangerous commit (file deletion/rename), conflict, or done
4. **On stop**: Resolve manually with `git show <hash>`, then run script again
5. **Resolve conflicts** preserving our custom features
6. **No co-authored lines** - keep commits clean
7. **Verify build**: `npm install && npm run build`

### Common Conflict Areas

- **Package names**: Most common conflict - change `@google/gemini-cli` to `@thacio/auditaria-cli` on package.json (but NOT `-core`)
- **Telemetry-related code**: External telemetry is disabled in the fork
- **ESBuild configuration**: KEEP our i18n-transform plugin - this is critical
  for automatic i18n
- **Command names and branding**: `gemini` → `auditaria`, "Gemini CLI" → "Auditaria CLI"
- **Authentication flows**: May have custom modifications for audit features
- **Web Interface Code**: Look for `WEB_INTERFACE` markers - preserve all marked sections during merges
- **AppContainer and Provider Hierarchy**: Changes to `gemini.tsx`, `AppContainer.tsx`, or `App.tsx` require careful merging to maintain our web interface provider wrapping pattern
- **Context System**: Changes to context providers or hooks may need integration with our `WebInterfaceContext` and language selection features
- **Initialization System**: Changes to `core/initializer.ts` or `core/auth.ts` must preserve our custom initialization
- **Provider Integration Code**: Look for `AUDITARIA_CLAUDE_PROVIDER`,
  `AUDITARIA_CODEX_PROVIDER`, `AUDITARIA_COPILOT_PROVIDER`, and
  `AUDITARIA_AGY_PROVIDER` markers in `client.ts`, `config.ts`, `snippets.ts`,
  `context-management.ts`, `tokenLimits.ts`, `models.ts`,
  `providerAvailability.ts`, `providerManager.ts`, `agent-session-manager.ts`,
  `agent-session.ts`, `ModelDialog.tsx`, `modelCatalog.ts`, and
  `AppContainer.tsx` — preserve all marked sections
- **Messaging Integration Code**: Look for `AUDITARIA_TELEGRAM_FEATURE`,
  `AUDITARIA_DISCORD_FEATURE`, and `AUDITARIA_TEAMS_FEATURE` markers in
  `gemini.tsx`, `AppContainer.tsx`, `config.ts`, `useHistoryManager.ts`, and
  `BuiltinCommandLoader.ts` — preserve all marked sections

## Recent Major Changes

### November 2025 - i18n Build-Time Transformation

- **Change Type**: Complete refactoring of i18n approach
- **Approach**: Automatic build-time transformation via ESBuild plugin
- **Key Benefits**:
  - Source code stays clean (no `t()` calls needed)
  - Fewer merge conflicts with upstream
  - Automatic string extraction and transformation
- **Files Added**:
  - `scripts/i18n-transform/` - ESBuild plugin and Babel transformer
  - `scripts/i18n-workflow.py` - Unified translation workflow
  - `scripts/i18n-translate.py` - LLM-based auto-translation
  - `packages/core/src/i18n/README.md` - Full documentation

### January 2025 - AppContainer Refactoring

- **Commits**: 1a6548e (Merge '885af07'), 47277da, fb5414569, 1f53686ba
- **Change Type**: Major architectural refactoring from upstream
- **Impact**: Complete restructuring of component hierarchy and state management
- **Files Affected**: Created `AppContainer.tsx`, `core/initializer.ts`,
  `core/auth.ts`, new context files
- **Fork Adaptations**: Moved web interface providers to wrap AppContainer from
  outside, integrated language selection hook

### December 2025 - Browser Agent (AI-Driven Browser Automation)

- **Commit**: `e644682` - feat(browser-agent): implemented browser-agent
- **Change Type**: New major feature - AI-controlled browser automation
- **Impact**: Adds `browser_agent` tool for autonomous web browsing tasks
- **Stats**: 41 files changed, 11,144 insertions, 3,752 deletions
- **Key Capabilities**:
  - Navigate, act, extract data, take screenshots
  - Autonomous multi-step tasks with `agent_task` action
  - Live browser streaming to web interface (CDP screencast)
  - Pause/Resume/Stop control during execution
  - Takeover mode for manual intervention
- **New Package**: `packages/browser-agent/` - Complete browser automation module
  (15 new files, ~4,000 lines)
- **Web Client**: 4 new components (BrowserStreamViewer, BrowserAgentControls,
  etc.)
- **CLI**: BrowserStepDisplay component for terminal output
- **Stagehand Fork**: `stagehand/` with OAuth support and pause/resume callbacks
- **Authentication**: Works with OAuth, Gemini API key, and Vertex AI

### February 2026 - Alternative LLM Providers (Claude Code)

- **Change Type**: New major feature — provider abstraction with Claude Code as
  first alternative backend
- **Impact**: Users can switch between Gemini and Claude at runtime via `/model`
- **Key Components**:
  - Provider abstraction in `packages/core/src/providers/`
  - Claude CLI driver spawning `claude --output-format stream-json`
  - MCP tool bridge exposing Auditaria tools to Claude
  - History mirroring, context compaction, and provider switching
- **Fork Adaptations**: 5-line interception in `client.ts`, minimal changes to
  `config.ts`, `snippets.ts`, `context-management.ts`, `ModelDialog.tsx`
- **Tests**: 48 unit tests across 3 test files

### February 2026 - Alternative LLM Providers (OpenAI Codex)

- **Change Type**: New major feature — third provider using OpenAI Codex CLI
- **Impact**: Users can switch between Gemini, Claude, and Codex via `/model`
- **Key Components**:
  - Codex CLI driver spawning `codex exec --json` subprocess
  - MCP tools via `~/.codex/config.toml` injection (AUDITARIA_MCP markers)
  - Item-based event parsing with accumulated text delta tracking
- **Models**: read live from `models_cache.json` (see Section 13); static
  fallback currently GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, GPT-5.4 Mini
- **Known behavior**: Codex truncates tool outputs to ~10K tokens internally
- **Tests**: 19 unit tests

### February 2026 - Alternative LLM Providers (GitHub Copilot)

- **Change Type**: Fourth provider via ACP protocol (`copilot --acp --stdio`)
- **Impact**: Users can switch between Gemini, Claude, Codex, and Copilot
- **Files Created**: `copilot/types.ts`, `copilot/copilotCLIDriver.ts`

### March 2026 - Messaging Platform Integrations (Telegram, Discord, Teams)

- **Change Type**: New major feature — bidirectional messaging platform bots
- **Impact**: Users can interact with Auditaria through Telegram, Discord, and
  Microsoft Teams alongside the CLI
- **Architecture**:
  - **Telegram**: grammY bot with long polling, shared CLI session, edit-in-place
    streaming
  - **Discord**: discord.js bot via gateway, shared CLI session, edit-in-place
    streaming
  - **Teams**: HTTP webhook server with Power Automate bridge, per-thread
    sessions, ngrok tunnels, pluggable response modes (sync/async/pull/hybrid)
- **Common Patterns**: All three use module-level bridge callbacks for
  CLI↔platform display sync, mutex-based processing, access control allowlists,
  autostart from saved config, and single-instance file locking
- **Key Differences**: Telegram/Discord share the CLI's GeminiClient (unified
  conversation); Teams uses per-thread isolated sessions with its own
  GeminiClient per thread
- **New Directories**: `services/telegram/`, `services/discord/`, `services/teams/`
- **Documentation**: `bundle/docs/teams-power-automate-setup.md`

### June 2026 — Claude Turn-Completion Redundancy (dual/triple channel)

- **Change Type**: Reliability hardening of the interactive Claude PTY driver
- **Problem**: With the PTY driver, turn completion was detected ONLY from the
  Stop hook (a `node` relay appending to a JSONL file). On Windows the relay's
  `appendFileSync` races (EBUSY/EPERM) across the separate PreToolUse/PostToolUse/
  Stop processes and silently drops lines; a dropped Stop hung the turn until the
  30-min `STOP_TIMEOUT_MS`. Same bug hit web-terminal background turns and the
  AskUserQuestion PreToolUse hook.
- **Fix**: Added two redundant channels alongside the hook (all in
  `claudeCLIDriver.ts`), first-to-finalize wins:
  - **Channel 2 — transcript-tail**: pure `scanTranscriptDelta()` (exported,
    unit-tested) + `scanTranscriptForTurn()` tail the session JSONL with a
    private cursor, finalize on a settled terminal non-sidechain `stop_reason`,
    and redundantly surface/resolve AskUserQuestion (deduped by `tool_use_id`).
  - **Channel 3 — PTY-scrape idle fallback** (Phase 4): last resort for the
    transcript-not-written regression / TUI slash commands; heavily guarded
    (no open tool, no pending prompt, 20s idle, `❯` in PTY tail).
  - Background watcher mirrors channel 2; relay retries appendFileSync; the
    post-turn backfill keys tool_result skipping on "result already emitted" so
    a dropped PostToolUse can't dangle a functionCall.
- **Kill switches**: `AUDITARIA_CLAUDE_TRANSCRIPT_CHANNEL_DISABLED=1` (channel 2),
  `AUDITARIA_CLAUDE_PTY_SCRAPE_DISABLED=1` (channel 3).
- **Files**: `claudeCLIDriver.ts` (+ markers), new
  `claudeTranscriptDetector.test.ts` (12 tests); stale `claudeCLIDriver.test.ts`
  repointed to the relocated `ClaudeCLIDriverPrint` fallback (11 tests green).
- **Validated**: 3-lens adversarial review (6 defects found + fixed) + fix
  re-verification; `npm run build` + core typecheck + tests pass.

### June 2026 — Claude Web Terminal Mirror + Persistent PTY + Background Watcher

- **Change Type**: Major reworking of the Claude provider for live-terminal UX
- **Impact**: The Claude provider now drives Claude interactively (PTY-based)
  instead of `--output-format stream-json`. Users get a live bidirectional
  xterm.js terminal in the web client, persistent Claude sessions across
  turns, mid-turn AskUserQuestion modals, and chat updates for turns the
  user types directly into the live PTY.
- **Key Components**:
  - **Persistent PTY** in `claudeCLIDriver.ts` (`ensurePtySpawned` — Claude
    stays alive across turns, abort sends Ctrl+C, killed only in
    `dispose()`)
  - **AskUserQuestion modal** via `useClaudeInteractivePromptDialog.tsx` +
    `claudeInteractivePromptTranslators.ts` (single + multi-question
    picker, "Type something" free-text)
  - **Web terminal mirror**: `claudePtyMirror.ts` singleton bus, xterm.js
    viewer in `web-client/src/components/ClaudePtyViewer.js` (modal +
    PiP modes, drag, corner-resize, localStorage persistence,
    bidirectional `claude_pty_data`/`claude_pty_input`/`claude_pty_resize`
    WebSocket messages)
  - **Background hook watcher**: 150ms setInterval in `claudeCLIDriver.ts`
    drains hook events + transcript when no chat-initiated sendMessage is
    running. Surfaces user-message / assistant-text / error /
    compaction-summary as text in chat. Paused around chat sendMessages.
  - **/tui fullscreen auto-enable**: Sidesteps the xterm scrollback-
    duplication bug in Claude Code 2.1.x
    (anthropics/claude-code#49086, #51828). Opt-out via
    `AUDITARIA_CLAUDE_TUI_INLINE=1`.
  - **Claude Fable in /model menu**: Added between Haiku and Opus 1M
- **Files Created**:
  - `core/providers/claude/claudePtyMirror.ts`
  - `core/providers/claude/interactivePromptSupport.ts`
  - `cli/src/ui/hooks/useClaudeInteractivePromptDialog.tsx`
  - `cli/src/ui/hooks/claudeInteractivePromptTranslators.ts` (+ tests)
  - `web-client/src/components/ClaudePtyViewer.js`
- **Stack of commits** (all marked with `AUDITARIA_CLAUDE_PROVIDER`):
  e86401d632 (PTY driver), 57d86a2d60 (AskUserQuestion event), 56e8b8eba3
  (multi-question), 9e6a6cbc09 (modal UI), c77d85d650 (translator tests),
  9a52449a1c (web terminal mirror), 1b3b6eee45 (persistent PTY),
  d191917b89 (background watcher), 60b79f732b (/tui fullscreen),
  b525f51760 (live PreToolUse text markers + errors + compaction
  summary), f1653f0e78 (localStorage + drag-resize), 3b5e7e51d8 (Fable).
- **Known caveats**: Background tool calls show as text markers
  ("↪ Calling Bash: …"), not rich tool-group cards — the rich-rendering
  attempt was reverted (commits 19a4e6379f, 8ca6f6df77) because it
  didn't read right in practice.

### June 2026 — Alternative LLM Providers (Google Antigravity / `agy`)

- **Change Type**: New major feature — fifth provider (after Gemini, Claude,
  Codex, Copilot), driving Google's Antigravity CLI (`agy`).
- **Impact**: `/model` → Google Antigravity submenu (full documented model set);
  `external_agent_session` provider `"agy"`; web model menu group "Antigravity".
- **Architecture**: PTY-to-run (`agy --print` needs a TTY) + transcript-to-read
  (`brain/<id>/.system_generated/logs/transcript_full.jsonl`) — no JSON mode.
  Terminal scraping is only a fallback. See **Section 20** and
  `.auditaria/agy-provider-plan.md`.
- **Key gotchas (validated live against agy 1.0.8)**: `--print <prompt>` must be
  LAST (else a following bare bool flag is absorbed as the prompt); conversation
  id discovery via dir-diff ONLY (the cwd-keyed cache is rewritten by every agy
  process — poisoning race); global `mcp_config.json` merged, never clobbered.
- **Files Created**: `providers/agy/{types.ts,agyCLIDriver.ts,agyCLIDriver.test.ts}`
  (14 unit tests). Integration points across 13 existing files, all marked
  `// AUDITARIA_AGY_PROVIDER`.

### June 2026 — Google discontinued Gemini CLI OAuth for consumer subscriptions

- **Change Type**: External Google policy change (not a code change) that
  affects how Auditaria users authenticate the default **Gemini provider**.
- **What happened (2026-06-18)**: Upstream Gemini CLI and the Gemini Code Assist
  IDE extensions **stopped serving requests over the "Sign in with Google" OAuth
  path** for **Google AI Pro**, **Google AI Ultra**, and free **"Gemini Code
  Assist for individuals"** accounts. Google migrated these users to the
  closed-source **Antigravity CLI** (`agy`). Ref: Google Developers Blog,
  "Transitioning Gemini CLI to Antigravity CLI".
- **Impact on Auditaria**: the default Gemini provider's OAuth login no longer
  returns model access for those tiers (auth/eligibility errors). Unaffected:
  orgs on a **Gemini Code Assist Standard/Enterprise** license. Still-valid
  Gemini auth: **API key (AI Studio)** or **Vertex AI** (note: from 2026-06-19
  the Gemini API rejects *unrestricted* standard API keys).
- **Migration paths** for affected users: (1) Gemini API key / Vertex AI,
  (2) the already-integrated **`agy` provider** (same Google account, official
  successor), or (3) **Claude / Codex / Copilot**.
- **Full details**: See **Section 20** (Antigravity / `agy`).

### July 2026 — Provider Terminal Abstraction + Copilot Interactive PTY Driver

- **Change Type**: New abstraction + new major feature — generalized the
  Claude-only PTY/web-terminal machinery into a provider-agnostic module and
  shipped GitHub Copilot as its first new consumer.
- **Impact**: Selecting Copilot in `/model` now drives the REAL Copilot TUI
  in a persistent PTY (was: headless agent-to-agent ACP) — live bidirectional
  web-terminal mirror (titled "GitHub Copilot Terminal"), TUI slash commands,
  and terminal-typed turns surfacing in chat. `AUDITARIA_COPILOT_ACP=1`
  restores the ACP driver; headless contexts (sub-agents, Teams) keep ACP.
- **New module**: `packages/core/src/providers/terminal/` (ptyMirror,
  ptySession, ptyWriteQueue, jsonlTail, textUtils) — see Section 22.
- **Renames**: `claudePtyMirror` → `providerPtyMirror` (source-guarded +
  labeled), `claude_pty_*` WS messages → `provider_pty_*` (+ `label`),
  `ClaudePtyViewer.js` → `ProviderTerminalViewer.js` (dynamic title).
- **Bug fixed**: sub-agent / Teams Claude drivers no longer hijack or
  interleave the main session's web terminal (`mirrorPty: false` +
  source-guarded emitData).
- **Key empirical findings (Copilot CLI 1.0.67, validated live)**: TUI
  writes `~/.copilot/session-state/<id>/events.jsonl` live (only after first
  prompt submission); `--session-id` pre-assigns the id; `--resume` appends
  to the same file; `assistant.turn_end` is per inference step — final only
  when the last assistant.message had no toolRequests; `user.message` is
  positive prompt-acceptance confirmation (enables typed-prompt retry
  ladder); abort = Esc. Details in Section 14.
- **Tests**: 17 new unit tests (CopilotTurnTracker/args 11, JsonlFileTail 6);
  e2e validated live (fresh spawn + tool turn on same PTY + resume across
  driver instances). Build, typecheck, lint green.

### September 2026 — Codex & Copilot model lists driven by the CLIs' own catalogs

- **Change Type**: Removed the hand-maintained model tables that drift every
  time OpenAI or GitHub ships a model; both provider menus (CLI `/model` and
  the web model selector, which share `modelCatalog.ts`) now read the source
  each CLI already writes.
- **Codex — new `providers/codex/codexModelCatalog.ts`**: reads
  `$CODEX_HOME/models_cache.json` (default `~/.codex`), keeps
  `visibility: "list"` entries, sorts by Codex's `priority`, and exposes ids,
  display names, descriptions and per-model `supported_reasoning_levels`.
  Memoised on (mtime, size) with a 5s stat throttle. Returns `undefined` on a
  missing/corrupt file so callers keep the static fallback.
  - Wired into `getSupportedCodexReasoningEfforts` (so `/model` meters AND the
    driver's clamp track real tiers), `getCodexModelOptions()` (new, replaces
    the `CODEX_SUBMENU_OPTIONS` const — now `CODEX_FALLBACK_OPTIONS`),
    `getCodexModelIds()` (new), and `getDisplayString` ("Codex (GPT-5.6 Sol)"
    instead of the raw slug).
  - `external_agent_session` picks it up too: the schema enum, the tool
    description and `validateToolParams` all resolve Codex ids per
    instantiation, so a new Codex model is offered AND accepted.
  - `types.ts` imports the catalog at runtime; the catalog imports back
    TYPE-ONLY — deliberately no ESM cycle.
- **Copilot**: dropped the dead `copilot --help` fallback in `modelCatalog.ts`
  (CLI 1.0.81 no longer lists model ids in `--help`, so the parse returned
  nothing while still paying a blocking `execSync` on every menu build). Cold
  cache now shows Auto alone until the background ACP refresh repopulates it.
  New `getCopilotModelDisplayName()` gives the footer Copilot's own label
  ("Copilot (Claude Sonnet 5)" instead of the slug).
- **Web**: `client.js` `formatModelFooterText` lost its hardcoded
  `codexTitleMap` (stale: listed `gpt-5.3-codex`/`gpt-5.2`, missing the whole
  5.6 family). It now prefers the backend's label and falls back to a shared
  `formatProviderModelId` slug prettifier, used for Copilot too.
- **Tests**: 13 new (`codexModelCatalog.test.ts`); `types.test.ts` and
  `ModelDialog.test.tsx` pinned to the static fallback so they never read the
  developer's real `~/.codex`. Typecheck, lint, build clean.
- **Pre-existing, untouched**: `ModelDialog.test.tsx` still cannot load at all
  (`core → browser-agent → core` circular import) — verified identical on a
  clean checkout.

### August 2026 — Web Terminal "Live screen" Mode (duplication-immune mirror)

- **Change Type**: New rendering mode for the provider web terminal that is
  immune to Claude Code's inline-mode duplicate-frame emission bug.
- **Background**: The duplication is a Claude Code TUI bug, not a
  PTY/emulator bug (reproduces on macOS/Linux and other emulators; a
  rewritten-ConPTY backend was built, validated, and discarded — see memory
  terminal-backend.md). Raw-stream mirroring accumulates the duplicates in
  the viewer's scrollback; the current *screen grid* always converges to
  correct, so the fix is to mirror the grid, not the stream.
- **Implementation**: `providers/terminal/screenMirror.ts`
  (`ProviderScreenMirror`: @xterm/headless with scrollback 0 +
  @xterm/addon-serialize snapshots) + `WebInterfaceService` fan-out
  (`provider_screen_data` broadcast, 80ms throttle; unicast
  `provider_pty_refresh`) + Live/Raw toggle in
  `ProviderTerminalViewer.js` (default Live; repaint = one ordered
  `'\x1bc' + snapshot` write). Details: Section 22, `screenMirror.ts`
  bullet.
- **Files**: created `screenMirror.ts` (+ 8 tests); modified
  `WebInterfaceService.ts`, `ProviderTerminalViewer.js`, core
  `package.json` (+`@xterm/addon-serialize` 0.13.0), core `index.ts`
  export.

This file should be updated whenever major changes are made to our fork or when
sync processes are completed.
