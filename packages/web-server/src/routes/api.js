/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Setup REST API routes
 */
export function setupApiRoutes(app, geminiService) {
    // Create new session
    app.post('/api/sessions', async (req, res) => {
        try {
            const sessionId = await geminiService.createSession();
            const config = geminiService.getSessionConfig(sessionId);
            res.json({
                sessionId,
                config
            });
        }
        catch (error) {
            console.error('Error creating session:', error);
            res.status(500).json({ error: 'Failed to create session' });
        }
    });
    // Get session info
    app.get('/api/sessions/:sessionId', (req, res) => {
        try {
            const { sessionId } = req.params;
            const config = geminiService.getSessionConfig(sessionId);
            res.json({
                sessionId,
                config
            });
        }
        catch (error) {
            console.error('Error getting session:', error);
            res.status(404).json({ error: 'Session not found' });
        }
    });
    // Get session history
    app.get('/api/sessions/:sessionId/history', (req, res) => {
        try {
            const { sessionId } = req.params;
            const history = geminiService.getHistory(sessionId);
            res.json({
                sessionId,
                history
            });
        }
        catch (error) {
            console.error('Error getting history:', error);
            res.status(404).json({ error: 'Session not found' });
        }
    });
    // Submit query (non-streaming endpoint for testing)
    app.post('/api/sessions/:sessionId/query', async (req, res) => {
        try {
            const { sessionId } = req.params;
            const { text } = req.body;
            if (!text) {
                return res.status(400).json({ error: 'Query text is required' });
            }
            await geminiService.submitQuery(sessionId, text);
            res.json({
                success: true,
                message: 'Query submitted. Use WebSocket for real-time responses.'
            });
        }
        catch (error) {
            console.error('Error submitting query:', error);
            res.status(500).json({ error: 'Failed to submit query' });
        }
    });
    // Get server info
    app.get('/api/info', (req, res) => {
        res.json({
            name: 'Auditaria Web Server',
            version: '0.1.13',
            description: 'Local web interface for Auditaria CLI',
            websocket: {
                endpoint: '/ws',
                description: 'Connect for real-time chat streaming'
            },
            endpoints: {
                '/api/sessions': 'POST - Create new session',
                '/api/sessions/:id': 'GET - Get session info',
                '/api/sessions/:id/history': 'GET - Get session history',
                '/api/sessions/:id/query': 'POST - Submit query (use WebSocket for streaming)',
                '/health': 'GET - Health check'
            }
        });
    });
}
//# sourceMappingURL=api.js.map