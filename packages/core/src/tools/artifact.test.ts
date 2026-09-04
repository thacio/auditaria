/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactService,
  type ArtifactHost,
} from '../artifacts/artifactService.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  ArtifactTool,
  tryParseArtifactDisplay,
  type ArtifactToolParams,
} from './artifact.js';
import type { ToolResult } from './tools.js';

const fragment = (title: string) =>
  `<title>${title}</title>\n<style>body{color:red}</style>\n<h1>${title}</h1>`;

describe('ArtifactTool', () => {
  let dir: string;
  let service: ArtifactService;
  let tool: ArtifactTool;
  let host: ArtifactHost & { openInBrowser: ReturnType<typeof vi.fn> };
  let autoOpen = true;

  const makeConfig = (): Config =>
    // Only the members the tool touches; everything else is irrelevant here.

    ({
      getArtifactService: () => service,
      getArtifactAutoOpen: () => autoOpen,
      storage: { getProjectTempDir: () => path.join(dir, 'tmp') },
    }) as unknown as Config;

  const messageBus = {} as unknown as MessageBus;

  const run = async (params: ArtifactToolParams): Promise<ToolResult> => {
    const error = tool.validateToolParams(params);
    if (error) throw new Error(`validation: ${error}`);
    return tool
      .build(params)
      .execute({ abortSignal: new AbortController().signal });
  };

  const writePage = async (name: string, title: string) => {
    const file = path.join(dir, name);
    await writeFile(file, fragment(title), 'utf-8');
    return file;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifact-tool-'));
    service = new ArtifactService(
      path.join(dir, '.auditaria'),
      path.join(dir, 'home'),
    );
    host = {
      getPort: () => 8629,
      openInBrowser: vi.fn(async () => true),
      notify: vi.fn(),
    };
    service.setHost(host);
    autoOpen = true;
    tool = new ArtifactTool(makeConfig(), messageBus);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('validates parameters the way Claude Code does', () => {
    expect(tool.validateToolParams({})).toMatch(/file_path is required/);
    expect(tool.validateToolParams({ action: 'read' })).toMatch(
      /url is required/,
    );
    expect(
      tool.validateToolParams({ action: 'read', url: 'https://claude.ai/x' }),
    ).toMatch(/does not name an artifact/);
    expect(
      tool.validateToolParams({ file_path: 'a.html', favicon: 'ab' }),
    ).toMatch(/emoji/);
    expect(tool.validateToolParams({ action: 'list' })).toBeNull();
    expect(tool.validateToolParams({ action: 'list_types' })).toBeNull();
  });

  it('publishes, opens the browser once, and redeploys the same file to the same artifact', async () => {
    const file = await writePage('report.html', 'Deploy Failures');
    const first = await run({
      file_path: file,
      favicon: '📊',
      description: 'Failures by service',
    });
    expect(String(first.llmContent)).toMatch(
      /^Published "Deploy Failures" as artifact [0-9a-f]{16}, version 1\./,
    );
    expect(String(first.llmContent)).toContain('URL: http://art-');
    expect(host.openInBrowser).toHaveBeenCalledTimes(1);

    const card = tryParseArtifactDisplay(first.returnDisplay);
    expect(card).toMatchObject({
      artifact: {
        title: 'Deploy Failures',
        favicon: '📊',
        version: 1,
        created: true,
      },
    });
    const id = card!.artifact.id;
    expect(card!.artifact.url).toBe(`http://art-${id}.localhost:8629/`);

    await writeFile(file, fragment('Deploy Failures'), 'utf-8');
    const second = await run({ file_path: file, label: 'Second pass' });
    expect(String(second.llmContent)).toMatch(
      /^Updated "Deploy Failures" as artifact/,
    );
    expect(String(second.llmContent)).toContain('version 2 ("Second pass")');
    expect(host.openInBrowser).toHaveBeenCalledTimes(1); // never on redeploy
    expect(
      tryParseArtifactDisplay(second.returnDisplay)?.artifact,
    ).toMatchObject({
      id,
      version: 2,
      created: false,
    });
  });

  it('requires a favicon on first publish and honours the auto-open switch', async () => {
    const file = await writePage('page.html', 'No Icon');
    const refused = await run({ file_path: file });
    expect(String(refused.llmContent)).toMatch(/favicon is required/);

    autoOpen = false;
    const ok = await run({ file_path: file, favicon: '🧪' });
    expect(String(ok.llmContent)).toMatch(/^Published/);
    expect(host.openInBrowser).not.toHaveBeenCalled();
  });

  it('reports the page as stored but unreachable when the web server is down', async () => {
    service.setHost(null);
    const file = await writePage('offline.html', 'Offline Page');
    const result = await run({ file_path: file, favicon: '📴' });
    expect(String(result.llmContent)).toContain('web interface is not running');
    expect(String(result.llmContent)).toContain('/web');
    expect(
      tryParseArtifactDisplay(result.returnDisplay)?.artifact.url,
    ).toBeNull();
  });

  it('refuses a url publish until the artifact was read, then updates it', async () => {
    const file = await writePage('a.html', 'Alpha');
    const created = await run({ file_path: file, favicon: '🅰️' });
    const id = tryParseArtifactDisplay(created.returnDisplay)!.artifact.id;

    // A fresh session (new service) knows nothing about the artifact.
    service = new ArtifactService(
      path.join(dir, '.auditaria'),
      path.join(dir, 'home'),
    );
    service.setHost(host);
    tool = new ArtifactTool(makeConfig(), messageBus);
    const other = await writePage('b.html', 'Alpha edited');

    const refused = await run({
      file_path: other,
      url: `http://art-${id}.localhost:8629/`,
    });
    expect(String(refused.llmContent)).toMatch(
      /^Refused: this session has not read or published/,
    );
    expect(String(refused.llmContent)).toContain('=== BEGIN ARTIFACT');
    expect(String(refused.llmContent)).toContain('<h1>Alpha</h1>');

    const read = await run({ action: 'read', url: id });
    expect(String(read.llmContent)).toContain('Base version 1 recorded');
    const updated = await run({ file_path: other, url: id });
    expect(String(updated.llmContent)).toMatch(
      /^Updated "Alpha edited" as artifact/,
    );
    expect(String(updated.llmContent)).toContain('version 2');
  });

  it('detects conflicts, hands back the live version, and honours force', async () => {
    const file = await writePage('c.html', 'Conflict');
    const created = await run({ file_path: file, favicon: '⚔️' });
    const id = tryParseArtifactDisplay(created.returnDisplay)!.artifact.id;

    // Someone else (the page, another session) publishes version 2.
    const store = await service.getStore();
    await store.publish(id, {
      body: fragment('Conflict by page'),
      format: 'html',
      source: 'page',
      title: 'Conflict by page',
    });

    const conflict = await run({ file_path: file });
    expect(String(conflict.llmContent)).toMatch(
      /^Conflict: artifact .* is now at version 2/,
    );
    expect(String(conflict.llmContent)).toContain('<h1>Conflict by page</h1>');

    // After the conflict the session's base is the live version: a plain
    // republish now succeeds as version 3, as does an explicit force.
    const merged = await run({ file_path: file });
    expect(String(merged.llmContent)).toContain('version 3');
    await store.publish(id, {
      body: fragment('Again'),
      format: 'html',
      source: 'page',
      title: 'Again',
    });
    const forced = await run({ file_path: file, force: true });
    expect(String(forced.llmContent)).toContain('version 5');
  });

  it('lists, watches, and deletes', async () => {
    expect(String((await run({ action: 'list' })).llmContent)).toMatch(
      /No artifacts yet/,
    );
    const file = await writePage('d.html', 'Listed');
    const created = await run({
      file_path: file,
      favicon: '📋',
      description: 'A listed page',
    });
    const id = tryParseArtifactDisplay(created.returnDisplay)!.artifact.id;

    const list = String((await run({ action: 'list' })).llmContent);
    expect(list).toContain('1 artifact(s)');
    expect(list).toContain(
      `📋 Listed — http://art-${id}.localhost:8629/ (v1 · attached)`,
    );
    expect(list).toContain('A listed page');
    expect(
      String((await run({ action: 'list', scope: 'shared' })).llmContent),
    ).toMatch(/Nothing listed/);

    const status = String((await run({ action: 'status' })).llmContent);
    expect(status).toContain('1 artifact watch(es)');
    expect(status).toContain('published here');
    expect(
      String((await run({ action: 'unwatch', url: id })).llmContent),
    ).toMatch(/Stopped watching/);
    expect(String((await run({ action: 'status' })).llmContent)).toMatch(
      /No artifact watches/,
    );
    expect(
      String((await run({ action: 'watch', url: id })).llmContent),
    ).toMatch(/Watching artifact/);

    const deleted = String(
      (await run({ action: 'delete', url: id })).llmContent,
    );
    expect(deleted).toMatch(/^Deleted artifact/);
    expect(String((await run({ action: 'list' })).llmContent)).toMatch(
      /No artifacts yet/,
    );
    expect(String((await run({ action: 'read', url: id })).llmContent)).toMatch(
      /was deleted/,
    );
  });

  it('answers pending and compatibility actions with guidance', async () => {
    const pending = await run({ action: 'read_db', url: '0123456789abcdef' });
    expect(String(pending.llmContent)).toMatch(
      /not available on this host yet/,
    );
    const types = await run({ action: 'list_types' });
    expect(String(types.llmContent)).toMatch(/no artifact types/);
  });

  it('prepends pending notices to the next result and renders markdown pages', async () => {
    const file = path.join(dir, 'notes.md');
    await writeFile(file, '# Notes\n\nHello **world**', 'utf-8');
    service.pushNotice('Artifact changed: Notes');
    expect(host.notify).toHaveBeenCalledWith('Artifact changed: Notes');
    const result = await run({ file_path: file, favicon: '📝' });
    expect(String(result.llmContent)).toMatch(
      /^NOTICE: Artifact changed: Notes\n\nPublished "notes"/,
    );
  });

  it('accepts room/mcp declarations with a note and rejects unknown ones', async () => {
    const file = await writePage('caps.html', 'Caps');
    const ok = await run({
      file_path: file,
      favicon: '🧩',
      capabilities: { db: {}, room: {} },
    });
    expect(String(ok.llmContent)).toContain(
      'capabilities: db, room (room accepted but not served',
    );
    const bad = await run({ file_path: file, capabilities: { magic: {} } });
    expect(String(bad.llmContent)).toMatch(/Unknown capability "magic"/);
  });
});
