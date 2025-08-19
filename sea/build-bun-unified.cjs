#!/usr/bin/env node

/**
 * Unified Bun WebSocket solution - Single server handling both HTTP and WebSocket
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini.js');
const OUTPUT_PATH = path.join(__dirname, '..', 'auditaria-standalone.exe');
const WEB_CLIENT_PATH = path.join(__dirname, '..', 'packages', 'web-client', 'src');

console.log('🔧 Building Auditaria CLI with unified Bun server...\n');

if (!fs.existsSync(BUNDLE_PATH)) {
  console.error('❌ Bundle not found');
  process.exit(1);
}

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
let bundleContent = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Remove shebang
if (bundleContent.startsWith('#!/')) {
  bundleContent = bundleContent.slice(bundleContent.indexOf('\n') + 1);
}

console.log('🔨 Applying fixes...');

// Fix 1: Interactive mode
bundleContent = bundleContent.replace(
  /const interactive = !!argv\.promptInteractive \|\| process33\.stdin\.isTTY && question\.length === 0;/,
  'const interactive = !!argv.promptInteractive || !!argv.web || (process33.stdin.isTTY && question.length === 0);'
);

// Fix 2: Unified Bun server that handles EVERYTHING
const unifiedBunServer = `
// UNIFIED BUN SERVER FOR HTTP + WEBSOCKET
(function() {
  if (typeof Bun === 'undefined' || !Bun.version) return;
  
  console.log('[Bun] Initializing unified server...');
  
  // Embedded locale data for Bun executable
  if (typeof globalThis.__EMBEDDED_LOCALES === 'undefined') {
    globalThis.__EMBEDDED_LOCALES = ${JSON.stringify(localeData)};
  }
  
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
    cliActionState: null
  };
  
  // Create unified Bun WebSocketServer replacement
  class BunUnifiedWebSocketServer {
    constructor(options) {
      console.log('[Bun] Creating unified WebSocket server');
      this.clients = wsClients;
      this._connectionHandler = null;
      
      // Only create server once
      if (unifiedServer) {
        console.log('[Bun] Server already exists on port', serverPort);
        return;
      }
      
      const port = options.port || (options.server && options.server.address?.()?.port) || 8629;
      
      // Create the unified Bun server
      unifiedServer = Bun.serve({
        port: port,
        hostname: 'localhost',
        
        fetch: (req, server) => {
          const url = new URL(req.url);
          
          // Handle WebSocket upgrade
          if (req.headers.get('upgrade') === 'websocket') {
            console.log('[Bun] WebSocket upgrade request');
            const success = server.upgrade(req, {
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
            console.log('[Bun] WebSocket connection opened');
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
            
            // Call the connection handler if set
            if (this._connectionHandler) {
              // Create a mock WebSocket for compatibility
              const mockWs = {
                send: (data) => ws.send(data),
                close: () => ws.close(),
                readyState: 1,
                on: (event, handler) => {
                  // Store handlers for later use
                  if (!ws._handlers) ws._handlers = {};
                  ws._handlers[event] = handler;
                }
              };
              
              // Store reference
              ws._mockWs = mockWs;
              
              this._connectionHandler(mockWs, {});
            }
          },
          
          message: (ws, message) => {
            console.log('[Bun] Message received:', message.toString().slice(0, 100));
            
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
              console.error('[Bun] Error handling message:', error);
            }
          },
          
          close: (ws) => {
            console.log('[Bun] WebSocket closed');
            wsClients.delete(ws);
            
            if (ws._mockWs && ws._handlers && ws._handlers.close) {
              ws._handlers.close();
            }
          },
          
          error: (ws, error) => {
            console.error('[Bun] WebSocket error:', error);
            wsClients.delete(ws);
            
            if (ws._mockWs && ws._handlers && ws._handlers.error) {
              ws._handlers.error(error);
            }
          }
        }
      });
      
      serverPort = unifiedServer.port;
      console.log('[Bun] Unified server started on port', serverPort);
      
      // Stop the original Express server if it exists
      if (options.server && options.server.close) {
        console.log('[Bun] Stopping original Express server');
        try {
          options.server.close();
          options.server.listening = false;
        } catch (e) {
          console.log('[Bun] Could not stop Express server:', e.message);
        }
      }
    }
    
    on(event, handler) {
      if (event === 'connection') {
        this._connectionHandler = handler;
        // If we already have clients, call handler for them
        wsClients.forEach(ws => {
          if (ws._mockWs) {
            handler(ws._mockWs, {});
          }
        });
      }
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
  
  // Override require('ws')
  try {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    
    Module.prototype.require = function(id) {
      if (id === 'ws') {
        return {
          WebSocketServer: BunUnifiedWebSocketServer,
          WebSocket: BunMockWebSocket,
          Server: BunUnifiedWebSocketServer
        };
      }
      return originalRequire.apply(this, arguments);
    };
  } catch (e) {}
  
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
  
  // Note: Express.static override removed - the unified Bun server handles static files directly
  
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
  };
  
  // Create handler setters
  globalThis.bunSetHandler = function(type, handler) {
    messageHandlers[type] = handler;
  };
  
  console.log('[Bun] Unified server ready');
})();
`;

// Inject the unified server
bundleContent = unifiedBunServer + '\n' + bundleContent;

// Fix 3: Patch WebInterfaceService to skip file checks in Bun and serve from embedded files
bundleContent = bundleContent.replace(
  /for \(const testPath of possiblePaths\) \{[\s\S]*?\}[\s]*if \(!webClientPath\) \{/g,
  `// In Bun runtime, skip file checks and use embedded files
  if (typeof Bun !== 'undefined' && globalThis.__EMBEDDED_WEB_FILES) {
    webClientPath = '/$bunfs/embedded-web-client';
    if (debugMode) {
      console.log('✓ Using embedded web client files in Bun runtime');
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

// Fix 3: Patch WebSocketServer instantiation
bundleContent = bundleContent.replace(
  /new import_websocket_server\.(default|WebSocketServer)\(/g,
  'new (globalThis.WebSocketServer || import_websocket_server.default)('
);

// Fix 4: Patch WebInterfaceService methods to use global broadcast
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

// Fix 4: Suppress locale warnings
console.log('   ✓ Suppressing locale warnings...');
bundleContent = bundleContent.replace(
  /console\.warn\("Could not read locales directory, falling back to defaults:", error\);/g,
  '// Warning suppressed for Bun executable'
);

bundleContent = bundleContent.replace(
  /console\.warn\(`Could not load translations for language \${language}:`, error\);/g,
  '// Warning suppressed for Bun executable'
);

// Fix 5: Replace file reading with embedded data check
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
const bunPath = 'C:\\Users\\thaci\\.bun\\bin\\bun.exe';

try {
  execSync(`"${bunPath}" build "${tempPath}" --compile --target=bun-windows-x64 --outfile "${OUTPUT_PATH}"`, {
    stdio: 'inherit'
  });
  
  console.log('\n✅ Build successful!');
  console.log('\n📋 Test instructions:');
  console.log('   1. Run: auditaria-standalone.exe -w no-browser');
  console.log('   2. Open: http://localhost:8629');
  console.log('   3. Check: WebSocket should show "Connected"');
  
} catch (error) {
  console.error('\n❌ Build failed:', error.message);
} finally {
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
}