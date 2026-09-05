/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { useEffect, useState, type FC } from 'react';
import { Box, Text } from 'ink';
import type { ArtifactRecord, ArtifactService } from '@google/gemini-cli-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { openBrowser } from '../../utils/browserUtils.js';
import { terminalLink } from './messages/ArtifactCardDisplay.js';

/** Rows the strip shows: this session's artifacts, most recent first. */
interface StripRow {
  readonly id: string;
  readonly title: string;
  readonly favicon: string;
  readonly url: string | null;
}

const MAX_ROWS = 3;

/**
 * This session's artifacts, as a strip under the footer after Claude Code's:
 * `✻ <title> · … /artifacts to see all · ctrl+] to open`. Each title is a
 * terminal hyperlink to the artifact's viewer; ctrl+] opens the most
 * recent one in the browser. Only artifacts published or attached in THIS
 * session appear; the gallery holds the project's whole history.
 */
export const ArtifactStrip: FC = () => {
  const config = useConfig();
  const service: ArtifactService = config.getArtifactService();
  const [rows, setRows] = useState<StripRow[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const ids = service.sessionArtifactIds().slice(-MAX_ROWS).reverse();
      if (ids.length === 0) {
        if (!cancelled) setRows([]);
        return;
      }
      const store = await service.getStore();
      const next: StripRow[] = [];
      for (const id of ids) {
        const record: ArtifactRecord | null = await store.get(id);
        if (!record || record.deletedAt) continue;
        next.push({
          id,
          title: record.title,
          favicon: record.favicon,
          url: service.viewerUrlFor(id),
        });
      }
      if (!cancelled) {
        setRows(next);
        setDismissed(false);
      }
    };
    void refresh();
    const unsubscribe = service.onSessionChange(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [service]);

  useKeypress(
    (key) => {
      if (rows.length === 0 || dismissed) return false;
      if (key.ctrl && key.name === ']') {
        const recent = rows[0];
        if (recent.url) {
          const url = recent.url;
          openBrowser(url).then(
            () => setToast(`Opened ${url}`),
            () => setToast(`Couldn't open a browser — copy ${url}`),
          );
        } else {
          setToast('The web interface is not running — run /web first.');
        }
        return true;
      }
      return false;
    },
    { isActive: rows.length > 0 && !dismissed },
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (rows.length === 0 || dismissed) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((row, index) => (
        <Box key={row.id}>
          <Text color={theme.text.accent}>✻ </Text>
          <Text color={index === 0 ? theme.text.primary : theme.text.secondary}>
            {row.url
              ? terminalLink(row.url, `${row.favicon} ${row.title}`)
              : `${row.favicon} ${row.title}`}
          </Text>
          {index === 0 ? (
            <Text color={theme.text.secondary}>
              {'  '}· /artifacts to see all · ctrl+] to open
            </Text>
          ) : null}
        </Box>
      ))}
      {toast ? <Text color={theme.text.secondary}>{toast}</Text> : null}
    </Box>
  );
};
