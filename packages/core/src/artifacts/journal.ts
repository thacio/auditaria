/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Append-only JSONL files and write-once blobs — the store's only two
 * persistence primitives. Chosen over a database because the data is small
 * (thousands of lines at most), the semantics are simple, and the pattern
 * is Windows-safe: nothing is ever renamed over an existing file, so
 * antivirus scanners and `EPERM` never get a chance to bite.
 */

const FILE_MODE = 0o600;

/**
 * Reads every well-formed line of a JSONL file. A torn last line (crash
 * mid-append) is skipped, never fatal. A missing file reads as empty.
 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return [];
    throw error;
  }
  return parseJsonlText<T>(raw);
}

export function readJsonlSync<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return [];
    throw error;
  }
  return parseJsonlText<T>(raw);
}

export function parseJsonlText<T>(raw: string): T[] {
  const lines = raw.split('\n');
  const out: T[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      // Callers own the schema: a journal line is whatever they appended.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      out.push(JSON.parse(text) as T);
    } catch {
      // A torn line: keep what parsed so far and drop the fragment.
    }
  }
  return out;
}

/** Appends one JSON line and fsyncs so the record survives a crash. */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsp.open(file, 'a', FILE_MODE);
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`, 'utf-8');
    try {
      await handle.sync();
    } catch {
      // fsync can fail on exotic filesystems; the append itself succeeded.
    }
  } finally {
    await handle.close();
  }
}

/**
 * Writes a file that must never exist yet (`wx`), so two writers can never
 * clobber each other and a rerun never silently overwrites history.
 */
export async function writeOnce(
  file: string,
  content: string | Uint8Array,
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, { flag: 'wx', mode: FILE_MODE });
}

/**
 * Replaces a whole file through a fresh temp name plus rename. Used only for
 * snapshots (compaction) where a torn write must not be observable; the
 * rename target is removed first because Windows refuses rename-over-existing
 * while another handle is open, and a retry ladder absorbs antivirus locks.
 */
export async function replaceFile(
  file: string,
  content: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fsp.writeFile(temp, content, { mode: FILE_MODE });
  const delays = [0, 50, 150, 400, 900];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      await fsp.rm(file, { force: true });
      await fsp.rename(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!isCode(error, 'EPERM') && !isCode(error, 'EBUSY')) break;
    }
  }
  await fsp.rm(temp, { force: true }).catch(() => undefined);
  throw lastError;
}

export function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
