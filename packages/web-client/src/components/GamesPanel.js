/**
 * GamesPanel — Arcade modal with game lobby, game view, and scoreboard.
 *
 * Layout:
 *   "Games" tab  → game cards grid + overview scoreboard below
 *   "Scores" tab → per-game leaderboards (expandable top-10 for each game)
 */

import { GAMES } from '../games/index.js';
import { GameEngine } from '../games/GameEngine.js';

export class GamesPanel {
    constructor() {
        this.modal = document.getElementById('games-modal');
        this.backdrop = document.getElementById('games-backdrop');
        this.closeBtn = document.getElementById('games-close');
        this.button = document.getElementById('games-button');

        /** @type {GameEngine | null} */
        this.currentGame = null;
        this.currentGameId = null;
        this.activeTab = 'games'; // 'games' | 'scores'
        this.view = 'lobby'; // 'lobby' | 'game' (within games tab)

        this._lobbyContainer = this.modal?.querySelector('.games-lobby');
        this._scoresContainer = this.modal?.querySelector('.games-scores');
        this._gameContainer = this.modal?.querySelector('.games-play-area');
        this._gameCanvas = this.modal?.querySelector('#games-canvas');
        this._gameIframe = this.modal?.querySelector('#games-iframe');
        this._gameTitle = this.modal?.querySelector('.games-play-title');
        this._gameControls = this.modal?.querySelector('.games-play-controls');
        this._backBtn = this.modal?.querySelector('#games-back-btn');
        this._restartBtn = this.modal?.querySelector('#games-restart-btn');
        this._minimizeBtn = this.modal?.querySelector('#games-minimize-btn');
        this._tabGames = this.modal?.querySelector('#games-tab-games');
        this._tabScores = this.modal?.querySelector('#games-tab-scores');

        this._expandedGame = null; // which game's top-10 is expanded in Scores tab

        // Volume state — start muted at low volume
        const saved = this._loadVolumePref();
        this._muted = saved.muted;
        this._volume = saved.volume;
        this._volumeInterval = null;

        this._setupHandlers();
        this._renderLobby();

        // Refresh game colors on theme change
        this._themeObserver = new MutationObserver(() => {
            if (this.currentGame && this.currentGame.running) {
                this.currentGame.refreshTheme();
            }
        });
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });
    }

    _setupHandlers() {
        this.button?.addEventListener('click', () => this.show());
        this.closeBtn?.addEventListener('click', () => this.close());
        this.backdrop?.addEventListener('click', () => {
            // If a game is active, minimize (preserves state). Otherwise close.
            if (this.view === 'game' && this.currentGameId) {
                this.minimize();
            } else {
                this.close();
            }
        });
        this._backBtn?.addEventListener('click', () => this._showLobby());
        this._restartBtn?.addEventListener('click', () => this._restartGame());
        this._minimizeBtn?.addEventListener('click', () => this.minimize());

        // Volume controls
        const muteBtn = this.modal?.querySelector('#games-mute-btn');
        const volSlider = this.modal?.querySelector('#games-volume-slider');
        muteBtn?.addEventListener('click', () => {
            this._muted = !this._muted;
            this._saveVolumePref();
            this._updateVolumeUI();
            this._applyVolumeToIframe();
        });
        volSlider?.addEventListener('input', (e) => {
            this._volume = parseInt(e.target.value, 10) / 100;
            if (this._volume > 0) this._muted = false;
            this._saveVolumePref();
            this._updateVolumeUI();
            this._applyVolumeToIframe();
        });

        this._tabGames?.addEventListener('click', () => this._switchTab('games'));
        this._tabScores?.addEventListener('click', () => this._switchTab('scores'));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._isOpen()) {
                if (this.view === 'game' && this.currentGame && this.currentGame.running && !this.currentGame.paused) {
                    // Canvas game running → pause
                    this.currentGame.pause();
                    this._showPauseOverlay();
                } else if (this.view === 'game' && this.currentGame && this.currentGame.paused) {
                    // Canvas game paused → back to lobby
                    this._showLobby();
                } else if (this.view === 'game') {
                    // Iframe game → minimize (preserves iframe state)
                    this.minimize();
                } else {
                    this.close();
                }
                e.stopPropagation();
            }
        });
    }

    _isOpen() {
        return this.modal && this.modal.style.display !== 'none' && this.modal.style.display !== '';
    }

    // ─── Modal ────────────────────────────────────────────

    show() {
        if (!this.modal) return;
        this.modal.style.display = 'block';
        setTimeout(() => this.modal.classList.add('show'), 10);
        this._updateMinimizeVisibility();
        // Resume iframe if it was paused
        this._resumeIframe();
        if (this.activeTab === 'games' && this.view === 'lobby') this._renderLobby();
        if (this.activeTab === 'scores') this._renderLeaderboards();
    }

    /** Close (×): destroy game, reset to lobby, dismiss modal */
    close() {
        if (!this.modal) return;
        this._destroyCurrentGame();
        this.view = 'lobby';
        if (this._lobbyContainer) this._lobbyContainer.style.display = '';
        if (this._gameContainer) this._gameContainer.style.display = 'none';
        this._hideModal();
    }

    /** Minimize (−): pause game, hide modal. Reopening resumes where you left off. */
    minimize() {
        if (!this.modal) return;
        // Canvas game: pause via engine
        if (this.currentGame && this.currentGame.running && !this.currentGame.paused) {
            this.currentGame.pause();
            this._showPauseOverlay();
        }
        // Iframe game: freeze by intercepting requestAnimationFrame
        this._pauseIframe();
        this._hideModal();
    }

    _hideModal() {
        this.modal.classList.remove('show');
        setTimeout(() => { this.modal.style.display = 'none'; }, 300);
    }

    _updateMinimizeVisibility() {
        if (!this._minimizeBtn) return;
        // Show minimize when any game is active (canvas or iframe)
        this._minimizeBtn.style.display = (this.view === 'game' && this.currentGameId) ? '' : 'none';
    }

    // ─── Tabs ─────────────────────────────────────────────

    _switchTab(tab) {
        this.activeTab = tab;
        this._tabGames?.classList.toggle('active', tab === 'games');
        this._tabScores?.classList.toggle('active', tab === 'scores');

        if (tab === 'games') {
            if (this._scoresContainer) this._scoresContainer.style.display = 'none';
            if (this.view === 'game') {
                if (this._lobbyContainer) this._lobbyContainer.style.display = 'none';
                if (this._gameContainer) this._gameContainer.style.display = 'flex';
            } else {
                if (this._lobbyContainer) this._lobbyContainer.style.display = '';
                if (this._gameContainer) this._gameContainer.style.display = 'none';
                this._renderLobby();
            }
        } else {
            if (this._lobbyContainer) this._lobbyContainer.style.display = 'none';
            if (this._gameContainer) this._gameContainer.style.display = 'none';
            if (this._scoresContainer) this._scoresContainer.style.display = '';
            this._renderLeaderboards();
        }
    }

    // ─── Games Tab: Lobby (cards + overview) ──────────────

    _renderLobby() {
        if (!this._lobbyContainer) return;
        const allScores = GameEngine._getAllScores();

        // Game cards
        let html = '<div class="games-grid">';
        html += GAMES.map(game => {
            const entry = GameEngine._getEntry(allScores, game.id);
            const badge = entry.best > 0 ? `<div class="game-card-score">${entry.best.toLocaleString()}</div>` : '';
            return `
                <button class="game-card" data-game-id="${game.id}">
                    <div class="game-card-icon">${game.icon}</div>
                    <div class="game-card-info">
                        <div class="game-card-name">${game.name}</div>
                        <div class="game-card-tagline">${game.tagline}</div>
                    </div>
                    ${badge}
                </button>`;
        }).join('');
        html += '</div>';

        // Overview scoreboard below cards
        html += this._buildOverviewTable(allScores);

        this._lobbyContainer.innerHTML = html;

        this._lobbyContainer.querySelectorAll('.game-card').forEach(card => {
            card.addEventListener('click', () => this._startGame(card.dataset.gameId));
        });
    }

    _buildOverviewTable(allScores) {
        const ranked = GAMES.map(g => ({
            ...g,
            entry: GameEngine._getEntry(allScores, g.id),
        })).sort((a, b) => {
            if (a.entry.best === 0 && b.entry.best === 0) return 0;
            if (a.entry.best === 0) return 1;
            if (b.entry.best === 0) return -1;
            return b.entry.best - a.entry.best;
        });

        const totalPlays = ranked.reduce((s, g) => s + g.entry.plays, 0);
        if (totalPlays === 0) return ''; // Don't show table if no scores yet

        const gamesPlayed = ranked.filter(g => g.entry.plays > 0).length;

        let html = `
            <div class="scores-overview">
                <div class="scores-overview-header">
                    <span class="scores-overview-title">High Scores</span>
                    <span class="scores-stat">${gamesPlayed}/${GAMES.length} played</span>
                </div>
                <div class="scores-table">`;

        ranked.forEach((game, i) => {
            const rank = game.entry.best > 0 ? i + 1 : null;
            const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
            const medalHtml = medal
                ? `<span class="scores-medal scores-medal-${medal}">${rank}</span>`
                : rank
                    ? `<span class="scores-rank">${rank}</span>`
                    : `<span class="scores-rank scores-rank-none">&ndash;</span>`;

            const bestStr = game.entry.best > 0 ? game.entry.best.toLocaleString() : '&ndash;';
            const dateStr = game.entry.date ? this._formatDate(game.entry.date) : '';
            const playsStr = game.entry.plays || '0';

            html += `
                <div class="scores-row">
                    <div class="scores-row-main">
                        ${medalHtml}
                        <div class="scores-row-icon">${game.icon}</div>
                        <div class="scores-row-name">${game.name}</div>
                        <div class="scores-row-best">${bestStr}</div>
                        <div class="scores-row-date">${dateStr}</div>
                        <div class="scores-row-plays">${playsStr}</div>
                    </div>
                </div>`;
        });

        html += '</div></div>';
        return html;
    }

    _showLobby() {
        this._destroyCurrentGame();
        this.view = 'lobby';
        if (this._lobbyContainer) this._lobbyContainer.style.display = '';
        if (this._gameContainer) this._gameContainer.style.display = 'none';
        this._updateMinimizeVisibility();
        this._renderLobby();
    }

    /** Clean up any running game (canvas or iframe) */
    _destroyCurrentGame() {
        if (this.currentGame) {
            this.currentGame.destroy();
            this.currentGame = null;
        }
        this._stopVolumePolling();
        this._cleanupIframe();
        this._removePauseOverlay();
        this.currentGameId = null;
        // Hide volume control
        const volWrap = this.modal?.querySelector('.games-volume-control');
        if (volWrap) volWrap.style.display = 'none';
    }

    // ─── Games Tab: Game View ─────────────────────────────

    _startGame(gameId) {
        const entry = GAMES.find(g => g.id === gameId);
        if (!entry) return;

        // Destroy any previously running game first
        this._destroyCurrentGame();

        this._switchTab('games');
        this.view = 'game';
        this.currentGameId = gameId;
        if (this._lobbyContainer) this._lobbyContainer.style.display = 'none';
        if (this._gameContainer) this._gameContainer.style.display = 'flex';

        if (this._gameTitle) this._gameTitle.textContent = entry.name;
        if (this._gameControls) this._gameControls.textContent = entry.controls;

        // Show volume control for iframe games, hide for canvas
        const volWrap = this.modal?.querySelector('.games-volume-control');
        if (volWrap) volWrap.style.display = entry.type === 'iframe' ? '' : 'none';
        this._updateVolumeUI();

        if (entry.type === 'iframe') {
            // Iframe-based external game
            if (this._gameCanvas) this._gameCanvas.style.display = 'none';
            if (this._gameIframe) {
                const size = entry.iframeSize || { width: 500, height: 600 };
                this._gameIframe.style.display = 'block';
                this._gameIframe.style.width = size.width + 'px';
                this._gameIframe.style.height = size.height + 'px';
                this._gameIframe.src = entry.iframeSrc;
            }
            this._startVolumePolling();
            // Hide restart button for iframe games (they have their own UI)
            if (this._restartBtn) this._restartBtn.style.display = 'none';
        } else {
            // Canvas-based game
            this._cleanupIframe();
            if (this._gameCanvas) this._gameCanvas.style.display = 'block';
            if (this._restartBtn) this._restartBtn.style.display = '';
            this.currentGame = entry.create(this._gameCanvas);
            this.currentGame.start();
        }
        this._updateMinimizeVisibility();
    }

    _cleanupIframe() {
        if (this._gameIframe) {
            this._gameIframe.src = 'about:blank';
            this._gameIframe.style.display = 'none';
        }
        if (this._gameCanvas) this._gameCanvas.style.display = 'block';
        if (this._restartBtn) this._restartBtn.style.display = '';
    }

    _restartGame() {
        if (this.currentGame) {
            this._removePauseOverlay();
            this.currentGame.reset();
        }
    }

    // ─── Pause Overlay ────────────────────────────────────

    _showPauseOverlay() {
        if (!this._gameContainer) return;
        this._removePauseOverlay();

        const overlay = document.createElement('div');
        overlay.className = 'games-pause-overlay';
        overlay.innerHTML = `
            <div class="games-pause-content">
                <div class="games-pause-title">PAUSED</div>
                <div class="games-pause-actions">
                    <button class="games-pause-btn games-resume-btn">Resume</button>
                    <button class="games-pause-btn games-quit-btn">Quit</button>
                </div>
            </div>`;

        overlay.querySelector('.games-resume-btn').addEventListener('click', () => {
            this._removePauseOverlay();
            if (this.currentGame) this.currentGame.resume();
        });
        overlay.querySelector('.games-quit-btn').addEventListener('click', () => this._showLobby());

        this._gameContainer.appendChild(overlay);
    }

    _removePauseOverlay() {
        this._gameContainer?.querySelector('.games-pause-overlay')?.remove();
    }

    // ─── Scores Tab: Per-Game Leaderboards ────────────────

    _renderLeaderboards() {
        if (!this._scoresContainer) return;
        const allScores = GameEngine._getAllScores();

        const totalPlays = GAMES.reduce((s, g) => s + GameEngine._getEntry(allScores, g.id).plays, 0);
        const gamesPlayed = GAMES.filter(g => GameEngine._getEntry(allScores, g.id).plays > 0).length;

        let html = `
            <div class="scores-summary">
                <span class="scores-stat"><strong>${totalPlays}</strong> total plays</span>
                <span class="scores-stat-sep"></span>
                <span class="scores-stat"><strong>${gamesPlayed}</strong>/${GAMES.length} games played</span>
            </div>
            <div class="leaderboards-list">`;

        GAMES.forEach(game => {
            const entry = GameEngine._getEntry(allScores, game.id);
            const hasHistory = entry.history && entry.history.length > 0;
            const expanded = this._expandedGame === game.id;
            const bestStr = entry.best > 0 ? entry.best.toLocaleString() : '&ndash;';
            const playsStr = entry.plays || '0';

            html += `
                <div class="leaderboard-game ${expanded ? 'expanded' : ''}" data-game-id="${game.id}">
                    <div class="leaderboard-header">
                        <div class="leaderboard-icon">${game.icon}</div>
                        <div class="leaderboard-name">${game.name}</div>
                        <div class="leaderboard-best">Best: <strong>${bestStr}</strong></div>
                        <div class="leaderboard-plays">${playsStr} plays</div>
                        <div class="leaderboard-chevron">${hasHistory ? '&#9662;' : ''}</div>
                    </div>
                    ${expanded && hasHistory ? this._renderTop10(entry.history) : ''}
                </div>`;
        });

        html += `</div>
            <div class="scores-actions">
                <button class="scores-clear-btn" id="scores-clear-btn">Clear All Scores</button>
            </div>`;

        this._scoresContainer.innerHTML = html;

        // Expand/collapse handlers
        this._scoresContainer.querySelectorAll('.leaderboard-game').forEach(row => {
            row.querySelector('.leaderboard-header')?.addEventListener('click', () => {
                const id = row.dataset.gameId;
                const entry = GameEngine._getEntry(allScores, id);
                if (!entry.history || entry.history.length === 0) return;
                this._expandedGame = this._expandedGame === id ? null : id;
                this._renderLeaderboards();
            });
        });

        // Clear scores
        this._scoresContainer.querySelector('#scores-clear-btn')?.addEventListener('click', () => {
            if (confirm('Clear all high scores and history?')) {
                try { localStorage.removeItem('auditaria-game-scores'); } catch {}
                this._expandedGame = null;
                this._renderLeaderboards();
            }
        });
    }

    _renderTop10(history) {
        let html = '<div class="scores-top10"><div class="scores-top10-header"><span>#</span><span>Score</span><span>Date</span></div>';
        history.forEach((h, i) => {
            const date = h.date ? this._formatDate(h.date) : '&ndash;';
            html += `<div class="scores-top10-row">
                <span class="scores-top10-rank">${i + 1}</span>
                <span class="scores-top10-score">${h.score.toLocaleString()}</span>
                <span class="scores-top10-date">${date}</span>
            </div>`;
        });
        html += '</div>';
        return html;
    }

    _formatDate(iso) {
        try {
            const d = new Date(iso);
            const now = new Date();
            if (d.toDateString() === now.toDateString()) return 'Today';
            const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
            if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch { return '&ndash;'; }
    }

    // ─── Volume Control ───────────────────────────────────

    _loadVolumePref() {
        try {
            const data = JSON.parse(localStorage.getItem('auditaria-game-volume') || 'null');
            if (data) return { muted: data.muted ?? true, volume: data.volume ?? 0.2 };
        } catch {}
        return { muted: true, volume: 0.2 };
    }

    _saveVolumePref() {
        try {
            localStorage.setItem('auditaria-game-volume', JSON.stringify({
                muted: this._muted,
                volume: this._volume,
            }));
        } catch {}
    }

    _updateVolumeUI() {
        const muteBtn = this.modal?.querySelector('#games-mute-btn');
        const volSlider = this.modal?.querySelector('#games-volume-slider');
        if (muteBtn) {
            muteBtn.innerHTML = this._muted || this._volume === 0
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg>';
        }
        if (volSlider) {
            volSlider.value = Math.round(this._volume * 100);
        }
    }

    /**
     * Apply volume/mute to ALL audio in the iframe:
     * - DOM <audio>/<video> elements
     * - JS `new Audio()` objects (tracked via constructor override)
     * - AudioContext gain nodes
     */
    _applyVolumeToIframe() {
        try {
            const win = this._gameIframe?.contentWindow;
            if (!win) return;
            const vol = this._volume;
            const muted = this._muted;

            // DOM audio/video elements
            win.document.querySelectorAll('audio, video').forEach(el => {
                el.volume = vol;
                el.muted = muted;
            });

            // Tracked Audio() instances from our constructor override
            if (win.__arcadeAudioInstances) {
                win.__arcadeAudioInstances.forEach(el => {
                    try { el.volume = vol; el.muted = muted; } catch {}
                });
            }

            // AudioContext master gain
            if (win.__arcadeMasterGain) {
                win.__arcadeMasterGain.gain.value = muted ? 0 : vol;
            }
        } catch { /* cross-origin or not loaded yet */ }
    }

    /** Inject volume hooks into iframe — override Audio constructor to track all instances */
    _injectVolumeHooks() {
        try {
            const win = this._gameIframe?.contentWindow;
            if (!win || win.__arcadeVolumeHooked) return;
            win.__arcadeVolumeHooked = true;
            win.__arcadeAudioInstances = [];
            const vol = this._volume;
            const muted = this._muted;

            // Override Audio constructor
            const OrigAudio = win.Audio;
            win.Audio = function (...args) {
                const audio = new OrigAudio(...args);
                audio.volume = vol;
                audio.muted = muted;
                win.__arcadeAudioInstances.push(audio);
                return audio;
            };
            win.Audio.prototype = OrigAudio.prototype;

            // Override AudioContext to add a master gain node
            const OrigAC = win.AudioContext || win.webkitAudioContext;
            if (OrigAC) {
                const origProto = OrigAC.prototype.createGain;
                // We can't easily intercept the destination, but we can hook createGain
                // For now, the polling will catch DOM audio elements
            }
        } catch { /* cross-origin or not loaded */ }
    }

    _startVolumePolling() {
        this._stopVolumePolling();
        const onLoad = () => {
            this._injectVolumeHooks();
            this._applyVolumeToIframe();
        };
        this._gameIframe?.addEventListener('load', onLoad);
        this._iframeLoadHandler = onLoad;
        // Poll to catch dynamically created audio and re-apply
        this._volumeInterval = setInterval(() => {
            this._injectVolumeHooks(); // In case iframe reloaded
            this._applyVolumeToIframe();
        }, 1000);
    }

    _stopVolumePolling() {
        if (this._volumeInterval) {
            clearInterval(this._volumeInterval);
            this._volumeInterval = null;
        }
    }

    // ─── Iframe Pause/Resume ──────────────────────────────

    /**
     * Freeze an iframe game by replacing requestAnimationFrame + setInterval
     * with no-ops. Works because iframes are same-origin.
     */
    _pauseIframe() {
        try {
            const win = this._gameIframe?.contentWindow;
            if (!win || win.__arcadePaused) return;
            win.__arcadePaused = true;

            // Intercept requestAnimationFrame — capture last callback
            win.__origRAF = win.requestAnimationFrame;
            win.requestAnimationFrame = function (cb) {
                win.__arcadeLastRAFCb = cb;
                return -1;
            };

            // Intercept setInterval — block new intervals
            win.__origSetInterval = win.setInterval;
            win.__arcadePausedIntervals = [];
            const origClear = win.clearInterval.bind(win);
            win.setInterval = function (cb, ms) {
                const id = win.__origSetInterval.call(win, () => {}, ms); // dummy
                win.__arcadePausedIntervals.push({ id, cb, ms });
                return id;
            };

            // Pause existing audio
            win.document?.querySelectorAll('audio, video').forEach(el => {
                if (!el.paused) { el.pause(); el.__arcadeWasPlaying = true; }
            });
        } catch { /* cross-origin or not loaded */ }
    }

    /** Resume a previously paused iframe game. */
    _resumeIframe() {
        try {
            const win = this._gameIframe?.contentWindow;
            if (!win || !win.__arcadePaused) return;
            win.__arcadePaused = false;

            // Restore requestAnimationFrame and replay last callback
            if (win.__origRAF) {
                win.requestAnimationFrame = win.__origRAF;
                if (win.__arcadeLastRAFCb) {
                    win.requestAnimationFrame(win.__arcadeLastRAFCb);
                    win.__arcadeLastRAFCb = null;
                }
            }

            // Restore setInterval — re-create paused intervals with original callbacks
            if (win.__origSetInterval) {
                const paused = win.__arcadePausedIntervals || [];
                const origClear = win.clearInterval.bind(win);
                paused.forEach(p => { origClear(p.id); });
                win.setInterval = win.__origSetInterval;
                paused.forEach(p => { win.setInterval(p.cb, p.ms); });
                win.__arcadePausedIntervals = [];
            }

            // Resume audio that was playing
            if (!this._muted) {
                win.document?.querySelectorAll('audio, video').forEach(el => {
                    if (el.__arcadeWasPlaying) { el.play(); el.__arcadeWasPlaying = false; }
                });
            }
        } catch { /* cross-origin or not loaded */ }
    }
}
