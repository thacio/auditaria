/**
 * ThemeManager - handles theme switching, persistence, and Monaco sync.
 *
 * Uses data-theme on <html> and emits a 'themechange' event.
 */

const STORAGE_KEY = 'auditaria-theme';
const THEME_EVENT = 'themechange';

const THEMES = [
  {
    id: 'calm-dark',
    label: 'Calm Dark',
    kind: 'dark',
    description: 'Minimal, cool',
    swatch: ['#0b0f14', '#4f7cff'],
    monaco: 'auditaria-calm-dark',
  },
  {
    id: 'calm-light',
    label: 'Calm Light',
    kind: 'light',
    description: 'Minimal, crisp',
    swatch: ['#f5f7fb', '#2563eb'],
    monaco: 'auditaria-calm-light',
  },
  {
    id: 'studio-dark',
    label: 'Studio Dark',
    kind: 'dark',
    description: 'Expressive, warm',
    swatch: ['#120f0b', '#f59e0b'],
    monaco: 'auditaria-studio-dark',
  },
  {
    id: 'studio-light',
    label: 'Studio Light',
    kind: 'light',
    description: 'Expressive, warm',
    swatch: ['#fbf7f1', '#ea580c'],
    monaco: 'auditaria-studio-light',
  },
];

class ThemeManager {
  constructor() {
    this._themes = THEMES;
    this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this._mediaQuery.addEventListener('change', (e) => this._onSystemChange(e));

    const initial = this._getInitialTheme();
    this._theme = initial;
    document.documentElement.setAttribute('data-theme', initial);
    this._syncColorScheme();
  }

  /** Current theme id */
  get theme() {
    return this._theme;
  }

  /** Current theme metadata */
  get themeMeta() {
    return this._themes.find((t) => t.id === this._theme) || this._themes[0];
  }

  /** Monaco theme name for current theme */
  get monacoTheme() {
    return this.themeMeta.monaco;
  }

  /** List of available themes */
  getThemes() {
    return [...this._themes];
  }

  /** Set a specific theme and persist */
  set(themeId) {
    const target = this._themes.find((t) => t.id === themeId);
    if (!target) return;

    document.documentElement.classList.add('theme-transitioning');
    this._theme = target.id;
    document.documentElement.setAttribute('data-theme', target.id);
    this._syncColorScheme();
    try { localStorage.setItem(STORAGE_KEY, target.id); } catch {}
    this._dispatch();
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning');
    }, 300);
  }

  /** Toggle between light and dark variants (keeps style family) */
  toggle() {
    const current = this.themeMeta;
    const nextKind = current.kind === 'dark' ? 'light' : 'dark';
    const family = current.id.includes('studio') ? 'studio' : 'calm';
    const nextId = `${family}-${nextKind}`;
    this.set(nextId);
    return nextId;
  }

  /** Attach the theme picker UI to a container */
  mountPicker(container) {
    if (!container) return;

    container.innerHTML = '';
    container.classList.add('theme-picker');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-picker-button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'theme-picker-menu';
    menu.setAttribute('role', 'menu');

    container.appendChild(button);
    container.appendChild(menu);

    const renderMenu = () => {
      menu.innerHTML = '';
      this._themes.forEach((theme) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'theme-picker-item';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('data-theme', theme.id);
        item.setAttribute('aria-checked', String(theme.id === this._theme));

        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.style.setProperty('--swatch-1', theme.swatch[0]);
        swatch.style.setProperty('--swatch-2', theme.swatch[1]);

        const label = document.createElement('span');
        label.className = 'theme-item-label';
        label.textContent = theme.label;

        const desc = document.createElement('span');
        desc.className = 'theme-item-desc';
        desc.textContent = theme.description;

        item.appendChild(swatch);
        item.appendChild(label);
        item.appendChild(desc);

        item.addEventListener('click', () => {
          this._closePicker(container, button);
          this.set(theme.id);
        });

        menu.appendChild(item);
      });
    };

    const updateButton = () => {
      const meta = this.themeMeta;
      button.innerHTML = '';
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch-inline';
      swatch.style.setProperty('--swatch-1', meta.swatch[0]);
      swatch.style.setProperty('--swatch-2', meta.swatch[1]);
      const text = document.createElement('span');
      text.className = 'theme-picker-label';
      text.textContent = meta.label;
      const caret = document.createElement('span');
      caret.className = 'theme-picker-caret';
      caret.textContent = 'v';
      button.appendChild(swatch);
      button.appendChild(text);
      button.appendChild(caret);
    };

    const toggleOpen = () => {
      const isOpen = container.classList.toggle('open');
      button.setAttribute('aria-expanded', String(isOpen));
    };

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleOpen();
    });

    document.addEventListener('click', () => this._closePicker(container, button));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this._closePicker(container, button);
      }
    });

    renderMenu();
    updateButton();
    document.addEventListener(THEME_EVENT, () => {
      renderMenu();
      updateButton();
    });
  }

  // --- private ---

  _closePicker(container, button) {
    if (!container.classList.contains('open')) return;
    container.classList.remove('open');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  _getInitialTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        if (stored === 'dark') return 'calm-dark';
        if (stored === 'light') return 'calm-light';
        if (this._themes.some((t) => t.id === stored)) {
          return stored;
        }
      }
    } catch {}
    return this._mediaQuery.matches ? 'studio-dark' : 'studio-light';
  }

  _onSystemChange(e) {
    // Only follow system when user hasn't stored a preference
    try { if (localStorage.getItem(STORAGE_KEY)) return; } catch {}
    this.set(e.matches ? 'studio-dark' : 'studio-light');
  }

  _syncColorScheme() {
    const meta = this.themeMeta;
    document.documentElement.style.colorScheme = meta.kind;
  }

  _dispatch() {
    document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: this._theme } }));
  }
}

export const themeManager = new ThemeManager();
