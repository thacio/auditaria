/**
 * Doodle Jump — Vertical platformer.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const PLAT_COUNT = 8;

export class DoodleJumpGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'doodle-jump', width: 375, height: 550, fps: 60 });
    }

    init() {
        this.playerW = 24;
        this.playerH = 24;
        this.playerX = this.width / 2 - this.playerW / 2;
        this.playerY = this.height - 100;
        this.velY = -8;
        this.velX = 0;
        this.gravity = 0.3;
        this.jumpForce = -9;
        this.moveSpeed = 5;
        this.score = 0;
        this.maxY = this.playerY;

        // Platforms
        this.platforms = [];
        for (let i = 0; i < PLAT_COUNT; i++) {
            this.platforms.push(this._makePlatform(this.height - i * (this.height / PLAT_COUNT)));
        }
        // Ensure start platform under player
        this.platforms[0].x = this.playerX - 10;
        this.platforms[0].y = this.playerY + this.playerH + 5;
    }

    _makePlatform(y) {
        const w = 60 + Math.random() * 30;
        return {
            x: Math.random() * (this.width - w),
            y: y !== undefined ? y : -10,
            w,
            h: 10,
            moving: Math.random() < 0.2,
            moveDir: Math.random() > 0.5 ? 1 : -1,
            moveSpeed: 1 + Math.random(),
        };
    }

    update() {
        // Horizontal movement
        if (this.isKeyDown('ArrowLeft') || this.isKeyDown('a')) {
            this.velX = -this.moveSpeed;
        } else if (this.isKeyDown('ArrowRight') || this.isKeyDown('d')) {
            this.velX = this.moveSpeed;
        } else {
            this.velX *= 0.85;
        }

        this.playerX += this.velX;

        // Wrap around screen
        if (this.playerX + this.playerW < 0) this.playerX = this.width;
        if (this.playerX > this.width) this.playerX = -this.playerW;

        // Gravity
        this.velY += this.gravity;
        this.playerY += this.velY;

        // Scroll when player goes above midpoint
        if (this.playerY < this.height / 2) {
            const shift = this.height / 2 - this.playerY;
            this.playerY = this.height / 2;
            this.platforms.forEach(p => { p.y += shift; });
            this.score += Math.floor(shift);
        }

        // Move moving platforms
        this.platforms.forEach(p => {
            if (p.moving) {
                p.x += p.moveDir * p.moveSpeed;
                if (p.x <= 0 || p.x + p.w >= this.width) p.moveDir *= -1;
            }
        });

        // Platform collision (only when falling)
        if (this.velY > 0) {
            for (const plat of this.platforms) {
                if (
                    this.playerX + this.playerW > plat.x &&
                    this.playerX < plat.x + plat.w &&
                    this.playerY + this.playerH >= plat.y &&
                    this.playerY + this.playerH <= plat.y + plat.h + this.velY + 2
                ) {
                    this.playerY = plat.y - this.playerH;
                    this.velY = this.jumpForce;
                }
            }
        }

        // Recycle platforms that go below screen
        this.platforms = this.platforms.filter(p => p.y < this.height + 20);
        while (this.platforms.length < PLAT_COUNT) {
            const topY = Math.min(...this.platforms.map(p => p.y));
            this.platforms.push(this._makePlatform(topY - (60 + Math.random() * 60)));
        }

        // Fall off screen = game over
        if (this.playerY > this.height + 50) {
            this.endGame();
        }
    }

    draw(ctx) {
        const c = this.colors;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Platforms
        for (const plat of this.platforms) {
            ctx.fillStyle = plat.moving ? c.warning : c.success;
            this.roundRect(ctx, plat.x, plat.y, plat.w, plat.h, 4);
            ctx.fill();
        }

        // Player (simple square doodle)
        ctx.fillStyle = c.primary;
        this.roundRect(ctx, this.playerX, this.playerY, this.playerW, this.playerH, 6);
        ctx.fill();

        // Eyes
        ctx.fillStyle = c.bg;
        const eyeY = this.playerY + 7;
        ctx.beginPath(); ctx.arc(this.playerX + 7, eyeY, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.playerX + 17, eyeY, 3, 0, Math.PI * 2); ctx.fill();

        // Pupils (look in direction of movement)
        const pupilOff = this.velX > 0.5 ? 1 : this.velX < -0.5 ? -1 : 0;
        ctx.fillStyle = c.text;
        ctx.beginPath(); ctx.arc(this.playerX + 7 + pupilOff, eyeY, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(this.playerX + 17 + pupilOff, eyeY, 1.5, 0, Math.PI * 2); ctx.fill();

        // Score
        ctx.fillStyle = c.text;
        ctx.font = '14px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${this.score}`, 8, 20);
    }
}
