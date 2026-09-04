/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  parseArtifactReference,
  type ArtifactService,
  type ArtifactSummary,
  type Config,
} from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import type { Key } from '../contexts/KeypressContext.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { openBrowser } from '../../utils/browserUtils.js';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

/** Relative time the way the gallery shows it ("Edited 42m ago"). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

interface Row extends ArtifactSummary {
  readonly url: string | null;
  readonly attached: boolean;
}

interface PickerProps {
  rows: Row[];
  onClose: () => void;
  onOpen: (row: Row) => Promise<string>;
  onCopy: (row: Row) => Promise<string>;
  onAttach: (row: Row) => Promise<string>;
  onDelete: (row: Row) => Promise<string>;
  onPin: (row: Row) => Promise<string>;
}

const VISIBLE_ROWS = 12;

/**
 * The `/artifacts` picker, after Claude Code's: a filterable list with
 * `enter attach · o open · c copy url · d delete · p pin · / search · esc`.
 */
export const ArtifactsPickerDialog: React.FC<PickerProps> = (props) => {
  const [rows, setRows] = useState(props.rows);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [toast, setToast] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
  }, [rows, query]);
  const selected = visible[Math.min(cursor, visible.length - 1)];

  const runAction = (label: string, action: () => Promise<string>) => {
    setBusy(true);
    setToast(`${label}…`);
    action()
      .then((message) => setToast(message))
      .catch((error: unknown) =>
        setToast(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  };

  useKeypress(
    (key: Key) => {
      if (busy) return true;
      if (confirmDelete) {
        if (key.name === 'y') {
          const row = confirmDelete;
          setConfirmDelete(null);
          runAction('Deleting', async () => {
            const message = await props.onDelete(row);
            setRows((current) => current.filter((r) => r.id !== row.id));
            return message;
          });
        } else if (key.name === 'n' || key.name === 'escape') {
          setConfirmDelete(null);
          setToast('');
        }
        return true;
      }
      if (searching) {
        if (key.name === 'escape') {
          setSearching(false);
          setQuery('');
        } else if (key.name === 'return' || key.name === 'down') {
          setSearching(false);
        } else if (key.name === 'backspace') {
          setQuery((q) => q.slice(0, -1));
        } else if (key.insertable && key.sequence) {
          setQuery((q) => q + key.sequence);
          setCursor(0);
        }
        return true;
      }
      switch (key.name) {
        case 'escape':
          props.onClose();
          return true;
        case 'up':
          setCursor((c) => Math.max(0, c - 1));
          return true;
        case 'down':
          setCursor((c) => Math.min(visible.length - 1, c + 1));
          return true;
        case '/':
          setSearching(true);
          return true;
        case 'return':
          if (selected) {
            runAction('Attaching', async () => {
              const message = await props.onAttach(selected);
              setRows((current) =>
                current.map((r) =>
                  r.id === selected.id ? { ...r, attached: true } : r,
                ),
              );
              return message;
            });
          }
          return true;
        case 'o':
          if (selected) runAction('Opening', () => props.onOpen(selected));
          return true;
        case 'c':
          if (selected) runAction('Copying', () => props.onCopy(selected));
          return true;
        case 'p':
          if (selected) {
            runAction(selected.pinned ? 'Unpinning' : 'Pinning', async () => {
              const message = await props.onPin(selected);
              setRows((current) =>
                current.map((r) =>
                  r.id === selected.id ? { ...r, pinned: !r.pinned } : r,
                ),
              );
              return message;
            });
          }
          return true;
        case 'd':
          if (selected) setConfirmDelete(selected);
          return true;
        default:
          return false;
      }
    },
    { isActive: true },
  );

  const start = Math.max(
    0,
    Math.min(
      cursor - Math.floor(VISIBLE_ROWS / 2),
      visible.length - VISIBLE_ROWS,
    ),
  );
  const slice = visible.slice(start, start + VISIBLE_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.text.primary}>
          Artifacts
        </Text>
        <Text color={theme.text.secondary}>{rows.length} in this project</Text>
      </Box>
      <Box>
        <Text color={searching ? theme.text.accent : theme.text.secondary}>
          {searching ? '/ ' : ''}
          {query || (searching ? 'Search artifacts…' : '')}
        </Text>
      </Box>
      {slice.length === 0 ? (
        <Text color={theme.text.secondary}>
          {rows.length === 0
            ? 'No artifacts yet. Publish one with the Artifact tool.'
            : `No artifacts match "${query}"`}
        </Text>
      ) : (
        slice.map((row, index) => {
          const isSelected = start + index === cursor;
          const meta = [
            row.attached ? 'attached' : null,
            'private',
            `v${row.latestVersion}`,
            relativeTime(row.updatedAt),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Box key={row.id}>
              <Text
                color={isSelected ? theme.text.accent : theme.text.secondary}
              >
                {isSelected ? '❯ ' : '  '}
              </Text>
              <Text color={theme.text.accent}>✻ </Text>
              {row.pinned ? <Text color={theme.status.warning}>★ </Text> : null}
              <Text
                color={isSelected ? theme.text.primary : theme.text.secondary}
              >
                {row.favicon}{' '}
                {row.title.length > 49
                  ? `${row.title.slice(0, 48)}…`
                  : row.title}
              </Text>
              <Text color={theme.text.secondary}> {meta}</Text>
            </Box>
          );
        })
      )}
      {visible.length > VISIBLE_ROWS ? (
        <Text color={theme.text.secondary}>
          {start > 0 ? `↑ ${start} more above  ` : ''}
          {start + VISIBLE_ROWS < visible.length
            ? `↓ ${visible.length - start - VISIBLE_ROWS} more below`
            : ''}
        </Text>
      ) : null}
      <Box marginTop={1}>
        {confirmDelete ? (
          <Text color={theme.status.warning}>
            Delete {confirmDelete.title}? This cannot be undone. y delete · n
            keep
          </Text>
        ) : toast ? (
          <Text color={theme.text.accent}>{toast}</Text>
        ) : (
          <Text color={theme.text.secondary}>
            enter attach · o open · c copy url · d delete · p pin · / search ·
            esc close
          </Text>
        )}
      </Box>
    </Box>
  );
};

