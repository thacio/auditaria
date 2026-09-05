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
    /** Comment threads of the artifact on screen. */
    this.threads = [];
    this.showComments = false;
    manager.addEventListener('comment', (event) => {
      const { id, thread, error } = event.detail || {};
      if (!this.viewing || id !== this.viewing.id) return;
      if (error) {
        toast(this.container, error);
        return;
      }
      if (thread) {
        const index = this.threads.findIndex((t) => t.id === thread.id);
        if (index >= 0) this.threads[index] = thread;
        else this.threads.unshift(thread);
        this.refreshComments();
      }
    });
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleThemeChange = this.handleThemeChange.bind(this);

    manager.addEventListener('list', () => this.render());
    manager.addEventListener('download', (event) =>
      this.showDownloadOffer(event.detail),
    );
    manager.addEventListener('consent', (event) =>
      this.showConsentRequest(event.detail),
    );
    manager.addEventListener('share', (event) => {
      const { id, error } = event.detail || {};
      if (error) this.shareError = error;
      else this.shareError = null;
      if (this.sharePending === id) this.sharePending = null;
      this.render();
    });
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
    this.threads = [];
    this.show();
    this.manager.comments(id).then((threads) => {
      if (this.viewing?.id === id) {
        this.threads = threads;
        this.refreshComments();
      }
    });
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
    // While the same version stays on screen, a gallery refresh, a share
    // change or a rename must not re-create the frame (that reloads the
    // page); only the chrome around it is rebuilt.
    if (
      artifact &&
      this.container.querySelector('.artifacts-viewer') &&
      this.renderedFrameBase ===
        this.frameBaseOf(artifact, this.servedVersionOf(artifact))
    ) {
      this.refreshViewerChrome(artifact);
      return;
    }
    this.renderedFrameBase = null;
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
      copyText(a.viewerUrl).then(() =>
        toast(this.container, `Copied ${a.viewerUrl}`),
      );
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

    const served = this.servedVersionOf(a);
    const header = this.buildViewerHeader(a, served);
    panel.appendChild(header);

    const share = this.manager.shareOf(a.id);
    if (share || this.shareError || this.sharePending === a.id) {
      panel.appendChild(this.renderShareBar(a, share));
    }

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
    const base = this.frameBaseOf(a, served);
    this.renderedFrameBase = base;
    frame.src = `${base}?theme=${this.themeKind()}`;
    const body = el('div', 'artifacts-viewer-body');
    body.appendChild(frame);
    if (this.showComments) body.appendChild(this.renderComments(a));
    panel.appendChild(body);
    return root;
  }

  servedVersionOf(a) {
    return this.viewing?.version ?? a.pinnedVersion ?? a.latestVersion;
  }

  frameBaseOf(a, served) {
    return served === a.latestVersion ? a.url : `${a.url}v/${served}/`;
  }

  /** The viewer's header: title, version picker, and the tool buttons. */
  buildViewerHeader(a, served) {
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
    // A new tab gets the viewer (chrome included), pinned to this version.
    openTab.href =
      served === a.latestVersion ? a.viewerUrl : `${a.viewerUrl}?v=${served}`;
    openTab.target = '_blank';
    openTab.rel = 'noopener';
    tools.appendChild(openTab);
    const copy = el('button', 'artifacts-btn', 'Copy link');
    copy.addEventListener('click', () =>
      copyText(a.viewerUrl).then(() =>
        toast(this.container, `Copied ${a.viewerUrl}`),
      ),
    );
    tools.appendChild(copy);
    const share = this.manager.shareOf(a.id);
    const pending = this.sharePending === a.id;
    const publish = el(
      'button',
      'artifacts-btn artifacts-btn--publish',
      share ? 'Unpublish' : pending ? 'Publishing…' : 'Publish',
    );
    publish.title = share
      ? 'Stop sharing this artifact'
      : 'Share this artifact with a temporary public link';
    publish.disabled = pending;
    publish.addEventListener('click', () => {
      if (share) {
        this.manager.unshare(a.id);
        return;
      }
      this.sharePending = a.id;
      this.shareError = null;
      this.manager.share(a.id);
      this.render();
    });
    tools.appendChild(publish);
    const openThreads = this.threads.filter((t) => !t.resolved).length;
    const commentsBtn = el(
      'button',
      `artifacts-btn artifacts-btn--comments${this.showComments ? ' artifacts-btn--active' : ''}`,
      openThreads ? `Comments (${openThreads})` : 'Comments',
    );
    commentsBtn.title = 'Comment on this artifact';
    commentsBtn.addEventListener('click', () => {
      // Only the sidebar changes; never re-create the frame for this.
      this.showComments = !this.showComments;
      commentsBtn.classList.toggle('artifacts-btn--active', this.showComments);
      this.refreshComments();
    });
    tools.appendChild(commentsBtn);
    const close = el('button', 'artifacts-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    tools.appendChild(close);
    header.appendChild(tools);
    return header;
  }
}

