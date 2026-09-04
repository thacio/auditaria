/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { relativeTime } from './ArtifactsManager.js';
import { themeManager } from '../utils/theme-manager.js';

/**
 * The artifacts tab: a gallery of this project's artifacts (cards with
 * favicon, title, description, edited time; pin, copy link, delete) and a
 * viewer that frames the artifact's own origin with the exact sandbox Claude
 * Code uses, a version picker, restore, open in a new tab, and the Publish
 * slot (wired by the share milestone).
 *
 * Body-appended overlay, like the knowledge-base modal; the console never
 * touches the framed document (it is cross-origin by construction).
 */
export class ArtifactsPanel {
  constructor(manager) {
    this.manager = manager;
    this.container = null;
    this.viewing = null; // { id, version }
    this.versions = [];
    this.confirmDeleteId = null;
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleThemeChange = this.handleThemeChange.bind(this);

    manager.addEventListener('list', () => this.render());
    manager.addEventListener('event', (event) =>
      this.onArtifactEvent(event.detail),
    );
    manager.addEventListener('open', (event) => {
      const id = event.detail?.id;
      if (id) this.open(id);
    });
    document.addEventListener('auditaria-artifact-open', (event) => {
      const id = event.detail?.id;
      if (id) this.open(id);
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  show() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'artifacts-overlay';
      document.body.appendChild(this.container);
      document.addEventListener('keydown', this.handleKeyDown);
      document.addEventListener('themechange', this.handleThemeChange);
    }
    this.container.hidden = false;
    this.manager.refresh();
    this.render();
  }

  hide() {
    if (!this.container) return;
    this.container.hidden = true;
    this.viewing = null;
    this.container.innerHTML = '';
  }

  toggle() {
    if (this.container && !this.container.hidden) this.hide();
    else this.show();
  }

  /** Opens the viewer on an artifact (from a card, a tool card, or the CLI). */
  open(id, version = null) {
    this.viewing = { id, version };
    this.versions = [];
    this.show();
    this.manager.versions(id).then((versions) => {
      if (this.viewing?.id === id) {
        this.versions = versions;
        this.render();
      }
    });
  }

  handleKeyDown(event) {
    if (!this.container || this.container.hidden) return;
    if (event.key === 'Escape') {
      if (this.confirmDeleteId) this.confirmDeleteId = null;
      else if (this.viewing) this.viewing = null;
      else this.hide();
      this.render();
    }
  }

  handleThemeChange(event) {
    const frame = this.container?.querySelector('iframe.artifact-frame');
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: 'auditaria-theme', theme: this.themeKind(event?.detail?.theme) },
      '*',
    );
  }

  /** 'dark' | 'light' from a theme id like 'calm-dark', else the manager. */
  themeKind(themeId) {
    if (typeof themeId === 'string') {
      if (themeId.endsWith('-dark') || themeId === 'dark') return 'dark';
      if (themeId.endsWith('-light') || themeId === 'light') return 'light';
    }
    return themeManager.themeMeta?.kind === 'dark' ? 'dark' : 'light';
  }

  onArtifactEvent(detail) {
    if (!detail || !this.viewing) return;
    // A new version of the artifact on screen: reload the frame to it.
    if (detail.kind === 'version' && detail.id === this.viewing.id) {
      this.viewing.version = null;
      this.manager.versions(detail.id).then((versions) => {
        this.versions = versions;
        this.render();
      });
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  render() {
    if (!this.container || this.container.hidden) return;
    const artifact = this.viewing ? this.manager.get(this.viewing.id) : null;
    if (this.viewing && !artifact) this.viewing = null;
    this.container.innerHTML = '';
    this.container.appendChild(
      this.viewing ? this.renderViewer(artifact) : this.renderGallery(),
    );
  }

  renderGallery() {
    const root = el('div', 'artifacts-modal');
    root.appendChild(el('div', 'artifacts-backdrop'));
    const panel = el('div', 'artifacts-panel');
    root.appendChild(panel);

    const header = el('div', 'artifacts-header');
    header.appendChild(el('h2', 'artifacts-title', 'Artifacts'));
    const meta = el(
      'span',
      'artifacts-meta',
      `${this.manager.artifacts.length} in this project`,
    );
    header.appendChild(meta);
    const close = el('button', 'artifacts-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    header.appendChild(close);
    panel.appendChild(header);

    const search = el('input', 'artifacts-search');
    search.type = 'search';
    search.placeholder = 'Search your artifacts';
    search.value = this.query || '';
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderCards(grid);
    });
    panel.appendChild(search);

    const grid = el('div', 'artifacts-grid');
    panel.appendChild(grid);
    this.renderCards(grid);

    root
      .querySelector('.artifacts-backdrop')
      .addEventListener('click', () => this.hide());
    return root;
  }

  renderCards(grid) {
    grid.innerHTML = '';
    const q = (this.query || '').trim().toLowerCase();
    const rows = this.manager.artifacts.filter(
      (a) => !q || a.title.toLowerCase().includes(q),
    );
    if (rows.length === 0) {
      grid.appendChild(
        el(
          'p',
          'artifacts-empty',
          this.manager.artifacts.length === 0
            ? 'No artifacts yet. Ask the agent for a page, chart, or report — it will appear here.'
            : `No artifacts match "${this.query}".`,
        ),
      );
      return;
    }
    const pinned = rows.filter((a) => a.pinned);
    const others = rows.filter((a) => !a.pinned);
    if (pinned.length) {
      grid.appendChild(el('h3', 'artifacts-group', 'Pinned'));
      for (const a of pinned) grid.appendChild(this.renderCard(a));
    }
    if (pinned.length && others.length)
      grid.appendChild(el('h3', 'artifacts-group', 'All'));
    for (const a of others) grid.appendChild(this.renderCard(a));
  }

  renderCard(a) {
    const card = el('article', 'artifact-card');
    card.setAttribute('aria-label', a.title);
    const thumb = el('div', 'artifact-thumb');
    thumb.textContent = a.favicon;
    card.appendChild(thumb);
    const body = el('div', 'artifact-card-body');
    body.appendChild(el('div', 'artifact-card-title', a.title));
    if (a.description)
      body.appendChild(el('div', 'artifact-card-desc', a.description));
    body.appendChild(
      el(
        'div',
        'artifact-card-meta',
        `Edited ${relativeTime(a.updatedAt)} · v${a.latestVersion}`,
      ),
    );
    card.appendChild(body);

    const actions = el('div', 'artifact-card-actions');
    const pin = iconButton(a.pinned ? '★' : '☆', a.pinned ? 'Unpin' : 'Pin');
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      this.manager.setPinned(a.id, !a.pinned);
    });
    const copy = iconButton('⧉', 'Copy link');
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(a.url).then(() => toast(this.container, `Copied ${a.url}`));
    });
    const del = iconButton('🗑', 'Delete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.confirmDeleteId = a.id;
      this.render();
    });
    actions.append(pin, copy, del);
    card.appendChild(actions);
    if (this.confirmDeleteId === a.id) {
      const confirm = el('div', 'artifact-card-confirm');
      confirm.appendChild(
        el('span', '', `Delete ${a.title}? It stays in the trash for 7 days.`),
      );
      const yes = el('button', 'artifacts-btn artifacts-btn--danger', 'Delete');
      yes.addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmDeleteId = null;
        this.manager.delete(a.id);
      });
      const no = el('button', 'artifacts-btn', 'Keep');
      no.addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmDeleteId = null;
        this.render();
      });
      confirm.append(yes, no);
      confirm.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(confirm);
    }
    card.addEventListener('click', () => this.open(a.id));
    return card;
  }

  renderViewer(a) {
    const root = el('div', 'artifacts-modal artifacts-modal--viewer');
    const panel = el('div', 'artifacts-viewer');
    root.appendChild(panel);

    const header = el('div', 'artifacts-header');
    const back = el('button', 'artifacts-back', '‹ Artifacts');
    back.addEventListener('click', () => {
      this.viewing = null;
      this.render();
    });
    header.appendChild(back);
    header.appendChild(el('span', 'artifacts-viewer-favicon', a.favicon));
    header.appendChild(el('h2', 'artifacts-title', a.title));

    const picker = el('select', 'artifacts-version-picker');
    picker.setAttribute('aria-label', 'Version');
    const served = this.viewing.version ?? a.pinnedVersion ?? a.latestVersion;
    const versions = this.versions.length
      ? this.versions
      : [{ n: a.latestVersion, createdAt: a.updatedAt }];
    for (const v of [...versions].reverse()) {
      const opt = document.createElement('option');
      opt.value = String(v.n);
      opt.textContent = `v${v.n}${v.label ? ` · ${v.label}` : ''}${v.n === a.latestVersion ? ' (latest)' : ''}${v.n === a.pinnedVersion ? ' · pinned' : ''}`;
      if (v.n === served) opt.selected = true;
      picker.appendChild(opt);
    }
    picker.addEventListener('change', () => {
      this.viewing.version = Number(picker.value);
      this.render();
    });
    header.appendChild(picker);

    const tools = el('div', 'artifacts-viewer-tools');
    if (served !== a.latestVersion) {
      const restore = el('button', 'artifacts-btn', 'Restore this version');
      restore.title = 'Publish this version again as the newest one';
      restore.addEventListener('click', () =>
        this.manager.restoreVersion(a.id, served),
      );
      tools.appendChild(restore);
    }
    const openTab = el('a', 'artifacts-btn', 'Open in new tab ↗');
    openTab.href = served === a.latestVersion ? a.url : `${a.url}v/${served}/`;
    openTab.target = '_blank';
    openTab.rel = 'noopener';
    tools.appendChild(openTab);
    const copy = el('button', 'artifacts-btn', 'Copy link');
    copy.addEventListener('click', () =>
      copyText(a.url).then(() => toast(this.container, `Copied ${a.url}`)),
    );
    tools.appendChild(copy);
    const publish = el(
      'button',
      'artifacts-btn artifacts-btn--publish',
      'Publish',
    );
    publish.title = 'Share this artifact with a temporary public link';
    publish.disabled = true;
    publish.dataset.artifactId = a.id;
    tools.appendChild(publish);
    const close = el('button', 'artifacts-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    tools.appendChild(close);
    header.appendChild(tools);
    panel.appendChild(header);

    const frame = document.createElement('iframe');
    frame.className = 'artifact-frame';
    frame.title = 'User-generated artifact content';
    // Exactly Claude Code's sandbox: scripts and forms, same-origin with the
    // artifact's OWN origin (never ours), no popups, no downloads.
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms',
    );
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen; clipboard-write');
    const base = served === a.latestVersion ? a.url : `${a.url}v/${served}/`;
    frame.src = `${base}?theme=${this.themeKind()}`;
    panel.appendChild(frame);
    return root;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(glyph, label) {
  const button = el('button', 'artifact-icon-btn', glyph);
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function toast(container, message) {
  if (!container) return;
  const node = el('div', 'artifacts-toast', message);
  container.appendChild(node);
  setTimeout(() => node.remove(), 2500);
}
