# Migration TODO List - App.tsx to AppContainer.tsx

## Our Custom Features to Migrate

### 1. Web Interface Integration
- [x] WebInterfaceProvider wrapper - Already migrated
- [ ] useWebInterface hook usage and all web interface logic
- [ ] Terminal capture for interactive screens
- [ ] Submit query registration and abort handler
- [ ] Web interface broadcasting:
  - [ ] Footer data broadcasting
  - [ ] Loading state broadcasting
  - [ ] MCP servers broadcasting
  - [ ] Console messages broadcasting
  - [ ] CLI action required messages
  - [ ] Startup message broadcasting
  - [ ] Tool confirmation broadcasting
- [ ] Multi-modal support (PartListUnion type)
- [ ] Pre-start terminal capture for ProQuotaDialog
- [ ] Terminal input handling from web interface
- [ ] Keypress event forwarding

### 2. Language Settings Integration
- [x] Import useLanguageCommand hook - Already done
- [x] languageError state - Already done
- [x] isLanguageDialogOpen state - Already done
- [x] openLanguageDialog in slash commands - Already done
- [x] handleLanguageSelect action - Already done
- [ ] isFirstTimeSetup logic (if used)

### 3. Internationalization (i18n)
- [x] Import t function from @thacio/auditaria-cli-core - Already done
- [ ] All t() function calls for user-facing strings:
  - [ ] Memory refresh messages
  - [ ] Quota exceeded messages (Pro paid/free, generic paid/free)
  - [ ] Fallback messages
  - [ ] Web CLI action messages
  - [ ] Authentication messages
  - [ ] Various UI messages

### 4. Help System
- [ ] showHelp state
- [ ] Help dialog or help display logic (if any)

### 5. Additional Context Providers (from AppWrapper)
- [ ] SubmitQueryProvider
- [ ] FooterProvider
- [ ] LoadingStateProvider
- [ ] ToolConfirmationProvider
- [ ] TerminalCaptureWrapper

### 6. Web Interface Specific Props
- [x] webEnabled, webOpenBrowser, webPort props in interface - Already done
- [ ] Pass these props through to WebInterfaceProvider (verify)

### 7. Package Renaming
- [x] All imports from @thacio/auditaria-cli-core - Already done

### 8. Additional Imports Needed
- [ ] Import PartListUnion from @google/genai for multimodal support
- [ ] Import web interface contexts
- [ ] Import terminal capture contexts
- [ ] Import additional providers

## Migration Strategy

1. First, add all missing imports
2. Add all missing state variables
3. Migrate web interface logic section by section
4. Add all t() internationalization calls
5. Test that all features work after migration