/**
 * The bar under the viewer header while an artifact is published: the
 * public address, a copy button, and the plain truth about its lifetime.
 */
ArtifactsPanel.prototype.renderShareBar = function renderShareBar(a, share) {
  const bar = el('div', 'artifacts-share-bar');
  if (this.shareError) {
    bar.classList.add('artifacts-share-bar--error');
    bar.appendChild(
      el(
        'span',
        'artifacts-share-text',
        `Could not publish: ${this.shareError}`,
      ),
    );
    return bar;
  }
  if (!share) {
    bar.appendChild(
      el(
        'span',
        'artifacts-share-text',
        'Opening a public tunnel… this can take about ten seconds.',
      ),
    );
    return bar;
  }
  const link = el('a', 'artifacts-share-url', share.url);
  link.href = share.url;
  link.target = '_blank';
  link.rel = 'noopener';
  bar.appendChild(el('span', 'artifacts-share-label', 'Public link'));
  bar.appendChild(link);
  const copy = el('button', 'artifacts-btn', 'Copy public link');
  copy.addEventListener('click', () =>
    copyText(share.url).then(() => toast(this.container, 'Public link copied')),
  );
  bar.appendChild(copy);
  bar.appendChild(
    el(
      'span',
      'artifacts-share-note',
      'Anyone with this link can view the latest version while Auditaria is running. The link stops working when Auditaria closes; click Publish again to get a new one.',
    ),
  );
  return bar;
};

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

/**
 * The comments sidebar: a new-thread box, then every thread (open first)
 * with its messages, a reply box, "Send to agent" (activation), and
 * Resolve/Reopen. Threads reach the agent only once sent.
 */
ArtifactsPanel.prototype.renderComments = function renderComments(a) {
  const side = el('aside', 'artifacts-comments');
  const head = el('div', 'artifacts-comments-head');
  head.appendChild(el('h3', '', 'Comments'));
  head.appendChild(
    el(
      'span',
      'artifacts-comments-hint',
      'A thread reaches the agent only when you send it.',
    ),
  );
  side.appendChild(head);

  const compose = el('form', 'artifacts-comment-compose');
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Comment on this artifact…';
  textarea.rows = 3;
  compose.appendChild(textarea);
  const row = el('div', 'artifacts-comment-actions');
  const post = el('button', 'artifacts-btn', 'Comment');
  post.type = 'submit';
  const send = el(
    'button',
    'artifacts-btn artifacts-btn--send',
    'Send to agent',
  );
  send.type = 'button';
  row.append(post, send);
  compose.appendChild(row);
  const submit = (sendToAgent) => {
    const text = textarea.value.trim();
    if (!text) return;
    this.manager.comment(a.id, 'create', { text, send_to_agent: sendToAgent });
    textarea.value = '';
  };
  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(false);
  });
  send.addEventListener('click', () => submit(true));
  side.appendChild(compose);

  const list = el('div', 'artifacts-comment-list');
  if (this.threads.length === 0) {
    list.appendChild(el('p', 'artifacts-comments-empty', 'No comments yet.'));
  }
  for (const t of this.threads) list.appendChild(this.renderThread(a, t));
  side.appendChild(list);
  return side;
};