function serviceOf(context: CommandContext): ArtifactService | null {
  const config: Config | undefined = context.services.agentContext?.config;
  return config ? config.getArtifactService() : null;
}

async function rowsOf(service: ArtifactService): Promise<Row[]> {
  const store = await service.getStore();
  return (await store.list()).map((row) => ({
    ...row,
    url: service.urlFor(row.id),
    attached: service.baseVersionOf(row.id) !== undefined,
  }));
}

/** Starts the web interface when needed and returns the artifact's URL. */
async function ensureUrl(
  context: CommandContext,
  service: ArtifactService,
  id: string,
): Promise<string> {
  let url = service.urlFor(id);
  if (!url && context.web) {
    const started = await context.web.start();
    if (started.messageType === 'error') throw new Error(started.content);
    url = service.urlFor(id);
  }
  if (!url) {
    throw new Error('The web interface is not running — run /web first.');
  }
  return url;
}

function info(context: CommandContext, text: string): void {
  context.ui.addItem({ type: MessageType.INFO, text }, Date.now());
}

function requireId(context: CommandContext, args: string): string | null {
  const id = parseArtifactReference(args.trim());
  if (!id) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: 'Give an artifact id or URL (see /artifacts list).',
      },
      Date.now(),
    );
  }
  return id;
}

const actions = (context: CommandContext, service: ArtifactService) => ({
  open: async (row: Row): Promise<string> => {
    const url = await ensureUrl(context, service, row.id);
    try {
      await openBrowser(url);
      return `Opened ${url}`;
    } catch {
      return `Couldn't open a browser — press c to copy ${url}`;
    }
  },
  copy: async (row: Row): Promise<string> => {
    const url = await ensureUrl(context, service, row.id);
    await copyToClipboard(url, context.services.settings.merged);
    return `Copied ${url}`;
  },
  attach: async (row: Row): Promise<string> => {
    service.track(row.id, row.latestVersion, service.hasPublishedHere(row.id));
    service.queueNotice(
      `The user attached the artifact ${row.id} ("${row.title}", version ${row.latestVersion}) to this session as the current artifact of interest. Re-read it before editing or republishing; a publish with url now updates it.`,
    );
    return `Attached ✻ ${row.title} — you'll be notified when it's republished`;
  },
  remove: async (row: Row): Promise<string> => {
    const store = await service.getStore();
    await store.delete(row.id);
    service.untrack(row.id);
    return 'Artifact deleted';
  },
  pin: async (row: Row): Promise<string> => {
    const store = await service.getStore();
    await store.setPinned(row.id, !row.pinned);
    return `${row.pinned ? 'Unpinned' : 'Pinned'} ${row.title}`;
  },
});

