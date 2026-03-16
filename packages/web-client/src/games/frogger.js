/**
 * Frogger — Cross the road and river.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const GRID = 40;
const COLS = 11;
const ROWS = 13;

export class FroggerGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'frogger', width: COLS * GRID, height: ROWS * GRID, fps: 60 });
    }

    init() {
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.frogX = Math.floor(COLS / 2) * GRID;
        this.frogY = (ROWS - 1) * GRID;
        this.frogW = GRID - 4;
        this.frogH = GRID - 4;
        this.maxRow = ROWS - 1;
        this.moveCooldown = 0;
        this.goalSlots = Array(5).fill(false);

        this._buildLanes();
    }

    _buildLanes() {
        // Lanes: rows 1-5 = river (logs), rows 7-11 = road (cars), row 0 = goal, row 6 = safe, row 12 = start
        const speed = 0.6 + this.level * 0.15;
        this.lanes = [];
        for (let r = 0; r < ROWS; r++) {
            this.lanes[r] = { type: 'safe', objects: [] };
        }

        // Road lanes (rows 7-11)
        const carWidths = [GRID * 1.2, GRID * 1.8, GRID * 1.2, GRID * 2.5, GRID * 1.2];
        const carSpeeds = [1, -1.3, 0.9, -0.7, 1.2].map(s => s * speed);
        for (let i = 0; i < 5; i++) {
            const row = 7 + i;
            this.lanes[row] = { type: 'road', objects: [] };
            const count = 2 + Math.floor(Math.random() * 2);
            const spacing = this.width / count;
            for (let j = 0; j < count; j++) {
                this.lanes[row].objects.push({
                    x: j * spacing + Math.random() * 40,
                    y: row * GRID,
                    w: carWidths[i],
                    h: GRID - 6,
                    dx: carSpeeds[i],
                });
            }
        }

        // River lanes (rows 1-5)
        const logWidths = [GRID * 3, GRID * 2, GRID * 3.5, GRID * 2, GRID * 2.5];
        const logSpeeds = [0.8, -1.1, 0.7, -0.9, 1.0].map(s => s * speed);
        for (let i = 0; i < 5; i++) {
            const row = 1 + i;
            this.lanes[row] = { type: 'river', objects: [] };
            const count = 2 + Math.floor(Math.random() * 2);
            const spacing = this.width / count;
            for (let j = 0; j < count; j++) {
                this.lanes[row].objects.push({
                    x: j * spacing,
                    y: row * GRID,
                    w: logWidths[i],
                    h: GRID - 6,
                    dx: logSpeeds[i],
                });
            }
        }

        // Goal row
        this.lanes[0] = { type: 'goal', objects: [] };
        // Safe median
        this.lanes[6] = { type: 'safe', objects: [] };
    }

    onKeyDown(key) {
        if (this.moveCooldown > 0) return;
        this.moveCooldown = 8;
        const prev = this.frogY;

        if (key === 'ArrowUp') this.frogY -= GRID;
        else if (key === 'ArrowDown') this.frogY = Math.min((ROWS - 1) * GRID, this.frogY + GRID);
        else if (key === 'ArrowLeft') this.frogX = Math.max(0, this.frogX - GRID);
        else if (key === 'ArrowRight') this.frogX = Math.min((COLS - 1) * GRID, this.frogX + GRID);

        const newRow = Math.round(this.frogY / GRID);
        if (newRow < this.maxRow) {
            this.maxRow = newRow;
            this.score += 10;
        }
    }

    _resetFrog() {
        this.frogX = Math.floor(COLS / 2) * GRID;
        this.frogY = (ROWS - 1) * GRID;
        this.maxRow = ROWS - 1;
    }

    _die() {
        this.lives--;
        if (this.lives <= 0) return this.endGame();
        this._resetFrog();
    }

    update() {
        if (this.moveCooldown > 0) this.moveCooldown--;

        // Move all objects, wrap around
        for (const lane of this.lanes) {
            for (const obj of lane.objects) {
                obj.x += obj.dx;
                if (obj.dx > 0 && obj.x > this.width + 20) obj.x = -obj.w - 10;
                if (obj.dx < 0 && obj.x + obj.w < -20) obj.x = this.width + 10;
            }
        }

        const row = Math.round(this.frogY / GRID);
        if (row < 0 || row >= ROWS) return;
        const lane = this.lanes[row];

        if (lane.type === 'road') {
            // Check car collision
            for (const car of lane.objects) {
                if (this._overlaps(this.frogX + 2, this.frogY + 2, this.frogW, this.frogH, car.x, car.y + 3, car.w, car.h)) {
                    return this._die();
                }
            }
        } else if (lane.type === 'river') {
            // Must be on a log
            let onLog = false;
            for (const log of lane.objects) {
                if (this._overlaps(this.frogX + 2, this.frogY + 2, this.frogW, this.frogH, log.x, log.y + 3, log.w, log.h)) {
                    onLog = true;
                    this.frogX += log.dx; // Ride the log
                    break;
                }
            }
            if (!onLog) return this._die();
            // Off screen
            if (this.frogX < -GRID || this.frogX > this.width) return this._die();
        } else if (lane.type === 'goal' && row === 0) {
            // Reached the goal
            const slot = Math.round(this.frogX / (this.width / 5));
            if (slot >= 0 && slot < 5 && !this.goalSlots[slot]) {
                this.goalSlots[slot] = true;
                this.score += 50;
                this._resetFrog();
                if (this.goalSlots.every(Boolean)) {
                    // All slots filled — next level
                    this.level++;
                    this.score += 100;
                    this.goalSlots.fill(false);
                    this._buildLanes();
                    this._resetFrog();
                }
            } else {
                this._die();
            }
        }
    }

    _overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    draw(ctx) {
        const c = this.colors;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Draw lane backgrounds
        for (let r = 0; r < ROWS; r++) {
            const lane = this.lanes[r];
            if (lane.type === 'road') {
                ctx.fillStyle = c.surface;
                ctx.fillRect(0, r * GRID, this.width, GRID);
            } else if (lane.type === 'river') {
                ctx.fillStyle = 'rgba(30, 100, 200, 0.2)';
                ctx.fillRect(0, r * GRID, this.width, GRID);
            } else if (lane.type === 'safe') {
                ctx.fillStyle = c.surface;
                ctx.fillRect(0, r * GRID, this.width, GRID);
            }
        }

        // Goal slots
        for (let i = 0; i < 5; i++) {
            const sx = i * (this.width / 5) + (this.width / 5 - GRID) / 2;
            ctx.fillStyle = this.goalSlots[i] ? c.success : c.border;
            this.roundRect(ctx, sx, 2, GRID, GRID - 4, 6);
            ctx.fill();
        }

        // Draw objects
        for (const lane of this.lanes) {
            for (const obj of lane.objects) {
                ctx.fillStyle = lane.type === 'road' ? c.error : c.accent2;
                this.roundRect(ctx, obj.x, obj.y + 3, obj.w, obj.h, 5);
                ctx.fill();
            }
        }

        // Frog
        ctx.fillStyle = c.success;
        this.roundRect(ctx, this.frogX + 2, this.frogY + 2, this.frogW, this.frogH, 8);
        ctx.fill();
        // Eyes
        ctx.fillStyle = c.bg;
        ctx.beginPath(); ctx.arc(this.frogX + 10, this.frogY + 12, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.frogX + 26, this.frogY + 12, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = c.text;
        ctx.beginPath(); ctx.arc(this.frogX + 10, this.frogY + 12, 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.frogX + 26, this.frogY + 12, 2, 0, Math.PI * 2); ctx.fill();

        // HUD
        ctx.fillStyle = c.text;
        ctx.font = '13px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${this.score}  Level: ${this.level}`, 8, this.height - 8);
        ctx.textAlign = 'right';
        ctx.fillText(`Lives: ${'●'.repeat(this.lives)}`, this.width - 8, this.height - 8);
    }
}
