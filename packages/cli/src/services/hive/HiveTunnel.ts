/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Cloudflare quick-tunnel launcher for Mode A (§2.3). Spawns `cloudflared`,
// which opens an OUTBOUND connection to Cloudflare's edge and proxies
// WSS/443 to the local HiveHub — no account, nothing to deploy. The random
// https://<rand>.trycloudflare.com URL is scraped from cloudflared's stderr.
// Pattern proven in deskstop-streaming host/src/tunnel.ts and the Teams
// ngrok manager.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TunnelHandle {
  url: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  stop(): void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Find cloudflared even if a fresh PATH hasn't been picked up after install. */
export function resolveCloudflared(): string {
  const candidates = [
    process.env['CLOUDFLARED_PATH'],
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    process.env['LOCALAPPDATA']
      ? join(
          process.env['LOCALAPPDATA'],
          'Microsoft',
          'WinGet',
          'Links',
          'cloudflared.exe',
        )
      : undefined,
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (existsSync(c)) return c;
  return 'cloudflared'; // rely on PATH
}

/** Actionable guidance when the tunnel cannot start (§8.3). */
export function cloudflaredInstallHint(): string {
  return [
    'cloudflared is required for /hive start (it publishes the hub over a free Cloudflare quick tunnel).',
    'Install it and try again:',
    '  Windows: winget install Cloudflare.cloudflared',
    '  macOS:   brew install cloudflared',
    '  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    'Note: cloudflared needs outbound port 7844. On strictly 443-only networks the quick tunnel cannot connect —',
    'the phase-3 cloud relay (Mode B) is the escape hatch for that environment.',
  ].join('\n');
}

export function startQuickTunnel(
  localPort: number,
  signal?: AbortSignal,
): Promise<TunnelHandle> {
  let proc: ChildProcessByStdio<null, Readable, Readable>;
  try {
    proc = spawn(
      resolveCloudflared(),
      ['tunnel', '--no-autoupdate', '--url', `http://localhost:${localPort}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return Promise.reject(
      new Error(
        `failed to spawn cloudflared: ${e instanceof Error ? e.message : String(e)}\n${cloudflaredInstallHint()}`,
      ),
    );
  }

  return new Promise<TunnelHandle>((resolve, reject) => {
    let settled = false;
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, proc, stop: () => proc.kill() });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const scan = (chunk: Buffer) => {
      const m = chunk.toString().match(URL_RE);
      if (m) finish(m[0]);
    };
    // cloudflared prints the quick-tunnel URL to stderr.
    proc.stderr.on('data', scan);
    proc.stdout.on('data', scan);
    proc.on('error', () => fail(new Error(cloudflaredInstallHint())));
    proc.on('exit', (code) =>
      fail(
        new Error(
          `cloudflared exited early with code ${code}.\n${cloudflaredInstallHint()}`,
        ),
      ),
    );

    const timer = setTimeout(
      () =>
        fail(
          new Error(
            'timed out waiting for the tunnel URL (30s). If this network blocks outbound port 7844, the quick tunnel cannot connect.',
          ),
        ),
      30_000,
    );
    signal?.addEventListener('abort', () => fail(new Error('aborted')), {
      once: true,
    });
  });
}
