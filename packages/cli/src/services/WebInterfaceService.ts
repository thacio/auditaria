/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import express from 'express';
import type { Express } from 'express';
import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// WEB_INTERFACE_START: Import HTML parser for link rewriting
import { parse } from 'node-html-parser';
// WEB_INTERFACE_END
import type { HistoryItem, ConsoleMessageItem, ResponseBlock } from '../ui/types.js';
import { ToolConfirmationOutcome, MCPServerConfig, DiscoveredMCPTool } from '@google/gemini-cli-core';
import type { FooterData } from '../ui/contexts/FooterContext.js';
import type { LoadingStateData } from '../ui/contexts/LoadingStateContext.js';
import type { PendingToolConfirmation } from '../ui/contexts/ToolConfirmationContext.js';
import type { SlashCommand } from '../ui/commands/types.js';
import type { TerminalCaptureData } from '../ui/contexts/TerminalCaptureContext.js';
import { EventEmitter } from 'events';
// WEB_INTERFACE_START: Import for multimodal support
import { type PartListUnion, createPartFromBase64 } from '@google/genai';

// WeakMap to store attachment metadata without polluting the Part objects
export const attachmentMetadataMap = new WeakMap<any, any>();
// WEB_INTERFACE_END

// WEB_INTERFACE_START: Import FileSystemService for file browser feature
import { FileSystemService } from './FileSystemService.js';
// WEB_INTERFACE_END

// WEB_INTERFACE_START: Import FileWatcherService for file change detection
import { FileWatcherService } from './FileWatcherService.js';
// WEB_INTERFACE_END

// WEB_INTERFACE_START: Import DirectoryWatcherService for automatic tree updates
import { DirectoryWatcherService } from './DirectoryWatcherService.js';
// WEB_INTERFACE_END

// Import DocxParserService for markdown to DOCX parsing
import { DocxParserService } from './DocxParserService.js';

// Knowledge Base Search Service
import { SearchServiceManager, getSearchService, collaborativeWritingService } from '@google/gemini-cli-core';

// AUDITARIA: Lazy load search module to check database existence
let searchModule: typeof import('@thacio/auditaria-search') | null = null;
async function getSearchModule(): Promise<typeof import('@thacio/auditaria-search')> {
  if (!searchModule) {
    searchModule = await import('@thacio/auditaria-search');
  }
  return searchModule;
}

// AUDITARIA: Import browser streaming components
import { StreamManager, SessionManager, type StreamFrame, type StagehandPage } from '@thacio/browser-agent';

// WEB_INTERFACE_START: Message resilience system
interface SequencedMessage {
  sequence: number;
  message: string;
  timestamp: number;
  ephemeral?: boolean;
}

// AUDITARIA: Message types that are full state snapshots - only keep latest, not history
// For these types, we replace the previous message instead of accumulating
const LATEST_ONLY_MESSAGE_TYPES = new Set([
  'file_tree_response',    // Full tree snapshot (5MB+) - only latest matters
  'mcp_servers',           // Full server list - only latest matters
  'slash_commands',        // Full command list - only latest matters
  'model_menu_data',       // WEB_INTERFACE: model menu snapshot - only latest matters
  'response_state',        // WEB_INTERFACE: Only latest response state matters
  'input_history_sync',    // AUDITARIA: input history snapshot - only latest matters
  // NOTE: console_messages intentionally NOT included - user needs to see live logs
]);

class CircularMessageBuffer {
  private buffer: (SequencedMessage | null)[];
  private head: number = 0;
  private tail: number = 0;
  private size: number = 0;
  private capacity: number;
  // AUDITARIA: Store latest-only messages separately (one per type)
  private latestOnlyMessages: Map<string, SequencedMessage> = new Map();

  constructor(capacity: number = 100) {
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
  }

  add(message: SequencedMessage, messageType?: string): void {
    // AUDITARIA: For state-snapshot messages, only keep the latest (replace previous)
    if (messageType && LATEST_ONLY_MESSAGE_TYPES.has(messageType)) {
      this.latestOnlyMessages.set(messageType, message);
      return;
    }

    this.buffer[this.tail] = message;
    this.tail = (this.tail + 1) % this.capacity;

    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Buffer is full, advance head
      this.head = (this.head + 1) % this.capacity;
    }
  }

  getMessagesFrom(sequence: number, persistentOnly: boolean = false): SequencedMessage[] {
    const messages: SequencedMessage[] = [];
    let current = this.head;

    // Get messages from circular buffer
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence > sequence) {
        // If persistentOnly is true, skip ephemeral messages
        if (!persistentOnly || !msg.ephemeral) {
          messages.push(msg);
        }
      }
      current = (current + 1) % this.capacity;
    }

    // AUDITARIA: Also include latest-only messages if they're newer than requested sequence
    for (const msg of this.latestOnlyMessages.values()) {
      if (msg.sequence > sequence) {
        // Respect persistentOnly filter for consistency
        if (!persistentOnly || !msg.ephemeral) {
          messages.push(msg);
        }
      }
    }

    return messages.sort((a, b) => a.sequence - b.sequence);
  }

  hasSequence(sequence: number): boolean {
    // Check circular buffer
    let current = this.head;
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence === sequence) {
        return true;
      }
      current = (current + 1) % this.capacity;
    }

    // AUDITARIA: Also check latest-only messages for consistency
    for (const msg of this.latestOnlyMessages.values()) {
      if (msg.sequence === sequence) {
        return true;
      }
    }

    return false;
  }

  getOldestSequence(): number | null {
    if (this.size === 0) return null;
    const msg = this.buffer[this.head];
    return msg ? msg.sequence : null;
  }
  
  // Prune messages that have been acknowledged
  pruneAcknowledged(acknowledgedSequence: number): number {
    let pruned = 0;
    let current = this.head;
    
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence <= acknowledgedSequence) {
        // This message has been acknowledged, can be nullified to free memory
        this.buffer[current] = null;
        pruned++;
      }
      current = (current + 1) % this.capacity;
    }
    
    return pruned;
  }
}

interface ClientState {
  messageBuffer: CircularMessageBuffer;
  lastAcknowledgedSequence: number;
}
// WEB_INTERFACE_END

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebInterfaceConfig {
  port?: number;
  host?: string;
}

export class WebInterfaceService extends EventEmitter {
  private app?: Express;
  private server?: Server;
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private isRunning = false;
  private port?: number;
  // WEB_INTERFACE_START: Message resilience system
  private sequenceNumber: number = 0;
  private clientStates: WeakMap<WebSocket, ClientState> = new WeakMap();
  private readonly MESSAGE_BUFFER_SIZE = 200;
  private readonly MAX_SEQUENCE_NUMBER = Number.MAX_SAFE_INTEGER - 1000000; // Leave headroom before overflow
  // WEB_INTERFACE_END
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  private submitQueryHandler?: (query: PartListUnion) => void;
  // WEB_INTERFACE_END
  private abortHandler?: () => void;
  private confirmationResponseHandler?: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void;
  private currentHistory: HistoryItem[] = [];
  private currentSlashCommands: readonly SlashCommand[] = [];
  private currentModelMenuData: any = null; // WEB_INTERFACE: model selector menu data
  private currentMCPServers: { servers: any[]; blockedServers: any[] } = { servers: [], blockedServers: [] };
  private currentConsoleMessages: ConsoleMessageItem[] = [];
  private currentCliActionState: { active: boolean; reason: string; title: string; message: string } | null = null;
  private currentTerminalCapture: TerminalCaptureData | null = null;
  // WEB_INTERFACE_START: Track ephemeral states for reconnection
  private currentResponseBlocks: ResponseBlock[] | null = null;
  private currentLoadingState: LoadingStateData | null = null;
  private currentFooterData: FooterData | null = null;
  private currentInputHistory: string[] = []; // AUDITARIA: input history for ArrowUp/Down on web
  private activeToolConfirmations: Map<string, PendingToolConfirmation> = new Map();
  // WEB_INTERFACE_END
  // WEB_INTERFACE_START: File system service for file browser
  private fileSystemService?: FileSystemService;
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: File watcher service for external change detection
  private fileWatcherService?: FileWatcherService;
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Directory watcher service for automatic tree updates
  private directoryWatcherService?: DirectoryWatcherService;
  // WEB_INTERFACE_END

  // DOCX parser service for markdown to DOCX conversion
  private docxParser?: DocxParserService;

  // AUDITARIA: Browser streaming state
  private streamManager?: StreamManager;
  private streamClients: Map<WebSocket, { sessionId: string; unsubscribe?: () => Promise<void> }> = new Map();

