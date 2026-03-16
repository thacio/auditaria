/**
 * Tetris — Classic block-stacking game.
 * Adapted from straker's Basic HTML Games (CC0 1.0 Universal)
 */

import { GameEngine } from './GameEngine.js';

const COLS = 10;
const ROWS = 20;
const BLOCK = 28;
const SIDE_W = 120;

const PIECES = [
    // I
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    // J
    [[1,0,0],[1,1,1],[0,0,0]],
    // L
    [[0,0,1],[1,1,1],[0,0,0]],
    // O
    [[1,1],[1,1]],
    // S
    [[0,1,1],[1,1,0],[0,0,0]],
    // T
    [[0,1,0],[1,1,1],[0,0,0]],
    // Z
    [[1,1,0],[0,1,1],[0,0,0]],
];

export class TetrisGame extends GameEngine {
    constructor(canvas) {
        super(canvas, {
            gameId: 'tetris',
            width: COLS * BLOCK + SIDE_W,
            height: ROWS * BLOCK,
            fps: 60,
        });
    }

    init() {
        this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
        this.score = 0;
        this.lines = 0;
        this.level = 1;
        this.dropCounter = 0;
        this.dropInterval = 800;
        this.piece = this._newPiece();
        this.nextPiece = this._newPiece();
        this._colorMap = {};
    }

    _newPiece() {
        const idx = Math.floor(Math.random() * PIECES.length);
        const matrix = PIECES[idx].map(r => [...r]);
        return {
            matrix,
            colorIdx: idx + 1,
            x: Math.floor((COLS - matrix[0].length) / 2),
            y: 0,
        };
    }

    _pieceColor(idx) {
        const c = this.colors;
        const palette = [null, c.accent, c.primary, c.success, c.warning, c.error, c.accent2, c.text];
        return palette[idx] || c.primary;
    }

    _collides(matrix, offX, offY) {
        for (let r = 0; r < matrix.length; r++) {
            for (let c = 0; c < matrix[r].length; c++) {
                if (!matrix[r][c]) continue;
                const nx = offX + c;
                const ny = offY + r;
                if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
                if (ny >= 0 && this.board[ny][nx]) return true;
            }
        }
        return false;
    }

    _merge() {
        const { matrix, x, y, colorIdx } = this.piece;
        for (let r = 0; r < matrix.length; r++) {
            for (let c = 0; c < matrix[r].length; c++) {
                if (!matrix[r][c]) continue;
                if (y + r < 0) return this.endGame();
                this.board[y + r][x + c] = colorIdx;
            }
        }
        this._clearLines();
        this.piece = this.nextPiece;
        this.nextPiece = this._newPiece();
        if (this._collides(this.piece.matrix, this.piece.x, this.piece.y)) {
            this.endGame();
        }
    }

    _clearLines() {
        let cleared = 0;
        for (let r = ROWS - 1; r >= 0; r--) {
            if (this.board[r].every(cell => cell !== 0)) {
                this.board.splice(r, 1);
                this.board.unshift(Array(COLS).fill(0));
                cleared++;
                r++; // re-check same row
            }
        }
        if (cleared) {
            const pts = [0, 100, 300, 500, 800];
            this.score += (pts[cleared] || 800) * this.level;
            this.lines += cleared;
            this.level = Math.floor(this.lines / 10) + 1;
            this.dropInterval = Math.max(100, 800 - (this.level - 1) * 70);
        }
    }

    _rotate(matrix) {
        const N = matrix.length;
        const rot = matrix.map((row, r) => row.map((_, c) => matrix[N - 1 - c][r]));
        return rot;
    }

    onKeyDown(key) {
        if (key === 'ArrowLeft') {
            if (!this._collides(this.piece.matrix, this.piece.x - 1, this.piece.y)) {
                this.piece.x--;
            }
        } else if (key === 'ArrowRight') {
            if (!this._collides(this.piece.matrix, this.piece.x + 1, this.piece.y)) {
                this.piece.x++;
            }
        } else if (key === 'ArrowDown') {
            if (!this._collides(this.piece.matrix, this.piece.x, this.piece.y + 1)) {
                this.piece.y++;
                this.score += 1;
            }
        } else if (key === 'ArrowUp') {
            const rotated = this._rotate(this.piece.matrix);
            if (!this._collides(rotated, this.piece.x, this.piece.y)) {
                this.piece.matrix = rotated;
            }
        } else if (key === ' ') {
            // Hard drop
            while (!this._collides(this.piece.matrix, this.piece.x, this.piece.y + 1)) {
                this.piece.y++;
                this.score += 2;
            }
            this._merge();
        }
    }