const openPicker = async (
  context: CommandContext,
): Promise<SlashCommandActionReturn | void> => {
  const service = serviceOf(context);
  if (!service) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Artifacts are not available in this configuration.',
    };
  }
  const rows = await rowsOf(service);
  const act = actions(context, service);
  return {
    type: 'custom_dialog',
    component: (
      <ArtifactsPickerDialog
        rows={rows}
        onClose={() => {
          context.ui.removeComponent();
          info(context, 'Artifacts panel closed');
        }}
        onOpen={act.open}
        onCopy={act.copy}
        onAttach={act.attach}
        onDelete={act.remove}
        onPin={act.pin}
      />
    ),
  };
};

const withId =
  (
    run: (
      context: CommandContext,
      service: ArtifactService,
      id: string,
    ) => Promise<string>,
  ) =>
  async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const service = serviceOf(context);
    if (!service) return;
    const id = requireId(context, args);
    if (!id) return;
    try {
      info(context, await run(context, service, id));
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
    }
  };

export const artifactsCommand: SlashCommand = {
  name: 'artifacts',
  description:
    'Browse the artifacts of this project: attach, open, copy the link, pin, delete',
  kind: CommandKind.BUILT_IN,
  action: (context) => openPicker(context),
  subCommands: [
    {
      name: 'list',
      description: 'List the artifacts of this project',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const service = serviceOf(context);
        if (!service) return;
        const rows = await rowsOf(service);
        if (rows.length === 0) {
          info(
            context,
            'No artifacts yet. Publish one with the Artifact tool.',
          );
          return;
        }
        info(
          context,
          rows
            .map(
              (r) =>
                `✻ ${r.favicon} ${r.title} — ${r.url ?? `artifact:${r.id}`} (v${r.latestVersion}${r.pinned ? ', pinned' : ''}${r.attached ? ', attached' : ''}) · ${relativeTime(r.updatedAt)}`,
            )
            .join('\n'),
        );
      },
    },
    {
      name: 'open',
      description:
        'Open an artifact in the browser (starts the web interface if needed)',
      kind: CommandKind.BUILT_IN,
      action: withId(async (context, service, id) => {
        const store = await service.getStore();
        const record = await store.require(id);
        const url = await ensureUrl(context, service, id);
        await openBrowser(url);
        return `Opened ${record.favicon} ${record.title}: ${url}`;
      }),
    },
    {
      name: 'copy',
      description: 'Copy an artifact link to the clipboard',
      kind: CommandKind.BUILT_IN,
      action: withId(async (context, service, id) => {
        const url = await ensureUrl(context, service, id);
        await copyToClipboard(url, context.services.settings.merged);
        return `Copied ${url}`;
      }),
    },
    {
      name: 'attach',
      description:
        'Attach an artifact to this session so the agent can update it',
      kind: CommandKind.BUILT_IN,
      action: withId(async (context, service, id) => {
        const store = await service.getStore();
        const record = await store.require(id);
        const rows = await rowsOf(service);
        const row = rows.find((r) => r.id === record.id);
        if (!row) throw new Error(`No artifact ${id}.`);
        return actions(context, service).attach(row);
      }),
    },
    {
      name: 'delete',
      description: 'Move an artifact to the trash (restorable for 7 days)',
      kind: CommandKind.BUILT_IN,
      action: withId(async (_context, service, id) => {
        const store = await service.getStore();
        const record = await store.require(id);
        await store.delete(id);
        service.untrack(id);
        return `Deleted ${record.title}. Restore it within 7 days with /artifacts restore ${id}.`;
      }),
    },
    {
      name: 'restore',
      description: 'Restore an artifact from the trash',
      kind: CommandKind.BUILT_IN,
      action: withId(async (_context, service, id) => {
        const store = await service.getStore();
        const record = await store.restore(id);
        return `Restored ${record.favicon} ${record.title}.`;
      }),
    },
  ],
};
