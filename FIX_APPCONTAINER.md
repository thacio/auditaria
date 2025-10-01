# AppContainer.tsx Fix Plan

## Issues to Fix:
1. Web interface code uses variables before they're declared
2. WebInterfaceService method names are wrong

## Variables Declaration Order:
- Line 686: `pendingHistoryItems` (local variable in cancelHandlerRef.current)
- Line 1104: `isFolderTrustDialogOpen`
- Line 1184: `elapsedTime`, `currentLoadingPhrase`
- Line 1310: `filteredConsoleMessages`
- Line 1360: `pendingHistoryItems` (the actual useMemo)

## Web Interface Code Location:
- Lines 790-1056: All web interface code that needs to move

## Method Name Fixes:
- `updateFooter` → `broadcastFooterData`
- `updateLoadingState` → `broadcastLoadingState`
- `updateSlashCommands` → `broadcastSlashCommands`
- `updateMCPServers` → `broadcastMCPServers`
- `updateConsoleMessages` → `broadcastConsoleMessages`
- `setCLIActionRequired` → `broadcastCliActionRequired`
- `setStartupMessage` → custom broadcast
- `setPendingToolConfirmation` → `broadcastToolConfirmation`
- `toolConfirmationContext.pendingConfirmation` → `toolConfirmationContext.pendingConfirmations[0]`

## Fix Order:
1. Cut web interface code (lines 790-1056)
2. Paste after line 1360
3. Fix all method names
4. Fix pendingConfirmation to pendingConfirmations[0]