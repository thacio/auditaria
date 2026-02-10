/**
 * ThemeManager — handles theme switching, persistence, and Monaco sync.
 *
 * Relies on an inline <script> in <head> that sets data-theme BEFORE first paint
 * (FOUC prevention). This module adds toggle/events/Monaco integration.
 */

const STORAGE_KEY = 'auditaria-theme';
const THEME_EVENT = 'themechange';

class ThemeManager {
  constructor() {
    this._theme = document.documentElement.getAttribute('data-theme') || 'dark';
    this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this._mediaQuery.addEventListener('change', (e) => this._onSystemChange(e));
  }

  /** Current theme: 'dark' | 'light' */
  get theme() {
    return this._theme;
  }

  /** Toggle between dark and light. Returns the new theme. */
  toggle() {
    const next = this._theme === 'dark' ? 'light' : 'dark';
    this.set(next);
    return next;
  }

  /** Set a specific theme and persist. */
  set(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    this._theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
    this._dispatch();
  }

  /** Wire up a toggle button (updates aria-label and icon). */
  bindToggle(button) {
    if (!button) return;
    this._updateToggle(button);
    button.addEventListener('click', () => {
      // Add brief transition class
      document.documentElement.classList.add('theme-transitioning');
      this.toggle();
      this._updateToggle(button);
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 300);
    });
    // React to programmatic changes too
    document.addEventListener(THEME_EVENT, () => this._updateToggle(button));
  }

  /** Get Monaco theme name for current theme. */
  get monacoTheme() {
    return this._theme === 'dark' ? 'vs-dark' : 'vs';
  }

  // --- private ---

  _onSystemChange(e) {
    // Only follow system when user hasn't stored a preference
    try { if (localStorage.getItem(STORAGE_KEY)) return; } catch {}
    this.set(e.matches ? 'dark' : 'light');
  }

  _dispatch() {
    document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: this._theme } }));
  }

  _updateToggle(button) {
    const isDark = this._theme === 'dark';
    button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} theme`);
    button.title = `Switch to ${isDark ? 'light' : 'dark'} theme`;
    // Update icon inside button (sun for dark mode = click to go light, moon for light mode)
    const svg = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    button.innerHTML = svg;
  }
}

export const themeManager = new ThemeManager();
