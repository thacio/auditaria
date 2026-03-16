/**
 * Bomberman — Maze bombing game.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const GRID = 32;
const COLS = 13;
const ROWS = 11;

// 0=empty, 1=wall(indestructible), 2=brick(destructible)
function generateMap() {
    const map = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    // Borders and pillars
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
                map[r][c] = 1;
            } else if (r % 2 === 0 && c % 2 === 0) {
                map[r][c] = 1; // pillars
            } else if (Math.random() < 0.35) {
                map[r][c] = 2; // bricks
            }
        }
    }
    // Clear spawn area (top-left)
    map[1][1] = 0; map[1][2] = 0; map[2][1] = 0;
    return map;
}

export class BombermanGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'bomberman', width: COLS * GRID, height: ROWS * GRID + 30, fps: 60 });
    }

    init() {
        this.map = generateMap();
        this.score = 0;
        this.lives = 3;
        this.player = { x: 1, y: 1, moving: false };
        this.bombs = [];
        this.explosions = [];
        this.enemies = [];
        this.bombPower = 2;
        this.maxBombs = 1;
        this.bombCooldown = 0;
        this.moveCooldown = 0;

        // Place enemies
        const empties = [];
        for (let r = 1; r < ROWS - 1; r++) {
            for (let c = 1; c < COLS - 1; c++) {
                if (this.map[r][c] === 0 && (r > 2 || c > 2)) {
                    empties.push({ x: c, y: r });
                }
            }
        }
        for (let i = 0; i < 3 && empties.length; i++) {
            const idx = Math.floor(Math.random() * empties.length);
            const pos = empties.splice(idx, 1)[0];
            this.enemies.push({
                x: pos.x, y: pos.y,
                px: pos.x * GRID, py: pos.y * GRID,
                dir: ['up', 'down', 'left', 'right'][Math.floor(Math.random() * 4)],
                speed: 0.8 + Math.random() * 0.4,
                moveTimer: 0,
            });
        }
    }

    onKeyDown(key) {
        if (key === ' ') {
            this._placeBomb();
        }
    }

    _placeBomb() {
        if (this.bombs.length >= this.maxBombs) return;
        const { x, y } = this.player;
        if (this.bombs.some(b => b.x === x && b.y === y)) return;
        this.bombs.push({ x, y, timer: 180, power: this.bombPower }); // 3 seconds at 60fps
    }

    _explode(bomb) {
        const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        this.explosions.push({ x: bomb.x, y: bomb.y, timer: 30 });

        for (const [dx, dy] of dirs) {
            for (let i = 1; i <= bomb.power; i++) {
                const nx = bomb.x + dx * i;
                const ny = bomb.y + dy * i;
                if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) break;
                if (this.map[ny][nx] === 1) break;
                if (this.map[ny][nx] === 2) {
                    this.map[ny][nx] = 0;
                    this.score += 10;
                    this.explosions.push({ x: nx, y: ny, timer: 30 });
                    break;
                }
                this.explosions.push({ x: nx, y: ny, timer: 30 });
            }
        }

        // Kill enemies in explosion
        this.enemies = this.enemies.filter(e => {
            const hit = this.explosions.some(ex => ex.x === Math.round(e.x) && ex.y === Math.round(e.y));
            if (hit) this.score += 50;
            return !hit;
        });

        // Player hit?
        if (this.explosions.some(ex => ex.x === this.player.x && ex.y === this.player.y)) {
            this.lives--;
            if (this.lives <= 0) return this.endGame();
            this.player.x = 1;
            this.player.y = 1;
        }
    }

    update() {
        // Player movement (grid-based with cooldown)
        if (this.moveCooldown > 0) {
            this.moveCooldown--;
        } else {
            let tx = this.player.x;
            let ty = this.player.y;

            if (this.isKeyDown('ArrowUp') || this.isKeyDown('w')) ty--;
            else if (this.isKeyDown('ArrowDown') || this.isKeyDown('s')) ty++;
            else if (this.isKeyDown('ArrowLeft') || this.isKeyDown('a')) tx--;
            else if (this.isKeyDown('ArrowRight') || this.isKeyDown('d')) tx++;

            if (tx !== this.player.x || ty !== this.player.y) {
                if (tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS && this.map[ty][tx] === 0) {
                    if (!this.bombs.some(b => b.x === tx && b.y === ty)) {
                        this.player.x = tx;
                        this.player.y = ty;
                        this.moveCooldown = 8; // ~130ms at 60fps
                    }
                }
            }
        }

        // Bombs
        for (let i = this.bombs.length - 1; i >= 0; i--) {
            this.bombs[i].timer--;
            if (this.bombs[i].timer <= 0) {
                this._explode(this.bombs[i]);
                this.bombs.splice(i, 1);
            }
        }

        // Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            this.explosions[i].timer--;
            if (this.explosions[i].timer <= 0) {
                this.explosions.splice(i, 1);
            }
        }

        // Enemies (simple random movement)
        for (const enemy of this.enemies) {
            enemy.moveTimer--;
            if (enemy.moveTimer <= 0) {
                enemy.moveTimer = 30 + Math.floor(Math.random() * 30);
                const dirs = ['up', 'down', 'left', 'right'];
                // Try current direction first, then random
                const tryDirs = [enemy.dir, ...dirs.sort(() => Math.random() - 0.5)];
                for (const d of tryDirs) {
                    let nx = Math.round(enemy.x), ny = Math.round(enemy.y);
                    if (d === 'up') ny--;
                    else if (d === 'down') ny++;
                    else if (d === 'left') nx--;
                    else if (d === 'right') nx++;
                    if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && this.map[ny][nx] === 0) {
                        enemy.dir = d;
                        enemy.x = nx;
                        enemy.y = ny;
                        break;
                    }
                }
            }

            // Enemy touches player?
            if (Math.round(enemy.x) === this.player.x && Math.round(enemy.y) === this.player.y) {
                this.lives--;
                if (this.lives <= 0) return this.endGame();
                this.player.x = 1;
                this.player.y = 1;
            }
        }

        // Win: all enemies dead
        if (this.enemies.length === 0) {
            this.score += 200;
            this.endGame();
        }
    }

    draw(ctx) {
        const c = this.colors;
        const HUD_H = 30;

        // HUD background
        ctx.fillStyle = c.surface;
        ctx.fillRect(0, 0, this.width, HUD_H);

        ctx.fillStyle = c.text;
        ctx.font = '13px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${this.score}`, 8, 20);
        ctx.textAlign = 'center';
        ctx.fillText(`Bombs: ${this.maxBombs - this.bombs.length}/${this.maxBombs}`, this.width / 2, 20);
        ctx.textAlign = 'right';
        ctx.fillText(`Lives: ${'●'.repeat(Math.max(0, this.lives))}`, this.width - 8, 20);

        // Map
        ctx.save();
        ctx.translate(0, HUD_H);

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, COLS * GRID, ROWS * GRID);

        for (let r = 0; r < ROWS; r++) {
            for (let col = 0; col < COLS; col++) {
                const cell = this.map[r][col];
                if (cell === 1) {
                    ctx.fillStyle = c.border;
                    ctx.fillRect(col * GRID, r * GRID, GRID, GRID);
                } else if (cell === 2) {
                    ctx.fillStyle = c.surface;
                    this.roundRect(ctx, col * GRID + 1, r * GRID + 1, GRID - 2, GRID - 2, 3);
                    ctx.fill();
                    ctx.strokeStyle = c.border;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
        }

        // Explosions
        for (const ex of this.explosions) {
            const alpha = ex.timer / 30;
            ctx.fillStyle = `rgba(239, 68, 68, ${alpha * 0.7})`;
            ctx.fillRect(ex.x * GRID + 2, ex.y * GRID + 2, GRID - 4, GRID - 4);
        }

        // Bombs
        for (const bomb of this.bombs) {
            const pulse = Math.sin(bomb.timer * 0.2) * 0.15 + 0.85;
            const size = GRID * 0.6 * pulse;
            const off = (GRID - size) / 2;
            ctx.fillStyle = c.warning;
            ctx.beginPath();
            ctx.arc(bomb.x * GRID + GRID / 2, bomb.y * GRID + GRID / 2, size / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Enemies
        for (const enemy of this.enemies) {
            ctx.fillStyle = c.error;
            this.roundRect(ctx, enemy.x * GRID + 3, enemy.y * GRID + 3, GRID - 6, GRID - 6, 6);
            ctx.fill();
            // Evil eyes
            ctx.fillStyle = c.bg;
            ctx.beginPath(); ctx.arc(enemy.x * GRID + 11, enemy.y * GRID + 14, 3, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(enemy.x * GRID + 21, enemy.y * GRID + 14, 3, 0, Math.PI * 2); ctx.fill();
        }

        // Player
        ctx.fillStyle = c.primary;
        this.roundRect(ctx, this.player.x * GRID + 2, this.player.y * GRID + 2, GRID - 4, GRID - 4, 8);
        ctx.fill();
        // Friendly eyes
        ctx.fillStyle = c.bg;
        ctx.beginPath(); ctx.arc(this.player.x * GRID + 11, this.player.y * GRID + 14, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.player.x * GRID + 21, this.player.y * GRID + 14, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = c.text;
        ctx.beginPath(); ctx.arc(this.player.x * GRID + 11, this.player.y * GRID + 14, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.player.x * GRID + 21, this.player.y * GRID + 14, 1.5, 0, Math.PI * 2); ctx.fill();

        ctx.restore();
    }
}
