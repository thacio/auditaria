// Custom TipTap nodes for TCU constructs that have no native equivalent.
// These are pure structure: they carry attrs that map 1:1 to the AST, so the
// editor never needs to know the markdown syntax (Python owns that).
import { Node, Extension, Mark } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextStyle from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import katex from 'katex';
import { dialog } from './ui.js';
import { blockCss, setBlockIndentRaw } from './ast-bridge.js';

// LaTeX formula ($…$ inline, $$…$$ display) rendered with KaTeX. Atom node;
// double-click to edit the LaTeX.
export const Formula = Node.create({
  name: 'formula',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' }, display: { default: false } };
  },
  parseHTML() { return [{ tag: 'span[data-formula]' }]; },
  renderHTML({ node }) {
    return ['span', { 'data-formula': '', class: 'formula' },
      (node.attrs.display ? '$$' : '$') + node.attrs.latex + (node.attrs.display ? '$$' : '$')];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span');
      dom.className = 'formula' + (node.attrs.display ? ' formula-display' : '');
      dom.setAttribute('data-formula', '');
      dom.contentEditable = 'false';
      try {
        katex.render(node.attrs.latex, dom, { displayMode: !!node.attrs.display, throwOnError: false });
      } catch (e) {
        dom.textContent = '$' + node.attrs.latex + '$';
      }
      dom.title = 'Duplo-clique para editar (LaTeX)';
      dom.addEventListener('dblclick', async () => {
        const v = await dialog({
          title: 'Editar fórmula (LaTeX)', submitLabel: 'Salvar',
          fields: [
            { key: 'latex', type: 'textarea', label: 'LaTeX', value: node.attrs.latex, rows: 2 },
            { key: 'display', type: 'checkbox', label: 'Em destaque (centralizada)', value: !!node.attrs.display },
            { key: 'preview', type: 'custom', label: 'Pré-visualização' },
          ],
          onBuild: (els) => {
            const r = () => { try { katex.render(els.latex.value || '\\,', els.preview, { displayMode: els.display.checked, throwOnError: false }); } catch (e) { els.preview.textContent = String((e && e.message) || e); } };
            els.latex.addEventListener('input', r); els.display.addEventListener('change', r); r();
          },
        });
        if (v == null || typeof getPos !== 'function') return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, latex: v.latex, display: v.display }));
      });
      return { dom };
    };
  },
});

// Colour marks carry the ORIGINAL authored token (e.g. "000000", "red",
// "#548DD4") alongside the CSS value used for display, so round-tripping is
// lossless — we never rewrite "000000" to "black". Model-only (rendered:false).
export const TcuTextStyle = TextStyle.extend({
  addAttributes() { return { ...this.parent?.(), tcuColor: { default: null, rendered: false } }; },
});
export const TcuHighlight = Highlight.extend({
  addAttributes() { return { ...this.parent?.(), tcuColor: { default: null, rendered: false } }; },
});

// Remember whether bold/italic/underline came from brace syntax ({bold}…{/bold})
// vs star/caret (**…**, ^^…^^) so we re-emit in the SAME form (no churn). Adds a
// model-only attribute to the existing marks (no mark replacement needed).
export const MarkStyle = Extension.create({
  name: 'markStyle',
  addGlobalAttributes() {
    return [
      { types: ['bold', 'italic', 'underline'], attributes: { tcuStyle: { default: null, rendered: false } } },
      // size/font ({size:N}, {font:X}) live on textStyle alongside colour.
      // block-level attributes ({center}, {size:N}, {space-after:Npt}, ...) on
      // paragraphs/headings. tcuBlockRaw round-trips; tcuBlockCss renders;
      // tcuAlign is exposed for toolbar active-state.
      {
        types: ['paragraph', 'heading'],
        attributes: {
          tcuBlockRaw: { default: null, rendered: false },
          tcuAlign: { default: null, rendered: false },
          tcuBlockCss: {
            default: null,
            parseHTML: () => null,
            renderHTML: (a) => (a.tcuBlockCss ? { style: a.tcuBlockCss } : {}),
          },
        },
      },
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => el.style.fontSize || null,
            renderHTML: (a) => (a.fontSize
              ? { style: `font-size:${/^[\d.]+$/.test(a.fontSize) ? a.fontSize + 'pt' : a.fontSize}` } : {}),
          },
          fontFamily: {
            default: null,
            parseHTML: (el) => el.style.fontFamily || null,
            renderHTML: (a) => (a.fontFamily ? { style: `font-family:${a.fontFamily}` } : {}),
          },
        },
      },
    ];
  },
});

// Flag inline attributes with no native mark: one CSS-styled mark each so they
// render (and round-trip via their name).
const cssMark = (name, style) => Mark.create({
  name,
  parseHTML() { return [{ tag: `span[data-m="${name}"]` }]; },
  renderHTML() { return ['span', { 'data-m': name, style }, 0]; },
});
export const Superscript = cssMark('superscript', 'vertical-align:super;font-size:.8em');
export const Subscript = cssMark('subscript', 'vertical-align:sub;font-size:.8em');
export const SmallCaps = cssMark('smallcaps', 'font-variant:small-caps');
export const AllCaps = cssMark('allcaps', 'text-transform:uppercase');
export const DoubleStrike = cssMark('doubleStrike', 'text-decoration:line-through;text-decoration-style:double');
export const Emboss = cssMark('emboss', 'color:#777;text-shadow:0 1px 1px rgba(255,255,255,.8)');
export const Imprint = cssMark('imprint', 'color:#888;text-shadow:0 -1px 1px rgba(0,0,0,.4)');
export const Outline = cssMark('outline', '-webkit-text-stroke:.4px currentColor;color:transparent');
export const Shadow = cssMark('shadow', 'text-shadow:1px 1px 1px rgba(0,0,0,.45)');
export const Hidden = cssMark('hidden', 'opacity:.35');
export const ATTR_MARKS = [Superscript, Subscript, SmallCaps, AllCaps, DoubleStrike, Emboss, Imprint, Outline, Shadow, Hidden];

