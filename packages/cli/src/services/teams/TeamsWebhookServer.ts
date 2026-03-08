/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { debugLogger } from '@google/gemini-cli-core';
import type { TeamsConfig, TeamsIncomingMessage } from './types.js';

/**
 * HTTP server that receives Microsoft Teams Outgoing Webhook messages.
 *
 * Handles:
 * - HMAC-SHA256 authentication (validates `Authorization: HMAC <base64>` header)
 * - JSON payload parsing
 * - @mention stripping from message text
 * - Detailed logging of every request for debugging/discovery
 *
 * Teams Outgoing Webhook flow:
 * 1. User @mentions the bot in a channel
 * 2. Teams POSTs JSON to our endpoint with HMAC signature
 * 3. We validate HMAC, parse payload, invoke the message handler
 * 4. We return a JSON response (sync mode) or ack (async modes)
 */
export class TeamsWebhookServer {
  private server: http.Server | null = null;
  private messageHandler:
    | ((msg: TeamsIncomingMessage, res: http.ServerResponse) => void)
    | undefined;

  constructor(private readonly config: TeamsConfig) {}

  /**
   * Registers the handler called for each validated incoming message.
   * The handler receives the parsed message AND the response object
   * so it can control when/what to respond (needed for sync mode).
   */
  onMessage(
    handler: (msg: TeamsIncomingMessage, res: http.ServerResponse) => void,
  ): void {
    this.messageHandler = handler;
  }

