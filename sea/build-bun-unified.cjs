#!/usr/bin/env node

/**
 * Unified Bun WebSocket solution - Single server handling both HTTP and WebSocket
 * FIXED: Server only initializes when --web flag is present
 * FIXED: Process.argv handling for correct argument parsing
 * FIXED: Interactive mode detection for standalone executable
 * FIXED: Stagehand and Playwright bundled for standalone executable
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini.js');
const BUN_BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini-bun-prebundle.js');
const OUTPUT_PATH = path.join(__dirname, '..', 'auditaria-standalone.exe');
const WEB_CLIENT_PATH = path.join(__dirname, '..', 'packages', 'web-client', 'src');

console.log('🔧 Building Auditaria CLI with unified Bun server...\n');

if (!fs.existsSync(BUNDLE_PATH)) {
  console.error('❌ Bundle not found. Run "npm run bundle" first.');
  process.exit(1);
}

// Step 0: Create Bun-specific bundle that INCLUDES Stagehand and Playwright
// The regular bundle has these as external to avoid worker thread crashes,
// but for standalone Bun exe we need them bundled in.
console.log('📦 Creating Bun-specific bundle (including Stagehand/Playwright)...');

try {
  // Read the main esbuild config to get base settings
  const pkg = require(path.join(__dirname, '..', 'package.json'));

  // Run esbuild with Stagehand/Playwright NOT external
  // We keep node-pty and native modules external as they're not used in browser-agent
  const externals = [
    '@lydell/node-pty',
    'node-pty',
    '@lydell/node-pty-darwin-arm64',
    '@lydell/node-pty-darwin-x64',
    '@lydell/node-pty-linux-x64',
    '@lydell/node-pty-win32-arm64',
    '@lydell/node-pty-win32-x64',
    'keytar',  // Native module for credential storage
    'web-tree-sitter',  // WASM module
    'tree-sitter-bash',  // WASM module
  ].map(e => `--external:${e}`).join(' ');

  execSync(`npx esbuild packages/cli/index.ts --bundle --platform=node --format=esm \
    ${externals} \
    --loader:.node=file \
    --loader:.wasm=file \
    --banner:js="const require = (await import('module')).createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);" \
    --define:process.env.CLI_VERSION='"${pkg.version}"' \
    --outfile="${BUN_BUNDLE_PATH}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe'
  });
  console.log('   ✓ Bun-specific bundle created (Stagehand/Playwright included)');
} catch (error) {
  console.error('   ⚠️  Failed to create Bun-specific bundle, falling back to regular bundle');
  console.error('   Error:', error.message);
  // Fall back to regular bundle
  fs.copyFileSync(BUNDLE_PATH, BUN_BUNDLE_PATH);
}

// Use the Bun-specific bundle
const ACTUAL_BUNDLE_PATH = fs.existsSync(BUN_BUNDLE_PATH) ? BUN_BUNDLE_PATH : BUNDLE_PATH;

// Embed locale files
console.log('📦 Embedding locale files...');
const LOCALE_PATH = path.join(__dirname, '..', 'bundle', 'locales');
let localeData = {};

if (fs.existsSync(LOCALE_PATH)) {
  const localeFiles = fs.readdirSync(LOCALE_PATH).filter(f => f.endsWith('.json'));
  localeFiles.forEach(file => {
    const lang = file.replace('.json', '');
    const content = fs.readFileSync(path.join(LOCALE_PATH, file), 'utf8');
    localeData[lang] = JSON.parse(content);
    console.log(`   ✓ Embedded locale: ${lang}`);
  });
} else {
  console.warn('   ⚠️  Locale directory not found, translations may not work');
}

// Embed web client files
console.log('\n📦 Embedding web client files...');
const webClientFiles = {};

function readDirRecursive(dir, baseDir = dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (fs.statSync(fullPath).isDirectory()) {
      readDirRecursive(fullPath, baseDir);
    } else {
      webClientFiles[relativePath] = fs.readFileSync(fullPath, 'base64');
    }
  }
}

if (fs.existsSync(WEB_CLIENT_PATH)) {
  readDirRecursive(WEB_CLIENT_PATH);
  console.log(`   ✓ Embedded ${Object.keys(webClientFiles).length} files`);
}

console.log('\n📖 Reading bundle...');
let bundleContent = fs.readFileSync(ACTUAL_BUNDLE_PATH, 'utf8');

// Remove shebang
if (bundleContent.startsWith('#!/')) {
  bundleContent = bundleContent.slice(bundleContent.indexOf('\n') + 1);
}

console.log('🔨 Applying fixes...');

// Fix 1: Process.argv cleanup for Bun environment
// This ensures clean argument parsing and prevents extra Bun-specific arguments
const argvCleanupFix = `
// BUN ARGV CLEANUP FIX
(function() {
  if (typeof Bun !== 'undefined' && Bun.version) {
    // Store original argv
    const originalArgv = [...process.argv];

    // Check if we're running as a standalone executable
    // In Bun, argv[0] is "bun" and argv[1] is the executable path
    const isStandalone = process.argv.some(arg => arg && arg.includes('auditaria-standalone'));

    if (isStandalone) {
      // In Bun compiled executable:
      // argv[0] = "bun"
      // argv[1] = "B:/~BUN/root/auditaria-standalone.exe"
      // argv[2+] = actual user arguments (if any)

      let cleanArgv = [];
      let exePath = null;
      let userArgsStart = -1;

      // Find the executable path and where user arguments start
      for (let i = 0; i < originalArgv.length; i++) {
        if (originalArgv[i] && originalArgv[i].includes('auditaria-standalone')) {
          exePath = originalArgv[i];
          // User arguments start after the executable path
          userArgsStart = i + 1;
          break;
        }
      }

      if (exePath) {
        // Build clean argv for yargs:
        // argv[0] = executable path
        // argv[1] = dummy script path (same as argv[0], required by yargs)
        // argv[2+] = user arguments
        cleanArgv.push(exePath);
        cleanArgv.push(exePath); // dummy script path for yargs

        // Add any actual user arguments
        for (let i = userArgsStart; i < originalArgv.length; i++) {
          const arg = originalArgv[i];
          // Skip if this is a duplicate of the exe path (Bun sometimes adds it twice)
          if (arg && arg !== exePath && !arg.startsWith('--bun-') && !arg.startsWith('-bun-')) {
            cleanArgv.push(arg);
          }
        }
      } else {
        // Fallback if exe path not found
        cleanArgv = [...originalArgv];
      }

      // Replace process.argv with cleaned version
      process.argv = cleanArgv;
    }
  }
})();
`;

// Fix 2: Enhanced interactive mode detection
// Ensure interactive mode works correctly when no arguments provided
const interactiveModeFixEnhanced = `
// ENHANCED INTERACTIVE MODE FIX FOR BUN
(function() {
  if (typeof Bun !== 'undefined' && Bun.version) {
    // Override hideBin globally if it exists
    // This approach doesn't require module interception
    const checkAndFixHideBin = () => {
      try {
        // Check if hideBin is available globally (it might be after yargs loads)
        if (typeof globalThis.hideBin === 'function') {
          const originalHideBin = globalThis.hideBin;
          globalThis.hideBin = function(argv) {
            if (argv && argv.length >= 2) {
              const isStandalone = argv[0] && argv[0].includes('auditaria-standalone');
              if (isStandalone) {
                return argv.slice(2);
              }
            }
            return originalHideBin(argv);
          };
        }
      } catch (e) {
        // Silently ignore if hideBin is not available
      }
    };

    // Check immediately and also set a timer to check later
    checkAndFixHideBin();
    setTimeout(checkAndFixHideBin, 0);

    // Additional fix: patch yargs parsing directly
    // Override process.argv before yargs processes it
    const originalSlice = Array.prototype.slice;
    Array.prototype.slice = function(...args) {
      // Check if this is being called on process.argv by yargs
      if (this === process.argv && args.length > 0 && args[0] === 2) {
        // This is likely hideBin trying to slice argv
        const isStandalone = this[0] && this[0].includes('auditaria-standalone');
        if (isStandalone && this.length >= 2 && this[1] === this[0]) {
          // Skip the duplicate executable path we added
          return originalSlice.call(this, 2);
        }
      }
      return originalSlice.apply(this, args);
    };
  }
})();
`;

// Fix 3: Always initialize Bun server infrastructure (but conditionally start)
const conditionalUnifiedBunServer = `
// UNIFIED BUN SERVER FOR HTTP + WEBSOCKET - ALWAYS INITIALIZED
(function() {
  if (typeof Bun === 'undefined' || !Bun.version) return;

  // Check if web interface is disabled at startup (web is enabled by default)
  const hasNoWebFlag = process.argv.some(arg => arg === '--no-web');
  const webEnabled = !hasNoWebFlag;

  // Debug output
  if (process.env.DEBUG) {
    console.log('[Bun] Web enabled (default):', webEnabled);
    console.log('[Bun] Current argv:', process.argv);
  }

  // Embedded locale data for Bun executable (always set this)
  if (typeof globalThis.__EMBEDDED_LOCALES === 'undefined') {
    globalThis.__EMBEDDED_LOCALES = ${JSON.stringify(localeData)};
  }

  // ALWAYS initialize server infrastructure (needed for /web command)
  // console.log('[Bun] Initializing server infrastructure...');

  const WEB_CLIENT_FILES = ${JSON.stringify(webClientFiles)};
  const wsClients = new Set();
  let unifiedServer = null;
  let serverPort = null;

  // Store embedded files globally for Express static middleware override
  globalThis.__EMBEDDED_WEB_FILES = WEB_CLIENT_FILES;

  // Message handlers storage
  let messageHandlers = {
    submitQuery: null,
    abort: null,
    confirmation: null
  };

  // State storage
  let serverState = {
    history: [],
    slashCommands: [],
    mcpServers: { servers: [], blockedServers: [] },
    consoleMessages: [],
    cliActionState: null,
    pendingItem: null,
    loadingState: null
  };

  // Create unified Bun WebSocketServer replacement
  class BunUnifiedWebSocketServer {
    constructor(options) {
      // console.log('[Bun] Creating unified WebSocket server instance');
      this.clients = wsClients;
      this._connectionHandler = null;
      this._options = options; // Store options for lazy initialization

      // Don't create the actual server yet - wait until it's needed
      // The server will be created either:
      // 1. Immediately if web is enabled (default, unless --no-web)
      // 2. Later when /web command is used

      // Check if we should auto-start the server (web enabled by default)
      if (webEnabled && !unifiedServer) {
        // console.log('[Bun] Auto-starting server (web enabled by default)');
        this._createServer(options);
      }
      // Otherwise, server will be created on demand
    }

    _createServer(options) {
      // Only create server once
      if (unifiedServer) {
        // console.log('[Bun] Server already exists on port', serverPort);
        return;
      }

      // console.log('[Bun] Creating actual Bun server');

      // Get port from command line arguments or use default
      let requestedPort = 8629;

      // Parse --port argument from process.argv
      const portArgIndex = process.argv.indexOf('--port');
      if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
        const parsedPort = parseInt(process.argv[portArgIndex + 1], 10);
        if (!isNaN(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
          requestedPort = parsedPort;
        } else {
          console.error(\`⚠️ Invalid port number: \${process.argv[portArgIndex + 1]}. Port must be between 0-65535. Starting in another port.\`);
        }
      }

      const port = options.port || (options.server && options.server.address?.()?.port) || requestedPort;

      // Create the unified Bun server
      unifiedServer = Bun.serve({
        port: port,
        hostname: 'localhost',

        fetch: (req, server) => {
          const url = new URL(req.url);

          // Handle WebSocket upgrade
          if (req.headers.get('upgrade') === 'websocket') {
            // console.log('[Bun] WebSocket upgrade request for:', url.pathname);

            // Store URL path for routing in open handler
            const success = server.upgrade(req, {
              data: {
                pathname: url.pathname,
                host: req.headers.get('host') || 'localhost'
              },
              headers: {
                'Access-Control-Allow-Origin': '*'
              }
            });

            if (success) {
              return undefined; // Let WebSocket handler take over
            }
            return new Response('WebSocket upgrade failed', { status: 400 });
          }

          // Handle API endpoints
          if (url.pathname === '/api/health') {
            return Response.json({
              status: 'ok',
              clients: wsClients.size,
              runtime: 'bun-unified'
            });
          }

          // Serve static files
          const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          const fileContent = WEB_CLIENT_FILES[filePath];

          if (fileContent) {
            const buffer = Buffer.from(fileContent, 'base64');
            const ext = path.extname(filePath).slice(1);
            const mimeTypes = {
              'html': 'text/html',
              'js': 'application/javascript',
              'css': 'text/css',
              'json': 'application/json',
              'png': 'image/png',
              'jpg': 'image/jpeg',
              'svg': 'image/svg+xml',
              'ico': 'image/x-icon'
            };

            return new Response(buffer, {
              headers: {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // Default 404
          return new Response('Not found', { status: 404 });
        },

        websocket: {
          open: (ws) => {
            // Get pathname from upgrade data
            const pathname = ws.data?.pathname || '/';
            const host = ws.data?.host || 'localhost';

            // console.log('[Bun] WebSocket connection opened for:', pathname);

            try {
              // Check if this is a special path that should be routed to WebInterfaceService
              const isBrowserStream = pathname.startsWith('/stream/browser/');
              const isAgentControl = pathname.startsWith('/control/agent/');

              // For stream/control connections, route to WebInterfaceService handler
              if ((isBrowserStream || isAgentControl) && this._connectionHandler) {
                // Create a mock WebSocket for compatibility
                const mockWs = {
                  send: (data) => {
                    try { ws.send(data); } catch (e) { /* ignore */ }
                  },
                  close: () => {
                    try { ws.close(); } catch (e) { /* ignore */ }
                  },
                  readyState: 1,
                  on: (event, handler) => {
                    if (!ws._handlers) ws._handlers = {};
                    ws._handlers[event] = handler;
                  }
                };

                // Create mock request with URL for path-based routing
                const mockRequest = {
                  url: pathname,
                  headers: { host: host }
                };

                ws._mockWs = mockWs;
                this._connectionHandler(mockWs, mockRequest);
                return;
              }

              // Main chat connection - add to broadcast clients
              wsClients.add(ws);

              // Send initial connection message
              ws.send(JSON.stringify({
                type: 'connection',
                data: { message: 'Connected to Auditaria CLI' },
                timestamp: Date.now()
              }));

              // Send current state
              if (serverState.history.length > 0) {
                ws.send(JSON.stringify({
                  type: 'history_sync',
                  data: { history: serverState.history },
                  timestamp: Date.now()
                }));
              }

              if (serverState.slashCommands.length > 0) {
                ws.send(JSON.stringify({
                  type: 'slash_commands',
                  data: { commands: serverState.slashCommands },
                  timestamp: Date.now()
                }));
              }

              ws.send(JSON.stringify({
                type: 'mcp_servers',
                data: serverState.mcpServers,
                timestamp: Date.now()
              }));

              ws.send(JSON.stringify({
                type: 'console_messages',
                data: serverState.consoleMessages,
                timestamp: Date.now()
              }));

              if (serverState.cliActionState && serverState.cliActionState.active) {
                ws.send(JSON.stringify({
                  type: 'cli_action_required',
                  data: serverState.cliActionState,
                  timestamp: Date.now()
                }));
              }

              // Send current pending item (for live tool updates like browser agent)
              if (serverState.pendingItem) {
                ws.send(JSON.stringify({
                  type: 'pending_item',
                  data: serverState.pendingItem,
                  ephemeral: true,
                  timestamp: Date.now()
                }));
              }

              // Send current loading state
              if (serverState.loadingState) {
                ws.send(JSON.stringify({
                  type: 'loading_state',
                  data: serverState.loadingState,
                  ephemeral: true,
                  timestamp: Date.now()
                }));
              }

              // Call the connection handler for main chat
              if (this._connectionHandler) {
                // Create a mock WebSocket for compatibility
                const mockWs = {
                  send: (data) => {
                    try { ws.send(data); } catch (e) { /* ignore */ }
                  },
                  close: () => {
                    try { ws.close(); } catch (e) { /* ignore */ }
                  },
                  readyState: 1,
                  on: (event, handler) => {
                    if (!ws._handlers) ws._handlers = {};
                    ws._handlers[event] = handler;
                  }
                };

                // Create mock request with URL
                const mockRequest = {
                  url: pathname,
                  headers: { host: host }
                };

                ws._mockWs = mockWs;
                this._connectionHandler(mockWs, mockRequest);
              }
            } catch (err) {
              console.error('[Bun] Error in open handler:', err);
            }
          },

          message: (ws, message) => {
            // console.log('[Bun] Message received:', message.toString().slice(0, 100));

            try {
              const data = JSON.parse(message.toString());

              // Handle different message types - these are already being processed
              // so we don't need to trigger mock handlers for them
              let messageHandled = false;

              if (data.type === 'user_message' && messageHandlers.submitQuery) {
                const query = data.content?.trim();
                if (query) {
                  messageHandlers.submitQuery(query);
                  messageHandled = true;
                }
              } else if (data.type === 'interrupt_request' && messageHandlers.abort) {
                messageHandlers.abort();
                messageHandled = true;
              } else if (data.type === 'tool_confirmation_response' && messageHandlers.confirmation) {
                if (data.callId && data.outcome) {
                  messageHandlers.confirmation(data.callId, data.outcome, data.payload);
                  messageHandled = true;
                }
              }

              // Only trigger mock handlers for unhandled message types
              // to avoid duplicate processing
              if (!messageHandled && ws._mockWs && ws._handlers && ws._handlers.message) {
                ws._handlers.message(message);
              }
            } catch (error) {
              // console.error('[Bun] Error handling message:', error);
            }
          },

          close: (ws, code, reason) => {
            // console.log('[Bun] WebSocket closed, code:', code, 'reason:', reason?.toString() || 'none');
            wsClients.delete(ws);

            if (ws._mockWs && ws._handlers && ws._handlers.close) {
              ws._handlers.close();
            }
          },

          error: (ws, error) => {
            // console.error('[Bun] WebSocket error:', error);
            wsClients.delete(ws);

            if (ws._mockWs && ws._handlers && ws._handlers.error) {
              ws._handlers.error(error);
            }
          }
        }
      });

      serverPort = unifiedServer.port;
      // console.log('[Bun] Unified server started on port', serverPort);

      // Stop the original Express server if it exists
      if (options.server && options.server.close) {
        // console.log('[Bun] Stopping original Express server');
        try {
          options.server.close();
          options.server.listening = false;
        } catch (e) {
          // console.log('[Bun] Could not stop Express server:', e.message);
        }
      }

      // Notify any waiting connection handlers
      if (this._connectionHandler) {
        wsClients.forEach(ws => {
          if (ws._mockWs) {
            this._connectionHandler(ws._mockWs, {});
          }
        });
      }
    }

    on(event, handler) {
      if (event === 'connection') {
        this._connectionHandler = handler;

        // Ensure server is created when handlers are attached
        // This happens when /web command is used
        if (!unifiedServer && this._options) {
          // console.log('[Bun] Late server initialization triggered by handler attachment');
          this._createServer(this._options);
        }

        // If we already have clients, call handler for them
        wsClients.forEach(ws => {
          if (ws._mockWs) {
            handler(ws._mockWs, {});
          }
        });
      }
    }

    // Method to manually start the server (for /web command)
    startServer() {
      if (!unifiedServer && this._options) {
        // console.log('[Bun] Manual server start requested');
        this._createServer(this._options);
        return serverPort;
      }
      return serverPort || null;
    }

    close(callback) {
      if (callback) callback();
    }
  }

  // Mock WebSocket class
  class BunMockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = 1;
      this.OPEN = 1;
      this.CLOSED = 3;
    }

    on() {}
    send() {}
    close() {}
  }

  // Override WebSocketServer globally
  globalThis.WebSocketServer = BunUnifiedWebSocketServer;
  globalThis.WebSocket = BunMockWebSocket;

  // Override require('ws') - simplified approach for Bun
  if (typeof require !== 'undefined' && typeof require.cache === 'object') {
    try {
      // Directly modify require.cache entries for ws module
      Object.keys(require.cache).forEach(key => {
        if (key.includes('ws') || key.includes('websocket')) {
          require.cache[key].exports = {
            WebSocketServer: BunUnifiedWebSocketServer,
            WebSocket: BunMockWebSocket,
            Server: BunUnifiedWebSocketServer
          };
        }
      });
    } catch (e) {}
  }

  // Override in require cache
  try {
    Object.keys(require.cache || {}).forEach(key => {
      if (key.includes('ws')) {
        require.cache[key].exports = {
          WebSocketServer: BunUnifiedWebSocketServer,
          WebSocket: BunMockWebSocket,
          Server: BunUnifiedWebSocketServer
        };
      }
    });
  } catch (e) {}

  // Create global broadcast function
  globalThis.bunBroadcast = function(message) {
    const payload = JSON.stringify({ ...message, timestamp: Date.now() });
    wsClients.forEach(ws => {
      try {
        ws.send(payload);
      } catch (e) {
        wsClients.delete(ws);
      }
    });
  };

  // Create state update functions
  globalThis.bunUpdateState = function(type, data) {
    if (type === 'history') serverState.history = data;
    else if (type === 'slashCommands') serverState.slashCommands = data;
    else if (type === 'mcpServers') serverState.mcpServers = data;
    else if (type === 'consoleMessages') serverState.consoleMessages = data;
    else if (type === 'cliActionState') serverState.cliActionState = data;
    else if (type === 'pendingItem') serverState.pendingItem = data;
    else if (type === 'loadingState') serverState.loadingState = data;
  };

  // Create handler setters
  globalThis.bunSetHandler = function(type, handler) {
    messageHandlers[type] = handler;
  };

  // Create function to start server on demand (for /web command)
  globalThis.bunStartServer = function() {
    // Find WebSocketServer instance and start it
    if (!unifiedServer) {
      // console.log('[Bun] Starting server on demand');
      // We need to trigger server creation through any WebSocketServer instance
      // The WebInterfaceService will have one
      return true; // Signal that server needs to be started
    }
    return false; // Server already running
  };

  globalThis.bunGetServerPort = function() {
    return serverPort;
  };

  // console.log('[Bun] Server infrastructure ready');
})();
`;

// Apply all fixes in order
bundleContent = argvCleanupFix + '\n' +
                interactiveModeFixEnhanced + '\n' +
                conditionalUnifiedBunServer + '\n' +
                bundleContent;

// Fix 4: Enhanced interactive mode check in the main code
// This ensures the CLI correctly detects interactive mode in Bun
bundleContent = bundleContent.replace(
  /const interactive = !!argv\.promptInteractive \|\| process33\.stdin\.isTTY && question\.length === 0;/g,
  `// Enhanced interactive check for Bun compatibility
  const interactive = !!argv.promptInteractive || !!argv.web ||
    (process33.stdin.isTTY && question.length === 0 && !argv.prompt);`
);

// Fix 5: Patch WebInterfaceService to skip file checks in Bun and serve from embedded files
bundleContent = bundleContent.replace(
  /for \(const testPath of possiblePaths\) \{[\s\S]*?\}[\s]*if \(!webClientPath\) \{/g,
  `// In Bun runtime, skip file checks and use embedded files
  if (typeof Bun !== 'undefined' && globalThis.__EMBEDDED_WEB_FILES) {
    webClientPath = '/$bunfs/embedded-web-client';
    if (debugMode) {
      // console.log('✓ Using embedded web client files in Bun runtime');
    }
  } else {
    for (const testPath of possiblePaths) {
      try {
        const fs = await import('fs');
        const indexPath = path.join(testPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          webClientPath = testPath;
          if (debugMode) {
            console.log(\`✓ Found web client files at: \${webClientPath}\`);
          }
          break;
        } else if (debugMode) {
          console.log(\`✗ Not found: \${indexPath}\`);
        }
      } catch (error) {
        if (debugMode) {
          console.log(\`✗ Error checking \${testPath}:\`, error);
        }
        // Continue to next path
      }
    }
  }

  if (!webClientPath) {`
);

// Fix 6: Patch WebSocketServer instantiation
bundleContent = bundleContent.replace(
  /new import_websocket_server\.(default|WebSocketServer)\(/g,
  'new (globalThis.WebSocketServer || import_websocket_server.default)('
);

// Fix 7: Patch WebInterfaceService methods to use global broadcast
bundleContent = bundleContent.replace(
  /broadcastMessage\(historyItem\)\s*{/g,
  `broadcastMessage(historyItem) {
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('history', [...(this.currentHistory || []), historyItem]);
      bunBroadcast({ type: 'history_item', data: historyItem });
      return;
    }`
);

bundleContent = bundleContent.replace(
  /setSubmitQueryHandler\(handler\)\s*{/g,
  `setSubmitQueryHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('submitQuery', handler);
    }`
);

// Fix 7b: Patch broadcastPendingItem for live tool updates (browser agent streaming)
bundleContent = bundleContent.replace(
  /broadcastPendingItem\(pendingItem\)\s*{/g,
  `broadcastPendingItem(pendingItem) {
    // Store current pending item for new clients
    this.currentPendingItem = pendingItem;
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('pendingItem', pendingItem);
      bunBroadcast({ type: 'pending_item', data: pendingItem, ephemeral: true });
      return;
    }`
);

// Fix 7c: Patch broadcastLoadingState for loading state updates
bundleContent = bundleContent.replace(
  /broadcastLoadingState\(loadingState\)\s*{/g,
  `broadcastLoadingState(loadingState) {
    // Store current loading state for new clients
    this.currentLoadingState = loadingState;
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('loadingState', loadingState);
      bunBroadcast({ type: 'loading_state', data: loadingState, ephemeral: true });
      return;
    }`
);

// Fix 7d: Patch broadcastFooterData for footer updates
bundleContent = bundleContent.replace(
  /broadcastFooterData\(footerData\)\s*{/g,
  `broadcastFooterData(footerData) {
    if (typeof bunBroadcast !== 'undefined') {
      bunBroadcast({ type: 'footer_data', data: footerData });
      return;
    }`
);

// Fix 7e: Patch broadcastWithSequence (generic broadcast helper used by many methods)
bundleContent = bundleContent.replace(
  /broadcastWithSequence\(type, data\)\s*{/g,
  `broadcastWithSequence(type, data) {
    if (typeof bunBroadcast !== 'undefined') {
      bunBroadcast({ type, data });
      return;
    }`
);

// Fix 7f: Patch setAbortHandler
bundleContent = bundleContent.replace(
  /setAbortHandler\(handler\)\s*{/g,
  `setAbortHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('abort', handler);
    }`
);

// Fix 7g: Patch setConfirmationResponseHandler
bundleContent = bundleContent.replace(
  /setConfirmationResponseHandler\(handler\)\s*{/g,
  `setConfirmationResponseHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('confirmation', handler);
    }`
);

// Fix 8: Suppress locale warnings
console.log('   ✓ Suppressing locale warnings...');
bundleContent = bundleContent.replace(
  /console\.warn\("Could not read locales directory, falling back to defaults:", error\);/g,
  '// Warning suppressed for Bun executable'
);

bundleContent = bundleContent.replace(
  /console\.warn\(`Could not load translations for language \${language}:`, error\);/g,
  '// Warning suppressed for Bun executable'
);

// Fix 9: Replace file reading with embedded data check
bundleContent = bundleContent.replace(
  /const fileContent = await fs\d+\.readFile\(filePath, "utf-8"\);[\s]*const translations = JSON\.parse\(fileContent\);/g,
  `let translations;
   if (globalThis.__EMBEDDED_LOCALES && globalThis.__EMBEDDED_LOCALES[language]) {
     translations = globalThis.__EMBEDDED_LOCALES[language];
   } else {
     const fileContent = await fs7.readFile(filePath, "utf-8");
     translations = JSON.parse(fileContent);
   }`
);

// Write modified bundle
const tempPath = path.join(__dirname, '..', 'bundle', 'gemini-bun-unified.js');
fs.writeFileSync(tempPath, bundleContent);
console.log(`   ✓ Bundle size: ${(bundleContent.length / 1024 / 1024).toFixed(2)} MB`);

console.log('\n🚀 Compiling...');

// Detect Bun path - try multiple locations
let bunPath = '';
const possibleBunPaths = [
  path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'), // User profile (Windows)
  path.join(process.env.HOME || '', '.bun', 'bin', 'bun.exe'), // Home directory
  'C:\\Users\\thaci\\.bun\\bin\\bun.exe', // Local development fallback
  'bun.exe', // In PATH (Windows)
  'bun' // In PATH (cross-platform)
];

for (const testPath of possibleBunPaths) {
  try {
    // Test if the command works
    execSync(`"${testPath}" --version`, { stdio: 'ignore' });
    bunPath = testPath;
    console.log(`   ✓ Found Bun at: ${bunPath}`);
    break;
  } catch (e) {
    // Continue to next path
  }
}

if (!bunPath) {
  console.error('\n❌ Could not find Bun executable. Please ensure Bun is installed.');
  console.error('   Tried paths:', possibleBunPaths);
  process.exit(1);
}

try {
  const iconPath = path.join(__dirname, '..', 'assets', 'auditaria.ico');
  // Use --external to skip WASM modules that can't be bundled
  // These are only used for shell command parsing, not critical for browser-agent
  execSync(`"${bunPath}" build "${tempPath}" --compile --target=bun-windows-x64 --windows-icon="${iconPath}" --external web-tree-sitter --external tree-sitter-bash --outfile "${OUTPUT_PATH}"`, {
    stdio: 'inherit'
  });

  console.log('\n✅ Build successful!');
  console.log('\n📋 Test instructions:');
  console.log('   Interactive mode (default):');
  console.log('      auditaria-standalone.exe');
  console.log('   ');
  console.log('   One-shot mode with prompt:');
  console.log('      auditaria-standalone.exe "What is 2+2?"');
  console.log('   ');
  console.log('   Web interface mode:');
  console.log('      auditaria-standalone.exe -w no-browser');
  console.log('      Or with custom port: auditaria-standalone.exe -w no-browser --port 3000');
  console.log('   ');
  console.log('   Then open: http://localhost:8629 (or your custom port)');

} catch (error) {
  console.error('\n❌ Build failed:', error.message);
} finally {
  // Clean up temporary files
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
  if (fs.existsSync(BUN_BUNDLE_PATH)) {
    fs.unlinkSync(BUN_BUNDLE_PATH);
  }
}