/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client side of the artifacts protocol. Keeps the gallery list current
 * from `artifact_list` snapshots and `artifact_event` pushes, and exposes
 * the requests the panel makes. The server is the source of truth: every
 * mutation is a request, and the list arrives back as a fresh snapshot.
 */
export class ArtifactsManager extends EventTarget {
  constructor(wsManager) {
    super();
    this.wsManager = wsManager;
    /** @type {Array<object>} */
    this.artifacts = [];
    this.versionWaiters = new Map();

    wsManager.addEventListener('artifact_list', (event) => {
      this.artifacts = Array.isArray(event.detail?.artifacts)
        ? event.detail.artifacts
        : [];
      this.dispatchEvent(new CustomEvent('list', { detail: this.artifacts }));
    });
    wsManager.addEventListener('artifact_event', (event) => {
      this.dispatchEvent(new CustomEvent('event', { detail: event.detail }));
    });
    wsManager.addEventListener('artifact_versions_response', (event) => {
      const { id, versions } = event.detail || {};
      const waiter = this.versionWaiters.get(id);
      if (waiter) {
        this.versionWaiters.delete(id);
        waiter(Array.isArray(versions) ? versions : []);
      }
    });
    /** id → { url, startedAt } while shared in this session. */
    this.shares = new Map();
    wsManager.addEventListener('artifact_share_state', (event) => {
      const { id, url, startedAt, error } = event.detail || {};
      if (!id) return;
      if (url) this.shares.set(id, { url, startedAt });
      else this.shares.delete(id);
      this.dispatchEvent(
        new CustomEvent('share', { detail: { id, url: url || null, error } }),
      );
    });
    /** id → resolver for the next comments listing. */
    this.commentWaiters = new Map();
    wsManager.addEventListener('artifact_comments_response', (event) => {
      const { id, threads } = event.detail || {};
      const waiter = this.commentWaiters.get(id);
      if (waiter) {
        this.commentWaiters.delete(id);
        waiter(Array.isArray(threads) ? threads : []);
      }
    });
    wsManager.addEventListener('artifact_comment_event', (event) => {
      this.dispatchEvent(new CustomEvent('comment', { detail: event.detail }));
    });
    wsManager.addEventListener('artifact_download_offer', (event) => {
      this.dispatchEvent(new CustomEvent('download', { detail: event.detail }));
    });
    wsManager.addEventListener('artifact_open', (event) => {
      this.dispatchEvent(new CustomEvent('open', { detail: event.detail }));
    });
    wsManager.addEventListener('connected', () => this.refresh());
  }

  refresh() {
    this.wsManager.send({ type: 'artifact_list_request' });
  }

  get(id) {
    return this.artifacts.find((a) => a.id === id) || null;
  }

  /** @returns {Promise<Array<object>>} */
  versions(id) {
    return new Promise((resolve) => {
      this.versionWaiters.set(id, resolve);
      this.wsManager.send({ type: 'artifact_versions_request', id });
      setTimeout(() => {
        if (this.versionWaiters.get(id) === resolve) {
          this.versionWaiters.delete(id);
          resolve([]);
        }
      }, 8000);
    });
  }

  rename(id, title) {
    this.wsManager.send({
      type: 'artifact_update_request',
      id,
      op: 'rename',
      title,
    });
  }

  setPinned(id, pinned) {
    this.wsManager.send({
      type: 'artifact_update_request',
      id,
      op: 'pin',
      pinned,
    });
  }

  pinVersion(id, version) {
    this.wsManager.send({
      type: 'artifact_update_request',
      id,
      op: 'pin_version',
      version,
    });
  }

  restoreVersion(id, version) {
    this.wsManager.send({
      type: 'artifact_update_request',
      id,
      op: 'restore_version',
      version,
    });
  }

  setSampleConsent(id, consent) {
    this.wsManager.send({
      type: 'artifact_update_request',
      id,
      op: 'sample_consent',
      consent,
    });
  }

  shareOf(id) {
    return this.shares.get(id) || null;
  }

  /** Publish: open a temporary public link for this session only. */
  share(id) {
    this.wsManager.send({ type: 'artifact_share_request', id, op: 'start' });
  }

  unshare(id) {
    this.wsManager.send({ type: 'artifact_share_request', id, op: 'stop' });
  }

  /** @returns {Promise<Array<object>>} the artifact's comment threads */
  comments(id) {
    return new Promise((resolve) => {
      this.commentWaiters.set(id, resolve);
      this.wsManager.send({ type: 'artifact_comments_request', id });
      setTimeout(() => {
        if (this.commentWaiters.get(id) === resolve) {
          this.commentWaiters.delete(id);
          resolve([]);
        }
      }, 8000);
    });
  }

  /** The viewer's answer to a page's download offer. */
  decideDownload(token, accept) {
    this.wsManager.send({ type: 'artifact_download_decision', token, accept });
  }

  /** op: create | reply | activate | resolve | reopen */
  comment(id, op, extra = {}) {
    this.wsManager.send({ type: 'artifact_comment_request', id, op, ...extra });
  }

  delete(id) {
    this.wsManager.send({ type: 'artifact_delete_request', id });
  }

  restore(id) {
    this.wsManager.send({ type: 'artifact_restore_request', id });
  }
}

/** "Edited 42m ago" / "Edited Sep 1", as the gallery shows it. */
export function relativeTime(iso, now = Date.now()) {
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