// Native TipTap tables, extended to carry the TCU header strings (row label,
// cell "Col {attrs}") so colspan/bg/merge/etc. survive untouched. The extra
// attrs are model-only (rendered:false) so they don't leak into the DOM.
// Cell background from the source bg:RRGGBB attr, applied so merged/coloured
// tables look closer to the Word output.
const cellBg = (parent, extra) => ({
  ...parent,
  tcuHeaderRaw: { default: '', rendered: false },
  tcuSrc: { default: null, rendered: false },   // "row,cell" pointer back into the stashed original
  // Display-only CSS (bg + borders + align) computed by the bridge; the
  // authoritative attrs round-trip via the cell headerRaw / markdown attrs.
  tcuCss: {
    default: null,
    renderHTML: (attrs) => (attrs.tcuCss ? { style: attrs.tcuCss } : {}),
  },
  ...extra,
});

export const TcuTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tcuSyntax: { default: 'block', rendered: false },   // 'block' (:::table) | 'markdown' (| a | b |)
      tcuCaption: { default: null, rendered: false },     // markdown caption line
      tcuHeader: { default: 'table', rendered: false },
      tcuColumnDefaults: { default: [], rendered: false },
      tcuRowDefaults: { default: [], rendered: false },
      tcuOriginal: { default: null, rendered: false },    // stashed original AST for merged tables
    };
  },
});
export const TcuTableRow = TableRow.extend({
  addAttributes() { return { ...this.parent?.(), tcuHeaderRaw: { default: '', rendered: false } }; },
});
export const TcuTableCell = TableCell.extend({
  addAttributes() { return cellBg(this.parent?.()); },
});
export const TcuTableHeader = TableHeader.extend({
  addAttributes() { return cellBg(this.parent?.()); },
});

// Word-like fixed-width tables: dragging a column edge redistributes width with
// the neighbour instead of growing the table past the page. The total is pinned
// to the A4 content width (16cm ≈ 605px); the .docx then fits the page.
export const TABLE_TARGET_PX = 605; // 16cm A4 content width (full-page table)
export function tableGridWidths(table) {
  const row0 = table.firstChild;
  if (!row0) return [];
  const ws = [];
  row0.forEach((cell) => {
    const cw = cell.attrs.colwidth;
    const span = cell.attrs.colspan || 1;
    for (let k = 0; k < span; k++) ws.push((cw && cw[k]) || 0);
  });
  return ws;
}
function rebalanceWidths(newW, oldW, T) {
  const n = newW.length;
  if (n < 2) return null;
  const eq = T / n;
  const w = newW.map((x) => x || eq);
  const ow = oldW.map((x) => x || eq);
  let changed = -1, best = 0.5;
  for (let i = 0; i < n; i++) { const d = Math.abs(w[i] - ow[i]); if (d > best) { best = d; changed = i; } }
  if (changed < 0) return null;
  const MIN = 24;
  const delta = w[changed] - ow[changed];
  const nb = changed + 1 < n ? changed + 1 : changed - 1;
  w[nb] = Math.max(MIN, ow[nb] - delta);
  const others = w.reduce((s, x, i) => (i === changed ? s : s + x), 0);
  w[changed] = Math.max(MIN, T - others);
  return w.map((x) => Math.round(x));
}
export function applyGridWidths(tr, table, tablePos, gridW) {
  const occ = {};
  let r = 0;
  table.forEach((row, rowOff) => {
    let c = 0;
    row.forEach((cell, cellOff) => {
      while (occ[r + ',' + c]) c++;
      const span = cell.attrs.colspan || 1;
      const rs = cell.attrs.rowspan || 1;
      const slice = gridW.slice(c, c + span);
      const cellPos = tablePos + 2 + rowOff + cellOff;
      tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, colwidth: slice });
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < span; dc++) if (dr || dc) occ[(r + dr) + ',' + (c + dc)] = true;
      c += span;
    });
    r++;
  });
}
export const FixedTableWidth = Extension.create({
  name: 'fixedTableWidth',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('fixedTableWidth'),
      appendTransaction(trs, oldState, newState) {
        if (!trs.some((tr) => tr.docChanged)) return null;
        if (trs.some((tr) => tr.getMeta('balanceTable'))) return null;
        // Only react to attribute-only edits (a column resize) — never to
        // content edits, loads or inserts (which change the document size).
        if (newState.doc.content.size !== oldState.doc.content.size) return null;
        let tr = null;
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== 'table') return;
          const oldNode = oldState.doc.nodeAt(pos);
          if (!oldNode || oldNode.type.name !== 'table' || oldNode.childCount !== node.childCount) return;
          const newW = tableGridWidths(node);
          const oldW = tableGridWidths(oldNode);
          if (newW.length < 2 || newW.length !== oldW.length) return;
          if (newW.every((w, i) => w === oldW[i])) return; // not a width change
          // Preserve the table's current total width (so a human-set narrower
          // table stays narrow); default to full page only when unset.
          const allSet = oldW.every((x) => x > 0);
          const T = allSet ? Math.min(oldW.reduce((a, b) => a + b, 0), TABLE_TARGET_PX) : TABLE_TARGET_PX;
          const balanced = rebalanceWidths(newW, oldW, T);
          if (!balanced) return;
          if (!tr) tr = newState.tr;
          applyGridWidths(tr, node, pos, balanced);
        });
        if (tr) { tr.setMeta('balanceTable', true); return tr; }
        return null;
      },
    })];
  },
});

