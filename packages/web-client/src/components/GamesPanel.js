/**
 * GamesPanel — Arcade modal with game lobby and game view.
 * Follows the same ModalManager pattern used by slash-commands and MCP modals.
 */

import { GAMES } from '../games/index.js';

const SCORES_KEY = 'auditaria-game-scores';

export class GamesPanel {
    constructor() {
        this.modal = document.getElementById('games-modal');
        this.backdrop = document.getElementById('games-backdrop');
        this.closeBtn = document.getElementById('games-close');
        this.button = document.getElementById('games-button');

        /** @type {import('../games/GameEngine.js').GameEngine | null} */
        this.currentGame = null;
        this.currentGameId = null;
        this.view = 'lobby'; // 'lobby' | 'game'

        this._lobbyContainer = this.modal?.querySelector('.games-lobby');
        this._gameContainer = this.modal?.querySelector('.games-play-area');
        this._gameCanvas = this.modal?.querySelector('#games-canvas');
        this._gameTitle = this.modal?.querySelector('.games-play-title');
        this._gameControls = this.modal?.querySelector('.games-play-controls');
        this._backBtn = this.modal?.querySelector('#games-back-btn');
        this._restartBtn = this.modal?.querySelector('#games-restart-btn');

        this._setupHandlers();
        this._renderLobby();

        // Listen for theme changes to refresh game colors
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

        // ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal?.style.display !== 'none' && this.modal?.style.display) {
                if (this.view === 'game' && this.currentGame && this.currentGame.running && !this.currentGame.paused) {
                    // Pause the game, show pause overlay
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

    show() {
        if (!this.modal) return;
        this.modal.style.display = 'block';
        setTimeout(() => this.modal.classList.add('show'), 10);

        if (this.view === 'game' && this.currentGame && this.currentGame.paused) {
            // Don't auto-resume — user must click "Resume"
        }
    }

    hide() {
        if (!this.modal) return;
        // Pause game if running
        if (this.currentGame && this.currentGame.running && !this.currentGame.paused) {
            this.currentGame.pause();
        }
        this.modal.classList.remove('show');
        setTimeout(() => { this.modal.style.display = 'none'; }, 300);
    }

    // ─── Lobby ────────────────────────────────────────────

    _renderLobby() {
        if (!this._lobbyContainer) return;
        const scores = this._getScores();

        this._lobbyContainer.innerHTML = GAMES.map(game => `
            <button class="game-card" data-game-id="${game.id}">
                <div class="game-card-icon">${game.icon}</div>
                <div class="game-card-info">
                    <div class="game-card-name">${game.name}</div>
                    <div class="game-card-tagline">${game.tagline}</div>
                </div>
                ${scores[game.id] ? `<div class="game-card-score">${scores[game.id]}</div>` : ''}
            </button>
        `).join('');

        // Card click handlers
        this._lobbyContainer.querySelectorAll('.game-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = card.dataset.gameId;
                this._startGame(id);
            });
        });
    }

    _showLobby() {
        // Destroy current game
        if (this.currentGame) {
            this.currentGame.destroy();
            this.currentGame = null;
            this.currentGameId = null;
        }
        this._removePauseOverlay();
        this.view = 'lobby';
        if (this._lobbyContainer) this._lobbyContainer.style.display = '';
        if (this._gameContainer) this._gameContainer.style.display = 'none';
        this._renderLobby(); // Refresh scores
    }

    // ─── Game View ────────────────────────────────────────

    _startGame(gameId) {
        const entry = GAMES.find(g => g.id === gameId);
        if (!entry || !this._gameCanvas) return;

        this.view = 'game';
        this.currentGameId = gameId;
        if (this._lobbyContainer) this._lobbyContainer.style.display = 'none';
        if (this._gameContainer) this._gameContainer.style.display = 'flex';

        // Title and controls
        if (this._gameTitle) this._gameTitle.textContent = entry.name;
        if (this._gameControls) this._gameControls.textContent = entry.controls;

        // Create and start game
        this.currentGame = entry.create(this._gameCanvas);
        this.currentGame.onGameOver = (score, isNew) => {
            // Refresh lobby scores when we go back
        };
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
            </div>
        `;

        overlay.querySelector('.games-resume-btn').addEventListener('click', () => {
            this._removePauseOverlay();
            if (this.currentGame) this.currentGame.resume();
        });
        overlay.querySelector('.games-quit-btn').addEventListener('click', () => {
            this._showLobby();
        });

        this._gameContainer.appendChild(overlay);
    }

    _removePauseOverlay() {
        if (!this._gameContainer) return;
        const existing = this._gameContainer.querySelector('.games-pause-overlay');
        if (existing) existing.remove();
    }

    // ─── Scores ───────────────────────────────────────────

    _getScores() {
        try { return JSON.parse(localStorage.getItem(SCORES_KEY) || '{}'); }
        catch { return {}; }
    }
}
