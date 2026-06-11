// Word-like UI primitives — framework-free DOM helpers. No TipTap import, so it
// stays decoupled from the editor (callers wire commands via callbacks).

const svg = (p) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const ICONS = {
  bold: svg('<path d="M5 3h4a2.4 2.4 0 0 1 0 5H5z"/><path d="M5 8h5a2.4 2.4 0 0 1 0 5H5z"/>'),
  italic: svg('<line x1="10.5" y1="3" x2="6.5" y2="13"/><line x1="7.5" y1="3" x2="11" y2="3"/><line x1="5" y1="13" x2="8.5" y2="13"/>'),
  underline: svg('<path d="M5 3v5a3 3 0 0 0 6 0V3"/><line x1="4" y1="14" x2="12" y2="14"/>'),
  strike: svg('<line x1="3" y1="8" x2="13" y2="8"/><path d="M5 5.4a3 1.8 0 0 1 6 0"/><path d="M5 10.6a3 1.8 0 0 0 6 0"/>'),
  sup: svg('<path d="M3 4l5 8M8 4l-5 8"/><path d="M11 4.5a1.2 1.2 0 1 1 2 .9c0 .8-2 1.3-2 2.1h2" stroke-width="1.2"/>'),
  sub: svg('<path d="M3 4l5 8M8 4l-5 8"/><path d="M11 9.5a1.2 1.2 0 1 1 2 .9c0 .8-2 1.3-2 2.1h2" stroke-width="1.2"/>'),
  smallcaps: svg('<text x="1.5" y="12" font-size="9" stroke="none" fill="currentColor">A</text><text x="8" y="12" font-size="6.5" stroke="none" fill="currentColor">A</text>'),
  alignLeft: svg('<line x1="3" y1="4" x2="13" y2="4"/><line x1="3" y1="8" x2="10" y2="8"/><line x1="3" y1="12" x2="12" y2="12"/>'),
  alignCenter: svg('<line x1="3" y1="4" x2="13" y2="4"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="4" y1="12" x2="12" y2="12"/>'),
  alignRight: svg('<line x1="3" y1="4" x2="13" y2="4"/><line x1="6" y1="8" x2="13" y2="8"/><line x1="4" y1="12" x2="13" y2="12"/>'),
  justify: svg('<line x1="3" y1="4" x2="13" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="13" y2="12"/>'),
  table: svg('<rect x="2.5" y="3" width="11" height="10" rx="1"/><line x1="2.5" y1="6.4" x2="13.5" y2="6.4"/><line x1="6.4" y1="3" x2="6.4" y2="13"/>'),
  image: svg('<rect x="2.5" y="3" width="11" height="10" rx="1"/><circle cx="6" cy="6.4" r="1"/><path d="M3 12l3-3 3 2 2-2 2 2"/>'),
  formula: svg('<path d="M9 3.5H7.2a1.4 1.4 0 0 0-1.4 1.4L4.3 12.5"/><line x1="3.2" y1="7.4" x2="7.2" y2="7.4"/><path d="M9.6 7.2l3 5M12.6 7.2l-3 5"/>'),
  quote: svg('<path d="M4 5h3v3a3 3 0 0 1-3 3z"/><path d="M9 5h3v3a3 3 0 0 1-3 3z"/>'),
  bullet: svg('<circle cx="3.4" cy="4" r=".9"/><circle cx="3.4" cy="8" r=".9"/><circle cx="3.4" cy="12" r=".9"/><line x1="6.4" y1="4" x2="13" y2="4"/><line x1="6.4" y1="8" x2="13" y2="8"/><line x1="6.4" y1="12" x2="13" y2="12"/>'),
  anchor: svg('<circle cx="8" cy="3.6" r="1.4"/><line x1="8" y1="5" x2="8" y2="13"/><path d="M3.6 9a4.4 4.4 0 0 0 8.8 0"/>'),
  xref: svg('<path d="M7 5l-3 3 3 3"/><path d="M4 8h6.5a2.5 2.5 0 0 0 2.5-2.5V3"/>'),
  note: svg('<path d="M4.5 2.5h5l3 3v8h-8z"/><line x1="6.5" y1="7" x2="10.5" y2="7"/><line x1="6.5" y1="9.5" x2="10.5" y2="9.5"/>'),
  pagebreak: svg('<path d="M5 2.5v3M11 2.5v3M5 13.5v-3M11 13.5v-3"/><line x1="3" y1="8" x2="13" y2="8" stroke-dasharray="2 1.6"/>'),
  undo: svg('<path d="M5.5 7H10a3 3 0 0 1 0 6H6.5"/><path d="M5.5 7l2.3-2.3M5.5 7l2.3 2.3"/>'),
  redo: svg('<path d="M10.5 7H6a3 3 0 0 0 0 6h2.5"/><path d="M10.5 7L8.2 4.7M10.5 7L8.2 9.3"/>'),
  clear: svg('<path d="M4 4l8 8M12 4l-8 8"/><line x1="3" y1="14.2" x2="13" y2="14.2"/>'),
  caret: svg('<path d="M4.5 6.5l3.5 3.5 3.5-3.5"/>'),
  color: svg('<path d="M5 12l3-8 3 8"/><line x1="6" y1="9.5" x2="10" y2="9.5"/>'),
  highlight: svg('<path d="M9 3l4 4-6 6H4v-3z"/><line x1="3" y1="14.2" x2="13" y2="14.2"/>'),
  bAll: svg('<rect x="2.5" y="2.5" width="11" height="11"/><line x1="8" y1="2.5" x2="8" y2="13.5"/><line x1="2.5" y1="8" x2="13.5" y2="8"/>'),
  bNone: svg('<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 2"/>'),
  bOut: svg('<rect x="2.5" y="2.5" width="11" height="11"/>'),
  rowAdd: svg('<rect x="2.5" y="3" width="11" height="4" rx="1"/><line x1="8" y1="9.5" x2="8" y2="13.5"/><line x1="6" y1="11.5" x2="10" y2="11.5"/>'),
  colAdd: svg('<rect x="3" y="2.5" width="4" height="11" rx="1"/><line x1="11.5" y1="8" x2="11.5" y2="8.01"/><line x1="9.5" y1="8" x2="13.5" y2="8"/><line x1="11.5" y1="6" x2="11.5" y2="10"/>'),
  rowDel: svg('<rect x="2.5" y="3" width="11" height="4" rx="1"/><line x1="6" y1="11.5" x2="10" y2="11.5"/>'),
  colDel: svg('<rect x="3" y="2.5" width="4" height="11" rx="1"/><line x1="9.5" y1="8" x2="13.5" y2="8"/>'),
  merge: svg('<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M6 8h4M8 6l2 2-2 2"/>'),
  trash: svg('<path d="M4 4.5h8M6.5 4.5V3h3v1.5M5.5 4.5l.5 9h4l.5-9"/>'),
};