// Live paragraph numbering shown as DECORATIONS (never stored in the model, so
// numbers can't leak into the .md). Replicates the parser's numbering_stack
// algorithm exactly: a numbered paragraph is level 0, a multilevel `+` item is
// level (indent/2); stack[level]++ resets deeper levels; the label is the
// non-zero prefix joined by '.'. The generated .docx remains authoritative.
export const autoNumberState = { enabled: true };

export const AutoNumber = Extension.create({
  name: 'autoNumber',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('autoNumber'),
      props: {
        decorations(state) {
          if (!autoNumberState.enabled) return DecorationSet.empty;
          const decos = [];
          const stack = new Array(10).fill(0);
          state.doc.forEach((node, offset) => {
            let level = null;
            if (node.type.name === 'paragraph' && node.content.size > 0) level = 0;
            else if (node.type.name === 'tcuListItem' && node.attrs.listType === 'multilevel')
              level = Math.floor((node.attrs.indent || 0) / 2);
            if (level === null) return;
            stack[level] += 1;
            for (let i = level + 1; i < stack.length; i++) stack[i] = 0;
            const parts = [];
            for (let i = 0; i <= level; i++) if (stack[i] > 0) parts.push(stack[i]);
            const label = parts.join('.') + (level === 0 ? '.' : '') + ' ';
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'numbered' }));
            decos.push(Decoration.widget(offset + 1, () => {
              const s = document.createElement('span');
              s.className = 'auto-number';
              s.textContent = label;
              s.contentEditable = 'false';
              return s;
            }, { side: -1, key: 'n:' + offset + ':' + label }));
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});

// Cross-reference anchor  {#para:id}  -> a non-editable chip.
export const XrefAnchor = Node.create({
  name: 'xrefAnchor',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { refType: { default: 'para' }, id: { default: '' } };
  },
  parseHTML() { return [{ tag: 'span[data-xref-anchor]' }]; },
  renderHTML({ node }) {
    return ['span', {
      'data-xref-anchor': '', class: 'chip chip-anchor',
      title: `âncora ${node.attrs.refType}:${node.attrs.id}`,
    }, `⚓ ${node.attrs.id}`];
  },
});

// Cross-reference  [@para:id]  -> a non-editable chip (number resolved by parser).
export const XrefRef = Node.create({
  name: 'xrefRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { refType: { default: 'para' }, id: { default: '' }, short: { default: false } };
  },
  parseHTML() { return [{ tag: 'span[data-xref-ref]' }]; },
  renderHTML({ node }) {
    return ['span', {
      'data-xref-ref': '', class: 'chip chip-ref',
      title: `referência ${node.attrs.refType}:${node.attrs.id}`,
    }, `↪ ${node.attrs.id}`];
  },
});

// Endnote / footnote {^endnote:id}citation{/endnote} (and bare reuse) — a
// superscript chip; the citation body is stored verbatim and editable.
export const Endnote = Node.create({
  name: 'endnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { noteType: { default: 'endnote' }, id: { default: '' }, body: { default: '' }, reuse: { default: false } };
  },
  parseHTML() { return [{ tag: 'sup[data-endnote]' }]; },
  renderHTML({ node }) {
    const plain = (node.attrs.body || '').replace(/\{\/?[^}]*\}/g, '').slice(0, 120);
    return ['sup', {
      'data-endnote': '', class: 'endnote-chip',
      title: (node.attrs.reuse ? '(reuso) ' : '') + (plain || node.attrs.id),
    }, node.attrs.id];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const sup = document.createElement('sup');
      sup.className = 'endnote-chip'; sup.setAttribute('data-endnote', '');
      sup.textContent = node.attrs.id;
      sup.title = (node.attrs.reuse ? '(reuso) ' : '') + ((node.attrs.body || '').replace(/\{\/?[^}]*\}/g, '').slice(0, 120) || node.attrs.id);
      if (!node.attrs.reuse) {
        sup.addEventListener('dblclick', async () => {
          const v = await dialog({
            title: 'Editar nota', submitLabel: 'Salvar',
            fields: [{ key: 'body', type: 'textarea', label: 'Texto da nota', value: node.attrs.body || '', rows: 3 }],
          });
          if (v == null || typeof getPos !== 'function') return;
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, body: v.body }));
        });
      }
      return { dom: sup };
    };
  },
});

// A list item in the TCU flat/marker-based list model. Top-level block; runs of
// these are regrouped into an AST `list` on export.
export const TcuListItem = Node.create({
  name: 'tcuListItem',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      listType: { default: 'bullet' },
      marker: { default: '-' },
      indent: { default: 0 },
    };
  },
  parseHTML() { return [{ tag: 'div[data-tcu-li]' }]; },
  renderHTML({ node }) {
    const a = node.attrs;
    const label = a.listType === 'bullet' ? '•'
      : a.listType === 'multilevel' ? ''
      : `${a.marker})`;
    // No left indent: the parser renders hierarchical `+` paragraphs and nested
    // lists flush-left (left_indent=None) — hierarchy shows via the number
    // (7.1.1, from the AutoNumber decoration) / marker, not via indentation.
    return ['div', {
      'data-tcu-li': '', class: 'tcu-li',
    },
      ['span', { class: 'tcu-marker', contenteditable: 'false' }, `${label} `],
      ['span', { class: 'tcu-li-body' }, 0],
    ];
  },
});

