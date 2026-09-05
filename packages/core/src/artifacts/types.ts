/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

/**
 * Data model of the artifacts store. Everything here is plain JSON that is
 * written to append-only journals under `<project>/.auditaria/artifacts/`.
 */

/** 16 lower-case hex characters; doubles as the host label `art-<id>`. */
export type ArtifactId = string;

/** Who produced a version. */
export type VersionSource = 'tool' | 'page' | 'web';

/** The runtime capabilities a page may declare (Claude contract 0.2.41). */
export type CapabilityName =
  | 'artifact'
  | 'self'
  | 'db'
  | 'user'
  | 'assets'
  | 'downloads'
  | 'sample'
  | 'room'
  | 'mcp';

/** `capabilities: {name: config}` as passed to the tool. */
export type CapabilityDeclaration = Readonly<Record<string, unknown>>;

export interface ArtifactVersion {
  /** 1-based, monotonic per artifact. */
  readonly n: number;
  readonly createdAt: string;
  readonly source: VersionSource;
  /** Title captured at publish time (from `<title>` or the `title` param). */
  readonly title: string;
  /** Optional version label (≤ 60 chars), shown in the version picker. */
  readonly label?: string;
  /** sha256 of the stored body, for dedup checks and ETags. */
  readonly sha256: string;
  readonly bytes: number;
  /** Source kind of the body: an authored HTML fragment or Markdown. */
  readonly format: 'html' | 'markdown';
  /**
   * Present when the version is a multi-file site: the body is its
   * `index.html` and the whole folder snapshot lives beside it.
   */
  readonly site?: SiteSummary;
}

/** What a site version records about its snapshot. */
export interface SiteSummary {
  readonly files: number;
  readonly bytes: number;
}

/** One file of a site being published: where it is and where it goes. */
export interface SiteFile {
  /** Relative path inside the site, forward slashes. */
  readonly path: string;
  /** Absolute source path to copy from. */
  readonly source: string;
  readonly bytes: number;
}

export interface SiteInput {
  readonly files: readonly SiteFile[];
}

export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly description: string;
  /** One or two emoji. */
  readonly favicon: string;
  readonly capabilities: CapabilityDeclaration;
  /** Highest version number ever minted. */
  readonly latestVersion: number;
  /** Version viewers see when set; `null` = latest. */
  readonly pinnedVersion: number | null;
  readonly pinned: boolean;
  /** Present when soft-deleted. */
  readonly deletedAt?: string;
  /** Owner consent for pages that ask the model (`sample`). */
  readonly sampleConsent: boolean;
}

/** Summary row for galleries and the tool's `list` action. */
export interface ArtifactSummary {
  readonly id: ArtifactId;
  readonly title: string;
  readonly description: string;
  readonly favicon: string;
  readonly latestVersion: number;
  readonly pinnedVersion: number | null;
  readonly pinned: boolean;
  readonly capabilities: CapabilityDeclaration;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sampleConsent: boolean;
}

/** One line of `artifact.jsonl`: the artifact's own history. */
export type ArtifactEvent =
  | {
      readonly type: 'created';
      readonly at: string;
      readonly record: ArtifactRecord;
    }
  | {
      readonly type: 'version';
      readonly at: string;
      readonly version: ArtifactVersion;
    }
  | {
      readonly type: 'meta';
      readonly at: string;
      readonly patch: Partial<
        Pick<
          ArtifactRecord,
          | 'title'
          | 'description'
          | 'favicon'
          | 'capabilities'
          | 'pinnedVersion'
          | 'pinned'
          | 'sampleConsent'
        >
      >;
    }
  | { readonly type: 'deleted'; readonly at: string }
  | { readonly type: 'restored'; readonly at: string }
  | {
      readonly type: 'shared';
      readonly at: string;
      readonly url: string;
    }
  | { readonly type: 'unshared'; readonly at: string };

export interface PublishInput {
  /** Authored body: an HTML fragment, or Markdown when `format` is markdown. */
  readonly body: string;
  readonly format: 'html' | 'markdown';
  readonly source: VersionSource;
  /** Title to use when the body carries none. */
  readonly title?: string;
  readonly description?: string;
  readonly favicon?: string;
  readonly label?: string;
  /**
   * Capability declaration gesture: `undefined` keeps the stored one,
   * `{}` clears it, a non-empty object replaces it in full.
   */
  readonly capabilities?: CapabilityDeclaration;
  /**
   * A multi-file site: the folder's files, copied into the version's
   * snapshot; `body` is then the site's `index.html`.
   */
  readonly site?: SiteInput;
}

export interface PublishOutcome {
  readonly record: ArtifactRecord;
  readonly version: ArtifactVersion;
  readonly created: boolean;
}

/** Events the store emits so the web layer can broadcast them. */
export interface ArtifactStoreEvents {
  /** A new version was minted (or the artifact was created). */
  version: [outcome: PublishOutcome];
  /** Metadata changed (title, description, pin, consent, …). */
  meta: [record: ArtifactRecord];
  deleted: [id: ArtifactId];
  restored: [record: ArtifactRecord];
}