// A toolbar button. mousedown→preventDefault keeps the editor selection alive.
export function tbtn({ label, icon, title, onClick, dataKey, wide, cls }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tbtn' + (wide ? ' tbtn-wide' : '') + (cls ? ' ' + cls : '');
  b.title = title || '';
  if (icon && ICONS[icon]) b.innerHTML = ICONS[icon];
  if (label != null) b.append(document.createTextNode(label));
  if (dataKey) b.dataset.k = dataKey;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => onClick(b));
  return b;
}

export function sep() { const s = document.createElement('span'); s.className = 'rg-sep'; return s; }

// A ribbon group: a row of controls with a small caption underneath (Word-style).
export function ribbonGroup(caption, nodes) {
  const g = document.createElement('div');
  g.className = 'rg';
  const body = document.createElement('div');
  body.className = 'rg-body';
  nodes.forEach((n) => n && body.appendChild(n));
  g.appendChild(body);
  if (caption) {
    const c = document.createElement('div');
    c.className = 'rg-cap'; c.textContent = caption;
    g.appendChild(c);
  }
  return g;
}

let openPop = null;
export function closePopover() {
  if (!openPop) return;
  openPop.pop.remove();
  document.removeEventListener('mousedown', openPop.onDoc);
  document.removeEventListener('keydown', openPop.onKey);
  openPop = null;
}
export function popover(anchor, build) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'pop';
  build(pop, closePopover);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  document.addEventListener('keydown', onKey);
  openPop = { pop, onDoc, onKey };
  return pop;
}

// A reusable color-swatch popover body. `colors` = [{name,hex}].
export function colorGrid(colors, onPick, onClear, title = 'Cores do tema') {
  return (pop, close) => {
    const t = document.createElement('div'); t.className = 'pop-title'; t.textContent = title;
    pop.appendChild(t);
    const grid = document.createElement('div'); grid.className = 'swatch-grid';
    for (const c of colors) {
      const sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'swatch'; sw.style.background = '#' + c.hex; sw.title = c.name;
      sw.addEventListener('mousedown', (e) => e.preventDefault());
      sw.addEventListener('click', () => { onPick(c); close(); });
      grid.appendChild(sw);
    }
    pop.appendChild(grid);
    if (onClear) {
      const cl = document.createElement('button');
      cl.type = 'button'; cl.className = 'pop-clear';
      cl.innerHTML = ICONS.clear + '<span>Automática / sem cor</span>';
      cl.addEventListener('mousedown', (e) => e.preventDefault());
      cl.addEventListener('click', () => { onClear(); close(); });
      pop.appendChild(cl);
    }
  };
}

