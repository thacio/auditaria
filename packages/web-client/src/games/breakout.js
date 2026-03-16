/**
 * Breakout — Classic brick-breaking game.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const BRICK_ROWS = 6;
const BRICK_COLS = 8;
const BRICK_W = 54;
const BRICK_H = 18;
const BRICK_PAD = 4;
const BRICK_TOP = 50;
const BRICK_LEFT = 12;

export class BreakoutGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'breakout', width: 450, height: 400, fps: 60 });
    }

    init() {
        this.paddleW = 80;
        this.paddleH = 12;
        this.paddleX = (this.width - this.paddleW) / 2;
        this.paddleSpeed = 7;

        this.ballR = 6;
        this.ballX = this.width / 2;
        this.ballY = this.height - 40;
        this.ballDX = 3.5;
        this.ballDY = -3.5;

        this.score = 0;
        this.lives = 3;

        // Build bricks
        this.bricks = [];
        const rowColors = (c) => [c.error, c.warning, c.primary, c.accent, c.success, c.accent2];
        this._rowColors = rowColors(this.colors);
        for (let r = 0; r < BRICK_ROWS; r++) {
            for (let col = 0; col < BRICK_COLS; col++) {
                this.bricks.push({
                    x: BRICK_LEFT + col * (BRICK_W + BRICK_PAD),
                    y: BRICK_TOP + r * (BRICK_H + BRICK_PAD),
                    w: BRICK_W,
                    h: BRICK_H,
                    color: this._rowColors[r % this._rowColors.length],
                    alive: true,
                    points: (BRICK_ROWS - r) * 10,
                });
            }
        }
    }

    update() {
        // Paddle movement
        if (this.isKeyDown('ArrowLeft')) {
            this.paddleX = Math.max(0, this.paddleX - this.paddleSpeed);
        }
        if (this.isKeyDown('ArrowRight')) {
            this.paddleX = Math.min(this.width - this.paddleW, this.paddleX + this.paddleSpeed);
        }

        // Ball movement
        this.ballX += this.ballDX;
        this.ballY += this.ballDY;

        // Wall bounces
        if (this.ballX - this.ballR <= 0 || this.ballX + this.ballR >= this.width) {
            this.ballDX = -this.ballDX;
        }
        if (this.ballY - this.ballR <= 0) {
            this.ballDY = -this.ballDY;
        }

        // Bottom — lose life
        if (this.ballY + this.ballR >= this.height) {
            this.lives--;
            if (this.lives <= 0) return this.endGame();
            this.ballX = this.width / 2;
            this.ballY = this.height - 40;
            this.ballDX = 3.5 * (Math.random() > 0.5 ? 1 : -1);
            this.ballDY = -3.5;
        }

        // Paddle collision
        if (
            this.ballDY > 0 &&
            this.ballY + this.ballR >= this.height - 30 - this.paddleH &&
            this.ballY + this.ballR <= this.height - 30 &&
            this.ballX >= this.paddleX &&
            this.ballX <= this.paddleX + this.paddleW
        ) {
            this.ballDY = -this.ballDY;
            // Angle based on where ball hits paddle
            const hit = (this.ballX - this.paddleX) / this.paddleW;
            this.ballDX = 6 * (hit - 0.5);
        }

        // Brick collision
        for (const brick of this.bricks) {
            if (!brick.alive) continue;
            if (
                this.ballX + this.ballR > brick.x &&
                this.ballX - this.ballR < brick.x + brick.w &&
                this.ballY + this.ballR > brick.y &&
                this.ballY - this.ballR < brick.y + brick.h
            ) {
                brick.alive = false;
                this.ballDY = -this.ballDY;
                this.score += brick.points;
                break;
            }
        }

        // Win check
        if (this.bricks.every(b => !b.alive)) {
            this.endGame();
        }
    }

    draw(ctx) {
        const c = this.colors;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Bricks
        for (const brick of this.bricks) {
            if (!brick.alive) continue;
            ctx.fillStyle = brick.color;
            this.roundRect(ctx, brick.x, brick.y, brick.w, brick.h, 4);
            ctx.fill();
        }

        // Paddle
        ctx.fillStyle = c.primary;
        this.roundRect(ctx, this.paddleX, this.height - 30 - this.paddleH, this.paddleW, this.paddleH, 6);
        ctx.fill();

        // Ball
        ctx.fillStyle = c.text;
        ctx.beginPath();
        ctx.arc(this.ballX, this.ballY, this.ballR, 0, Math.PI * 2);
        ctx.fill();

        // HUD
        ctx.fillStyle = c.text;
        ctx.font = '14px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${this.score}`, 8, 20);
        ctx.textAlign = 'right';
        ctx.fillText(`Lives: ${'●'.repeat(this.lives)}`, this.width - 8, 20);
    }
}