  /**
   * Starts the HTTP server on the configured port.
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        debugLogger.error('Teams: HTTP server error:', err);
        reject(err);
      });

      this.server.listen(this.config.port, () => {
        debugLogger.log(
          `Teams: Webhook server listening on port ${this.config.port}`,
        );
        debugLogger.log(`Teams: Response mode: ${this.config.responseMode}`);
        debugLogger.log(
          `Teams: Allow list: ${this.config.allowFrom.length > 0 ? this.config.allowFrom.join(', ') : 'EMPTY (all denied)'}`,
        );
        if (this.config.webhookUrl) {
          debugLogger.log(
            `Teams: Incoming webhook URL configured for async responses`,
          );
        }
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          debugLogger.log('Teams: Webhook server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handles an incoming HTTP request.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    debugLogger.debug(
      `Teams: ${req.method} ${req.url} from ${req.socket.remoteAddress}`,
    );

    // Only accept POST
    if (req.method !== 'POST') {
      debugLogger.debug('Teams: Rejected non-POST request');
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const bodyStr = body.toString('utf-8');

      debugLogger.debug(`Teams: Raw body (${body.length} bytes): ${bodyStr}`);

      // HMAC validation
      if (this.config.hmacSecret) {
        const authHeader = req.headers['authorization'] || '';
        debugLogger.debug(`Teams: Authorization header: ${authHeader}`);

        if (!this.validateHmac(body, authHeader)) {
          debugLogger.error('Teams: HMAC validation FAILED');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        debugLogger.debug('Teams: HMAC validation PASSED');
      } else {
        debugLogger.debug(
          'Teams: No HMAC secret configured — skipping validation',
        );
      }

      // Parse body — try JSON first, fall back to wrapping raw text
      let payload: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        payload = JSON.parse(bodyStr) as Record<string, unknown>;
      } catch {
        // Not JSON — wrap raw body as text (Power Automate may send HTML or plain text)
        debugLogger.log(
          `Teams: Body is not JSON — treating as raw text (${body.length} bytes)`,
        );
        debugLogger.log(`Teams: Raw body content: ${bodyStr}`);
        payload = { text: bodyStr, _rawBody: true };
      }

      // Log the full parsed payload for discovery
      debugLogger.log('Teams: === INCOMING MESSAGE ===');
      debugLogger.log(
        `Teams: Payload keys: ${Object.keys(payload).join(', ')}`,
      );
      debugLogger.log(
        `Teams: Full payload:\n${JSON.stringify(payload, null, 2)}`,
      );

      // Parse the message
      const message = this.parsePayload(payload);
      if (!message) {
        debugLogger.error('Teams: Could not parse message from payload');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unrecognized payload format' }));
        return;
      }

      // Log parsed fields
      debugLogger.log('Teams: --- Parsed Message ---');
      debugLogger.log(`Teams:   text: "${message.text}"`);
      debugLogger.log(`Teams:   rawText: "${message.rawText}"`);
      debugLogger.log(`Teams:   userId (AAD): ${message.userId}`);
      debugLogger.log(`Teams:   userName: ${message.userName}`);
      debugLogger.log(`Teams:   teamsUserId: ${message.teamsUserId}`);
      debugLogger.log(`Teams:   conversationId: ${message.conversationId}`);
      debugLogger.log(`Teams:   conversationName: ${message.conversationName}`);
      debugLogger.log(`Teams:   messageId: ${message.messageId}`);
      debugLogger.log(`Teams:   serviceUrl: ${message.serviceUrl}`);

      // Log thread-related fields (discovery)
      const replyToId =
        typeof payload['replyToId'] === 'string'
          ? payload['replyToId']
          : undefined;
      const conversation =
        payload['conversation'] != null &&
        typeof payload['conversation'] === 'object'
          ? (payload['conversation'] as Record<string, unknown>) // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
          : undefined;
      debugLogger.log('Teams: --- Thread Discovery ---');
      debugLogger.log(`Teams:   replyToId: ${replyToId ?? '(not present)'}`);
      debugLogger.log(
        `Teams:   conversation.id: ${conversation?.['id'] ?? '(not present)'}`,
      );
      debugLogger.log(
        `Teams:   conversation.conversationType: ${conversation?.['conversationType'] ?? '(not present)'}`,
      );
      debugLogger.log(
        `Teams:   conversation.isGroup: ${conversation?.['isGroup'] ?? '(not present)'}`,
      );
      debugLogger.log(
        `Teams:   conversation.name: ${conversation?.['name'] ?? '(not present)'}`,
      );
      debugLogger.log('Teams: === END MESSAGE ===');

      // Access control
      if (this.config.allowFrom.length > 0) {
        if (!this.config.allowFrom.includes(message.userId)) {
          debugLogger.log(
            `Teams: Access DENIED for user ${message.userName} (AAD: ${message.userId})`,
          );
          // Still respond so Teams doesn't timeout
          this.sendJsonResponse(res, 200, {
            type: 'message',
            text: `Access denied. Your AAD Object ID: \`${message.userId}\`\nAsk the bot admin to run: /teams allow ${message.userId}`,
          });
          return;
        }
        debugLogger.debug(
          `Teams: Access ALLOWED for user ${message.userName} (AAD: ${message.userId})`,
        );
      } else {
        debugLogger.debug(
          `Teams: Allow list empty — denying all. User AAD: ${message.userId}`,
        );
        this.sendJsonResponse(res, 200, {
          type: 'message',
          text: `No users in allow list. Your AAD Object ID: \`${message.userId}\`\nRun in CLI: /teams allow ${message.userId}`,
        });
        return;
      }

      // Invoke message handler
      if (this.messageHandler) {
        this.messageHandler(message, res);
      } else {
        // No handler registered — return debug echo (Phase 1 / discovery mode)
        debugLogger.log('Teams: No message handler — returning debug echo');
        this.sendJsonResponse(res, 200, {
          type: 'message',
          text:
            `Received. Payload debug:\n` +
            `- text: ${message.text}\n` +
            `- from: ${message.userName} (AAD: ${message.userId})\n` +
            `- conversation.id: ${message.conversationId}\n` +
            `- replyToId: ${replyToId ?? '(not present)'}\n` +
            `- messageId: ${message.messageId}`,
        });
      }
    });
  }

  /**
   * Validates the HMAC-SHA256 signature from the Authorization header.
   *
   * Teams sends: `Authorization: HMAC <base64-signature>`
   * The signature is HMAC-SHA256(body, base64decode(secret)), then base64-encoded.
   */
  private validateHmac(body: Buffer, authHeader: string): boolean {
    try {
      const match = /^HMAC\s+(.+)$/i.exec(authHeader);
      if (!match || !match[1]) {
        debugLogger.debug(
          'Teams: Authorization header missing or not HMAC format',
        );
        return false;
      }

      const receivedSignature = match[1];
      const secretBuffer = Buffer.from(this.config.hmacSecret, 'base64');
      const expectedSignature = crypto
        .createHmac('sha256', secretBuffer)
        .update(body)
        .digest('base64');

      const isValid = crypto.timingSafeEqual(
        Buffer.from(receivedSignature, 'base64'),
        Buffer.from(expectedSignature, 'base64'),
      );

      debugLogger.debug(
        `Teams: HMAC expected=${expectedSignature} received=${receivedSignature} valid=${isValid}`,
      );
      return isValid;
    } catch (err) {
      debugLogger.error('Teams: HMAC validation error:', err);
      return false;
    }
  }