    update(delta) {
        this.dropCounter += delta;
        if (this.dropCounter >= this.dropInterval) {
            this.dropCounter = 0;
            if (!this._collides(this.piece.matrix, this.piece.x, this.piece.y + 1)) {
                this.piece.y++;
            } else {
                this._merge();
            }
        }
    }

    draw(ctx) {
        const c = this.colors;
        const fieldW = COLS * BLOCK;

        // Background
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, this.width, this.height);

        // Board grid
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= COLS; x++) {
            ctx.beginPath(); ctx.moveTo(x * BLOCK, 0); ctx.lineTo(x * BLOCK, ROWS * BLOCK); ctx.stroke();
        }
        for (let y = 0; y <= ROWS; y++) {
            ctx.beginPath(); ctx.moveTo(0, y * BLOCK); ctx.lineTo(fieldW, y * BLOCK); ctx.stroke();
        }

        // Placed blocks
        for (let r = 0; r < ROWS; r++) {
            for (let col = 0; col < COLS; col++) {
                if (this.board[r][col]) {
                    ctx.fillStyle = this._pieceColor(this.board[r][col]);
                    this.roundRect(ctx, col * BLOCK + 1, r * BLOCK + 1, BLOCK - 2, BLOCK - 2, 4);
                    ctx.fill();
                }
            }
        }

        // Current piece
        const { matrix, x, y, colorIdx } = this.piece;
        ctx.fillStyle = this._pieceColor(colorIdx);
        for (let r = 0; r < matrix.length; r++) {
            for (let col = 0; col < matrix[r].length; col++) {
                if (matrix[r][col]) {
                    this.roundRect(ctx, (x + col) * BLOCK + 1, (y + r) * BLOCK + 1, BLOCK - 2, BLOCK - 2, 4);
                    ctx.fill();
                }
            }
        }

        // Ghost piece
        let ghostY = y;
        while (!this._collides(matrix, x, ghostY + 1)) ghostY++;
        if (ghostY !== y) {
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = this._pieceColor(colorIdx);
            for (let r = 0; r < matrix.length; r++) {
                for (let col = 0; col < matrix[r].length; col++) {
                    if (matrix[r][col]) {
                        this.roundRect(ctx, (x + col) * BLOCK + 1, (ghostY + r) * BLOCK + 1, BLOCK - 2, BLOCK - 2, 4);
                        ctx.fill();
                    }
                }
            }
            ctx.globalAlpha = 1;
        }

        // Side panel
        const sx = fieldW + 10;
        ctx.fillStyle = c.surface;
        ctx.fillRect(fieldW, 0, SIDE_W, this.height);
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(fieldW, 0); ctx.lineTo(fieldW, this.height); ctx.stroke();

        ctx.fillStyle = c.text;
        ctx.font = 'bold 14px "Space Grotesk", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Score', sx, 30);
        ctx.font = '20px "Space Grotesk", sans-serif';
        ctx.fillStyle = c.primary;
        ctx.fillText(String(this.score), sx, 55);

        ctx.fillStyle = c.text;
        ctx.font = 'bold 14px "Space Grotesk", sans-serif';
        ctx.fillText('Level', sx, 90);
        ctx.font = '20px "Space Grotesk", sans-serif';
        ctx.fillStyle = c.accent;
        ctx.fillText(String(this.level), sx, 115);

        ctx.fillStyle = c.text;
        ctx.font = 'bold 14px "Space Grotesk", sans-serif';
        ctx.fillText('Lines', sx, 150);
        ctx.font = '20px "Space Grotesk", sans-serif';
        ctx.fillStyle = c.success;
        ctx.fillText(String(this.lines), sx, 175);

        // Next piece preview
        ctx.fillStyle = c.text;
        ctx.font = 'bold 14px "Space Grotesk", sans-serif';
        ctx.fillText('Next', sx, 220);
        const nm = this.nextPiece.matrix;
        const previewBlock = 16;
        const previewX = sx + 10;
        const previewY = 235;
        ctx.fillStyle = this._pieceColor(this.nextPiece.colorIdx);
        for (let r = 0; r < nm.length; r++) {
            for (let col = 0; col < nm[r].length; col++) {
                if (nm[r][col]) {
                    this.roundRect(ctx, previewX + col * previewBlock, previewY + r * previewBlock, previewBlock - 2, previewBlock - 2, 3);
                    ctx.fill();
                }
            }
        }
    }
}
