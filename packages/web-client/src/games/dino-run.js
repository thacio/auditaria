/**
 * Dino Run — Endless runner inspired by Chrome's offline dinosaur game.
 * Original implementation (CC0 — public domain).
 */

import { GameEngine } from './GameEngine.js';

const GROUND_Y = 260;
const GRAVITY = 0.55;
const JUMP_FORCE = -11;
const DUCK_GRAVITY = 1.2;

export class DinoRunGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'dino-run', width: 600, height: 300, fps: 60 });
    }

    init() {
        this.score = 0;
        this.speed = 5;
        this.frameCount = 0;

        // Dino
        this.dino = {
            x: 50,
            y: GROUND_Y,
            w: 24,
            h: 40,
            vy: 0,
            jumping: false,
            ducking: false,
        };

        // Obstacles
        this.obstacles = [];
        this.nextObstacle = 80;

        // Clouds (decorative)
        this.clouds = [];
        for (let i = 0; i < 4; i++) {
            this.clouds.push({
                x: Math.random() * this.width,
                y: 40 + Math.random() * 60,
                w: 40 + Math.random() * 30,
            });
        }

        // Ground scroll
        this.groundOffset = 0;
    }

    onKeyDown(key) {
        if ((key === 'ArrowUp' || key === ' ' || key === 'w') && !this.dino.jumping) {
            this.dino.vy = JUMP_FORCE;
            this.dino.jumping = true;
            this.dino.ducking = false;
        }
        if ((key === 'ArrowDown' || key === 's') && !this.dino.jumping) {
            this.dino.ducking = true;
        }
    }

    onKeyUp(key) {
        if (key === 'ArrowDown' || key === 's') {
            this.dino.ducking = false;
        }
    }

    _spawnObstacle() {
        const type = Math.random();
        if (type < 0.45) {
            // Small cactus
            this.obstacles.push({
                x: this.width + 10,
                y: GROUND_Y,
                w: 14,
                h: 30 + Math.random() * 12,
                type: 'cactus-sm',
            });
        } else if (type < 0.8) {
            // Tall cactus (sometimes double)
            const count = Math.random() < 0.3 ? 2 : 1;
            for (let i = 0; i < count; i++) {
                this.obstacles.push({
                    x: this.width + 10 + i * 20,
                    y: GROUND_Y,
                    w: 16,
                    h: 36 + Math.random() * 10,
                    type: 'cactus-lg',
                });
            }
        } else {
            // Pterodactyl (flying obstacle)
            const flyH = Math.random() < 0.5 ? GROUND_Y - 30 : GROUND_Y - 55;
            this.obstacles.push({
                x: this.width + 10,
                y: flyH,
                w: 28,
                h: 18,
                type: 'ptero',
            });
        }
    }

    update() {
        this.frameCount++;

        // Speed ramp
        this.speed = 5 + Math.floor(this.frameCount / 300) * 0.5;
        if (this.speed > 14) this.speed = 14;

        // Score
        if (this.frameCount % 4 === 0) this.score++;

        // Ground scroll
        this.groundOffset = (this.groundOffset + this.speed) % 20;

        // Clouds
        for (const cloud of this.clouds) {
            cloud.x -= this.speed * 0.2;
            if (cloud.x + cloud.w < 0) {
                cloud.x = this.width + Math.random() * 100;
                cloud.y = 40 + Math.random() * 60;
            }
        }

        // Dino physics
        const dino = this.dino;
        if (dino.jumping) {
            const grav = dino.ducking ? DUCK_GRAVITY : GRAVITY;
            dino.vy += grav;
            dino.y += dino.vy;
            if (dino.y >= GROUND_Y) {
                dino.y = GROUND_Y;
                dino.vy = 0;
                dino.jumping = false;
            }
        }

        // Dino hitbox adjusts when ducking
        if (dino.ducking && !dino.jumping) {
            dino.w = 32;
            dino.h = 22;
        } else {
            dino.w = 24;
            dino.h = 40;
        }

        // Spawn obstacles
        this.nextObstacle -= this.speed;
        if (this.nextObstacle <= 0) {
            this._spawnObstacle();
            this.nextObstacle = 50 + Math.random() * 60;
        }

        // Move obstacles
        for (const obs of this.obstacles) {
            obs.x -= this.speed;
        }
        this.obstacles = this.obstacles.filter(o => o.x + o.w > -20);

        // Collision
        const dx = dino.x;
        const dy = dino.y - dino.h;
        const dw = dino.w;
        const dh = dino.h;
        for (const obs of this.obstacles) {
            const ox = obs.x;
            const oy = obs.y - obs.h;
            const ow = obs.w;
            const oh = obs.h;
            // Shrink hitbox a bit for fairness
            const margin = 4;
            if (
                dx + margin < ox + ow - margin &&
                dx + dw - margin > ox + margin &&
                dy + margin < oy + oh - margin &&
                dy + dh - margin > oy + margin
            ) {
                return this.endGame();
            }
        }
    }

    draw(ctx) {
        const c = this.colors;

        // Sky
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Clouds
        ctx.fillStyle = c.border;
        for (const cloud of this.clouds) {
            this.roundRect(ctx, cloud.x, cloud.y, cloud.w, 12, 6);
            ctx.fill();
            this.roundRect(ctx, cloud.x + 8, cloud.y - 6, cloud.w * 0.6, 10, 5);
            ctx.fill();
        }

        // Ground line
        ctx.strokeStyle = c.textMuted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, GROUND_Y + 1);
        ctx.lineTo(this.width, GROUND_Y + 1);
        ctx.stroke();

        // Ground texture (dashes scrolling)
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        for (let x = -this.groundOffset; x < this.width; x += 20) {
            const segW = 4 + Math.abs(Math.sin(x * 0.1)) * 6;
            ctx.beginPath();
            ctx.moveTo(x, GROUND_Y + 6);
            ctx.lineTo(x + segW, GROUND_Y + 6);
            ctx.stroke();
        }

        // Obstacles
        for (const obs of this.obstacles) {
            if (obs.type === 'ptero') {
                // Pterodactyl — simple bird shape
                ctx.fillStyle = c.error;
                this.roundRect(ctx, obs.x, obs.y - obs.h, obs.w, obs.h, 4);
                ctx.fill();
                // Wing flap
                const wingUp = Math.sin(this.frameCount * 0.15) > 0;
                ctx.beginPath();
                ctx.moveTo(obs.x + 4, obs.y - obs.h / 2);
                ctx.lineTo(obs.x + obs.w / 2, wingUp ? obs.y - obs.h - 10 : obs.y - obs.h + 4);
                ctx.lineTo(obs.x + obs.w - 4, obs.y - obs.h / 2);
                ctx.fillStyle = c.error;
                ctx.fill();
            } else {
                // Cactus
                ctx.fillStyle = c.success;
                this.roundRect(ctx, obs.x, obs.y - obs.h, obs.w, obs.h, 3);
                ctx.fill();
                // Side arms for large cactus
                if (obs.type === 'cactus-lg') {
                    ctx.fillRect(obs.x - 5, obs.y - obs.h * 0.6, 6, 3);
                    ctx.fillRect(obs.x + obs.w - 1, obs.y - obs.h * 0.4, 6, 3);
                }
            }
        }

        // Dino
        const dino = this.dino;
        const dinoTop = dino.y - dino.h;
        ctx.fillStyle = c.primary;
        this.roundRect(ctx, dino.x, dinoTop, dino.w, dino.h, 5);
        ctx.fill();

        // Dino eye
        ctx.fillStyle = c.bg;
        const eyeX = dino.x + dino.w - 7;
        const eyeY = dinoTop + (dino.ducking && !dino.jumping ? 5 : 8);
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Dino legs (animated)
        ctx.fillStyle = c.primary;
        const legAnim = Math.sin(this.frameCount * 0.3);
        if (dino.jumping) {
            // Both legs back in air
            ctx.fillRect(dino.x + 4, dino.y - 2, 5, 6);
            ctx.fillRect(dino.x + 12, dino.y - 2, 5, 6);
        } else {
            ctx.fillRect(dino.x + 4, dino.y, 5, 4 + legAnim * 2);
            ctx.fillRect(dino.x + 12, dino.y, 5, 4 - legAnim * 2);
        }

        // Score
        ctx.fillStyle = c.text;
        ctx.font = '16px "IBM Plex Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(String(this.score).padStart(5, '0'), this.width - 12, 25);

        // Speed indicator
        ctx.font = '11px "Space Grotesk", sans-serif';
        ctx.fillStyle = c.textMuted;
        ctx.textAlign = 'left';
        ctx.fillText(`Speed: ${this.speed.toFixed(1)}`, 8, 20);
    }
}