// Image / figure: ![alt](src){width=..} with an optional {#fig:id caption=".."}.
export const TcuImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: '' }, alt: { default: '' }, opts: { default: '' }, caption: { default: null } };
  },
  parseHTML() { return [{ tag: 'figure[data-fig] img' }]; },
  renderHTML({ node }) {
    const w = (/width[=:]\s*([\d.]+(?:%|pt|cm|mm|in|px)?)/.exec(node.attrs.opts || '') || [])[1];
    const style = w ? `max-width:${/[a-z%]$/.test(w) ? w : w + 'px'}` : 'max-width:100%';
    const cap = node.attrs.caption
      ? (/caption[=:]\s*"([^"]*)"/.exec(node.attrs.caption) || [, ''])[1] : '';
    return ['figure', { 'data-fig': '', class: 'fig' },
      ['img', { src: node.attrs.src, alt: node.attrs.alt, style }],
      ['figcaption', {}, cap]];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const fig = document.createElement('figure');
      fig.className = 'fig'; fig.setAttribute('data-fig', '');
      const w = (/width[=:]\s*([\d.]+(?:%|pt|cm|mm|in|px)?)/.exec(node.attrs.opts || '') || [])[1];
      const img = document.createElement('img');
      img.src = node.attrs.src; img.alt = node.attrs.alt;
      img.style.maxWidth = w ? (/[a-z%]$/.test(w) ? w : w + 'px') : '100%';
      const cap = document.createElement('figcaption');
      cap.textContent = node.attrs.caption
        ? (/caption[=:]\s*"([^"]*)"/.exec(node.attrs.caption) || [, ''])[1] : '';
      fig.title = 'Duplo-clique para editar a legenda';
      fig.addEventListener('dblclick', async () => {
        const v = await dialog({
          title: 'Legenda da figura', submitLabel: 'Salvar',
          fields: [{ key: 'caption', type: 'text', label: 'Legenda (vazio = sem legenda)', value: cap.textContent || '' }],
        });
        if (v == null || typeof getPos !== 'function') return;
        const id = (/#fig:([\w-]+)/.exec(node.attrs.caption || '') || [, 'fig1'])[1];
        const text = (v.caption || '').trim();
        const caption = text ? `{#fig:${id} caption="${text}"}` : null;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, caption }));
      });
      fig.append(img, cap);
      return { dom: fig };
    };
  },
});

// Make a card-style block collapsible: clicking its header toggles a chevron and
// hides the body element(s). Display-only (never touches the document/.md).
function addCollapse(dom, headerEl, ...bodyEls) {
  const tog = document.createElement('span');
  tog.className = 'collapse-tog';
  tog.textContent = '▾';
  headerEl.prepend(tog);
  headerEl.classList.add('collapsible');
  headerEl.title = 'Recolher / expandir';
  headerEl.addEventListener('mousedown', (e) => e.preventDefault());
  headerEl.addEventListener('click', (e) => {
    if (e.target.closest('input, textarea, select, .fm-chip, button:not(.collapse-tog)')) return;
    const collapsed = dom.classList.toggle('is-collapsed');
    tog.textContent = collapsed ? '▸' : '▾';
    for (const b of bodyEls) if (b) b.style.display = collapsed ? 'none' : '';
  });
}

// ::: structural blocks rendered as proper widgets (not code boxes).
export const PageBreak = Node.create({
  name: 'pageBreak', group: 'block', atom: true, selectable: true,
  parseHTML() { return [{ tag: 'div[data-pagebreak]' }]; },
  renderHTML() { return ['div', { 'data-pagebreak': '', class: 'page-break' }, 'Quebra de página']; },
});

