/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

/**
 * Public surface of the web interface for the rest of the CLI.
 *
 * Layout of this module:
 *   protocol.ts   — the wire vocabulary (message types, envelope, guards)
 *   config.ts     — ports, host, buffer sizes, compression settings
 *   core/         — transport: HTTP server, WebSocket hub, client registry,
 *                   sequenced broadcaster, inbound router, feature base
 *   http/         — HTTP routes: static client, health, file preview
 *   features/     — one self-contained WebFeature per capability
 *   WebInterfaceService.ts — the facade composing all of the above
 */

export {
  WebInterfaceService,
  type WebInterfaceEventMap,
  type WebInterfaceStatus,
} from './WebInterfaceService.js';
export { DEFAULT_WEB_PORT, type WebInterfaceConfig } from './config.js';
export {
  attachmentMetadataMap,
  type AttachmentMetadata,
} from './features/chatAttachments.js';
export type {
  ChatBridge,
  ModelChangeRequest,
  WebModelMenuData,
  WebTerminalKeyInput,
} from './features/ChatFeature.js';
