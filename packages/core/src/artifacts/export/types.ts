/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: independent HTML exports.
export interface ExportInput {
  html: string;
  /** Directory against which local references resolve. */
  rootDir: string;
  entry?: string;
  title?: string;
  version?: number;
  artifactId?: string;
  assets?: ReadonlyMap<string, string>;
}

export interface ExportOptions {
  target?: 'standalone' | 'sharepoint';
  compression?: 'none' | 'lossless';
  /** Gzip embedded data, decoded in memory (requires DecompressionStream). */
  compressData?: boolean;
  allowRemote?: boolean;
  warnMiB?: number;
  /** Explicit static data resources exposed by the generated resource API. */
  resources?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ExportDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  source?: string;
}

export interface ExportResource {
  source: string;
  type: string;
  bytes: number;
  sha256: string;
}

export interface ExportReport {
  formatVersion: 1;
  target: 'standalone' | 'sharepoint';
  artifactId?: string;
  version?: number;
  sourceSha256: string;
  outputSha256: string;
  inputBytes: number;
  outputBytes: number;
  outputMiB: number;
  compression: 'none' | 'lossless';
  dataBytesSaved: number;
  imageBytesSaved: number;
  resources: ExportResource[];
  largestResources: ExportResource[];
  diagnostics: ExportDiagnostic[];
  conversionStatus: 'ready' | 'needs_adaptation';
  validationStatus: 'not_run';
}

export interface ExportResult {
  html: string;
  report: ExportReport;
}

export interface SavedExport {
  report: ExportReport;
  htmlFile?: string;
  reportFile?: string;
  instructionsFile?: string;
}