ArtifactsPanel.prototype.renderThread = function renderThread(a, t) {
  const box = el(
    'article',
    `artifacts-thread${t.resolved ? ' artifacts-thread--resolved' : ''}`,
  );
  box.dataset.threadId = t.id;
  const meta = el('div', 'artifacts-thread-meta');
  meta.appendChild(
    el('span', 'artifacts-thread-state', t.resolved ? 'Resolved' : 'Open'),
  );
  meta.appendChild(
    el('span', '', `v${t.version} · ${relativeTime(t.createdAt)}`),
  );
  if (t.activated)
    meta.appendChild(el('span', 'artifacts-thread-sent', 'Sent to agent'));
  box.appendChild(meta);
  if (t.anchor && t.anchor.text) {
    box.appendChild(el('blockquote', 'artifacts-thread-anchor', t.anchor.text));
  }
  for (const m of t.messages) {
    const msg = el('div', `artifacts-message artifacts-message--${m.author}`);
    msg.appendChild(
      el(
        'span',
        'artifacts-message-who',
        m.author === 'agent' ? 'Agent · via you' : 'You',
      ),
    );
    msg.appendChild(el('span', 'artifacts-message-text', m.text));
    if (m.sentToAgent)
      msg.appendChild(el('span', 'artifacts-message-flag', 'sent to agent'));
    box.appendChild(msg);
  }
  const replyBox = document.createElement('textarea');
  replyBox.rows = 2;
  replyBox.placeholder = 'Reply…';
  replyBox.className = 'artifacts-reply-box';
  box.appendChild(replyBox);
  const actions = el('div', 'artifacts-comment-actions');
  const reply = el('button', 'artifacts-btn', 'Reply');
  reply.addEventListener('click', () => {
    const text = replyBox.value.trim();
    if (!text) return;
    this.manager.comment(a.id, 'reply', { thread_id: t.id, text });
    replyBox.value = '';
  });
  actions.appendChild(reply);
  if (!t.activated) {
    const activate = el(
      'button',
      'artifacts-btn artifacts-btn--send',
      'Send to agent',
    );
    activate.addEventListener('click', () => {
      const text = replyBox.value.trim();
      if (text) {
        this.manager.comment(a.id, 'reply', {
          thread_id: t.id,
          text,
          send_to_agent: true,
        });
      } else {
        this.manager.comment(a.id, 'activate', { thread_id: t.id });
      }
      replyBox.value = '';
    });
    actions.appendChild(activate);
  }
  const toggle = el(
    'button',
    'artifacts-btn',
    t.resolved ? 'Reopen' : 'Resolve',
  );
  toggle.addEventListener('click', () =>
    this.manager.comment(a.id, t.resolved ? 'reopen' : 'resolve', {
      thread_id: t.id,
    }),
  );
  actions.appendChild(toggle);
  box.appendChild(actions);
  return box;
};

/** Re-renders only the comments sidebar and its button, keeping the frame. */
ArtifactsPanel.prototype.refreshComments = function refreshComments() {
  const viewer = this.container?.querySelector('.artifacts-viewer');
  const a = this.viewing ? this.manager.get(this.viewing.id) : null;
  if (!viewer || !a) {
    this.render();
    return;
  }
  const old = viewer.querySelector('.artifacts-comments');
  if (this.showComments) {
    const fresh = this.renderComments(a);
    if (old) old.replaceWith(fresh);
    else viewer.querySelector('.artifacts-viewer-body')?.appendChild(fresh);
  } else if (old) {
    old.remove();
  }
  const button = viewer.querySelector('.artifacts-btn--comments');
  if (button) {
    const open = this.threads.filter((t) => !t.resolved).length;
    button.textContent = open ? `Comments (${open})` : 'Comments';
  }
};

