/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { GeminiWebService } from './services/geminiService.js';
import { WebSocketHandler } from './websocket/websocketHandler.js';
import { setupApiRoutes } from './routes/api.js';
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
// Get current directory for static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Try to find the web client files
const possibleClientPaths = [
    // Bundled with web-server: dist/client
    join(__dirname, '..', 'client'),
    // In CLI bundle: web-server/dist -> web-server/client
    join(__dirname, '..', '..', 'client'),
];
let clientPath = null;
for (const path of possibleClientPaths) {
    if (existsSync(path)) {
        clientPath = path;
        break;
    }
}
// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:8080'], // Allow both dev and production
    credentials: true
}));
app.use(express.json());
// Initialize services
const geminiService = new GeminiWebService();
const wsHandler = new WebSocketHandler(geminiService);
// Setup API routes
setupApiRoutes(app, geminiService);
// Serve static files from React build
if (clientPath) {
    console.log(`📁 Serving static files from: ${clientPath}`);
    app.use(express.static(clientPath));
    // Catch-all handler: send back React app's index.html file for client-side routing
    app.get('*', (req, res) => {
        const indexPath = join(clientPath, 'index.html');
        if (existsSync(indexPath)) {
            res.sendFile(indexPath);
        }
        else {
            res.status(404).send('Client files not found');
        }
    });
}
else {
    console.log('⚠️  No client files found. Web interface will not be available.');
    app.get('/', (req, res) => {
        res.send(`
      <h1>Auditaria Web Server</h1>
      <p>The web server is running, but client files are not available.</p>
      <p>Please build the web client first.</p>
      <p><strong>Health check:</strong> <a href="/health">/health</a></p>
    `);
    });
}
// WebSocket handling
wss.on('connection', (ws, request) => {
    wsHandler.handleConnection(ws, request);
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Start server
const PORT = process.env.PORT || 8080;
async function startServer() {
    try {
        // Initialize the Gemini service
        await geminiService.initialize();
        server.listen(PORT, () => {
            console.log(`🚀 Auditaria Web Server running on http://localhost:${PORT}`);
            console.log(`📡 WebSocket server ready for connections`);
            console.log(`🌐 Web client should connect to http://localhost:`8629``);
        });
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
startServer();
//# sourceMappingURL=server.js.map