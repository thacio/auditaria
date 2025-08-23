#!/usr/bin/env node

/**
 * Auditaria Launcher with Embedded GUI - Improved Version
 * 
 * This script builds a single Windows executable that contains:
 * 1. A PowerShell-based GUI for selecting launch options
 * 2. The entire Auditaria application with all unified fixes
 * 3. Embedded web client files
 * 4. Embedded locale files
 * 5. Unified Bun WebSocket server for web interface
 * 
 * When run, it displays a native Windows GUI first, then launches the embedded application.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini.js');
const OUTPUT_PATH = path.join(__dirname, '..', 'auditaria-launcher.exe');
const LAUNCHER_ENTRY_PATH = path.join(__dirname, '..', 'bundle', 'gemini-launcher-entry.js');
const WEB_CLIENT_PATH = path.join(__dirname, '..', 'packages', 'web-client', 'src');

console.log('🚀 Building Auditaria with embedded GUI launcher (Improved Version)...\n');

// Step 1: Ensure the application bundle exists
if (!fs.existsSync(BUNDLE_PATH)) {
  console.error(`❌ Application bundle not found at: ${BUNDLE_PATH}`);
  console.error('Please run "npm run bundle" first.');
  process.exit(1);
}
console.log('✓ Application bundle found.');

// Step 2: Embed locale files
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

// Step 3: Embed web client files
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

// Step 4: Read and prepare the application bundle
console.log('\n📖 Reading bundle...');
let bundleContent = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Remove shebang if it exists
if (bundleContent.startsWith('#!/')) {
  bundleContent = bundleContent.slice(bundleContent.indexOf('\n') + 1);
}

// Step 5: Apply all fixes from unified script
console.log('🔨 Applying unified fixes...');

// Fix 1: Interactive mode - include web mode
bundleContent = bundleContent.replace(
  /const interactive = !!argv\.promptInteractive \|\| process33\.stdin\.isTTY && question\.length === 0;/,
  'const interactive = !!argv.promptInteractive || !!argv.web || (process33.stdin.isTTY && question.length === 0);'
);

// Fix 2: Unified Bun server for HTTP + WebSocket
const unifiedBunServer = `
// UNIFIED BUN SERVER FOR HTTP + WEBSOCKET
(function() {
  if (typeof Bun === 'undefined' || !Bun.version) return;
  
  // console.log('[Bun] Initializing unified server...');
  
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
      // console.log('[Bun] Creating unified WebSocket server');
      this.clients = wsClients;
      this._connectionHandler = null;
      
      // Only create server once
      if (unifiedServer) {
        //console.log('[Bun] Server already exists on port', serverPort);
        return;
      }
      
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
            // console.log('[Bun] WebSocket upgrade request');
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
            // console.log('[Bun] WebSocket connection opened');
            wsClients.add(ws);
            
            // Send initial connection message
            ws.send(JSON.stringify({
              type: 'connection',
              data: { message: 'Connected to Auditaria' },
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
            // console.log('[Bun] Message received:', message.toString().slice(0, 100));
            
            try {
              const data = JSON.parse(message.toString());
              
              // Handle different message types
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
              if (!messageHandled && ws._mockWs && ws._handlers && ws._handlers.message) {
                ws._handlers.message(message);
              }
            } catch (error) {
              console.error('[Bun] Error handling message:', error);
            }
          },
          
          close: (ws) => {
            // console.log('[Bun] WebSocket closed');
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
  
  // console.log('[Bun] Unified server ready');
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

// Fix 4: Patch WebSocketServer instantiation
bundleContent = bundleContent.replace(
  /new import_websocket_server\.(default|WebSocketServer)\(/g,
  'new (globalThis.WebSocketServer || import_websocket_server.default)('
);

// Fix 5: Patch WebInterfaceService methods to use global broadcast
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

// Fix 6: Suppress locale warnings
bundleContent = bundleContent.replace(
  /console\.warn\("Could not read locales directory, falling back to defaults:", error\);/g,
  '// Warning suppressed for Bun executable'
);

bundleContent = bundleContent.replace(
  /console\.warn\(`Could not load translations for language \${language}:`, error\);/g,
  '// Warning suppressed for Bun executable'
);

// Fix 7: Replace file reading with embedded data check
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

console.log(`   ✓ All unified fixes applied`);
console.log(`   ✓ Bundle size: ${(bundleContent.length / 1024 / 1024).toFixed(2)} MB`);

// Step 6: Define the improved PowerShell GUI script
const powershellScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

# Create the main form
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Auditaria Launcher'
$form.Size = New-Object System.Drawing.Size(540, 590)
$form.MinimumSize = New-Object System.Drawing.Size(540, 590)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $false
$form.Icon = [System.Drawing.SystemIcons]::Application
$form.BackColor = [System.Drawing.Color]::FromArgb(240, 240, 240)

# Create title label
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(20, 20)
$titleLabel.Size = New-Object System.Drawing.Size(460, 30)
$titleLabel.Text = 'Auditaria - AI-Powered Audit Assistant'
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 51, 102)
$form.Controls.Add($titleLabel)

# Create working directory label and textbox
$dirLabel = New-Object System.Windows.Forms.Label
$dirLabel.Location = New-Object System.Drawing.Point(20, 65)
$dirLabel.Size = New-Object System.Drawing.Size(150, 20)
$dirLabel.Text = 'Working Directory:'
$dirLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($dirLabel)

$dirTextBox = New-Object System.Windows.Forms.TextBox
$dirTextBox.Location = New-Object System.Drawing.Point(20, 90)
$dirTextBox.Size = New-Object System.Drawing.Size(380, 25)
$dirTextBox.Text = [Environment]::GetFolderPath('MyDocuments')
$dirTextBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Controls.Add($dirTextBox)

# Create browse button
$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Location = New-Object System.Drawing.Point(410, 89)
$browseButton.Size = New-Object System.Drawing.Size(75, 27)
$browseButton.Text = 'Browse...'
$browseButton.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$browseButton.FlatStyle = 'Standard'
$browseButton.Add_Click({
    $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
    $folderBrowser.Description = 'Select the folder where Auditaria will have access'
    $folderBrowser.SelectedPath = $dirTextBox.Text
    $folderBrowser.ShowNewFolderButton = $true
    if ($folderBrowser.ShowDialog() -eq 'OK') {
        $dirTextBox.Text = $folderBrowser.SelectedPath
    }
})
$form.Controls.Add($browseButton)

# Create launch options group box
$optionsGroup = New-Object System.Windows.Forms.GroupBox
$optionsGroup.Location = New-Object System.Drawing.Point(20, 130)
$optionsGroup.Size = New-Object System.Drawing.Size(465, 130)
$optionsGroup.Text = 'Launch Options'
$optionsGroup.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($optionsGroup)

$webCheckBox = New-Object System.Windows.Forms.CheckBox
$webCheckBox.Location = New-Object System.Drawing.Point(15, 25)
$webCheckBox.Size = New-Object System.Drawing.Size(430, 25)
$webCheckBox.Text = 'Launch with Web Interface (--web)'
$webCheckBox.Checked = $true
$webCheckBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$optionsGroup.Controls.Add($webCheckBox)

$noBrowserCheckBox = New-Object System.Windows.Forms.CheckBox
$noBrowserCheckBox.Location = New-Object System.Drawing.Point(35, 50)
$noBrowserCheckBox.Size = New-Object System.Drawing.Size(410, 25)
$noBrowserCheckBox.Text = "Don't open browser automatically (no-browser)"
$noBrowserCheckBox.Checked = $false
$noBrowserCheckBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$noBrowserCheckBox.Enabled = $true
$optionsGroup.Controls.Add($noBrowserCheckBox)

# Custom port checkbox and textbox
$customPortCheckBox = New-Object System.Windows.Forms.CheckBox
$customPortCheckBox.Location = New-Object System.Drawing.Point(35, 75)
$customPortCheckBox.Size = New-Object System.Drawing.Size(120, 25)
$customPortCheckBox.Text = 'Custom port:'
$customPortCheckBox.Checked = $false
$customPortCheckBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$customPortCheckBox.Enabled = $true
$optionsGroup.Controls.Add($customPortCheckBox)

$portTextBox = New-Object System.Windows.Forms.TextBox
$portTextBox.Location = New-Object System.Drawing.Point(160, 75)
$portTextBox.Size = New-Object System.Drawing.Size(80, 25)
$portTextBox.Text = '8629'
$portTextBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$portTextBox.Enabled = $false
$portTextBox.MaxLength = 5
$optionsGroup.Controls.Add($portTextBox)

$portInfoLabel = New-Object System.Windows.Forms.Label
$portInfoLabel.Location = New-Object System.Drawing.Point(250, 78)
$portInfoLabel.Size = New-Object System.Drawing.Size(180, 20)
$portInfoLabel.Text = '(0-65535, default: 8629)'
$portInfoLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$portInfoLabel.ForeColor = [System.Drawing.Color]::Gray
$optionsGroup.Controls.Add($portInfoLabel)

# Create security group box
$securityGroup = New-Object System.Windows.Forms.GroupBox
$securityGroup.Location = New-Object System.Drawing.Point(20, 270)
$securityGroup.Size = New-Object System.Drawing.Size(465, 55)
$securityGroup.Text = 'Security Settings'
$securityGroup.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($securityGroup)

$sslCheckBox = New-Object System.Windows.Forms.CheckBox
$sslCheckBox.Location = New-Object System.Drawing.Point(15, 25)
$sslCheckBox.Size = New-Object System.Drawing.Size(440, 25)
$sslCheckBox.Text = 'Disable SSL verification (for corporate firewalls with MITM)'
$sslCheckBox.Checked = $false
$sslCheckBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$sslCheckBox.ForeColor = [System.Drawing.Color]::FromArgb(139, 69, 19)
$securityGroup.Controls.Add($sslCheckBox)

# Create approval mode group box
$approvalGroup = New-Object System.Windows.Forms.GroupBox
$approvalGroup.Location = New-Object System.Drawing.Point(20, 335)
$approvalGroup.Size = New-Object System.Drawing.Size(465, 100)
$approvalGroup.Text = 'Approval Mode'
$approvalGroup.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($approvalGroup)

$approvalDefaultRadio = New-Object System.Windows.Forms.RadioButton
$approvalDefaultRadio.Location = New-Object System.Drawing.Point(15, 25)
$approvalDefaultRadio.Size = New-Object System.Drawing.Size(440, 20)
$approvalDefaultRadio.Text = 'Default - Prompt for approval on tool use'
$approvalDefaultRadio.Checked = $true
$approvalDefaultRadio.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$approvalGroup.Controls.Add($approvalDefaultRadio)

$approvalAutoEditRadio = New-Object System.Windows.Forms.RadioButton
$approvalAutoEditRadio.Location = New-Object System.Drawing.Point(15, 48)
$approvalAutoEditRadio.Size = New-Object System.Drawing.Size(440, 20)
$approvalAutoEditRadio.Text = 'Auto Edit - Auto-approve edit tools only'
$approvalAutoEditRadio.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$approvalGroup.Controls.Add($approvalAutoEditRadio)

$approvalYoloRadio = New-Object System.Windows.Forms.RadioButton
$approvalYoloRadio.Location = New-Object System.Drawing.Point(15, 71)
$approvalYoloRadio.Size = New-Object System.Drawing.Size(440, 20)
$approvalYoloRadio.Text = 'YOLO - Auto-approve all tools (use with caution)'
$approvalYoloRadio.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$approvalYoloRadio.ForeColor = [System.Drawing.Color]::FromArgb(255, 69, 0)
$approvalGroup.Controls.Add($approvalYoloRadio)

# Enable/disable no-browser and custom port based on web checkbox
$webCheckBox.Add_CheckedChanged({
    $noBrowserCheckBox.Enabled = $webCheckBox.Checked
    $customPortCheckBox.Enabled = $webCheckBox.Checked
    if (-not $webCheckBox.Checked) {
        $noBrowserCheckBox.Checked = $false
        $customPortCheckBox.Checked = $false
        $portTextBox.Enabled = $false
    }
})

# Enable/disable port textbox based on custom port checkbox
$customPortCheckBox.Add_CheckedChanged({
    $portTextBox.Enabled = $customPortCheckBox.Checked
})

# Create Start and Cancel buttons
$startButton = New-Object System.Windows.Forms.Button
$startButton.Location = New-Object System.Drawing.Point(310, 490)
$startButton.Size = New-Object System.Drawing.Size(100, 35)
$startButton.Text = 'Start Auditaria'
$startButton.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$startButton.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 212)
$startButton.ForeColor = [System.Drawing.Color]::White
$startButton.FlatStyle = 'Flat'
$startButton.FlatAppearance.BorderSize = 0
$startButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($startButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Location = New-Object System.Drawing.Point(420, 490)
$cancelButton.Size = New-Object System.Drawing.Size(85, 35)
$cancelButton.Text = 'Cancel'
$cancelButton.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$cancelButton.FlatStyle = 'Flat'
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)

$form.AcceptButton = $startButton
$form.CancelButton = $cancelButton

# Show the dialog and process the result
$result = $form.ShowDialog()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $workingDir = $dirTextBox.Text
    
    # Validate directory exists
    if (-not (Test-Path -Path $workingDir -PathType Container)) {
        [System.Windows.Forms.MessageBox]::Show(
            'The selected directory does not exist. Please choose a valid directory.',
            'Invalid Directory',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        exit 1
    }
    
    # Build command line arguments
    $args = @()
    if ($webCheckBox.Checked) {
        if ($noBrowserCheckBox.Checked) {
            $args += '--web', 'no-browser'
        } else {
            $args += '--web'
        }
        
        # Add custom port if specified
        if ($customPortCheckBox.Checked) {
            $port = $portTextBox.Text.Trim()
            
            # Validate port number
            $portNum = 0
            if ([int]::TryParse($port, [ref]$portNum)) {
                if ($portNum -ge 0 -and $portNum -le 65535) {
                    $args += '--port', $port
                } else {
                    [System.Windows.Forms.MessageBox]::Show(
                        "Invalid port number: $port. Port must be between 0-65535. Using default port 8629.",
                        'Invalid Port',
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Warning
                    )
                    # Continue without adding the port argument
                }
            } else {
                [System.Windows.Forms.MessageBox]::Show(
                    "Invalid port number: $port. Please enter a valid number.",
                    'Invalid Port',
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                )
                # Continue without adding the port argument
            }
        }
    }
    
    # Add approval mode
    if ($approvalAutoEditRadio.Checked) {
        $args += '--approval-mode', 'auto_edit'
    } elseif ($approvalYoloRadio.Checked) {
        $args += '--approval-mode', 'yolo'
    }
    # Default mode doesn't need explicit parameter
    
    # Output the configuration as a JSON object
    $output = @{
        workingDir = $workingDir
        args = $args
        disableSSL = $sslCheckBox.Checked
    }
    Write-Output ($output | ConvertTo-Json -Compress)
    exit 0
} else {
    # User cancelled
    exit 1
}
`;

console.log('✓ PowerShell GUI script defined.');

// Step 7: Create the launcher entry point script
const launcherEntryPoint = `
// Launcher Entry Point with Embedded GUI
(function() {
  const powershellScript = \`${powershellScript.replace(/`/g, '``').replace(/\$/g, '\\$')}\`;
  
  let powershell;
  if (typeof Bun !== 'undefined') {
    // Bun runtime
    powershell = Bun.spawnSync(['powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass', 
      '-WindowStyle', 'Hidden',
      '-Command',
      powershellScript
    ], {
      stdout: 'pipe',
      stderr: 'pipe'
    });
    
    // Convert Bun result to Node-like format
    const textDecoder = new TextDecoder();
    powershell = {
      status: powershell.exitCode,
      stdout: powershell.stdout ? textDecoder.decode(powershell.stdout) : '',
      stderr: powershell.stderr ? textDecoder.decode(powershell.stderr) : '',
      error: powershell.exitCode !== 0 && !powershell.stdout ? new Error('PowerShell failed') : null
    };
  } else {
    // Node.js runtime (fallback)
    const { spawnSync } = require('child_process');
    powershell = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-Command',
      powershellScript
    ], { encoding: 'utf8', shell: false });
  }

  if (powershell.error) {
    console.error('Failed to start PowerShell:', powershell.error);
    process.exit(1);
  }

  if (powershell.status !== 0) {
    // User likely cancelled, or an error occurred in PowerShell
    process.exit(powershell.status || 0);
  }

  const output = powershell.stdout?.trim();
  if (!output) {
    // No output means the user cancelled
    process.exit(0);
  }

  let config;
  try {
    config = JSON.parse(output);
  } catch (e) {
    console.error('Failed to parse configuration from GUI:', e);
    console.error('Received:', output);
    process.exit(1);
  }

  // Configuration successful, now prepare to run the app

  // 1. Change the working directory
  try {
    process.chdir(config.workingDir);
    console.log(\`Working directory: \${config.workingDir}\`);
  } catch (e) {
    console.error(\`Failed to change working directory to: \${config.workingDir}\`);
    console.error(e);
    process.exit(1);
  }

  // 2. Handle SSL setting for corporate firewalls
  if (config.disableSSL) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log('⚠️  SSL verification disabled for corporate firewall');
  }

  // 3. Set the process arguments
  // process.argv will be [executable, script, ...args]
  process.argv = [
    process.execPath,
    __filename,
    ...config.args
  ];

// 4. Run the embedded application bundle with all fixes
})();

${bundleContent}
`;

console.log('✓ Launcher entry point script created.');

// Step 8: Write the launcher entry point to a temporary file
try {
  fs.writeFileSync(LAUNCHER_ENTRY_PATH, launcherEntryPoint);
  console.log(`✓ Launcher entry point written to: ${LAUNCHER_ENTRY_PATH}`);
} catch (error) {
  console.error('❌ Failed to write launcher entry point file:', error);
  process.exit(1);
}

// Step 9: Compile the launcher entry point with Bun
console.log('\n📦 Compiling with Bun...');

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
    console.log(`✓ Found Bun at: ${bunPath}`);
    break;
  } catch (e) {
    // Continue to next path
  }
}

if (!bunPath) {
  console.error('❌ Could not find Bun executable. Please ensure Bun is installed.');
  console.error('Tried paths:', possibleBunPaths);
  process.exit(1);
}

try {
  const iconPath = path.join(__dirname, '..', 'assets', 'auditaria.ico');
  execSync(`"${bunPath}" build "${LAUNCHER_ENTRY_PATH}" --compile --target=bun-windows-x64 --windows-icon="${iconPath}" --outfile "${OUTPUT_PATH}"`, {
    stdio: 'inherit'
  });
  
  console.log(`\n✅ Build successful! Executable created at: ${OUTPUT_PATH}`);
  console.log('\n📋 Features:');
  console.log('   ✓ Native Windows GUI for launch options');
  console.log('   ✓ Embedded web client files');
  console.log('   ✓ Embedded locale files');
  console.log('   ✓ Unified Bun WebSocket server');
  console.log('   ✓ All fixes from unified build applied');
  console.log('\n🚀 To test:');
  console.log('   1. Run: auditaria-launcher.exe');
  console.log('   2. Select folder and options in GUI');
  console.log('   3. Click "Start Auditaria"');
  
} catch (error) {
  console.error('\n❌ Bun compilation failed:', error.message);
  process.exit(1);
} finally {
  // Step 10: Clean up the temporary entry point file
  if (fs.existsSync(LAUNCHER_ENTRY_PATH)) {
    fs.unlinkSync(LAUNCHER_ENTRY_PATH);
    console.log(`✓ Cleaned up temporary file: ${LAUNCHER_ENTRY_PATH}`);
  }
}

console.log('\n✨ Done!');