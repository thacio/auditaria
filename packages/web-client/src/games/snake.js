/**
 * Snake — Classic snake game.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const GRID = 16;

export class SnakeGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'snake', width: 400, height: 400, fps: 15 });
    }

    init() {
        this.snake = [];
        this.direction = 'right';
        this.nextDirection = 'right';

        // Start in the middle
        const startX = Math.floor(this.width / GRID / 2) * GRID;
        const startY = Math.floor(this.height / GRID / 2) * GRID;
        for (let i = 3; i >= 0; i--) {
            this.snake.push({ x: startX - i * GRID, y: startY });
        }

        this.food = this._placeFood();
        this.score = 0;
        this.grow = false;
    }

    _placeFood() {
        const cols = this.width / GRID;
        const rows = this.height / GRID;
        let pos;
        do {
            pos = {
                x: Math.floor(Math.random() * cols) * GRID,
                y: Math.floor(Math.random() * rows) * GRID,
            };
        } while (this.snake.some(s => s.x === pos.x && s.y === pos.y));
        return pos;
    }

    onKeyDown(key) {
        const map = {
            ArrowUp: 'up', ArrowDown: 'down',
            ArrowLeft: 'left', ArrowRight: 'right',
            w: 'up', s: 'down', a: 'left', d: 'right',
        };
        const dir = map[key];
        if (!dir) return;

        // Prevent 180-degree turn
        const opp = { up: 'down', down: 'up', left: 'right', right: 'left' };
        if (opp[dir] !== this.direction) {
            this.nextDirection = dir;
        }
    }

    update() {
        this.direction = this.nextDirection;
        const head = { ...this.snake[this.snake.length - 1] };

        switch (this.direction) {
            case 'up':    head.y -= GRID; break;
            case 'down':  head.y += GRID; break;
            case 'left':  head.x -= GRID; break;
            case 'right': head.x += GRID; break;
        }

        // Wall collision
        if (head.x < 0 || head.x >= this.width || head.y < 0 || head.y >= this.height) {
            return this.endGame();
        }

        // Self collision
        if (this.snake.some(s => s.x === head.x && s.y === head.y)) {
            return this.endGame();
        }

        this.snake.push(head);

        // Food
        if (head.x === this.food.x && head.y === this.food.y) {
            this.score += 10;
            this.food = this._placeFood();
        } else {
            this.snake.shift();
        }
    }

    draw(ctx) {
        const c = this.colors;

        // Background
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Grid lines (subtle)
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 0.5;
        for (let x = 0; x < this.width; x += GRID) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.height); ctx.stroke();
        }
        for (let y = 0; y < this.height; y += GRID) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.width, y); ctx.stroke();
        }

        // Food
        ctx.fillStyle = c.success;
        this.roundRect(ctx, this.food.x + 1, this.food.y + 1, GRID - 2, GRID - 2, 4);
        ctx.fill();

        // Snake
        this.snake.forEach((seg, i) => {
            const isHead = i === this.snake.length - 1;
            ctx.fillStyle = isHead ? c.primary : c.accent;
            this.roundRect(ctx, seg.x + 1, seg.y + 1, GRID - 2, GRID - 2, isHead ? 5 : 3);
            ctx.fill();
        });

        // Score
        ctx.fillStyle = c.text;
        ctx.font = '14px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${this.score}`, 8, 18);
    }
}