// Table of contents (:::summary). The parser emits a Word TOC field built from
// the heading styles; here it's a placeholder card (Word fills the real entries).
// opts carries the raw fence options verbatim (title:"…" depth:N) for round-trip.
export const Summary = Node.create({
  name: 'summary', group: 'block', atom: true, selectable: true, draggable: false,
  addAttributes() { return { opts: { default: '' } }; },
  parseHTML() { return [{ tag: 'div[data-summary]' }]; },
  renderHTML() { return ['div', { 'data-summary': '', class: 'summary-card' }]; },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'summary-card'; dom.setAttribute('data-summary', '');
      dom.contentEditable = 'false';
      let cur = node;
      const draw = (n) => {
        const opts = n.attrs.opts || '';
        const title = (/title:"([^"]*)"/.exec(opts) || [, ''])[1] || 'Sumário';
        const depth = (/depth:(\d+)/.exec(opts) || [, '3'])[1];
        dom.innerHTML = '';
        const t = document.createElement('div'); t.className = 'summary-title'; t.textContent = '▤ ' + title;
        const note = document.createElement('div'); note.className = 'summary-note';
        note.textContent = 'Sumário gerado automaticamente dos títulos (níveis 1–' + depth + '). Duplo-clique para editar.';
        dom.append(t, note);
      };
      draw(cur);
      dom.addEventListener('dblclick', async () => {
        const opts = cur.attrs.opts || '';
        const v = await dialog({
          title: 'Sumário (tabela de conteúdo)', submitLabel: 'Salvar',
          fields: [
            { key: 'title', type: 'text', label: 'Título (vazio = "Sumário")', value: (/title:"([^"]*)"/.exec(opts) || [, ''])[1] },
            { key: 'depth', type: 'segmented', label: 'Profundidade (níveis de título)', value: (/depth:(\d+)/.exec(opts) || [, '3'])[1], options: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }] },
          ],
        });
        if (v == null || typeof getPos !== 'function') return;
        const parts = [];
        if ((v.title || '').trim()) parts.push('title:"' + v.title.trim() + '"');
        if (v.depth && v.depth !== '3') parts.push('depth:' + v.depth);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...cur.attrs, opts: parts.join(' ') }));
      });
      return { dom, update: (n) => { if (n.type.name !== 'summary') return false; cur = n; draw(n); return true; }, ignoreMutation: () => true, stopEvent: () => true };
    };
  },
});
export const PageOrientation = Node.create({
  name: 'pageOrientation', group: 'block', atom: true, selectable: true,
  addAttributes() { return { orientation: { default: 'landscape' } }; },
  parseHTML() { return [{ tag: 'div[data-pageorient]' }]; },
  renderHTML({ node }) {
    return ['div', { 'data-pageorient': '', class: 'page-orient' },
      '⟳ Orientação: ' + (node.attrs.orientation === 'landscape' ? 'paisagem' : 'retrato')];
  },
});
export const FigureGrid = Node.create({
  name: 'figureGrid', group: 'block', atom: true, selectable: true,
  addAttributes() {
    return { opts: { default: '' }, caption: { default: null }, raw: { default: '' }, images: { default: [] } };
  },
  parseHTML() { return [{ tag: 'figure[data-figgrid]' }]; },
  addNodeView() {
    return ({ node }) => {
      const fig = document.createElement('figure');
      fig.className = 'fig-grid'; fig.setAttribute('data-figgrid', '');
      const cols = (/cols[=:]\s*(\d+)/.exec(node.attrs.opts || '') || [, 2])[1];
      const grid = document.createElement('div');
      grid.className = 'fig-grid-inner';
      grid.style.gridTemplateColumns = `repeat(${cols},1fr)`;
      for (const im of (node.attrs.images || [])) {
        const img = document.createElement('img');
        img.src = im.src; img.alt = im.alt || ''; grid.appendChild(img);
      }
      fig.appendChild(grid);
      if (node.attrs.caption) {
        const cap = document.createElement('figcaption');
        cap.textContent = (/caption[=:]\s*"([^"]*)"/.exec(node.attrs.caption) || [, ''])[1];
        fig.appendChild(cap);
      }
      return { dom: fig };
    };
  },
});
const rawListNode = (name, label) => Node.create({
  name, group: 'block', atom: true, selectable: true,
  addAttributes() { return { raw: { default: '' } }; },
  addNodeView() {
    return ({ node }) => {
      const box = document.createElement('div');
      box.className = 'listish';
      const tag = document.createElement('div');
      tag.className = 'listish-tag'; tag.textContent = label;
      const body = document.createElement('div');
      body.className = 'listish-body';
      for (const ln of (node.attrs.raw || '').split('\n')) {
        if (!ln.trim()) continue;
        const li = document.createElement('div'); li.className = 'listish-li'; li.textContent = ln;
        body.appendChild(li);
      }
      box.append(tag, body);
      addCollapse(box, tag, body);
      return { dom: box };
    };
  },
});
export const ContinueList = rawListNode('continueList', 'Lista (continuação)');
export const RawList = rawListNode('rawList', 'Lista (formatação literal)');

// Document metadata: a simple, fully-free YAML editor (like the preamble). The
// known variables are quick-insert chips whose names + tooltip descriptions
// come entirely from the parser manifest (the metaVars option, set by the host
// from spec.metadataFields = the complete list of {name, description, format}).
function buildMetaCard(dom, node, editor, getPos, metaVars) {
  dom.innerHTML = '';
  const elx = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const head = elx('div', 'fm-head', 'Metadados do documento (YAML)');
  const ta = elx('textarea', 'fm-yaml');
  ta.value = node.attrs.raw || '';
  ta.spellcheck = false;
  ta.placeholder = 'tipo: instrucao\nprocesso: TC 000.000/0000-0\n…';

  const commit = () => {
    if (typeof getPos === 'function') {
      editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, raw: ta.value }));
    }
  };
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 4, 360) + 'px'; };
  let timer;
  ta.addEventListener('input', () => { fit(); clearTimeout(timer); timer = setTimeout(commit, 300); });
  ta.addEventListener('blur', commit); // ensures export (which blurs the field) always sees the latest

  const chips = elx('div', 'fm-chips');
  chips.appendChild(elx('span', 'fm-chips-lab', 'Inserir variável:'));
  for (const f of (metaVars || [])) {
    const name = (typeof f === 'string') ? f : f.name;
    const chip = elx('button', 'fm-chip', name);
    chip.type = 'button';
    chip.title = (typeof f === 'string') ? name : (f.description + (f.format ? '  ·  ' + f.format : ''));
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', () => {
      const pos = (ta.selectionStart != null) ? ta.selectionStart : ta.value.length;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);
      const ins = (before && !before.endsWith('\n') ? '\n' : '') + name + ': ';
      ta.value = before + ins + after;
      const cp = (before + ins).length;
      ta.focus();
      ta.setSelectionRange(cp, cp);
      fit();
      commit();
    });
    chips.appendChild(chip);
  }

  dom.append(head, chips, ta);
  addCollapse(dom, head, chips, ta);
  setTimeout(fit, 0);
}
export const Frontmatter = Node.create({
  name: 'frontmatter',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  addOptions() { return { metaVars: [] }; }, // accepted variables (from the manifest), injected by the host
  addAttributes() { return { raw: { default: '' } }; },
  parseHTML() { return [{ tag: 'div[data-frontmatter]' }]; },
  renderHTML() { return ['div', { 'data-frontmatter': '', class: 'frontmatter-card' }]; },
  addNodeView() {
    const metaVars = this.options.metaVars || [];
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'frontmatter-card'; dom.setAttribute('data-frontmatter', '');
      dom.contentEditable = 'false';
      buildMetaCard(dom, node, editor, getPos, metaVars);
      return {
        dom,
        update: (updated) => updated.type.name === 'frontmatter', // our own edits don't rebuild (keeps focus)
        ignoreMutation: () => true,
        stopEvent: () => true,
      };
    };
  },
});

