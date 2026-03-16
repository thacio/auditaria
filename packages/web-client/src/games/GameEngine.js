/**
 * GameEngine — Base class for all Arcade mini-games.
 * Handles canvas setup, game loop, pause/resume, theme colors, and high scores.
 *
 * License: CC0 1.0 Universal (games adapted from straker's Basic HTML Games)
 */

const SCORES_KEY = 'auditaria-game-scores';

export class GameEngine {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts  — { gameId, width, height, fps }
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.gameId = opts.gameId || 'unknown';
        this.width = opts.width || 400;
        this.height = opts.height || 400;
        this.fps = opts.fps || 60;

        this.canvas.width = this.width;
        this.canvas.height = this.height;

        this.running = false;
        this.paused = false;
        this.gameOver = false;
        this.score = 0;
        this._rafId = null;
        this._lastTime = 0;
        this._frameInterval = 1000 / this.fps;

        // Keyboard state
        this._keys = {};
        this._keyDownHandler = (e) => this._onKeyDown(e);
        this._keyUpHandler = (e) => this._onKeyUp(e);

        this.colors = this.getThemeColors();
    }

    /** Read current CSS theme variables */
    getThemeColors() {
        const s = getComputedStyle(document.documentElement);
        const v = (name) => s.getPropertyValue(name).trim() || undefined;
        return {
            bg:        v('--surface')      || '#1a1713',
            primary:   v('--primary')      || '#f59e0b',
            accent:    v('--accent')       || '#f97316',
            accent2:   v('--accent-2')     || '#84cc16',
            text:      v('--text')         || '#f2ece6',
            textMuted: v('--text-muted')   || '#9c8f82',
            border:    v('--border')       || '#2f2820',
            success:   v('--success')      || '#22c55e',
            error:     v('--error')        || '#ef4444',
            warning:   v('--warning')      || '#f59e0b',
            surface:   v('--surface-alt')  || '#221d18',
        };
    }

    /** Refresh theme colors (call on theme change) */
    refreshTheme() {
        this.colors = this.getThemeColors();
    }

    // ─── Lifecycle ────────────────────────────────────────

    start() {
        this.running = true;
        this.paused = false;
        this.gameOver = false;
        this.score = 0;
        this._bindKeys();
        this.init();
        this._lastTime = performance.now();
        this._loop(this._lastTime);
    }

    pause() {
        if (!this.running || this.gameOver) return;
        this.paused = true;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    resume() {
        if (!this.running || !this.paused || this.gameOver) return;
        this.paused = false;
        this._lastTime = performance.now();
        this._loop(this._lastTime);
    }

    reset() {
        this.destroy();
        this.colors = this.getThemeColors();
        this.start();
    }

    destroy() {
        this.running = false;
        this.paused = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._unbindKeys();
    }

    // ─── Game loop ────────────────────────────────────────

    _loop(timestamp) {
        if (!this.running || this.paused) return;
        this._rafId = requestAnimationFrame((t) => this._loop(t));

        const delta = timestamp - this._lastTime;
        if (delta >= this._frameInterval) {
            this._lastTime = timestamp - (delta % this._frameInterval);
            this.update(delta);
            this.draw(this.ctx);
        }
    }

    // ─── Keyboard ─────────────────────────────────────────

    _bindKeys() {
        document.addEventListener('keydown', this._keyDownHandler, true);
        document.addEventListener('keyup', this._keyUpHandler, true);
    }

    _unbindKeys() {
        document.removeEventListener('keydown', this._keyDownHandler, true);
        document.removeEventListener('keyup', this._keyUpHandler, true);
        this._keys = {};
    }

    _onKeyDown(e) {
        if (!this.running || this.gameOver) return;
        // Capture game-relevant keys
        const gameKeys = [
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            ' ', 'Space', 'Enter', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
            'w', 'a', 's', 'd'
        ];
        if (gameKeys.includes(e.key) || gameKeys.includes(e.code)) {
            e.preventDefault();
            e.stopPropagation();
        }
        this._keys[e.key] = true;
        this.onKeyDown(e.key);
    }

    _onKeyUp(e) {
        this._keys[e.key] = false;
        this.onKeyUp(e.key);
    }

    isKeyDown(key) {
        return !!this._keys[key];
    }

    // ─── Score ────────────────────────────────────────────

    getHighScore() {
        try {
            const data = JSON.parse(localStorage.getItem(SCORES_KEY) || '{}');
            return data[this.gameId] || 0;
        } catch { return 0; }
    }

    _saveHighScore() {
        try {
            const data = JSON.parse(localStorage.getItem(SCORES_KEY) || '{}');
            if (this.score > (data[this.gameId] || 0)) {
                data[this.gameId] = this.score;
                localStorage.setItem(SCORES_KEY, JSON.stringify(data));
                return true; // new high score
            }
        } catch { /* ignore */ }
        return false;
    }

    /** Call from subclass when game is over */
    endGame() {
        this.gameOver = true;
        this.running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        const isNew = this._saveHighScore();
        this.onGameOver(this.score, isNew);
        this._drawGameOver(isNew);
    }

    _drawGameOver(isNewHigh) {
        const ctx = this.ctx;
        // Overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, this.width, this.height);

        ctx.textAlign = 'center';
        ctx.fillStyle = this.colors.text;
        ctx.font = 'bold 28px "Space Grotesk", sans-serif';
        ctx.fillText('GAME OVER', this.width / 2, this.height / 2 - 30);

        ctx.font = '18px "Space Grotesk", sans-serif';
        ctx.fillStyle = this.colors.primary;
        ctx.fillText(`Score: ${this.score}`, this.width / 2, this.height / 2 + 10);

        if (isNewHigh) {
            ctx.fillStyle = this.colors.success;
            ctx.font = '14px "Space Grotesk", sans-serif';
            ctx.fillText('New High Score!', this.width / 2, this.height / 2 + 40);
        }

        ctx.fillStyle = this.colors.textMuted;
        ctx.font = '13px "Space Grotesk", sans-serif';
        ctx.fillText('Press any key or click Restart', this.width / 2, this.height / 2 + 70);
    }

    // ─── Helpers ──────────────────────────────────────────

    /** Draw rounded rectangle */
    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // ─── Subclass hooks (override these) ──────────────────

    /** Called once at start — initialize game state */
    init() {}
    /** Called each frame — update game logic */
    update(/* delta */) {}
    /** Called each frame — draw to canvas */
    draw(/* ctx */) {}
    /** Called on keydown */
    onKeyDown(/* key */) {}
    /** Called on keyup */
    onKeyUp(/* key */) {}
    /** Called on game over */
    onGameOver(/* score, isNewHighScore */) {}
}