/**
 * A page offered the viewer a file. The page cannot save it itself (the
 * frame's sandbox forbids downloads), so the console asks, and on Save
 * navigates its own hidden frame to the one-time attachment URL.
 */
ArtifactsPanel.prototype.showDownloadOffer = function showDownloadOffer(offer) {
  if (!offer || !offer.token) return;
  const existing = document.querySelector(
    `.artifacts-download-bar[data-token="${offer.token}"]`,
  );
  if (existing) return;
  const bar = el('div', 'artifacts-download-bar');
  bar.dataset.token = offer.token;
  const kb =
    offer.size >= 1024
      ? `${(offer.size / 1024).toFixed(offer.size >= 10240 ? 0 : 1)} KB`
      : `${offer.size} B`;
  bar.appendChild(
    el(
      'span',
      'artifacts-download-text',
      `“${offer.title}” wants to save ${offer.filename} (${kb}).`,
    ),
  );
  const actions = el('div', 'artifacts-comment-actions');
  const save = el('button', 'artifacts-btn artifacts-btn--publish', 'Save');
  save.addEventListener('click', () => {
    this.manager.decideDownload(offer.token, true);
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = offer.url;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 60000);
    bar.remove();
  });
  const decline = el('button', 'artifacts-btn', 'Decline');
  decline.addEventListener('click', () => {
    this.manager.decideDownload(offer.token, false);
    bar.remove();
  });
  actions.append(save, decline);
  bar.appendChild(actions);
  document.body.appendChild(bar);
};

/** Rebuilds the header, share bar and comments around a frame that stays. */
ArtifactsPanel.prototype.refreshViewerChrome = function refreshViewerChrome(a) {
  const viewer = this.container?.querySelector('.artifacts-viewer');
  if (!viewer) {
    this.render();
    return;
  }
  const served = this.servedVersionOf(a);
  const header = this.buildViewerHeader(a, served);
  const oldHeader = viewer.querySelector('.artifacts-header');
  if (oldHeader) oldHeader.replaceWith(header);
  else viewer.prepend(header);
  const oldBar = viewer.querySelector('.artifacts-share-bar');
  const share = this.manager.shareOf(a.id);
  if (share || this.shareError || this.sharePending === a.id) {
    const bar = this.renderShareBar(a, share);
    if (oldBar) oldBar.replaceWith(bar);
    else header.after(bar);
  } else if (oldBar) {
    oldBar.remove();
  }
  this.refreshComments();
};

/**
 * A page wants to ask the model. That spends the owner's own provider
 * quota, so the owner allows it once per artifact; the page's first call
 * waits for this answer.
 */
ArtifactsPanel.prototype.showConsentRequest = function showConsentRequest(req) {
  if (!req || !req.id) return;
  const existing = document.querySelector(
    `.artifacts-consent-bar[data-id="${req.id}"]`,
  );
  if (existing) return;
  const bar = el('div', 'artifacts-download-bar artifacts-consent-bar');
  bar.dataset.id = req.id;
  bar.appendChild(
    el(
      'span',
      'artifacts-download-text',
      `“${req.title}” wants to ask the model. That spends your own provider quota; allowing it applies to this artifact until you turn it off.`,
    ),
  );
  const actions = el('div', 'artifacts-comment-actions');
  const allow = el('button', 'artifacts-btn artifacts-btn--publish', 'Allow');
  allow.addEventListener('click', () => {
    this.manager.setSampleConsent(req.id, true);
    bar.remove();
  });
  const deny = el('button', 'artifacts-btn', 'Not now');
  deny.addEventListener('click', () => {
    this.manager.setSampleConsent(req.id, false);
    bar.remove();
  });
  actions.append(allow, deny);
  bar.appendChild(actions);
  document.body.appendChild(bar);
};