// A dropdown menu popover body from [{label, onClick, active}] items.
export function menu(items) {
  return (pop, close) => {
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; pop.appendChild(s); continue; }
      const mi = document.createElement('button');
      mi.type = 'button'; mi.className = 'menu-item' + (it.active ? ' is-active' : '');
      mi.textContent = it.label;
      mi.addEventListener('mousedown', (e) => e.preventDefault());
      mi.addEventListener('click', () => { it.onClick(); close(); });
      pop.appendChild(mi);
    }
  };
}

// A modal dialog built from a declarative field list. Returns a Promise that
// resolves to a {key: value} map on submit, or null on cancel/Esc/✕/backdrop.
// Field types: text | textarea | checkbox | segmented | custom (a div the
// caller fills via onBuild, e.g. a live preview). text supports `datalist`.
export function dialog({ title, fields, submitLabel = 'Inserir', onBuild }) {
  closePopover();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay';
    const card = document.createElement('div');
    card.className = 'dlg';
    const h = document.createElement('div'); h.className = 'dlg-title'; h.textContent = title;
    const body = document.createElement('div'); body.className = 'dlg-body';
    const els = {};
    for (const f of fields) {
      const row = document.createElement('div');
      row.className = 'dlg-field' + (f.type === 'checkbox' ? ' dlg-check' : '');
      if (f.label && f.type !== 'checkbox') {
        const lab = document.createElement('label'); lab.className = 'dlg-lab'; lab.textContent = f.label;
        row.appendChild(lab);
      }
      let el;
      if (f.type === 'textarea') {
        el = document.createElement('textarea'); el.rows = f.rows || 3;
        el.value = f.value || ''; el.placeholder = f.placeholder || '';
      } else if (f.type === 'checkbox') {
        el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!f.value;
        const lab = document.createElement('label'); lab.className = 'dlg-lab';
        lab.append(el, document.createTextNode(' ' + (f.label || '')));
        row.appendChild(lab);
      } else if (f.type === 'segmented') {
        el = document.createElement('div'); el.className = 'dlg-seg';
        el.dataset.value = f.value || (f.options[0] && f.options[0].value);
        for (const o of f.options) {
          const b = document.createElement('button'); b.type = 'button'; b.textContent = o.label; b.dataset.v = o.value;
          if (o.value === el.dataset.value) b.classList.add('on');
          b.addEventListener('click', () => { el.dataset.value = o.value; [...el.children].forEach((c) => c.classList.toggle('on', c.dataset.v === o.value)); });
          el.appendChild(b);
        }
      } else if (f.type === 'custom') {
        el = document.createElement('div'); el.className = 'dlg-custom';
      } else {
        el = document.createElement('input'); el.type = 'text';
        el.value = f.value || ''; el.placeholder = f.placeholder || '';
        if (f.datalist && f.datalist.length) {
          const dl = document.createElement('datalist'); dl.id = 'dl-' + f.key + '-' + Math.floor(performance.now());
          for (const o of f.datalist) { const opt = document.createElement('option'); opt.value = o; dl.appendChild(opt); }
          el.setAttribute('list', dl.id); row.appendChild(dl);
        }
      }
      if (f.type !== 'checkbox') row.appendChild(el);
      els[f.key] = el;
      body.appendChild(row);
    }
    const getValues = () => {
      const v = {};
      for (const f of fields) {
        const el = els[f.key];
        if (f.type === 'checkbox') v[f.key] = el.checked;
        else if (f.type === 'segmented') v[f.key] = el.dataset.value;
        else if (f.type === 'custom') continue;
        else v[f.key] = el.value;
      }
      return v;
    };
    const foot = document.createElement('div'); foot.className = 'dlg-foot';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'dlg-btn'; cancel.textContent = 'Cancelar';
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'dlg-btn dlg-ok'; ok.textContent = submitLabel;
    foot.append(cancel, ok);
    card.append(h, body, foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); close(getValues()); }
    };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(getValues()));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
    if (onBuild) onBuild(els, getValues);
    const first = body.querySelector('input:not([type=checkbox]), textarea');
    if (first) setTimeout(() => first.focus(), 0);
  });
}
