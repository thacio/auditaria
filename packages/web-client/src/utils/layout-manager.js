/**
 * LayoutManager - handles layout switching and persistence.
 *
 * Uses data-layout on <html> and emits a 'layoutchange' event.
 */

const STORAGE_KEY = 'auditaria-layout';
const LAYOUT_EVENT = 'layoutchange';

const LAYOUTS = [
  {
    id: 'workbench',
    label: 'Workbench',
    description: 'Pinned panels, balanced workspace',
  },
  {
    id: 'wide',
    label: 'Wide',
    description: 'More space for chat and previews',
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter chrome, denser layout',
  },
];

class LayoutManager {
  constructor() {
    this._layouts = LAYOUTS;
    this._layout = this._getInitialLayout();
    document.documentElement.setAttribute('data-layout', this._layout);
  }

  /** Current layout id */
  get layout() {
    return this._layout;
  }

  /** Current layout metadata */
  get layoutMeta() {
    return this._layouts.find((layout) => layout.id === this._layout) || this._layouts[0];
  }

  /** List of available layouts */
  getLayouts() {
    return [...this._layouts];
  }

  /** Set a layout and persist */
  set(layoutId) {
    const target = this._layouts.find((layout) => layout.id === layoutId);
    if (!target) return;

    document.documentElement.classList.add('layout-transitioning');
    this._layout = target.id;
    document.documentElement.setAttribute('data-layout', target.id);
    try { localStorage.setItem(STORAGE_KEY, target.id); } catch {}
    this._dispatch();
    setTimeout(() => {
      document.documentElement.classList.remove('layout-transitioning');
    }, 200);
  }

  /** Attach the layout picker UI to a container */
  mountPicker(container) {
    if (!container) return;

    container.innerHTML = '';
    container.classList.add('layout-picker');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layout-picker-button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'layout-picker-menu';
    menu.setAttribute('role', 'menu');

    container.appendChild(button);
    container.appendChild(menu);

    const renderMenu = () => {
      menu.innerHTML = '';
      this._layouts.forEach((layout) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'layout-picker-item';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('data-layout', layout.id);
        item.setAttribute('aria-checked', String(layout.id === this._layout));

        const label = document.createElement('span');
        label.className = 'layout-item-label';
        label.textContent = layout.label;

        const desc = document.createElement('span');
        desc.className = 'layout-item-desc';
        desc.textContent = layout.description;

        item.appendChild(label);
        item.appendChild(desc);

        item.addEventListener('click', () => {
          this._closePicker(container, button);
          this.set(layout.id);
        });

        menu.appendChild(item);
      });
    };

    const updateButton = () => {
      const meta = this.layoutMeta;
      button.innerHTML = '';

      const icon = document.createElement('span');
      icon.className = 'layout-picker-icon';
      icon.textContent = 'Layout';

      const text = document.createElement('span');
      text.className = 'layout-picker-label';
      text.textContent = meta.label;

      const caret = document.createElement('span');
      caret.className = 'layout-picker-caret';
      caret.textContent = 'v';

      button.appendChild(icon);
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
    document.addEventListener(LAYOUT_EVENT, () => {
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

  _getInitialLayout() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && this._layouts.some((layout) => layout.id === stored)) {
        return stored;
      }
    } catch {}
    return 'workbench';
  }

  _dispatch() {
    document.dispatchEvent(new CustomEvent(LAYOUT_EVENT, { detail: { layout: this._layout } }));
  }
}

export const layoutManager = new LayoutManager();
