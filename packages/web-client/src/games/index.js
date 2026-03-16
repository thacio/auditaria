/**
 * Game Registry — metadata and factory for all arcade games.
 * Each entry defines how the game appears in the lobby and how to create it.
 */

import { SnakeGame } from './snake.js';
import { TetrisGame } from './tetris.js';
import { BreakoutGame } from './breakout.js';
import { PongGame } from './pong.js';
import { DoodleJumpGame } from './doodle-jump.js';
import { FroggerGame } from './frogger.js';
import { BombermanGame } from './bomberman.js';
import { DinoRunGame } from './dino-run.js';

/**
 * @typedef {object} GameEntry
 * @property {string} id
 * @property {string} name
 * @property {string} tagline
 * @property {string} controls  — short hint shown below the canvas
 * @property {string} icon      — inline SVG string (simple geometric art)
 * @property {(canvas: HTMLCanvasElement) => import('./GameEngine.js').GameEngine} create
 */

/** @type {GameEntry[]} */
export const GAMES = [
    {
        id: 'snake',
        name: 'Snake',
        tagline: 'Eat, grow, survive.',
        controls: 'Arrow keys or WASD to move',
        icon: `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8,28 8,16 16,16 16,24 24,24 24,12 32,12"/>
            <circle cx="32" cy="12" r="2.5" fill="currentColor"/>
            <rect x="26" y="30" width="6" height="6" rx="1.5" fill="currentColor" stroke="none"/>
        </svg>`,
        create: (canvas) => new SnakeGame(canvas),
    },
    {
        id: 'tetris',
        name: 'Tetris',
        tagline: 'Stack and clear lines.',
        controls: 'Left/Right to move, Up to rotate, Down for soft drop, Space for hard drop',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <rect x="6" y="24" width="8" height="8" rx="1.5" opacity="0.7"/>
            <rect x="14" y="24" width="8" height="8" rx="1.5" opacity="0.9"/>
            <rect x="14" y="16" width="8" height="8" rx="1.5" opacity="0.9"/>
            <rect x="22" y="24" width="8" height="8" rx="1.5" opacity="0.5"/>
            <rect x="22" y="16" width="8" height="8" rx="1.5" opacity="0.5"/>
            <rect x="14" y="8" width="8" height="8" rx="1.5" opacity="0.6"/>
        </svg>`,
        create: (canvas) => new TetrisGame(canvas),
    },
    {
        id: 'breakout',
        name: 'Breakout',
        tagline: 'Smash all the bricks.',
        controls: 'Left/Right arrows to move paddle',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <rect x="4" y="6" width="10" height="5" rx="1.5" opacity="0.8"/>
            <rect x="15" y="6" width="10" height="5" rx="1.5" opacity="0.6"/>
            <rect x="26" y="6" width="10" height="5" rx="1.5" opacity="0.4"/>
            <rect x="4" y="12" width="10" height="5" rx="1.5" opacity="0.5"/>
            <rect x="15" y="12" width="10" height="5" rx="1.5" opacity="0.7"/>
            <rect x="26" y="12" width="10" height="5" rx="1.5" opacity="0.9"/>
            <rect x="12" y="33" width="16" height="4" rx="2"/>
            <circle cx="20" cy="27" r="2.5"/>
        </svg>`,
        create: (canvas) => new BreakoutGame(canvas),
    },
    {
        id: 'pong',
        name: 'Pong',
        tagline: 'Beat the CPU.',
        controls: 'Up/Down arrows or W/S to move paddle',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <rect x="6" y="10" width="4" height="16" rx="2"/>
            <rect x="30" y="14" width="4" height="16" rx="2"/>
            <circle cx="20" cy="20" r="3"/>
            <line x1="20" y1="4" x2="20" y2="36" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.3"/>
        </svg>`,
        create: (canvas) => new PongGame(canvas),
    },
    {
        id: 'doodle-jump',
        name: 'Doodle Jump',
        tagline: 'Jump higher and higher.',
        controls: 'Left/Right arrows to move',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <rect x="6" y="30" width="18" height="4" rx="2" opacity="0.5"/>
            <rect x="18" y="22" width="14" height="4" rx="2" opacity="0.6"/>
            <rect x="4" y="14" width="14" height="4" rx="2" opacity="0.7"/>
            <rect x="14" y="16" width="10" height="10" rx="4"/>
            <circle cx="17" cy="19" r="1.5" fill="none" stroke="currentColor" stroke-width="1"/>
            <circle cx="21" cy="19" r="1.5" fill="none" stroke="currentColor" stroke-width="1"/>
        </svg>`,
        create: (canvas) => new DoodleJumpGame(canvas),
    },
    {
        id: 'frogger',
        name: 'Frogger',
        tagline: 'Cross the road and river.',
        controls: 'Arrow keys to hop',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <ellipse cx="20" cy="22" rx="10" ry="8" opacity="0.8"/>
            <circle cx="14" cy="15" r="4"/>
            <circle cx="26" cy="15" r="4"/>
            <circle cx="14" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
            <circle cx="26" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
            <ellipse cx="12" cy="30" rx="3" ry="2" opacity="0.6"/>
            <ellipse cx="28" cy="30" rx="3" ry="2" opacity="0.6"/>
        </svg>`,
        create: (canvas) => new FroggerGame(canvas),
    },
    {
        id: 'bomberman',
        name: 'Bomberman',
        tagline: 'Blast your way through.',
        controls: 'Arrow keys to move, Space to place bomb',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <circle cx="20" cy="22" r="10" opacity="0.8"/>
            <line x1="20" y1="12" x2="22" y2="6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="23" cy="5" r="2.5" opacity="0.5"/>
            <circle cx="16" cy="20" r="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
            <circle cx="24" cy="20" r="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
        </svg>`,
        create: (canvas) => new BombermanGame(canvas),
    },
    {
        id: 'dino-run',
        name: 'Dino Run',
        tagline: 'Run, jump, survive.',
        controls: 'Space/Up to jump, Down to duck',
        icon: `<svg viewBox="0 0 40 40" fill="currentColor">
            <path d="M12 28h3v4h-3zM18 28h3v4h-3z" opacity="0.8"/>
            <path d="M8 14h20v14H8z" rx="3" opacity="0.8"/>
            <path d="M22 8h8v10h-4v-3h-4z"/>
            <rect x="26" y="10" width="2.5" height="2.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
            <path d="M33 28h-28" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
        </svg>`,
        create: (canvas) => new DinoRunGame(canvas),
    },
];