// Structural line-oriented blocks (:::title / :::preamble / :::fecho) rendered
// as editable WYSIWYG (not a code box). Each line is a SpecialLine carrying
// indent / alignment / size so it looks like the Word output.
const SPECIAL_LABEL = { title: 'Título', preamble: 'Preâmbulo', fecho: 'Fecho' };

export const SpecialBlock = Node.create({
  name: 'specialBlock',
  group: 'block',
  content: 'specialLine+',
  defining: true,
  addAttributes() {
    return { kind: { default: 'title' }, header: { default: 'title' } };
  },
  parseHTML() { return [{ tag: 'div[data-special-block]' }]; },
  renderHTML({ node }) {
    return ['div', { 'data-special-block': '', class: 'special-block', 'data-kind': node.attrs.kind },
      ['div', { class: 'special-label', contenteditable: 'false' }, SPECIAL_LABEL[node.attrs.kind] || node.attrs.kind],
      ['div', { class: 'special-body' }, 0],
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'special-block';
      dom.setAttribute('data-special-block', '');
      dom.setAttribute('data-kind', node.attrs.kind);
      const label = document.createElement('div');
      label.className = 'special-label';
      label.contentEditable = 'false';
      label.append(document.createTextNode(SPECIAL_LABEL[node.attrs.kind] || node.attrs.kind));
      const body = document.createElement('div');
      body.className = 'special-body';
      dom.append(label, body);
      addCollapse(dom, label, body);
      return { dom, contentDOM: body };
    };
  },
});

export const SpecialLine = Node.create({
  name: 'specialLine',
  content: 'inline*',
  addAttributes() {
    return { indent: { default: 0 }, align: { default: null }, size: { default: null } };
  },
  parseHTML() { return [{ tag: 'div[data-special-line]' }]; },
  renderHTML({ node }) {
    const a = node.attrs;
    const style = [];
    if (a.align) style.push(`text-align:${a.align}`);
    if (a.indent) style.push(`padding-left:${a.indent * 0.5}em`);
    if (a.size) style.push(`font-size:${a.size}pt`);
    return ['div', { 'data-special-line': '', class: 'special-line', style: style.join(';') }, 0];
  },
});

// Any not-yet-structured fenced block (:::page-break, :::raw-list, ...).
// Rendered verbatim and round-tripped losslessly; raw text is editable.
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { header: { default: '' }, raw: { default: '' } };
  },
  parseHTML() { return [{ tag: 'div[data-raw-block]' }]; },
  renderHTML({ node }) {
    return ['div', { 'data-raw-block': '', class: 'raw-block' },
      ['div', { class: 'raw-head' }, `:::${node.attrs.header}`],
      ['pre', { class: 'raw-body' }, node.attrs.raw || ''],
    ];
  },
  // Minimal nodeView so the raw body is editable as plain text.
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'raw-block';
      dom.setAttribute('data-raw-block', '');
      const head = document.createElement('div');
      head.className = 'raw-head';
      head.textContent = `:::${node.attrs.header}`;
      const body = document.createElement('textarea');
      body.className = 'raw-body';
      body.value = node.attrs.raw || '';
      body.rows = Math.max(2, (node.attrs.raw || '').split('\n').length);
      body.addEventListener('input', () => {
        if (typeof getPos === 'function') {
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(getPos(), undefined, {
              ...node.attrs, raw: body.value,
            }));
        }
      });
      dom.appendChild(head);
      dom.appendChild(body);
      addCollapse(dom, head, body);
      return { dom, ignoreMutation: () => true, stopEvent: () => true };
    };
  },
});

// Word-like Tab indentation. Tab indents the current block(s), Shift-Tab and
// Backspace-at-start outdent. Lists nest via their space `indent`; paragraphs/
// headings via a left `indent` block attr (1.25cm steps). Defers to the table
// keymap when inside a table (Tab there moves between cells).
function _inTable($from) {
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return true;
  return false;
}
function _indentSelection(editor, dir) {
  const { state, view } = editor;
  if (_inTable(state.selection.$from)) return false; // let prosemirror-tables handle Tab
  const { from, to } = state.selection;
  let tr = state.tr; let touched = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'tcuListItem') {
      const cur = node.attrs.indent || 0;
      const next = Math.max(0, cur + dir * 2);
      if (next !== cur) { tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }); touched = true; }
      return false;
    }
    if (node.type.name === 'paragraph' || node.type.name === 'heading') {
      const raw = node.attrs.tcuBlockRaw || '';
      const next = setBlockIndentRaw(raw, dir);
      if (next !== raw) { tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, tcuBlockRaw: next || null, tcuBlockCss: blockCss(next) }); touched = true; }
      return false;
    }
    return undefined;
  });
  if (touched) view.dispatch(tr);
  return true; // consume Tab (prevent focus loss / stray tab char)
}
function _backspaceOutdent(editor) {
  const { state } = editor;
  const { empty, $from } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false; // only at the very start
  const node = $from.parent;
  if (node.type.name === 'tcuListItem' && (node.attrs.indent || 0) > 0) return _indentSelection(editor, -1);
  if ((node.type.name === 'paragraph' || node.type.name === 'heading') && /(?:^|\s)indent:[\d.]+cm/.test(node.attrs.tcuBlockRaw || '')) return _indentSelection(editor, -1);
  return false; // otherwise let the default Backspace (merge/delete) run
}
export const TabIndent = Extension.create({
  name: 'tabIndent',
  addKeyboardShortcuts() {
    const editor = this.editor;
    return {
      Tab: () => _indentSelection(editor, +1),
      'Shift-Tab': () => _indentSelection(editor, -1),
      Backspace: () => _backspaceOutdent(editor),
    };
  },
});