  /**
   * Parses the Teams outgoing webhook payload into our message type.
   */
  private parsePayload(
    payload: Record<string, unknown>,
  ): TeamsIncomingMessage | null {
    try {
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const obj = (v: unknown): Record<string, unknown> | undefined =>
        v != null && typeof v === 'object' && !Array.isArray(v)
          ? (v as Record<string, unknown>) // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
          : undefined;

      let rawText = '';
      let userId = '';
      let userName = 'unknown';
      let teamsUserId = '';
      let conversationId = '';
      let conversationName = '';
      let messageId = '';

      // --- Extract text ---
      const bodyObj = obj(payload['body']);
      if (str(bodyObj?.['plainTextContent'])) {
        rawText = str(bodyObj?.['plainTextContent']);
      } else if (str(bodyObj?.['content'])) {
        rawText = str(bodyObj?.['content']);
      } else {
        rawText = str(payload['text']);
      }

      // --- Extract user info ---
      const from = obj(payload['from']);
      const fromUser = obj(from?.['user']);
      if (fromUser) {
        userName = str(fromUser['displayName']) || 'unknown';
        userId = str(fromUser['id']) || str(fromUser['aadObjectId']);
        teamsUserId = str(from?.['id']);
      } else if (str(from?.['aadObjectId'])) {
        userId = str(from?.['aadObjectId']);
        userName = str(from?.['name']) || 'unknown';
        teamsUserId = str(from?.['id']);
      } else if (str(payload['userId'])) {
        userId = str(payload['userId']);
        userName =
          str(payload['userName']) || str(payload['from']) || 'unknown';
      }

      // --- Extract conversation/channel info ---
      const channelIdentity = obj(payload['channelIdentity']);
      const conversation = obj(payload['conversation']);
      if (str(channelIdentity?.['channelId'])) {
        conversationId = str(channelIdentity?.['channelId']);
      } else if (str(conversation?.['id'])) {
        conversationId = str(conversation?.['id']);
        conversationName = str(conversation?.['name']);
      } else if (str(payload['channelId'])) {
        conversationId = str(payload['channelId']);
      }

      // --- Extract message ID ---
      if (payload['messageId']) {
        messageId = String(payload['messageId']);
      } else if (payload['id']) {
        messageId = String(payload['id']);
      }

      const serviceUrl = str(payload['serviceUrl']);

      // --- Compute thread ID ---
      const replyToId = str(payload['replyToId']);
      const threadId = replyToId || messageId;

      // Strip HTML tags and trigger keyword from text
      const text = rawText
        .replace(/<at>.*?<\/at>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/^#auditaria\b\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        text,
        rawText,
        userId,
        userName,
        teamsUserId,
        conversationId,
        conversationName,
        messageId,
        threadId,
        serviceUrl,
        rawPayload: payload,
      };
    } catch (err) {
      debugLogger.error('Teams: Error parsing payload:', err);
      return null;
    }
  }

  /**
   * Sends a JSON response to Teams.
   */
  sendJsonResponse(
    res: http.ServerResponse,
    statusCode: number,
    body: Record<string, unknown>,
  ): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
