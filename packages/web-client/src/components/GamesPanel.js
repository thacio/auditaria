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
        this._gameTitle = this.modal?.querySelector('.games-play-title');
        this._gameControls = this.modal?.querySelector('.games-play-controls');
        this._backBtn = this.modal?.querySelector('#games-back-btn');
        this._restartBtn = this.modal?.querySelector('#games-restart-btn');
        this._tabGames = this.modal?.querySelector('#games-tab-games');
        this._tabScores = this.modal?.querySelector('#games-tab-scores');

        this._expandedGame = null; // which game's top-10 is expanded in Scores tab

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
        this.closeBtn?.addEventListener('click', () => this.hide());
        this.backdrop?.addEventListener('click', () => this.hide());
        this._backBtn?.addEventListener('click', () => this._showLobby());
        this._restartBtn?.addEventListener('click', () => this._restartGame());

        this._tabGames?.addEventListener('click', () => this._switchTab('games'));
        this._tabScores?.addEventListener('click', () => this._switchTab('scores'));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal?.style.display !== 'none' && this.modal?.style.display) {
                if (this.view === 'game' && this.currentGame && this.currentGame.running && !this.currentGame.paused) {
                    this.currentGame.pause();
                    this._showPauseOverlay();
                } else if (this.view === 'game') {
                    this._showLobby();
                } else {
                    this.hide();
                }
                e.stopPropagation();
            }
        });
    }

    // ─── Modal ────────────────────────────────────────────

    show() {
        if (!this.modal) return;
        this.modal.style.display = 'block';
        setTimeout(() => this.modal.classList.add('show'), 10);
        if (this.activeTab === 'games' && this.view === 'lobby') this._renderLobby();
        if (this.activeTab === 'scores') this._renderLeaderboards();
    }

    hide() {
        if (!this.modal) return;
        if (this.currentGame && this.currentGame.running && !this.currentGame.paused) {
            this.currentGame.pause();
        }
        this.modal.classList.remove('show');
        setTimeout(() => { this.modal.style.display = 'none'; }, 300);
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
        if (this.currentGame) {
            this.currentGame.destroy();
            this.currentGame = null;
            this.currentGameId = null;
        }
        this._removePauseOverlay();
        this.view = 'lobby';
        if (this._lobbyContainer) this._lobbyContainer.style.display = '';
        if (this._gameContainer) this._gameContainer.style.display = 'none';
        this._renderLobby();
    }

    // ─── Games Tab: Game View ─────────────────────────────

    _startGame(gameId) {
        const entry = GAMES.find(g => g.id === gameId);
        if (!entry || !this._gameCanvas) return;

        this._switchTab('games');
        this.view = 'game';
        this.currentGameId = gameId;
        if (this._lobbyContainer) this._lobbyContainer.style.display = 'none';
        if (this._gameContainer) this._gameContainer.style.display = 'flex';

        if (this._gameTitle) this._gameTitle.textContent = entry.name;
        if (this._gameControls) this._gameControls.textContent = entry.controls;

        this.currentGame = entry.create(this._gameCanvas);
        this.currentGame.start();
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
}
