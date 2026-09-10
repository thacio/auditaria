/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactService } from '@google/gemini-cli-core';
import type { WebFeatureContext } from '../core/types.js';
import { ArtifactsFeature } from './ArtifactsFeature.js';

vi.mock('@google/gemini-cli-core', () => ({
  SHAREPOINT_INSTRUCTIONS: 'SharePoint guide',
}));
vi.mock('../artifacts/artifactHost.js', () => ({
  createArtifactHost: vi.fn(),
  runtimeDirFor: () => '',
}));
vi.mock('../artifacts/shareSession.js', () => ({
  ShareManager: class {
    stopAll = vi.fn(async () => {});
  },
}));
vi.mock('../../../utils/cleanup.js', () => ({ registerCleanup: vi.fn() }));

describe('artifact export console HTTP flow', () => {
  let server: Server | undefined;
  let feature: ArtifactsFeature | undefined;
  afterEach(async () => {
    await feature?.detach();
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
  });

  it('requires console origin, uses selected version/options and serves independent attachments', async () => {
    const app = express();
    const report = {
      conversionStatus: 'ready',
      target: 'sharepoint',
      outputBytes: 20 * 1024 * 1024,
      outputMiB: 20,
      diagnostics: [{ severity: 'warning', code: 'large_file' }],
    };
    const analyzeExport = vi.fn(async () => ({
      html: '<html>independent</html>',
      report,
    }));
    const store = Object.assign(new EventEmitter(), {
      purgeExpired: async () => [],
    });
    const service = {
      getStore: async () => store,
      analyzeExport,
      setHost: vi.fn(),
    } as unknown as ArtifactService;
    feature = new ArtifactsFeature({ service, webClientRoot: '' });
    const context = {
      http: { mount: app.use.bind(app), mountHost: vi.fn() },
      ws: { addEndpoint: vi.fn() },
      inbound: { on: vi.fn() },
      logger: { debug: vi.fn() },
    } as unknown as WebFeatureContext;
    await feature.attach(context);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    feature.onListening({
      port,
      host: '127.0.0.1',
      loopback: true,
      consoleOrigins: [origin],
    });
    const endpoint = origin + '/api/artifact-exports/0123456789abcdef/export';
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        compression: 'none',
        compressData: false,
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(analyzeExport).toHaveBeenCalledWith(
      { id: '0123456789abcdef', version: 2 },
      expect.objectContaining({ compression: 'none', compressData: false }),
    );
    const downloaded = await fetch(origin + result.downloadBase + '/html');
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toContain(
      'attachment',
    );
    expect(await downloaded.text()).toBe('<html>independent</html>');
    expect(
      (await fetch(origin + result.downloadBase + '/instructions')).status,
    ).toBe(200);
    expect(
      (await fetch(origin + '/api/artifact-exports/download/unknown/html'))
        .status,
    ).toBe(404);
  });
});
