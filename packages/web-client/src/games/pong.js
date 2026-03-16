/**
 * Pong — Classic paddle game vs CPU.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

export class PongGame extends GameEngine {
    constructor(canvas) {
        super(canvas, { gameId: 'pong', width: 480, height: 360, fps: 60 });
    }

    init() {
        this.paddleH = 60;
        this.paddleW = 10;
        this.paddleSpeed = 4;
        this.maxScore = 7;

        // Player (left)
        this.playerY = (this.height - this.paddleH) / 2;
        // CPU (right)
        this.cpuY = (this.height - this.paddleH) / 2;
        this.cpuSpeed = 2.8;

        this.playerScore = 0;
        this.cpuScore = 0;

        this._resetBall();
    }

    _resetBall() {
        this.ballX = this.width / 2;
        this.ballY = this.height / 2;
        const angle = (Math.random() * Math.PI / 4) - Math.PI / 8;
        const dir = Math.random() > 0.5 ? 1 : -1;
        this.ballSpeed = 4;
        this.ballDX = dir * this.ballSpeed * Math.cos(angle);
        this.ballDY = this.ballSpeed * Math.sin(angle);
        this.ballR = 6;
    }

    update() {
        // Player paddle
        if (this.isKeyDown('ArrowUp') || this.isKeyDown('w')) {
            this.playerY = Math.max(0, this.playerY - this.paddleSpeed);
        }
        if (this.isKeyDown('ArrowDown') || this.isKeyDown('s')) {
            this.playerY = Math.min(this.height - this.paddleH, this.playerY + this.paddleSpeed);
        }

        // CPU AI — follow ball with slight delay
        const cpuCenter = this.cpuY + this.paddleH / 2;
        if (this.ballDX > 0) { // Ball moving toward CPU
            if (cpuCenter < this.ballY - 10) this.cpuY += this.cpuSpeed;
            else if (cpuCenter > this.ballY + 10) this.cpuY -= this.cpuSpeed;
        } else {
            // Drift toward center when ball going away
            if (cpuCenter < this.height / 2 - 20) this.cpuY += this.cpuSpeed * 0.5;
            else if (cpuCenter > this.height / 2 + 20) this.cpuY -= this.cpuSpeed * 0.5;
        }
        this.cpuY = Math.max(0, Math.min(this.height - this.paddleH, this.cpuY));

        // Ball movement
        this.ballX += this.ballDX;
        this.ballY += this.ballDY;

        // Top/bottom bounce
        if (this.ballY - this.ballR <= 0 || this.ballY + this.ballR >= this.height) {
            this.ballDY = -this.ballDY;
        }

        // Player paddle collision (left)
        if (
            this.ballDX < 0 &&
            this.ballX - this.ballR <= 20 + this.paddleW &&
            this.ballX - this.ballR >= 20 &&
            this.ballY >= this.playerY &&
            this.ballY <= this.playerY + this.paddleH
        ) {
            this.ballDX = Math.abs(this.ballDX) * 1.05;
            const hit = (this.ballY - this.playerY) / this.paddleH - 0.5;
            this.ballDY = hit * 6;
        }

        // CPU paddle collision (right)
        if (
            this.ballDX > 0 &&
            this.ballX + this.ballR >= this.width - 20 - this.paddleW &&
            this.ballX + this.ballR <= this.width - 20 &&
            this.ballY >= this.cpuY &&
            this.ballY <= this.cpuY + this.paddleH
        ) {
            this.ballDX = -Math.abs(this.ballDX) * 1.05;
            const hit = (this.ballY - this.cpuY) / this.paddleH - 0.5;
            this.ballDY = hit * 6;
        }

        // Score
        if (this.ballX < 0) {
            this.cpuScore++;
            this.score = this.playerScore; // Track player score
            if (this.cpuScore >= this.maxScore) return this.endGame();
            this._resetBall();
        }
        if (this.ballX > this.width) {
            this.playerScore++;
            this.score = this.playerScore;
            if (this.playerScore >= this.maxScore) return this.endGame();
            this._resetBall();
        }
    }

    draw(ctx) {
        const c = this.colors;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Center line
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.width / 2, 0);
        ctx.lineTo(this.width / 2, this.height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Paddles
        ctx.fillStyle = c.primary;
        this.roundRect(ctx, 20, this.playerY, this.paddleW, this.paddleH, 4);
        ctx.fill();

        ctx.fillStyle = c.error;
        this.roundRect(ctx, this.width - 20 - this.paddleW, this.cpuY, this.paddleW, this.paddleH, 4);
        ctx.fill();

        // Ball
        ctx.fillStyle = c.text;
        ctx.beginPath();
        ctx.arc(this.ballX, this.ballY, this.ballR, 0, Math.PI * 2);
        ctx.fill();

        // Scores
        ctx.fillStyle = c.text;
        ctx.font = 'bold 32px "Space Grotesk", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(this.playerScore), this.width / 2 - 50, 45);
        ctx.fillText(String(this.cpuScore), this.width / 2 + 50, 45);

        // Labels
        ctx.font = '11px "Space Grotesk", sans-serif';
        ctx.fillStyle = c.textMuted;
        ctx.fillText('YOU', this.width / 2 - 50, 62);
        ctx.fillText('CPU', this.width / 2 + 50, 62);
    }
}