// Review comments. The anchor is a Comment mark on the commented span; the
// thread data (author/date/text/resolved, replies = same id) lives in a
// CommentsBlock card. md syntax: {comment:id}..{/comment} + a :::comments block.
export const Comment = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() { return { commentId: { default: '' } }; },
  parseHTML() { return [{ tag: 'span[data-comment]' }]; },
  renderHTML({ mark }) {
    return ['span', { 'data-comment': mark.attrs.commentId, class: 'comment-anchor',
      title: 'Comentário (' + mark.attrs.commentId + ') — duplo-clique para ver no painel' }, 0];
  },
});

// Tracked changes (Word). Insertion = green underline, deletion = red strike;
// both carry author + date. md syntax: {ins[:author@date]}..{/ins} / {del..}.
const revTitle = (label, mark) => label + (mark.attrs.author ? ' · ' + mark.attrs.author : '') + (mark.attrs.date ? ' · ' + mark.attrs.date : '');
export const Insertion = Mark.create({
  name: 'ins',
  inclusive: true,
  addAttributes() { return { author: { default: '' }, date: { default: '' } }; },
  parseHTML() { return [{ tag: 'ins' }, { tag: 'span[data-ins]' }]; },
  renderHTML({ mark }) { return ['ins', { 'data-ins': '', class: 'rev-ins', title: revTitle('Inserção', mark) }, 0]; },
});
export const Deletion = Mark.create({
  name: 'del',
  inclusive: true,
  addAttributes() { return { author: { default: '' }, date: { default: '' } }; },
  parseHTML() { return [{ tag: 'del' }, { tag: 'span[data-del]' }]; },
  renderHTML({ mark }) { return ['del', { 'data-del': '', class: 'rev-del', title: revTitle('Exclusão', mark) }, 0]; },
});

// Hyperlink ([text](url) -> real Word w:hyperlink). Carries the href.
export const Link = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() { return { href: { default: '' } }; },
  parseHTML() { return [{ tag: 'a[href]' }]; },
  renderHTML({ mark }) {
    return ['a', { href: mark.attrs.href, class: 'doc-link', rel: 'noopener', title: mark.attrs.href + ' — Ctrl+clique para abrir' }, 0];
  },
});

export function parseCommentLines(text) {
  const items = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    const idtoks = (parts[0] || '').trim().split(/\s+/).filter(Boolean);
    if (!idtoks.length) continue;
    let likes = 0;
    for (const tok of idtoks.slice(1)) { if (tok.startsWith('like:')) { const n = parseInt(tok.slice(5), 10); if (!isNaN(n)) likes = n; } }
    items.push({
      id: idtoks[0],
      resolved: idtoks.slice(1).includes('resolved'),
      likes,
      author: (parts[1] || '').trim(),
      date: (parts[2] || '').trim(),
      text: parts.slice(3).join('|').trim(),
    });
  }
  return items;
}
export function commentItemsToLines(items) {
  return (items || []).map((it) => {
    let idf = it.id || '';
    if (it.resolved) idf += ' resolved';
    if (it.likes) idf += ' like:' + it.likes;
    return idf + ' | ' + (it.author || '') + ' | ' + (it.date || '') + ' | ' + (it.text || '');
  }).join('\n');
}
export const CommentsBlock = Node.create({
  name: 'commentsBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() { return { items: { default: [] } }; },
  parseHTML() { return [{ tag: 'div[data-comments]' }]; },
  renderHTML() { return ['div', { 'data-comments': '', class: 'comments-card' }]; },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'comments-card'; dom.setAttribute('data-comments', '');
      dom.contentEditable = 'false';
      let cur = node;
      const head = document.createElement('div');
      head.className = 'comments-head';
      const list = document.createElement('div');
      const ta = document.createElement('textarea');
      ta.className = 'comments-raw';
      ta.spellcheck = false;
      ta.title = 'id[ resolved] | autor | data | texto   (mesmo id = resposta)';
      const draw = (n) => {
        const items = n.attrs.items || [];
        const threads = new Set(items.map((it) => it.id));
        head.textContent = 'Comentários — ' + threads.size + ' tópico(s), ' + items.length + ' mensagem(ns)';
        list.innerHTML = '';
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'comment-row' + (it.resolved ? ' resolved' : '');
          row.innerHTML = '<b>' + (it.id || '') + '</b> · <i>' + (it.author || 'Revisor') + '</i> '
            + (it.date ? '<span class="cdate">' + it.date + '</span>' : '')
            + (it.resolved ? ' <span class="cdone">✓ resolvido</span>' : '')
            + '<div class="ctext"></div>';
          row.querySelector('.ctext').textContent = it.text || '';
          list.appendChild(row);
        }
        if (document.activeElement !== ta) ta.value = commentItemsToLines(items);
      };
      ta.addEventListener('change', () => {
        if (typeof getPos !== 'function') return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...cur.attrs, items: parseCommentLines(ta.value) }));
      });
      const adv = document.createElement('details');
      adv.className = 'comments-adv';
      const sm = document.createElement('summary'); sm.textContent = 'Editar como texto';
      adv.append(sm, ta);
      dom.append(head, list, adv);
      draw(cur);
      return { dom, update: (n) => { if (n.type.name !== 'commentsBlock') return false; cur = n; draw(n); return true; }, ignoreMutation: () => true, stopEvent: () => true };
    };
  },
});