  /**
   * Start HTTP server on specified port
   */
  private async startServerOnPort(port: number, host: string = 'localhost'): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = this.app!.listen(port, host, () => {
        // Small delay to ensure server is fully ready
        setTimeout(() => resolve(server), 10);
      });
      server.on('error', reject);
    });
  }

  /**
   * Start the web interface server
   */
  async start(config: WebInterfaceConfig = {}): Promise<number> {
    if (this.isRunning) {
      throw new Error('Web interface is already running');
    }

    try {
      this.app = express();
      
      // Serve static files from web-client directory
      // The web client files are bundled with the CLI package
      const possiblePaths: string[] = [
        // 1. Package-relative resolution (best for global npm installations)
        (() => {
          try {
            const packageDir = path.dirname(require.resolve('@thacio/auditaria/package.json'));
            return path.join(packageDir, 'web-client');
          } catch {
            return null;
          }
        })(),
        // 2. For published package: web-client is in the same dist folder
        path.resolve(__dirname, 'web-client'),
        // 3. For development: try bundle location first
        path.resolve(__dirname, '../../../bundle/web-client'), 
        // 4. Development fallback: source files
        path.resolve(__dirname, '../../../packages/web-client/src'),
        // 5. Legacy development paths
        path.resolve(process.cwd(), 'packages/web-client/src'),
      ].filter((path): path is string => path !== null); // Type-safe filter to remove null values
      
      let webClientPath = '';
      const debugMode = process.env.DEBUG || process.env.NODE_ENV === 'development';
      
      if (debugMode) {
        // console.log('Web client path resolution attempts:');
        possiblePaths.forEach((testPath, index) => {
          // console.log(`  ${index + 1}. ${testPath}`);
        });
      }
      
      for (const testPath of possiblePaths) {
        try {
          const fs = await import('fs');
          const indexPath = path.join(testPath, 'index.html');
          if (fs.existsSync(indexPath)) {
            webClientPath = testPath;
            if (debugMode) {
              // console.log(`✓ Found web client files at: ${webClientPath}`);
            }
            break;
          } else if (debugMode) {
            // console.log(`✗ Not found: ${indexPath}`);
          }
        } catch (error) {
          if (debugMode) {
            // console.log(`✗ Error checking ${testPath}:`, error);
          }
          // Continue to next path
        }
      }
      
      if (!webClientPath) {
        const errorMsg = 'Could not find web client files in any of the attempted paths';
        if (debugMode) {
          console.error('❌', errorMsg);
          console.error('Attempted paths:', possiblePaths);
        }
        throw new Error(errorMsg);
      }
      
      // console.log('Web client serving from:', webClientPath);
      this.app.use(express.static(webClientPath));
      
      // API endpoint for current history
      this.app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', clients: this.clients.size });
      });

      // WEB_INTERFACE_START: HTML link rewriting function
      /**
       * Rewrite all relative URLs in HTML content to absolute preview URLs
       * This enables proper navigation (forward and backward) without base tag issues
       */
      const rewriteHtmlLinks = (content: string, absolutePath: string): string => {
        try {
          const root = parse(content);
          const baseDir = path.dirname(absolutePath);

          // Elements with href or src attributes that need rewriting
          const elementsToRewrite = [
            { selector: 'a[href]', attr: 'href' },
            { selector: 'img[src]', attr: 'src' },
            { selector: 'link[href]', attr: 'href' },
            { selector: 'script[src]', attr: 'src' },
            { selector: 'source[src]', attr: 'src' },
            { selector: 'video[src]', attr: 'src' },
            { selector: 'audio[src]', attr: 'src' },
            { selector: 'iframe[src]', attr: 'src' },
            { selector: 'embed[src]', attr: 'src' },
            { selector: 'object[data]', attr: 'data' },
            { selector: 'form[action]', attr: 'action' }
          ];

          for (const { selector, attr } of elementsToRewrite) {
            const elements = root.querySelectorAll(selector);

            for (const el of elements) {
              const value = el.getAttribute(attr);

              // Skip if no value
              if (!value) continue;

              // Skip absolute URLs (http://, https://, //)
              if (value.startsWith('http://') ||
                  value.startsWith('https://') ||
                  value.startsWith('//')) {
                continue;
              }

              // Skip data URLs
              if (value.startsWith('data:')) {
                continue;
              }

              // Skip anchors (same-page links)
              if (value.startsWith('#')) {
                continue;
              }

              // Skip mailto, tel, javascript protocols
              if (value.startsWith('mailto:') ||
                  value.startsWith('tel:') ||
                  value.startsWith('javascript:')) {
                continue;
              }

              // This is a relative URL - resolve it to absolute filesystem path
              const resolvedPath = path.resolve(baseDir, value);
              const normalizedPath = resolvedPath.replace(/\\/g, '/');

              // Rewrite to preview URL
              el.setAttribute(attr, `/preview-file/${encodeURIComponent(normalizedPath)}`);
            }
          }

          return root.toString();
        } catch (error) {
          console.error('Error rewriting HTML links:', error);
          // Return original content if rewriting fails
          return content;
        }
      };
      // WEB_INTERFACE_END

      // WEB_INTERFACE_START: HTML Preview endpoint
      // Serves files from filesystem with proper MIME types and base tag injection
      // Uses wildcard routing for elegant path resolution
      // Supports HTTP Range requests for video/audio seeking
      this.app.get('/preview-file/*', async (req, res) => {
        try {
          const path = await import('node:path');
          const fs = await import('node:fs/promises');
          const nodeFs = await import('node:fs');

          // Get the file path from the URL (everything after /preview-file/)
          const requestedPath = (req.params as any)[0] as string;
          if (!requestedPath) {
            res.status(400).send('Missing file path');
            return;
          }

          // Decode the path
          const decodedPath = decodeURIComponent(requestedPath);

          // Security: ensure path is absolute and normalized
          const absolutePath = path.isAbsolute(decodedPath)
            ? path.normalize(decodedPath)
            : path.resolve(decodedPath);

          // Get file stats for size information
          const stats = await fs.stat(absolutePath);
          const fileSize = stats.size;

          // Read file extension
          const ext = path.extname(absolutePath).toLowerCase();

          // Determine if binary or text
          const binaryExtensions = [
            // Images
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.tif', '.avif',
            // Fonts
            '.woff', '.woff2', '.ttf', '.eot', '.otf',
            // Documents
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
            // Video
            '.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv',
            // Audio
            '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus',
            // Archives
            '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso',
            // Executables and binaries
            '.exe', '.dll', '.so', '.dylib', '.bin', '.dmg', '.pkg', '.deb', '.rpm'
          ];
          const isBinary = binaryExtensions.includes(ext);

          // Video and audio extensions that need Range support for seeking
          const mediaExtensions = [
            '.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv',
            '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus'
          ];
          const isMedia = mediaExtensions.includes(ext);

          // Set appropriate content type
          const contentTypes: Record<string, string> = {
            // HTML & Web
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.xml': 'application/xml; charset=utf-8',
            '.rss': 'application/rss+xml; charset=utf-8',
            '.atom': 'application/atom+xml; charset=utf-8',

            // Images
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.ico': 'image/x-icon',
            '.bmp': 'image/bmp',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff',
            '.avif': 'image/avif',

            // Fonts
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
            '.eot': 'application/vnd.ms-fontobject',

            // Documents
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.ppt': 'application/vnd.ms-powerpoint',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            '.odt': 'application/vnd.oasis.opendocument.text',
            '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
            '.odp': 'application/vnd.oasis.opendocument.presentation',

            // Data formats
            '.csv': 'text/csv; charset=utf-8',
            '.tsv': 'text/tab-separated-values; charset=utf-8',
            '.yaml': 'text/yaml; charset=utf-8',
            '.yml': 'text/yaml; charset=utf-8',
            '.toml': 'application/toml; charset=utf-8',
            '.ini': 'text/plain; charset=utf-8',
            '.conf': 'text/plain; charset=utf-8',
            '.cfg': 'text/plain; charset=utf-8',

            // Text files
            '.txt': 'text/plain; charset=utf-8',
            '.md': 'text/markdown; charset=utf-8',
            '.log': 'text/plain; charset=utf-8',
            '.rtf': 'application/rtf',

            // Video
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.wmv': 'video/x-ms-wmv',
            '.flv': 'video/x-flv',
            '.mkv': 'video/x-matroska',
            '.m4v': 'video/x-m4v',
            '.ogv': 'video/ogg',

            // Audio
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.aac': 'audio/aac',
            '.m4a': 'audio/mp4',
            '.flac': 'audio/flac',
            '.wma': 'audio/x-ms-wma',
            '.opus': 'audio/opus',

            // Archives
            '.zip': 'application/zip',
            '.rar': 'application/vnd.rar',
            '.7z': 'application/x-7z-compressed',
            '.tar': 'application/x-tar',
            '.gz': 'application/gzip',
            '.bz2': 'application/x-bzip2',
            '.xz': 'application/x-xz',
            '.iso': 'application/x-iso9660-image',

            // Executables
            '.exe': 'application/vnd.microsoft.portable-executable',
            '.dll': 'application/x-msdownload',
            '.dmg': 'application/x-apple-diskimage',
            '.pkg': 'application/x-newton-compatible-pkg',
            '.deb': 'application/vnd.debian.binary-package',
            '.rpm': 'application/x-rpm',

            // Programming languages (common source code)
            '.ts': 'text/typescript; charset=utf-8',
            '.tsx': 'text/typescript; charset=utf-8',
            '.jsx': 'text/jsx; charset=utf-8',
            '.py': 'text/x-python; charset=utf-8',
            '.rb': 'text/x-ruby; charset=utf-8',
            '.php': 'text/x-php; charset=utf-8',
            '.java': 'text/x-java; charset=utf-8',
            '.c': 'text/x-c; charset=utf-8',
            '.cpp': 'text/x-c++; charset=utf-8',
            '.h': 'text/x-c; charset=utf-8',
            '.hpp': 'text/x-c++; charset=utf-8',
            '.cs': 'text/x-csharp; charset=utf-8',
            '.go': 'text/x-go; charset=utf-8',
            '.rs': 'text/x-rust; charset=utf-8',
            '.swift': 'text/x-swift; charset=utf-8',
            '.kt': 'text/x-kotlin; charset=utf-8',
            '.sh': 'application/x-sh; charset=utf-8',
            '.bash': 'application/x-sh; charset=utf-8',
            '.zsh': 'application/x-sh; charset=utf-8',

            // Other
            '.wasm': 'application/wasm',
            '.ics': 'text/calendar; charset=utf-8',
            '.vcf': 'text/vcard; charset=utf-8'
          };

          const contentType = contentTypes[ext] || 'application/octet-stream';
          res.setHeader('Content-Type', contentType);

          // Handle Range requests for video/audio files (enables seeking)
          if (isMedia && req.headers.range) {
            // Parse range header (e.g., "bytes=0-1023" or "bytes=1024-")
            const range = req.headers.range;
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            // Validate range
            if (start >= fileSize || end >= fileSize || start > end) {
              res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
              res.send('Range Not Satisfiable');
              return;
            }

            const chunkSize = (end - start) + 1;

            // Set headers for partial content
            res.status(206); // Partial Content
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunkSize);

            // Stream the requested range
            const stream = nodeFs.createReadStream(absolutePath, { start, end });
            stream.pipe(res);

            // Handle stream errors
            stream.on('error', (error) => {
              console.error('Stream error:', error);
              if (!res.headersSent) {
                res.status(500).send('Error streaming file');
              }
            });
          }
          // For media files without range request, still indicate range support
          else if (isMedia) {
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', fileSize.toString());

            // Stream entire file
            const stream = nodeFs.createReadStream(absolutePath);
            stream.pipe(res);

            stream.on('error', (error) => {
              console.error('Stream error:', error);
              if (!res.headersSent) {
                res.status(500).send('Error streaming file');
              }
            });
          }
          // For non-media files, read and send as before
          else {
            const content = isBinary
              ? await fs.readFile(absolutePath)
              : await fs.readFile(absolutePath, 'utf-8');

            // WEB_INTERFACE_START: For HTML files, rewrite all relative URLs to absolute preview URLs
            // This enables proper browser navigation (back/forward) without base tag URL encoding issues
            if ((ext === '.html' || ext === '.htm') && typeof content === 'string') {
              const rewrittenContent = rewriteHtmlLinks(content, absolutePath);
              res.send(rewrittenContent);
            } else {
              res.send(content);
            }
            // WEB_INTERFACE_END
          }
        } catch (error: any) {
          console.error('Preview file error:', error);
          if (error.code === 'ENOENT') {
            res.status(404).send('File not found');
          } else {
            res.status(500).send(`Error: ${error.message}`);
          }
        }
      });
      // WEB_INTERFACE_END

      // Start HTTP server with port fallback
      let requestedPort = config.port || 8629; // Default to 8629
      const host = config.host || 'localhost';
      
      // Validate port number
      if (config.port !== undefined && config.port !== null) {
        if (isNaN(config.port) || config.port < 0 || config.port > 65535) {
          console.error(`Invalid port number: ${config.port}. Port must be between 0-65535. Starting in another port.`);
          requestedPort = 8629;
        }
      }
      
      let usedFallback = false;
      try {
        // Try requested port first
        this.server = await this.startServerOnPort(requestedPort, host);
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          try {
            // Retry with random port (0 = random)
            this.server = await this.startServerOnPort(0, host);
            usedFallback = true;
          } catch (fallbackError: any) {
            // If fallback also fails, throw the original error with more context
            throw new Error(`Failed to start web server on port ${requestedPort} (in use) and fallback to random port also failed: ${fallbackError.message}`);
          }
        } else {
          throw error; // Re-throw non-port-conflict errors
        }
      }
      
      const address = this.server.address();
      if (!address || typeof address === 'string') {
        throw new Error(`Failed to get server address. Address type: ${typeof address}, value: ${address}`);
      }
      this.port = address.port;

      // Log fallback message after we have the actual assigned port
      if (usedFallback) {
        // console.log(`Port ${requestedPort} is in use, using port ${this.port} instead`);
      }

      // Set up WebSocket server with compression enabled
      this.wss = new WebSocketServer({ 
        server: this.server,
        perMessageDeflate: {
          zlibDeflateOptions: {
            // See zlib defaults
            chunkSize: 1024,
            memLevel: 7,
            level: 3
          },
          zlibInflateOptions: {
            chunkSize: 10 * 1024
          },
          // Other options settable:
          clientNoContextTakeover: true, // Defaults to negotiated value
          serverNoContextTakeover: true, // Defaults to negotiated value
          serverMaxWindowBits: 10, // Defaults to negotiated value
          // Below options specified as default values
          concurrencyLimit: 10, // Limits zlib concurrency for perf
          threshold: 1024 // Size (in bytes) below which messages should not be compressed
        }
      });
      this.setupWebSocketHandlers();

      // WEB_INTERFACE_START: Initialize file system service
      // Use current working directory as workspace root
      this.fileSystemService = new FileSystemService(process.cwd());
      // WEB_INTERFACE_END

      // WEB_INTERFACE_START: Initialize file watcher service
      this.fileWatcherService = new FileWatcherService(process.cwd());
      this.setupFileWatcherHandlers();
      // WEB_INTERFACE_END

      // WEB_INTERFACE_START: Initialize directory watcher service for automatic tree updates
      this.directoryWatcherService = new DirectoryWatcherService(
        process.cwd(),
        this.fileSystemService?.getIgnoredPatterns()
      );
      this.setupDirectoryWatcherHandlers();
      await this.directoryWatcherService.start();
      // WEB_INTERFACE_END

      // Initialize DOCX parser service
      this.docxParser = new DocxParserService(process.cwd());

      // AUDITARIA: Initialize browser streaming manager
      this.streamManager = StreamManager.getInstance();
      this.streamManager.setPageResolver(async (sessionId: string) => {
        const sessionManager = SessionManager.getInstance();
        if (!sessionManager.hasSession(sessionId)) {
          return null;
        }
        return sessionManager.getPage(sessionId);
      });
      // console.log('Browser streaming manager initialized');

      // AUDITARIA: Subscribe to collaborative writing registry changes so the
      // web toggle stays in sync when the AI tool starts/stops tracking.
      collaborativeWritingService.getRegistry().onChange(() => {
        this.handleCollaborativeWritingStatusRequest();
      });

      this.isRunning = true;
      return this.port;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the web interface server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Close all WebSocket connections
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });
    this.clients.clear();

    // AUDITARIA: Clean up stream clients
    for (const [ws, clientInfo] of this.streamClients) {
      if (clientInfo.unsubscribe) {
        try {
          await clientInfo.unsubscribe();
        } catch {
          // Ignore errors during cleanup
        }
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    this.streamClients.clear();
    if (this.streamManager) {
      await this.streamManager.stopAll();
    }

    // WEB_INTERFACE_START: Clean up file watcher service
    if (this.fileWatcherService) {
      this.fileWatcherService.destroy();
      this.fileWatcherService = undefined;
    }
    // WEB_INTERFACE_END

    // WEB_INTERFACE_START: Clean up directory watcher service
    if (this.directoryWatcherService) {
      await this.directoryWatcherService.stop();
      this.directoryWatcherService = undefined;
    }
    // WEB_INTERFACE_END

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = undefined;
    }

    this.app = undefined;
    this.port = undefined;
    this.isRunning = false;
  }

  /**
   * Broadcast a message to all connected web clients
   */
  broadcastMessage(historyItem: HistoryItem): void {
    // Clear response state when content becomes final (AI message or tool group)
    if (historyItem.type === 'gemini' || historyItem.type === 'gemini_content' || historyItem.type === 'tool_group') {
      this.currentResponseBlocks = null;
    }
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    // WEB_INTERFACE_START: Add sequence number
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'history_item',
      data: historyItem,
      sequence,
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
          }
          // WEB_INTERFACE_END
        } catch (_error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast footer data to all connected web clients
   */
  broadcastFooterData(footerData: FooterData): void {
    // Store current footer data for new clients
    this.currentFooterData = footerData;

    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    // WEB_INTERFACE_START: Add sequence number
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'footer_data',
      data: footerData,
      sequence,
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
          }
          // WEB_INTERFACE_END
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  // AUDITARIA: Broadcast input history (ArrowUp/Down) to web clients
  broadcastInputHistory(history: string[]): void {
    this.currentInputHistory = history;

    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'input_history_sync',
      data: { history },
      sequence,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() }, 'input_history_sync');
          }
        } catch (error) {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast loading state data to all connected web clients
   */
  broadcastLoadingState(loadingState: LoadingStateData): void {
    // Store current loading state for new clients
    this.currentLoadingState = loadingState;
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    // WEB_INTERFACE_START: Add sequence number with ephemeral flag
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'loading_state',
      data: loadingState,
      sequence,
      ephemeral: true,  // Mark as ephemeral - not saved in history
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer with ephemeral flag
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now(), ephemeral: true });
          }
          // WEB_INTERFACE_END
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast unified response state (ordered blocks of streaming content) to all connected web clients
   */
  broadcastResponseState(blocks: ResponseBlock[] | null): void {
    this.currentResponseBlocks = blocks;

    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'response_state',
      data: blocks,
      sequence,
      ephemeral: true,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now(), ephemeral: true });
          }
        } catch (error) {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    });
  }

  // WEB_INTERFACE_START: Safely increment sequence number with overflow protection
  private getNextSequence(): number {
    if (this.sequenceNumber >= this.MAX_SEQUENCE_NUMBER) {
      this.sequenceNumber = 0;
      // console.log('Sequence number wrapped around to 0');
    }
    return ++this.sequenceNumber;
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Generic broadcast helper with sequence numbers
  private broadcastWithSequence(type: string, data: any): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type,
      data,
      sequence,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          const state = this.clientStates.get(client);
          if (state) {
            // Pass message type so buffer can handle state-snapshot types appropriately
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() }, type);
          }
        } catch (_error) {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    });
  }
  // WEB_INTERFACE_END

  /**
   * Broadcast tool confirmation request to all connected web clients
   */
  broadcastToolConfirmation(confirmation: PendingToolConfirmation): void {
    // Store active tool confirmation for new clients
    if (confirmation.callId) {
      this.activeToolConfirmations.set(confirmation.callId, confirmation);
    }
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_confirmation', confirmation);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast tool confirmation removal to all connected web clients
   */
  broadcastToolConfirmationRemoval(callId: string): void {
    // Remove from active confirmations
    this.activeToolConfirmations.delete(callId);
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_confirmation_removal', { callId });
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast tool call result to all connected web clients
   */
  broadcastToolResult(callId: string, isOk: boolean, result: any): void {
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_result', { callId, isOk, result });
    // WEB_INTERFACE_END
  }

  /**
   * Get current server status
   */
  getStatus(): { isRunning: boolean; port?: number; clients: number } {
    return {
      isRunning: this.isRunning,
      port: this.port,
      clients: this.clients.size,
    };
  }

  /**
   * Set the handler for submit query function
   */
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  setSubmitQueryHandler(handler: (query: PartListUnion) => void): void {
    this.submitQueryHandler = handler;
  }
  // WEB_INTERFACE_END

  /**
   * Set the handler for aborting current AI processing from web interface
   */
  setAbortHandler(handler: () => void): void {
    this.abortHandler = handler;
  }

  /**
   * Set the handler for tool confirmation responses from web interface
   */
  setConfirmationResponseHandler(handler: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void): void {
    this.confirmationResponseHandler = handler;
  }

  /**
   * Set the current history for new clients
   */
  setCurrentHistory(history: HistoryItem[]): void {
    this.currentHistory = history;
  }

  /**
   * Broadcast clear command to all connected web clients
   */
  broadcastClear(): void {
    // Clear internal history and ephemeral states
    this.currentHistory = [];
    this.currentResponseBlocks = null;
    this.currentLoadingState = null;
    this.activeToolConfirmations.clear();
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('clear', null);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast slash commands data to all connected web clients
   */
  broadcastSlashCommands(commands: readonly SlashCommand[]): void {
    // Store current commands for new clients
    this.currentSlashCommands = commands;
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('slash_commands', { commands });
    // WEB_INTERFACE_END
  }

  // WEB_INTERFACE_START: Broadcast model menu data to all connected web clients
  broadcastModelMenuData(modelMenuData: any): void {
    this.currentModelMenuData = modelMenuData;
    this.broadcastWithSequence('model_menu_data', modelMenuData);
  }
  // WEB_INTERFACE_END

  /**
   * Broadcast MCP servers data to all connected web clients
   */
  broadcastMCPServers(
    mcpServers: Record<string, MCPServerConfig>, 
    blockedMcpServers: Array<{ name: string; extensionName: string }>,
    serverTools: Map<string, DiscoveredMCPTool[]>,
    serverStatuses: Map<string, string>
  ): void {
    // Transform the data for web client consumption
    const serversData = Object.entries(mcpServers).map(([name, config]) => {
      const tools = serverTools.get(name) || [];
      const status = serverStatuses.get(name) || 'disconnected';

      return {
        name,
        extensionName: config.extension?.name,
        description: config.description,
        status,
        oauth: config.oauth,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          schema: tool.schema
        }))
      };
    });

    // Store current MCP servers data for new clients
    this.currentMCPServers = {
      servers: serversData,
      blockedServers: blockedMcpServers
    };

    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('mcp_servers', this.currentMCPServers);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast console messages to all connected web clients
   */
  broadcastConsoleMessages(messages: ConsoleMessageItem[]): void {
    // Store current console messages for new clients
    this.currentConsoleMessages = messages;

    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('console_messages', messages);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast CLI action required state to all connected web clients
   */
  broadcastCliActionRequired(active: boolean, reason: string = 'authentication', title: string = 'CLI Action Required', message: string = 'Please complete the action in the CLI terminal.'): void {
    // Store the current state for new clients
    if (active) {
      this.currentCliActionState = { active, reason, title, message };
    } else {
      this.currentCliActionState = null;
    }
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('cli_action_required', {
      active,
      reason,
      title,
      message
    });
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast terminal capture to all connected web clients
   */
  broadcastTerminalCapture(data: TerminalCaptureData): void {
    // Store current terminal capture for new clients
    if (data.content) {
      this.currentTerminalCapture = data;
    } else {
      this.currentTerminalCapture = null;
    }
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('terminal_capture', data);
    // WEB_INTERFACE_END
  }

  /**
   * Handle incoming messages from web clients
   */
  // WEB_INTERFACE_START: Handle acknowledgment messages
  private handleAcknowledgment(ws: WebSocket, message: { lastSequence: number }): void {
    const state = this.clientStates.get(ws);
    if (state && message.lastSequence) {
      const previousAck = state.lastAcknowledgedSequence;
      state.lastAcknowledgedSequence = message.lastSequence;
      
      // Prune acknowledged messages from the buffer to free memory
      if (message.lastSequence > previousAck) {
        const pruned = state.messageBuffer.pruneAcknowledged(message.lastSequence);
        if (pruned > 0) {
          // console.log(`Pruned ${pruned} acknowledged messages for client`);
        }
      }
    }
  }

  // Handle resync requests
  private handleResyncRequest(ws: WebSocket, message: { from: number; persistentOnly?: boolean }): void {
    const state = this.clientStates.get(ws);
    if (!state) return;

    const fromSequence = message.from || 0;
    const persistentOnly = message.persistentOnly === true;
    
    // Check if we have the requested sequence in our buffer
    const oldestSequence = state.messageBuffer.getOldestSequence();
    if (oldestSequence !== null && fromSequence < oldestSequence) {
      // Buffer overrun - client is too far behind
      ws.send(JSON.stringify({
        type: 'force_resync',
        currentSequence: this.sequenceNumber,
        timestamp: Date.now()
      }));
      
      // Send current state as if it's a new connection
      this.sendInitialState(ws);
    } else {
      // We can fulfill the resync request - only send persistent messages if requested
      const messages = state.messageBuffer.getMessagesFrom(fromSequence, persistentOnly);
      messages.forEach(msg => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(msg.message);
          } catch (error) {
            console.error('Error sending resync message:', error);
          }
        }
      });
    }
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Enhanced to handle attachments for multimodal support and file operations
  private handleIncomingMessage(message: { type: string; content?: string; attachments?: any[]; callId?: string; outcome?: string; payload?: any; key?: any; path?: string; relativePath?: string; recursive?: boolean; oldPath?: string; newPath?: string; selection?: string; reasoningEffort?: string }): void {
    if (message.type === 'user_message' && this.submitQueryHandler) {
      const text = message.content?.trim() || '';
      
      // Convert attachments to multimodal Parts
      if (message.attachments && message.attachments.length > 0) {
        const parts: any[] = [];
        
        // Add text part if present
        if (text) {
          parts.push({ text });
        }
        
        // Add attachment parts and store metadata in WeakMap
        for (const attachment of message.attachments) {
          if (attachment.data && attachment.mimeType) {
            try {
              // Create inline data part for images and files
              const part = createPartFromBase64(attachment.data, attachment.mimeType);
              
              // Store metadata in WeakMap for later retrieval
              attachmentMetadataMap.set(part, {
                type: attachment.type,
                mimeType: attachment.mimeType,
                name: attachment.name,
                size: attachment.size,
                thumbnail: attachment.thumbnail,
                icon: attachment.icon,
                displaySize: attachment.displaySize
              });
              
              parts.push(part);
            } catch (error) {
              console.error('Failed to create part from attachment:', error);
            }
          }
        }
        
        // Send multimodal message 
        if (parts.length > 0) {
          this.submitQueryHandler(parts as PartListUnion);
        }
      } else if (text) {
        // Send text-only message
        this.submitQueryHandler(text);
      }
    } else if (message.type === 'interrupt_request' && this.abortHandler) {
    // WEB_INTERFACE_END
      this.abortHandler();
    } else if (message.type === 'tool_confirmation_response' && this.confirmationResponseHandler) {
      if (message.callId && message.outcome) {
        // Map string values to enum values
        let outcome: ToolConfirmationOutcome;
        switch (message.outcome) {
          case 'proceed_once':
            outcome = ToolConfirmationOutcome.ProceedOnce;
            break;
          case 'proceed_always':
            outcome = ToolConfirmationOutcome.ProceedAlways;
            break;
          case 'proceed_always_server':
            outcome = ToolConfirmationOutcome.ProceedAlwaysServer;
            break;
          case 'proceed_always_tool':
            outcome = ToolConfirmationOutcome.ProceedAlwaysTool;
            break;
          case 'modify_with_editor':
            outcome = ToolConfirmationOutcome.ModifyWithEditor;
            break;
          case 'cancel':
            outcome = ToolConfirmationOutcome.Cancel;
            break;
          default:
            console.error(`Unknown confirmation outcome: ${message.outcome}`);
            return;
        }

        this.confirmationResponseHandler(message.callId, outcome, message.payload);
      }
    } else if (message.type === 'terminal_input' && message.key) {
      // WEB_INTERFACE_START: Forward terminal input to AppContainer
      // AppContainer will handle emitting the correct event type based on Ink's mode
      this.emit('terminal_input', message.key);
      // WEB_INTERFACE_END
    }
    // WEB_INTERFACE_START: Model selection request from web footer
    else if (message.type === 'set_model_request' && message.selection) {
      this.emit('model_change_request', {
        selection: message.selection,
        reasoningEffort: message.reasoningEffort,
      });
    }
    // WEB_INTERFACE_END
    // WEB_INTERFACE_START: File operation handlers
    else if (message.type === 'file_tree_request') {
      this.handleFileTreeRequest(message.relativePath);
    } else if (message.type === 'file_read_request' && message.path) {
      this.handleFileReadRequest(message.path);
    } else if (message.type === 'file_write_request' && message.path && message.content !== undefined) {
      this.handleFileWriteRequest(message.path, message.content);
    } else if (message.type === 'file_create_request' && message.path) {
      this.handleFileCreateRequest(message.path, message.content);
    } else if (message.type === 'file_delete_request' && message.path) {
      this.handleFileDeleteRequest(message.path, message.recursive);
    } else if (message.type === 'file_rename_request' && message.oldPath && message.newPath) {
      this.handleFileRenameRequest(message.oldPath, message.newPath);
    } else if (message.type === 'file_open_system' && message.path) {
      this.handleFileOpenSystemRequest(message.path);
    } else if (message.type === 'file_reveal_request' && message.path) {
      this.handleFileRevealRequest(message.path);
    }
    // WEB_INTERFACE_START: File watcher request handlers
    else if (message.type === 'file_watch_request' && message.path) {
      this.handleFileWatchRequest(message.path, message.content);
    } else if (message.type === 'file_unwatch_request' && message.path) {
      this.handleFileUnwatchRequest(message.path);
    }
    // WEB_INTERFACE_END
    // DOCX parser request handlers
    else if (message.type === 'parser_status_request') {
      this.broadcastParserStatus();
    } else if (message.type === 'parse_request' && message.path) {
      this.handleParseRequest(message.path);
    }
    // Knowledge Base handlers
    else if (message.type === 'knowledge_base_status_request') {
      this.handleKnowledgeBaseStatusRequest();
    } else if (message.type === 'knowledge_base_init_request') {
      this.handleKnowledgeBaseInitRequest();
    } else if (message.type === 'knowledge_base_resume_request') {
      this.handleKnowledgeBaseResumeRequest();
    } else if (message.type === 'knowledge_base_reindex_request') {
      this.handleKnowledgeBaseReindexRequest((message as any).force);
    } else if (message.type === 'knowledge_base_autoindex_request') {
      this.handleKnowledgeBaseAutoIndexRequest((message as any).enabled);
    } else if (message.type === 'knowledge_base_search_request') {
      this.handleKnowledgeBaseSearchRequest(message as any);
    }
    // AUDITARIA: Collaborative Writing handlers for web toggle
    else if (message.type === 'collaborative_writing_status_request') {
      this.handleCollaborativeWritingStatusRequest();
    } else if (message.type === 'collaborative_writing_toggle') {
      this.handleCollaborativeWritingToggle((message as any).path, (message as any).action);
    }
  }

  /**
   * Set up WebSocket connection handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, request: import('http').IncomingMessage) => {
      // AUDITARIA: Parse URL to route based on path
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      // AUDITARIA_FEATURE_START: Check if this is an agent control connection
      if (url.pathname.startsWith('/control/agent/')) {
        const sessionId = url.pathname.split('/').pop() || 'default';
        this.handleAgentControlConnection(ws, sessionId);
        return;
      }
      // AUDITARIA_END

      // Check if this is a browser stream connection
      if (url.pathname.startsWith('/stream/browser/')) {
        const sessionId = url.pathname.split('/').pop() || 'default';
        this.handleBrowserStreamConnection(ws, sessionId);
        return;
      }

      // Standard chat connection handling
      this.clients.add(ws);

      // WEB_INTERFACE_START: Initialize client state for message resilience
      this.clientStates.set(ws, {
        messageBuffer: new CircularMessageBuffer(this.MESSAGE_BUFFER_SIZE),
        lastAcknowledgedSequence: 0
      });
      // WEB_INTERFACE_END

      ws.on('close', () => {
        this.clients.delete(ws);
        // WEB_INTERFACE_START: Clean up file watches for disconnected client
        if (this.fileWatcherService) {
          this.fileWatcherService.unwatchAllForClient(ws);
        }
        // WEB_INTERFACE_END
        // Client state will be automatically cleaned up by WeakMap
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });

      // Handle incoming messages from web client
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          // WEB_INTERFACE_START: Handle new message types for resilience
          if (message.type === 'ack') {
            this.handleAcknowledgment(ws, message);
          } else if (message.type === 'resync_request') {
            this.handleResyncRequest(ws, message);
          } else {
            this.handleIncomingMessage(message);
          }
          // WEB_INTERFACE_END
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });

      // Send initial state to the client
      this.sendInitialState(ws);
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
  }

  // AUDITARIA: Browser streaming connection handler
  /**
   * Handle browser stream WebSocket connections
   */
  private async handleBrowserStreamConnection(ws: WebSocket, sessionId: string): Promise<void> {
    // console.log(`[BrowserStream] Client connecting for session: ${sessionId}`);

    if (!this.streamManager) {
      ws.send(JSON.stringify({ type: 'error', message: 'Stream manager not initialized' }));
      ws.close();
      return;
    }

    // Check if session exists
    const sessionManager = SessionManager.getInstance();
    if (!sessionManager.hasSession(sessionId)) {
      ws.send(JSON.stringify({ type: 'error', message: `Session '${sessionId}' not found` }));
      ws.close();
      return;
    }

    // Send connected message
    ws.send(JSON.stringify({
      type: 'connected',
      clientId: `stream-${Date.now()}`,
      sessionId,
      availableQualities: ['low', 'medium', 'high'],
    }));

    let unsubscribe: (() => Promise<void>) | undefined;

    try {
      // Subscribe to stream
      unsubscribe = await this.streamManager.subscribe(
        sessionId,
        `ws-${Date.now()}`,
        (frame: StreamFrame) => this.sendStreamFrame(ws, frame),
        'medium',
      );

      // Store subscription for cleanup
      this.streamClients.set(ws, { sessionId, unsubscribe });

      ws.send(JSON.stringify({ type: 'started', sessionId }));
    } catch (error: any) {
      console.error('[BrowserStream] Error starting stream:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
      ws.close();
      return;
    }

    // Handle control messages from client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleStreamControlMessage(ws, sessionId, message);
      } catch (error) {
        console.error('[BrowserStream] Error handling message:', error);
      }
    });

    // Handle disconnect
    ws.on('close', async () => {
      console.log(`[BrowserStream] Client disconnected from session: ${sessionId}`);
      const clientInfo = this.streamClients.get(ws);
      if (clientInfo?.unsubscribe) {
        await clientInfo.unsubscribe();
      }
      this.streamClients.delete(ws);
    });

    ws.on('error', async (error) => {
      console.error('[BrowserStream] WebSocket error:', error);
      const clientInfo = this.streamClients.get(ws);
      if (clientInfo?.unsubscribe) {
        await clientInfo.unsubscribe();
      }
      this.streamClients.delete(ws);
    });
  }

  /**
   * Send binary frame to stream client
   */
  private sendStreamFrame(ws: WebSocket, frame: StreamFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      // Decode base64 to binary
      const imageData = Buffer.from(frame.data, 'base64');

      // Create header: timestamp (8 bytes) + width (2 bytes) + height (2 bytes)
      const header = Buffer.alloc(12);
      header.writeDoubleLE(frame.timestamp, 0);
      header.writeUInt16LE(frame.width, 8);
      header.writeUInt16LE(frame.height, 10);

      // Combine header + image data
      const packet = Buffer.concat([header, imageData]);

      ws.send(packet, { binary: true });
    } catch (error) {
      console.warn('[BrowserStream] Error sending frame:', error);
    }
  }

  /**
   * Handle stream control messages
   */
  private async handleStreamControlMessage(ws: WebSocket, sessionId: string, message: any): Promise<void> {
    if (!this.streamManager) return;

    switch (message.type) {
      case 'set_quality':
        if (message.quality && ['low', 'medium', 'high'].includes(message.quality)) {
          await this.streamManager.setQuality(sessionId, message.quality);
          ws.send(JSON.stringify({ type: 'quality_changed', quality: message.quality }));
        }
        break;

      case 'get_status':
        const status = this.streamManager.getStatus(sessionId);
        ws.send(JSON.stringify({ type: 'status', status }));
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  // AUDITARIA_FEATURE_START: Agent control connection handler
  /**
   * Handle agent control WebSocket connections for pause/resume/stop
   */
  private handleAgentControlConnection(ws: WebSocket, sessionId: string): void {
    // console.log(`[AgentControl] Client connected for session: ${sessionId}`);

    const sessionManager = SessionManager.getInstance();

    // Send initial state
    const sessionInfo = sessionManager.getSessionInfo(sessionId);
    if (sessionInfo) {
      ws.send(JSON.stringify({
        type: 'state',
        state: sessionInfo.state,
        sessionId,
        headless: sessionInfo.headless,  // AUDITARIA: Send headless flag to hide/show takeover button
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'state',
        state: 'unknown',
        sessionId,
        headless: true,  // Default to headless (no takeover button)
      }));
    }

    // Handle control messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.action) {
          case 'pause':
            sessionManager.pauseExecution(sessionId);
            ws.send(JSON.stringify({ type: 'state', state: 'paused', sessionId }));
            break;

          case 'resume':
            sessionManager.resumeExecution(sessionId);
            ws.send(JSON.stringify({ type: 'state', state: 'running', sessionId }));
            break;

          case 'stop':
            sessionManager.stopExecution(sessionId);
            ws.send(JSON.stringify({ type: 'state', state: 'stopping', sessionId }));
            break;

          case 'takeover':
            // AUDITARIA_FEATURE: Takeover control - pause and switch to headful mode
            // console.log(`[AgentControl] ====== TAKEOVER REQUESTED for session ${sessionId} ======`);
            (async () => {
              try {
                // console.log(`[AgentControl] Sending taking_over state to client`);
                ws.send(JSON.stringify({ type: 'state', state: 'taking_over', sessionId }));

                // console.log(`[AgentControl] Calling sessionManager.takeOverSession(${sessionId})`);
                await sessionManager.takeOverSession(sessionId);

                // console.log(`[AgentControl] takeOverSession completed successfully`);
                ws.send(JSON.stringify({ type: 'state', state: 'taken_over', sessionId }));
                ws.send(JSON.stringify({
                  type: 'takeover_ready',
                  message: 'Browser is now visible. You can interact with it manually.',
                }));
                // console.log(`[AgentControl] ====== TAKEOVER COMPLETE ======`);
              } catch (error: any) {
                console.error('[AgentControl] ====== TAKEOVER FAILED ======');
                console.error('[AgentControl] Error:', error);
                console.error('[AgentControl] Stack:', error.stack);
                ws.send(JSON.stringify({
                  type: 'error',
                  message: error.message || 'Takeover failed',
                }));
              }
            })();
            break;

          case 'end_takeover':
            // AUDITARIA_FEATURE: End takeover - switch back to headless mode
            // console.log(`[AgentControl] ====== END TAKEOVER REQUESTED for session ${sessionId} ======`);
            (async () => {
              try {
                // console.log(`[AgentControl] Sending ending_takeover state to client`);
                ws.send(JSON.stringify({ type: 'state', state: 'ending_takeover', sessionId }));

                // console.log(`[AgentControl] Calling sessionManager.endTakeOver(${sessionId})`);
                await sessionManager.endTakeOver(sessionId);

                // console.log(`[AgentControl] endTakeOver completed successfully`);
                // AUDITARIA: Send 'running' state since endTakeOver auto-resumes the agent
                ws.send(JSON.stringify({ type: 'state', state: 'running', sessionId }));
                ws.send(JSON.stringify({
                  type: 'takeover_ended',
                  message: 'Browser minimized. Agent execution resumed automatically.',
                }));
                // console.log(`[AgentControl] ====== END TAKEOVER COMPLETE ======`);
              } catch (error: any) {
                console.error('[AgentControl] ====== END TAKEOVER FAILED ======');
                console.error('[AgentControl] Error:', error);
                console.error('[AgentControl] Stack:', error.stack);
                ws.send(JSON.stringify({
                  type: 'error',
                  message: error.message || 'End takeover failed',
                }));
              }
            })();
            break;

          case 'get_state':
            const info = sessionManager.getSessionInfo(sessionId);
            ws.send(JSON.stringify({
              type: 'state',
              state: info?.state || 'unknown',
              sessionId,
              headless: info?.headless ?? true,  // AUDITARIA: Send headless flag
            }));
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${message.action}` }));
        }
      } catch (error: any) {
        console.error('[AgentControl] Error handling message:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    ws.on('close', () => {
      // console.log(`[AgentControl] Client disconnected from session: ${sessionId}`);
    });

    ws.on('error', (error) => {
      console.error(`[AgentControl] WebSocket error for session ${sessionId}:`, error);
    });
  }
  // AUDITARIA_END

  // WEB_INTERFACE_START: File operation handler methods
  /**
   * Handle file tree request
   */
  private async handleFileTreeRequest(relativePath?: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      const tree = await this.fileSystemService.getFileTree(relativePath || '.');

      this.broadcastWithSequence('file_tree_response', {
        tree,
        workspaceRoot: this.fileSystemService.getWorkspaceRoot()
      });
    } catch (error: any) {
      console.error('Error reading file tree:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'tree',
        path: relativePath || '.',
        error: error.message
      });
    }
  }

  /**
   * Handle file read request
   */
  private async handleFileReadRequest(path: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      const fileContent = await this.fileSystemService.readFile(path);

      this.broadcastWithSequence('file_read_response', fileContent);
    } catch (error: any) {
      console.error('Error reading file:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'read',
        path,
        error: error.message
      });
    }
  }

  /**
   * Handle file write request
   */
  private async handleFileWriteRequest(path: string, content: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      // WEB_INTERFACE_START: Mark expected change before writing
      // This prevents the file watcher from treating this as an external change
      if (this.fileWatcherService) {
        this.fileWatcherService.markExpectedChange(path, content);
      }
      // WEB_INTERFACE_END

      await this.fileSystemService.writeFile(path, content);

      this.broadcastWithSequence('file_write_response', {
        success: true,
        path,
        message: 'File saved successfully'
      });
    } catch (error: any) {
      console.error('Error writing file:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'write',
        path,
        error: error.message
      });
    }
  }

  /**
   * Handle file create request
   */
  private async handleFileCreateRequest(path: string, content?: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      await this.fileSystemService.createFile(path, content || '');

      this.broadcastWithSequence('file_create_response', {
        success: true,
        path,
        message: 'File created successfully'
      });

      // Refresh file tree
      this.handleFileTreeRequest();
    } catch (error: any) {
      console.error('Error creating file:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'create',
        path,
        error: error.message
      });
    }
  }

  /**
   * Handle file delete request
   */
  private async handleFileDeleteRequest(path: string, recursive?: boolean): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      await this.fileSystemService.deleteFile(path, recursive || false);

      this.broadcastWithSequence('file_delete_response', {
        success: true,
        path,
        message: 'File deleted successfully'
      });

      // Refresh file tree
      this.handleFileTreeRequest();
    } catch (error: any) {
      console.error('Error deleting file:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'delete',
        path,
        error: error.message
      });
    }
  }

  /**
   * Handle file rename request
   */
  private async handleFileRenameRequest(oldPath: string, newPath: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      await this.fileSystemService.renameFile(oldPath, newPath);

      this.broadcastWithSequence('file_rename_response', {
        success: true,
        oldPath,
        newPath,
        message: 'File renamed successfully'
      });

      // Refresh file tree
      this.handleFileTreeRequest();
    } catch (error: any) {
      console.error('Error renaming file:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'rename',
        oldPath,
        newPath,
        error: error.message
      });
    }
  }

  /**
   * Handle file open with system default request
   */
  private async handleFileOpenSystemRequest(path: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      await this.fileSystemService.openWithSystemDefault(path);

      this.broadcastWithSequence('file_open_system_response', {
        success: true,
        path,
        message: 'File opened with system default application'
      });
    } catch (error: any) {
      console.error('Error opening file with system default:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'open_system',
        path,
        error: error.message
      });
    }
  }

  /**
   * Handle file reveal in explorer request
   */
  private async handleFileRevealRequest(path: string): Promise<void> {
    if (!this.fileSystemService) {
      console.error('FileSystemService not initialized');
      return;
    }

    try {
      await this.fileSystemService.revealInFileManager(path);

      this.broadcastWithSequence('file_reveal_response', {
        success: true,
        path,
        message: 'File revealed in file explorer'
      });
    } catch (error: any) {
      console.error('Error revealing file in explorer:', error);
      this.broadcastWithSequence('file_operation_error', {
        operation: 'reveal',
        path,
        error: error.message
      });
    }
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Send initial state to a client
  private sendInitialState(ws: WebSocket): void {
    const state = this.clientStates.get(ws);
    if (!state) return;
    
    // Helper to send and store message
    const sendAndStore = (type: string, data: any) => {
      const sequence = this.getNextSequence();
      const message = JSON.stringify({
        type,
        data,
        sequence,
        timestamp: Date.now(),
      });
      
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
        } catch (error) {
          console.error(`Error sending ${type}:`, error);
        }
      }
    };
    
    // Send welcome message with starting sequence
    sendAndStore('connection', {
      message: 'Connected to Auditaria',
      startingSequence: this.sequenceNumber
    });
    
    // Send current history to new client
    if (this.currentHistory.length > 0) {
      sendAndStore('history_sync', { history: this.currentHistory });
    }
    
    // Send current slash commands to new client
    if (this.currentSlashCommands.length > 0) {
      sendAndStore('slash_commands', { commands: this.currentSlashCommands });
    }

    // WEB_INTERFACE_START: Send current model menu data to new client
    if (this.currentModelMenuData) {
      sendAndStore('model_menu_data', this.currentModelMenuData);
    }
    // WEB_INTERFACE_END
    
    // Send current MCP servers to new client (always send, even if empty)
    sendAndStore('mcp_servers', this.currentMCPServers);
    
    // Send current console messages to new client (always send, even if empty)
    sendAndStore('console_messages', this.currentConsoleMessages);
    
    // Send current CLI action state to new client if active
    if (this.currentCliActionState && this.currentCliActionState.active) {
      sendAndStore('cli_action_required', this.currentCliActionState);
    }
    
    // Send current terminal capture to new client if available
    if (this.currentTerminalCapture && this.currentTerminalCapture.content) {
      sendAndStore('terminal_capture', this.currentTerminalCapture);
    }
    
    // WEB_INTERFACE_START: Send ephemeral states that are still relevant
    // Send current loading state if active
    if (this.currentLoadingState) {
      sendAndStore('loading_state', this.currentLoadingState);
    }

    // Send current footer data to new client
    if (this.currentFooterData) {
      sendAndStore('footer_data', this.currentFooterData);
    }

    // AUDITARIA: Send input history for ArrowUp/Down navigation
    if (this.currentInputHistory.length > 0) {
      sendAndStore('input_history_sync', { history: this.currentInputHistory });
    }

    // Send current response state if exists
    if (this.currentResponseBlocks) {
      sendAndStore('response_state', this.currentResponseBlocks);
    }
    
    // Send all active tool confirmations
    for (const [callId, confirmation] of this.activeToolConfirmations) {
      sendAndStore('tool_confirmation', confirmation);
    }
    // WEB_INTERFACE_END

    // Send parser status to new client
    if (this.docxParser) {
      sendAndStore('parser_status', {
        available: this.docxParser.isParserAvailable(),
        path: this.docxParser.getParserPath()
      });
    }

    // AUDITARIA: Send collaborative writing status to new client
    const registry = collaborativeWritingService.getRegistry();
    const trackedFiles = registry.getAllTrackedFiles().map((f: any) => ({
      path: f.filePath,
      startedAt: f.startedAt.toISOString(),
      lastChangeSource: f.lastChangeSource,
    }));
    sendAndStore('collaborative_writing_status', { trackedFiles });
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: File watcher event handlers
  /**
   * Set up file watcher service event handlers
   */
  private setupFileWatcherHandlers(): void {
    if (!this.fileWatcherService) {
      return;
    }

    // Handle external file changes
    this.fileWatcherService.on('file-external-change', (event: any) => {
      const { path, diskContent, diskStats, clients } = event;

      // Broadcast to specific clients watching this file
      clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN && this.clients.has(client)) {
          const sequence = this.getNextSequence();
          const message = JSON.stringify({
            type: 'file_external_change',
            data: {
              path,
              diskContent,
              diskStats
            },
            sequence,
            timestamp: Date.now()
          });

          try {
            client.send(message);
            const state = this.clientStates.get(client);
            if (state) {
              state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
            }
          } catch (error) {
            console.error('Error sending file-external-change:', error);
          }
        }
      });
    });

    // Handle external file deletions
    this.fileWatcherService.on('file-external-delete', (event: any) => {
      const { path, clients } = event;

      // Broadcast to specific clients watching this file
      clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN && this.clients.has(client)) {
          const sequence = this.getNextSequence();
          const message = JSON.stringify({
            type: 'file_external_delete',
            data: { path },
            sequence,
            timestamp: Date.now()
          });

          try {
            client.send(message);
            const state = this.clientStates.get(client);
            if (state) {
              state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
            }
          } catch (error) {
            console.error('Error sending file-external-delete:', error);
          }
        }
      });
    });

    // Handle watch errors
    this.fileWatcherService.on('watch-error', (event: any) => {
      const { path, error, clients } = event;

      // Broadcast to specific clients
      clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN && this.clients.has(client)) {
          const sequence = this.getNextSequence();
          const message = JSON.stringify({
            type: 'file_watch_error',
            data: {
              path,
              error
            },
            sequence,
            timestamp: Date.now()
          });

          try {
            client.send(message);
            const state = this.clientStates.get(client);
            if (state) {
              state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
            }
          } catch (error) {
            console.error('Error sending file-watch-error:', error);
          }
        }
      });
    });
  }

  /**
   * Handle file watch request from client
   */
  private async handleFileWatchRequest(path: string, content?: string): Promise<void> {
    if (!this.fileWatcherService) {
      console.error('FileWatcherService not initialized');
      return;
    }

    // Find the client that sent this request
    // Note: In the current architecture, we broadcast to all clients
    // For watch requests, we need to track which client sent the request
    // For now, we'll watch for all clients that have the file open

    // Get the initial content if not provided
    let initialContent = content;
    if (!initialContent && this.fileSystemService) {
      try {
        const fileContent = await this.fileSystemService.readFile(path);
        initialContent = fileContent.content;
      } catch (error: any) {
        console.error(`Failed to read file for watch: ${path}`, error);
        this.broadcastWithSequence('file_watch_error', {
          path,
          error: error.message
        });
        return;
      }
    }

    // Watch file for all connected clients
    // Note: This is simplified - in production, you'd track which specific client made the request
    for (const client of this.clients) {
      try {
        await this.fileWatcherService.watchFile(path, client, initialContent || '');
      } catch (error: any) {
        console.error(`Failed to watch file ${path}:`, error);
      }
    }

    // console.log(`File watch started: ${path}`);
  }

  /**
   * Handle file unwatch request from client
   */
  private handleFileUnwatchRequest(path: string): void {
    if (!this.fileWatcherService) {
      console.error('FileWatcherService not initialized');
      return;
    }

    // Unwatch for all clients
    // Note: This is simplified - in production, you'd unwatch only for the requesting client
    for (const client of this.clients) {
      this.fileWatcherService.unwatchFile(path, client);
    }

    // console.log(`File watch stopped: ${path}`);
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Directory watcher event handlers
  /**
   * Set up directory watcher service event handlers
   */
  private setupDirectoryWatcherHandlers(): void {
    if (!this.directoryWatcherService) {
      return;
    }

    // Handle directory changes - refresh file tree for all clients
    this.directoryWatcherService.on('directory-change', (_event: any) => {
      this.handleFileTreeRequest();
    });

    // Handle watcher errors
    this.directoryWatcherService.on('error', (error: Error) => {
      console.error('Directory watcher error:', error);
    });
  }
  // WEB_INTERFACE_END

  /**
   * Broadcast parser availability to all connected clients
   */
  public broadcastParserStatus(): void {
    if (!this.docxParser) {
      return;
    }

    this.broadcastWithSequence('parser_status', {
      available: this.docxParser.isParserAvailable(),
      path: this.docxParser.getParserPath()
    });
  }

  /**
   * Handle parse request from web client
   */
  private async handleParseRequest(mdPath: string): Promise<void> {
    if (!this.docxParser) {
      console.error('DocxParserService not initialized');
      return;
    }

    const result = await this.docxParser.parseMarkdownToDocx(mdPath);

    if (result.success && result.outputPath) {
      // Send success response
      this.broadcastWithSequence('parse_response', {
        success: true,
        outputPath: result.outputPath,
        message: 'Successfully parsed to DOCX'
      });

      // Open the DOCX file with system default application
      await this.docxParser.openDocxFile(result.outputPath);
    } else {
      // Send error response
      this.broadcastWithSequence('parse_error', {
        success: false,
        error: result.error || 'Unknown error'
      });
    }
  }

  /**
   * Refresh parser status (called after setup-skill completes)
   * This method can be called from setupSkillCommand
   */
  public refreshParserStatus(): void {
    if (!this.docxParser) {
      return;
    }

    this.docxParser.refresh();
    this.broadcastParserStatus();
  }

  // =========================================================================
  // AUDITARIA: Collaborative Writing Handlers (Web Toggle)
  // =========================================================================

  /**
   * Handle collaborative writing status request from web client
   * Returns list of all tracked files
   */
  private handleCollaborativeWritingStatusRequest(): void {
    const registry = collaborativeWritingService.getRegistry();
    const trackedFiles = registry.getAllTrackedFiles().map((f: any) => ({
      path: f.filePath,
      startedAt: f.startedAt.toISOString(),
      lastChangeSource: f.lastChangeSource,
    }));

    this.broadcastWithSequence('collaborative_writing_status', {
      trackedFiles,
    });
  }

  /**
   * Handle collaborative writing toggle request from web client
   * Starts or stops tracking a file for collaborative writing
   */
  private async handleCollaborativeWritingToggle(filePath: string, action: 'start' | 'end'): Promise<void> {
    if (!filePath) {
      this.broadcastWithSequence('collaborative_writing_toggle_result', {
        path: filePath,
        action,
        success: false,
        message: 'File path is required',
      });
      return;
    }

    const registry = collaborativeWritingService.getRegistry();
    const path = await import('node:path');
    const resolvedPath = path.resolve(filePath);

    try {
      if (action === 'start') {
        if (registry.isTracking(resolvedPath)) {
          this.broadcastWithSequence('collaborative_writing_toggle_result', {
            path: resolvedPath,
            action,
            success: true,
            message: 'Already tracking this file',
          });
        } else {
          await registry.startTracking(resolvedPath);
          this.broadcastWithSequence('collaborative_writing_toggle_result', {
            path: resolvedPath,
            action,
            success: true,
            message: 'Started collaborative writing for this file',
          });
        }
      } else if (action === 'end') {
        if (!registry.isTracking(resolvedPath)) {
          this.broadcastWithSequence('collaborative_writing_toggle_result', {
            path: resolvedPath,
            action,
            success: true,
            message: 'File was not being tracked',
          });
        } else {
          registry.stopTracking(resolvedPath);
          this.broadcastWithSequence('collaborative_writing_toggle_result', {
            path: resolvedPath,
            action,
            success: true,
            message: 'Stopped collaborative writing for this file',
          });
        }
      }

      // Status broadcast is handled automatically by registry onChange listener
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      this.broadcastWithSequence('collaborative_writing_toggle_result', {
        path: resolvedPath,
        action,
        success: false,
        message: errorMsg.includes('ENOENT')
          ? 'File not found'
          : errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
            ? 'Permission denied'
            : errorMsg,
      });
    }
  }

  // =========================================================================
  // Knowledge Base Handlers
  // =========================================================================

  /**
   * Handle knowledge base status request
   */
  private handleKnowledgeBaseStatusRequest(): void {
    const searchService = getSearchService();
    const progress = searchService.getIndexingProgress();
    const searchSystem = searchService.getSearchSystem();

    // Check if the indexing service is online (queue processor started)
    // This is true when /knowledge-base init was run or auto-index is enabled
    const isIndexingServiceOnline = searchService.isIndexingEnabled();

    if (searchSystem) {
      // Service is running, get stats from the active search system
      (async () => {
        let autoIndex = false;
        try {
          const storage = (searchSystem as any).storage;
          if (storage && typeof storage.getConfigValue === 'function') {
            const config = await storage.getConfigValue('autoIndex');
            autoIndex = config === true;
          }
        } catch {
          // Ignore errors
        }

        // Get stats if available - include full document counts like CLI
        let stats: any = null;
        try {
          const fullStats = await searchSystem.getStats();
          stats = {
            totalDocuments: fullStats?.totalDocuments || 0,
            filesIndexed: fullStats?.indexedDocuments || 0,
            pendingDocuments: fullStats?.pendingDocuments || 0,
            failedDocuments: fullStats?.failedDocuments || 0,
            ocrPending: fullStats?.ocrPending || 0,
            totalPassages: fullStats?.totalChunks || 0,
            dbSize: fullStats?.databaseSize || 0,
          };
        } catch {
          // Stats not available
        }

        const state = searchService.getState();
        this.broadcastWithSequence('knowledge_base_status', {
          initialized: true,
          running: isIndexingServiceOnline, // True when indexing service is online (queue processor running)
          autoIndex,
          lastSync: state.lastSyncAt?.toISOString() || null,
          stats,
          indexingProgress: progress,
        });
      })();
    } else {
      // Service not running at the moment - check if database file exists
      // If database exists, user can search without needing to "initialize"
      (async () => {
        const rootPath = process.cwd();
        let databaseExists = false;
        let stats: any = null;
        let autoIndexConfig = false;

        try {
          const search = await getSearchModule();
          databaseExists = search.searchDatabaseExists(rootPath);

          // If database exists, try to get stats by loading it temporarily
          if (databaseExists) {
            try {
              const tempSystem = await search.loadSearchSystem(rootPath, {
                useMockEmbedder: true, // Don't need real embeddings just to check status
              });
              if (tempSystem) {
                const tempStats = await tempSystem.getStats();
                stats = {
                  totalDocuments: tempStats?.totalDocuments || 0,
                  filesIndexed: tempStats?.indexedDocuments || 0,
                  pendingDocuments: tempStats?.pendingDocuments || 0,
                  failedDocuments: tempStats?.failedDocuments || 0,
                  ocrPending: tempStats?.ocrPending || 0,
                  totalPassages: tempStats?.totalChunks || 0,
                  dbSize: tempStats?.databaseSize || 0,
                };

                // Try to get autoIndex config
                try {
                  const storage = (tempSystem as any).storage;
                  if (storage && typeof storage.getConfigValue === 'function') {
                    const config = await storage.getConfigValue('autoIndex');
                    autoIndexConfig = config === true;
                  }
                } catch {
                  // Ignore
                }

                await tempSystem.close();
              }
            } catch {
              // Could not load temp system, but database exists
            }
          }
        } catch {
          // Module not available or other error
        }

        // Re-check if indexing service started while we were loading
        const finalIndexingServiceOnline = searchService.isIndexingEnabled();

        this.broadcastWithSequence('knowledge_base_status', {
          initialized: databaseExists,
          running: finalIndexingServiceOnline, // True when indexing service is online
          autoIndex: autoIndexConfig,
          lastSync: null,
          stats,
          indexingProgress: progress,
          databaseExists, // Additional flag for UI
        });
      })();
    }
  }

  /**
   * Handle knowledge base initialization request
   */
  private async handleKnowledgeBaseInitRequest(): Promise<void> {
    const searchService = getSearchService();

    try {
      // Get root path from current working directory
      const rootPath = process.cwd();

      // Start the search service with indexing enabled
      await searchService.start(rootPath, { startIndexing: true });

      this.broadcastWithSequence('knowledge_base_init_response', {
        success: true,
      });

      // Setup progress broadcasting
      this.setupKnowledgeBaseProgressBroadcasting(searchService);

      // Request status update after init
      setTimeout(() => this.handleKnowledgeBaseStatusRequest(), 500);
    } catch (error) {
      this.broadcastWithSequence('knowledge_base_init_response', {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle knowledge base start service request
   * Equivalent to /knowledge-base init - starts service and begins indexing
   */
  private async handleKnowledgeBaseResumeRequest(): Promise<void> {
    const searchService = getSearchService();

    try {
      const rootPath = process.cwd();

      // Behavior matches /knowledge-base init:
      // 1. If service not running: start it with indexing enabled
      // 2. If service running but indexing not enabled: enable indexing
      // 3. Then trigger a sync to process new/changed files
      if (!searchService.isRunning()) {
        await searchService.start(rootPath, { startIndexing: true });
      } else if (!searchService.isIndexingEnabled()) {
        // Service is running but queue processor not started - enable it
        searchService.enableIndexing();
      }

      // Trigger sync to start processing files (runs in background, don't await)
      searchService.triggerSync({ force: false }).catch((err) => {
        console.warn('[KB Resume] Sync failed:', err.message);
      });

      this.broadcastWithSequence('knowledge_base_resume_response', {
        success: true,
        running: true,
      });

      // Setup progress broadcasting
      this.setupKnowledgeBaseProgressBroadcasting(searchService);

      // Request status update
      setTimeout(() => this.handleKnowledgeBaseStatusRequest(), 500);
    } catch (error) {
      this.broadcastWithSequence('knowledge_base_resume_response', {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle knowledge base reindex request
   */
  private async handleKnowledgeBaseReindexRequest(force?: boolean): Promise<void> {
    const searchService = getSearchService();

    if (!searchService.isRunning()) {
      // Start the service first, then trigger reindex
      try {
        const rootPath = process.cwd();
        await searchService.start(rootPath, { startIndexing: false });
      } catch (error) {
        this.broadcastWithSequence('knowledge_base_reindex_progress', {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    try {
      // Setup progress broadcasting
      this.setupKnowledgeBaseProgressBroadcasting(searchService);

      // Trigger sync with force option
      await searchService.triggerSync({ force: force ?? true });
    } catch (error) {
      this.broadcastWithSequence('knowledge_base_reindex_progress', {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle knowledge base auto-index toggle request
   */
  private async handleKnowledgeBaseAutoIndexRequest(enabled: boolean): Promise<void> {
    const searchService = getSearchService();
    const searchSystem = searchService.getSearchSystem();

    if (!searchSystem) {
      this.broadcastWithSequence('knowledge_base_autoindex_response', {
        success: false,
        error: 'Knowledge base not initialized',
      });
      return;
    }

    try {
      // Set autoIndex config in storage
      const storage = (searchSystem as any).storage;
      if (storage && typeof storage.setConfigValue === 'function') {
        await storage.setConfigValue('autoIndex', enabled);

        this.broadcastWithSequence('knowledge_base_autoindex_response', {
          success: true,
          enabled,
        });
      } else {
        this.broadcastWithSequence('knowledge_base_autoindex_response', {
          success: false,
          error: 'Storage not available',
        });
      }
    } catch (error) {
      this.broadcastWithSequence('knowledge_base_autoindex_response', {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle knowledge base search request
   */
  private async handleKnowledgeBaseSearchRequest(request: {
    query: string;
    searchType?: 'keyword' | 'semantic' | 'hybrid';
    filters?: {
      folders?: string[];
      extensions?: string[];
    };
    page?: number;
    limit?: number;
    // Diversity options
    diversityStrategy?: 'none' | 'score_penalty' | 'cap_then_fill';
    diversityDecay?: number;
    maxPerDocument?: number;
    semanticDedup?: boolean;
    semanticDedupThreshold?: number;
  }): Promise<void> {
    const searchService = getSearchService();
    let searchSystem = searchService.getSearchSystem();
    let tempSystem: any = null;

    // If service isn't running, try to load a temporary system if database exists
    if (!searchSystem) {
      const rootPath = process.cwd();
      try {
        const search = await getSearchModule();
        if (!search.searchDatabaseExists(rootPath)) {
          this.broadcastWithSequence('knowledge_base_search_response', {
            error: 'Knowledge base not found. Please initialize it first.',
            results: [],
            total: 0,
            page: 1,
            totalPages: 0,
          });
          return;
        }

        // Database exists - load a temporary system for searching
        tempSystem = await search.loadSearchSystem(rootPath, {
          useMockEmbedder: false, // Need real embeddings for semantic search
        });
        searchSystem = tempSystem;
      } catch (loadError) {
        this.broadcastWithSequence('knowledge_base_search_response', {
          error: `Failed to load knowledge base: ${loadError instanceof Error ? loadError.message : String(loadError)}`,
          results: [],
          total: 0,
          page: 1,
          totalPages: 0,
        });
        return;
      }
    }

    if (!searchSystem) {
      this.broadcastWithSequence('knowledge_base_search_response', {
        error: 'Knowledge base not available',
        results: [],
        total: 0,
        page: 1,
        totalPages: 0,
      });
      return;
    }

    try {
      const {
        query,
        searchType = 'hybrid',
        filters = {},
        page = 1,
        limit = 25,
        // Diversity options with defaults
        diversityStrategy = 'score_penalty',
        diversityDecay = 0.85,
        maxPerDocument = 5,
        semanticDedup = true,
        semanticDedupThreshold = 0.97,
      } = request;

      // Fetch a larger batch of results to enable proper pagination.
      // The search engine doesn't return total count, so we fetch up to MAX_SEARCH_RESULTS
      // and paginate on the server side.
      const MAX_SEARCH_RESULTS = 200;

      // Build search options matching SearchOptions interface
      const searchOptions: any = {
        query,
        strategy: searchType,
        limit: MAX_SEARCH_RESULTS,
        offset: 0, // Always start from beginning, paginate after
        highlight: true, // Enable <mark> highlighting for search term matches
        // Use web search syntax for user-facing searches (supports "quoted phrases", OR, -exclusion)
        useWebSearchSyntax: true,
        // Diversity options
        diversity: {
          strategy: diversityStrategy,
          decayFactor: diversityDecay,
          maxPerDocument: maxPerDocument,
          semanticDedup: semanticDedup,
          semanticDedupThreshold: semanticDedupThreshold,
        },
      };

      // Apply filters if provided
      const searchFilters: any = {};
      if (filters.folders && filters.folders.length > 0) {
        searchFilters.folders = filters.folders;
      }
      if (filters.extensions && filters.extensions.length > 0) {
        searchFilters.fileTypes = filters.extensions.map((ext: string) =>
          ext.startsWith('.') ? ext : `.${ext}`
        );
      }
      if (Object.keys(searchFilters).length > 0) {
        searchOptions.filters = searchFilters;
      }

      // Execute search - returns SearchResponse with results array
      const response = await searchSystem.search(searchOptions);

      // Calculate pagination from the full result set
      const total = response.results.length;
      const totalPages = Math.ceil(total / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = Math.min(startIndex + limit, total);
      const paginatedResults = response.results.slice(startIndex, endIndex);

      // Format results for frontend - include all relevant fields
      const formattedResults = paginatedResults.map((result: any) => ({
        filePath: result.filePath || '',
        fileName: result.fileName || '',
        score: result.score || 0,
        chunkText: result.chunkText || '',
        passages: [{
          content: result.chunkText || '',
          lineNumber: result.metadata?.page || null,
        }],
        // Include additional sources from semantic deduplication
        additionalSources: result.additionalSources?.map((src: any) => ({
          filePath: src.filePath,
          fileName: src.fileName,
          documentId: src.documentId,
          score: src.score,
        })) || [],
      }));

      this.broadcastWithSequence('knowledge_base_search_response', {
        results: formattedResults,
        total,
        page,
        totalPages,
        hasMore: endIndex < total,
        query,
      });
    } catch (error) {
      this.broadcastWithSequence('knowledge_base_search_response', {
        error: error instanceof Error ? error.message : String(error),
        results: [],
        total: 0,
        page: 1,
        totalPages: 0,
      });
    } finally {
      // Close temporary system if we created one
      if (tempSystem) {
        try {
          await tempSystem.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Setup progress broadcasting for knowledge base indexing
   */
  private setupKnowledgeBaseProgressBroadcasting(searchService: SearchServiceManager): void {
    // Poll for progress updates during indexing
    const progressInterval = setInterval(async () => {
      const progress = searchService.getIndexingProgress();
      const searchSystem = searchService.getSearchSystem();

      // Get real-time stats from the search system for accurate progress
      let liveStats: any = null;
      if (searchSystem) {
        try {
          const fullStats = await searchSystem.getStats();
          liveStats = {
            totalDocuments: fullStats?.totalDocuments || 0,
            filesIndexed: fullStats?.indexedDocuments || 0,
            pendingDocuments: fullStats?.pendingDocuments || 0,
            failedDocuments: fullStats?.failedDocuments || 0,
            totalPassages: fullStats?.totalChunks || 0,
            dbSize: fullStats?.databaseSize || 0,
          };
        } catch {
          // Stats not available
        }
      }

      this.broadcastWithSequence('knowledge_base_reindex_progress', {
        status: progress.status,
        totalFiles: progress.totalFiles,
        processedFiles: progress.processedFiles,
        failedFiles: progress.failedFiles,
        currentFile: progress.currentFile,
        // Include live stats for real-time updates
        stats: liveStats,
      });

      // Stop polling when completed or failed
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'idle') {
        clearInterval(progressInterval);

        // Send final status update
        setTimeout(() => this.handleKnowledgeBaseStatusRequest(), 500);
      }
    }, 5000); // Every 5 seconds during active indexing

    // Clean up after 30 minutes max (safety)
    setTimeout(() => {
      clearInterval(progressInterval);
    }, 30 * 60 * 1000);
  }
}