// Word-like track-changes MODE. When trackChangesState.enabled, typing becomes a
// tracked insertion and deleting marks text struck-through (kept) instead of
// removing it; deleting your own just-inserted text removes it outright.
// Accept/Reject finalize. The marks (ins/del) and the .md round-trip are unchanged.
export const trackChangesState = { enabled: false, getAuthor: () => 'Autor' };
function _revStamp() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }

function _revSegs(state, from, to) {
  const insT = state.schema.marks.ins, delT = state.schema.marks.del;
  const segs = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isText) return;
    const a = Math.max(from, pos), b = Math.min(to, pos + n.nodeSize);
    if (b > a) segs.push({ a, b, ins: n.marks.some((m) => m.type === insT), del: n.marks.some((m) => m.type === delT) });
  });
  return segs.sort((x, y) => y.a - x.a); // descending so deletes don't shift earlier ranges
}
function _markDeleted(state, tr, from, to) {
  const delT = state.schema.marks.del;
  for (const s of _revSegs(state, from, to)) {
    if (s.ins) tr.delete(s.a, s.b);                 // removing your own insertion -> gone
    else if (!s.del) tr.addMark(s.a, s.b, delT.create({ author: trackChangesState.getAuthor(), date: _revStamp() }));
  }
  return tr;
}
function _trackDelete(editor, dir) {
  if (!trackChangesState.enabled) return false;
  const { state, view } = editor;
  const sel = state.selection;
  let from = sel.from, to = sel.to;
  if (sel.empty) {
    if (dir < 0) { if (from <= 1) return false; from -= 1; } else { if (to >= state.doc.content.size - 1) return false; to += 1; }
  }
  const tr = _markDeleted(state, state.tr, from, to);
  const cur = dir < 0 ? from : tr.mapping.map(to);
  try { tr.setSelection(TextSelection.create(tr.doc, Math.max(1, Math.min(cur, tr.doc.content.size - 1)))); } catch (e) { /* keep */ }
  view.dispatch(tr.setMeta('trackHandled', true));
  return true;
}
// The contiguous ins/del run covering `pos` (the change "under the cursor").
function _changeRangeAt(state, pos) {
  const insT = state.schema.marks.ins, delT = state.schema.marks.del;
  const isRev = (m) => m.type === insT || m.type === delT;
  const segs = [];
  state.doc.descendants((n, p) => { if (n.isText) { const r = (n.marks || []).find(isRev); if (r) segs.push({ from: p, to: p + n.nodeSize, type: r.type }); } });
  for (let i = 0; i < segs.length; i++) {
    if (pos >= segs[i].from && pos <= segs[i].to) {
      let from = segs[i].from, to = segs[i].to; const type = segs[i].type;
      for (let j = i - 1; j >= 0 && segs[j].to === from && segs[j].type === type; j--) from = segs[j].from;
      for (let j = i + 1; j < segs.length && segs[j].from === to && segs[j].type === type; j++) to = segs[j].to;
      return { from, to };
    }
  }
  return null;
}
// Accept/reject revisions. all=true -> whole doc; else the selection (if any) or
// just the change under the cursor. Returns how many revision spans were affected.
export function acceptRejectChanges(editor, accept, all) {
  const { state, view } = editor;
  const insT = state.schema.marks.ins, delT = state.schema.marks.del;
  let from, to;
  if (all) { from = 0; to = state.doc.content.size; }
  else if (!state.selection.empty) { from = state.selection.from; to = state.selection.to; }
  else { const r = _changeRangeAt(state, state.selection.from); if (!r) { view.focus(); return 0; } from = r.from; to = r.to; }
  let tr = state.tr; let count = 0;
  for (const s of _revSegs(state, from, to)) {
    if (s.ins) { count += 1; if (accept) tr.removeMark(s.a, s.b, insT); else tr.delete(s.a, s.b); }
    else if (s.del) { count += 1; if (accept) tr.delete(s.a, s.b); else tr.removeMark(s.a, s.b, delT); }
  }
  if (tr.steps.length) view.dispatch(tr.setMeta('trackHandled', true));
  view.focus();
  return count;
}
export const TrackChanges = Extension.create({
  name: 'trackChanges',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('trackChanges'),
      props: {
        handleTextInput(view, from, to, text) {
          const ts = trackChangesState;
          if (!ts.enabled) return false;
          const { state } = view;
          const S = state.schema;
          const insMark = S.marks.ins.create({ author: ts.getAuthor(), date: _revStamp() });
          const base = (state.storedMarks || state.doc.resolve(from).marks()).filter((m) => m.type.name !== 'ins' && m.type.name !== 'del');
          const marks = base.concat(insMark);
          let tr = state.tr;
          if (from < to) tr = _markDeleted(state, tr, from, to); // typing over a selection -> delete it (tracked)
          const at = tr.mapping.map(from < to ? to : from);
          tr.insert(at, S.text(text, marks));
          try { tr.setSelection(TextSelection.create(tr.doc, at + text.length)); } catch (e) { /* keep */ }
          tr.setStoredMarks(marks);
          view.dispatch(tr.setMeta('trackHandled', true));
          return true;
        },
      },
    })];
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => _trackDelete(this.editor, -1),
      Delete: () => _trackDelete(this.editor, 1),
    };
  },
});
