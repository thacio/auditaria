// Framework-agnostic editor core: builds the WYSIWYG editor + ribbon + table
// tools and exposes setAst/getAst. No fetch, no app DOM ids, no preview — the
// host app injects { editorElement, ribbonEl, tableRibbonEl, spec } and the
// callbacks { notify, uploadImage, onChange }, then places the menus + canvas.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { Color } from '@tiptap/extension-color';
import { CellSelection } from '@tiptap/pm/tables';
import { XrefAnchor, XrefRef, TcuListItem, RawBlock, AutoNumber, autoNumberState,
  TcuTable, TcuTableRow, TcuTableCell, TcuTableHeader, TcuTextStyle, TcuHighlight,
  SpecialBlock, SpecialLine, MarkStyle, Formula, ATTR_MARKS, TcuImage, Endnote,
  PageBreak, PageOrientation, FigureGrid, ContinueList, RawList, FixedTableWidth,
  tableGridWidths, applyGridWidths, TABLE_TARGET_PX, Frontmatter, Summary, TabIndent,
  Comment, CommentsBlock, Insertion, Deletion, Link,
  IMAGE_WRAP_OPTS, IMAGE_ALIGN_OPTS, IMAGE_SIDE_OPTS, IMAGE_FIELD_HINTS,
  TrackChanges, trackChangesState, acceptRejectChanges } from './extensions.js';
import { astToPM, pmToAst, cellCss, editCellRaw, cellAttrString, setBlockAlignRaw, blockCss, serializeImageOpts } from './ast-bridge.js';
import { tbtn, sep, ribbonGroup, popover, colorGrid, menu, dialog } from './ui.js';
import katex from 'katex';

const XREF_TYPES = [
  { value: 'para', label: 'Parágrafo' }, { value: 'sec', label: 'Seção' },
  { value: 'tab', label: 'Tabela' }, { value: 'fig', label: 'Figura' },
];

const HL_PALETTE = [
  ['yellow', '#ffff00'], ['green', '#92d050'], ['cyan', '#00ffff'], ['pink', '#ffc0cb'],
  ['blue', '#0070ff'], ['red', '#ff0000'], ['gray', '#808080'], ['dark_yellow', '#808000'],
];
const hlColors = () => HL_PALETTE.map(([name, css]) => ({ name, hex: css.replace('#', ''), css }));

export function createDocEditor({ editorElement, ribbonEl, tableRibbonEl, spec,
  notify = () => {}, uploadImage = null, onChange = () => {},
  commentsPanelEl = null, getReviewer = () => 'Revisor', onCommentFocus = () => {} }) {
  let docAttrs = { frontmatter: null, trailingNewline: true };
  let editor;
  let lastCommentsJson = null;
  const syncers = [];
  const registerSync = (fn) => syncers.push(fn);
  const refreshUI = () => { for (const fn of syncers) { try { fn(); } catch (e) { /* ignore */ } } };
  const bindActive = (b, pred) => { registerSync(() => b.classList.toggle('is-active', !!pred())); return b; };

function currentAlign() {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'paragraph' || n.type.name === 'heading') return n.attrs.tcuAlign || 'justify';
  }
  return 'justify';
}
function setTcuAlign(align) {
  const { state, view } = editor;
  const val = align === 'justify' ? null : align;
  let tr = state.tr; let touched = false;
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type.name === 'paragraph' || n.type.name === 'heading') {
      const raw = setBlockAlignRaw(n.attrs.tcuBlockRaw, align);
      tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, tcuBlockRaw: raw || null, tcuAlign: val, tcuBlockCss: blockCss(raw) });
      touched = true;
    }
  });
  if (touched) { view.dispatch(tr); view.focus(); }
}
function isInTable() {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return true;
  return false;
}
function insertListItem(listType, marker, indent) {
  editor.chain().focus().insertContent({ type: 'tcuListItem', attrs: { listType, marker, indent }, content: [{ type: 'text', text: 'item' }] }).run();
}
function existingAnchorIds() {
  const ids = new Set();
  editor.state.doc.descendants((n) => { if (n.type.name === 'xrefAnchor') ids.add(n.attrs.id); });
  return [...ids];
}
async function finishFigure(src, alt) {
  const v = await dialog({
    title: 'Inserir figura',
    fields: [
      { key: 'width', type: 'text', label: 'Largura', value: '80%', placeholder: '80%, 192pt, 5cm', hint: IMAGE_FIELD_HINTS.width },
      { key: 'wrap', type: 'segmented', label: 'Envolvimento de texto', value: 'none', options: IMAGE_WRAP_OPTS, hint: IMAGE_FIELD_HINTS.wrap },
      { key: 'align', type: 'segmented', label: 'Alinhamento (quando flutuante)', value: 'left', options: IMAGE_ALIGN_OPTS, hint: IMAGE_FIELD_HINTS.align },
      { key: 'side', type: 'segmented', label: 'Lado do texto (quadrado/justo/através)', value: 'both', options: IMAGE_SIDE_OPTS, hint: IMAGE_FIELD_HINTS.side },
      { key: 'gap', type: 'text', label: 'Distância do texto (gap, opcional)', value: '', placeholder: '0.5cm', hint: IMAGE_FIELD_HINTS.gap },
      { key: 'lock', type: 'checkbox', label: 'Travar posição (lock)', value: false, hint: IMAGE_FIELD_HINTS.lock },
      { key: 'caption', type: 'text', label: 'Legenda (vazio = sem legenda)', value: '', hint: IMAGE_FIELD_HINTS.caption },
      { key: 'id', type: 'text', label: 'id da figura (para [@fig:id])', value: 'fig1', hint: IMAGE_FIELD_HINTS.id },
    ],
  });
  if (!v) return;
  const width = (v.width || '').trim() || '80%';
  const map = new Map([['width', width]]);
  const wrap = v.wrap && v.wrap !== 'none' ? v.wrap : null;
  if (wrap) {
    map.set('wrap', wrap);
    if (v.align && v.align !== 'left') map.set('align', v.align);
    if (v.side && v.side !== 'both') map.set('side', v.side);
    const gap = (v.gap || '').trim();
    if (gap) map.set('gap', gap);
    if (v.lock) map.set('lock', '');
  }
  const opts = serializeImageOpts(map);
  const cap = (v.caption || '').trim();
  const caption = cap ? `{#fig:${(v.id || 'fig1').trim() || 'fig1'} caption="${cap}"}` : null;
  editor.chain().focus().insertContent({ type: 'image', attrs: { src, alt: alt || '', opts, caption } }).run();
}
function insertFigure() {
  if (!uploadImage) { insertFigureUrl(); return; }
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    notify('Enviando imagem…');
    try {
      const { path } = await uploadImage(file);
      if (!path) throw new Error('falha no upload');
      notify('Imagem enviada ✓');
      finishFigure(path, file.name);
    } catch (e) { notify('Falha ao enviar a imagem: ' + e, 'err'); }
  });
  input.click();
}
async function insertFigureUrl() {
  const v = await dialog({
    title: 'Inserir figura por caminho/URL',
    fields: [{ key: 'src', type: 'text', label: 'Caminho/URL da imagem', placeholder: 'images/chart.png ou https://…' }],
  });
  if (!v || !(v.src || '').trim()) return;
  finishFigure(v.src.trim(), '');
}
function wireFormulaPreview(els) {
  const render = () => {
    try { katex.render(els.latex.value || '\\,', els.preview, { displayMode: !!(els.display && els.display.checked), throwOnError: false }); }
    catch (e) { els.preview.textContent = String((e && e.message) || e); }
  };
  els.latex.addEventListener('input', render);
  if (els.display) els.display.addEventListener('change', render);
  render();
}
async function insertFormula() {
  const v = await dialog({
    title: 'Inserir fórmula (LaTeX)',
    fields: [
      { key: 'latex', type: 'textarea', label: 'LaTeX', value: '', placeholder: 'E = mc^2', rows: 2 },
      { key: 'display', type: 'checkbox', label: 'Em destaque (centralizada)', value: false },
      { key: 'preview', type: 'custom', label: 'Pré-visualização' },
    ],
    onBuild: wireFormulaPreview,
  });
  if (!v || !(v.latex || '').trim()) return;
  editor.chain().focus().insertContent({ type: 'formula', attrs: { latex: v.latex.trim(), display: v.display } }).run();
}
async function insertAnchor() {
  const v = await dialog({
    title: 'Inserir âncora de referência',
    fields: [
      { key: 'type', type: 'segmented', label: 'Tipo', value: 'para', options: XREF_TYPES },
      { key: 'id', type: 'text', label: 'id da âncora', placeholder: 'intro' },
    ],
  });
  if (!v || !(v.id || '').trim()) return;
  editor.chain().focus().insertContent({ type: 'xrefAnchor', attrs: { refType: v.type, id: v.id.trim() } }).run();
}
async function insertXref() {
  const v = await dialog({
    title: 'Referência cruzada',
    fields: [
      { key: 'type', type: 'segmented', label: 'Tipo', value: 'para', options: XREF_TYPES },
      { key: 'id', type: 'text', label: 'id referenciado', placeholder: 'intro', datalist: existingAnchorIds() },
      { key: 'short', type: 'checkbox', label: 'Forma curta (ex.: "Tabela 1")', value: false },
    ],
  });
  if (!v || !(v.id || '').trim()) return;
  editor.chain().focus().insertContent({ type: 'xrefRef', attrs: { refType: v.type, id: v.id.trim(), short: v.short } }).run();
}
async function insertNote() {
  const v = await dialog({
    title: 'Inserir nota',
    fields: [
      { key: 'id', type: 'text', label: 'id da nota', placeholder: 'lei8666' },
      { key: 'noteType', type: 'segmented', label: 'Tipo', value: 'endnote', options: [{ value: 'endnote', label: 'Nota de fim' }, { value: 'footnote', label: 'Rodapé' }] },
      { key: 'body', type: 'textarea', label: 'Texto da citação / nota', value: '', rows: 3 },
    ],
  });
  if (!v || !(v.id || '').trim()) return;
  editor.chain().focus().insertContent({ type: 'endnote', attrs: { noteType: v.noteType, id: v.id.trim(), body: v.body, reuse: false } }).run();
}
async function insertLink() {
  const { empty } = editor.state.selection;
  const existing = editor.getAttributes('link').href || '';
  const v = await dialog({
    title: existing ? 'Editar link' : 'Inserir link',
    fields: [
      ...(empty ? [{ key: 'text', type: 'text', label: 'Texto', placeholder: 'texto do link' }] : []),
      { key: 'href', type: 'text', label: 'URL', value: existing, placeholder: 'https://… ou mailto:…' },
    ],
  });
  if (!v) return;
  const href = (v.href || '').trim();
  if (!href) { editor.chain().focus().unsetMark('link').run(); return; } // empty URL clears the link
  if (empty) {
    const text = (v.text || '').trim() || href;
    editor.chain().focus().insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run();
  } else {
    editor.chain().focus().setMark('link', { href }).run();
  }
}
function existingCommentIds() {
  const ids = new Set();
  editor.state.doc.descendants((n) => {
    (n.marks || []).forEach((m) => { if (m.type.name === 'comment' && m.attrs.commentId) ids.add(m.attrs.commentId); });
    if (n.type.name === 'commentsBlock') (n.attrs.items || []).forEach((it) => ids.add(it.id));
  });
  return ids;
}
function getCommentsNode() {
  let pos = null, node = null;
  editor.state.doc.forEach((n, offset) => { if (n.type.name === 'commentsBlock') { pos = offset; node = n; } });
  return { pos, node };
}
function commentItems() { const { node } = getCommentsNode(); return (node && node.attrs.items) || []; }
function setCommentItems(items) {
  const { state, view } = editor;
  const { pos, node } = getCommentsNode();
  let tr;
  if (node && items.length === 0) tr = state.tr.delete(pos, pos + node.nodeSize); // drop the empty block
  else if (node) tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, items });
  else if (items.length) tr = state.tr.insert(state.doc.content.size, state.schema.nodes.commentsBlock.create({ items }));
  else return;
  view.dispatch(tr);
}
// Remove the comment mark from every span anchored to a thread id.
function removeCommentMark(tid) {
  const { state, view } = editor;
  const mt = state.schema.marks.comment;
  let tr = state.tr; let changed = false;
  state.doc.descendants((n, pos) => {
    if (n.isText && (n.marks || []).some((m) => m.type === mt && m.attrs.commentId === tid)) {
      tr = tr.removeMark(pos, pos + n.nodeSize, mt); changed = true;
    }
  });
  if (changed) view.dispatch(tr);
}
function deleteCommentMessage(idx) {
  const items = commentItems();
  const tid = items[idx] && items[idx].id;
  const next = items.filter((_, i) => i !== idx);
  setCommentItems(next);
  if (tid && !next.some((it) => it.id === tid)) removeCommentMark(tid); // thread emptied -> drop anchor
}
function deleteThread(tid) {
  setCommentItems(commentItems().filter((it) => it.id !== tid));
  removeCommentMark(tid);
}
// ---- navigation between a commented span and its thread ----
function findCommentRange(tid) {
  let from = null, to = null;
  editor.state.doc.descendants((n, pos) => {
    if (n.isText && (n.marks || []).some((m) => m.type.name === 'comment' && m.attrs.commentId === tid)) {
      if (from === null) from = pos;
      to = pos + n.nodeSize;
    }
  });
  return from !== null ? { from, to } : null;
}
function gotoCommentSpan(tid) {
  const r = findCommentRange(tid);
  if (r) editor.chain().focus().setTextSelection(r).scrollIntoView().run();
}
function highlightThread(tid) {
  if (!commentsPanelEl) return;
  const all = commentsPanelEl.querySelectorAll('.cp-thread');
  all.forEach((t) => t.classList.toggle('active', t.dataset.threadId === tid));
  const active = commentsPanelEl.querySelector('.cp-thread[data-thread-id="' + tid + '"]');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function addCommentItem(item) { setCommentItems([...commentItems(), item]); }
// Full local timestamp (YYYY-MM-DDTHH:MM:SS) so comments carry the date AND time.
const nowStamp = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const fmtStamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
  return m ? (m[3] + '/' + m[2] + '/' + m[1] + (m[4] ? ' ' + m[4] + ':' + m[5] : '')) : (s || '');
};
function replyToThread(tid, text) { addCommentItem({ id: tid, author: getReviewer() || 'Revisor', date: nowStamp(), text, likes: 0, resolved: false }); }
function toggleResolveThread(tid, resolved) { setCommentItems(commentItems().map((it) => (it.id === tid ? { ...it, resolved } : it))); }
function thumbsComment(idx) { setCommentItems(commentItems().map((it, i) => (i === idx ? { ...it, likes: (it.likes || 0) + 1 } : it))); }
function editCommentText(idx, text) { setCommentItems(commentItems().map((it, i) => (i === idx ? { ...it, text } : it))); }

function renderCommentsPanel() {
  if (!commentsPanelEl) return;
  const items = commentItems();
  const json = JSON.stringify(items);
  if (json === lastCommentsJson && commentsPanelEl.childElementCount) return; // only rebuild on change (keeps reply focus)
  lastCommentsJson = json;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  commentsPanelEl.innerHTML = '';
  if (!items.length) { commentsPanelEl.appendChild(el('div', 'cp-empty', 'Nenhum comentário. Selecione um trecho e clique 💬.')); return; }
  const order = []; const threads = {};
  items.forEach((it, idx) => { if (!threads[it.id]) { threads[it.id] = []; order.push(it.id); } threads[it.id].push({ it, idx }); });
  for (const tid of order) {
    const msgs = threads[tid];
    const resolved = msgs.length > 0 && msgs.every((m) => m.it.resolved);
    const thread = el('div', 'cp-thread' + (resolved ? ' resolved' : ''));
    thread.dataset.threadId = tid;
    for (const { it, idx } of msgs) {
      const msg = el('div', 'cp-msg');
      const head = el('div', 'mhead');
      head.title = 'Ir ao trecho comentado';
      const who = el('span', 'who', it.author || 'Revisor');
      const when = el('span', 'when', fmtStamp(it.date));
      head.append(who, when);
      head.addEventListener('click', () => gotoCommentSpan(tid));
      const body = el('div', 'body', it.text || '');
      const acts = el('div', 'acts');
      const like = el('button', it.likes ? 'liked' : '', '👍' + (it.likes ? ' ' + it.likes : ''));
      like.title = 'Curtir'; like.addEventListener('click', () => thumbsComment(idx));
      const edit = el('button', '', '✎ editar');
      edit.addEventListener('click', () => {
        const ta = document.createElement('textarea'); ta.value = it.text || ''; ta.rows = 2;
        body.replaceWith(ta); ta.focus();
        const save = () => editCommentText(idx, ta.value.trim());
        ta.addEventListener('blur', save);
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
      });
      const del = el('button', 'del', '🗑');
      del.title = 'Excluir esta mensagem'; del.addEventListener('click', () => deleteCommentMessage(idx));
      acts.append(like, edit, del);
      msg.append(head, body, acts);
      thread.appendChild(msg);
    }
    const foot = el('div', 'cp-thread-foot');
    const replyWrap = el('div', 'cp-reply');
    const ta = document.createElement('textarea'); ta.rows = 1; ta.placeholder = 'Responder…';
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) { e.preventDefault(); replyToThread(tid, ta.value.trim()); } });
    const send = el('button', 'cp-btn', 'Responder');
    send.addEventListener('click', () => { if (ta.value.trim()) replyToThread(tid, ta.value.trim()); });
    replyWrap.append(ta, send);
    const res = el('button', 'cp-btn resolve', resolved ? '↺ Reabrir' : '✓ Resolver');
    res.addEventListener('click', () => toggleResolveThread(tid, !resolved));
    const delThread = el('button', 'cp-btn danger', '🗑 Excluir');
    delThread.title = 'Excluir o tópico inteiro (comentário + respostas + marca)';
    delThread.addEventListener('click', () => deleteThread(tid));
    foot.append(replyWrap, res, delThread);
    thread.appendChild(foot);
    commentsPanelEl.appendChild(thread);
  }
}
async function insertComment() {
  if (editor.state.selection.empty) { notify('Selecione o texto a comentar primeiro.', 'err'); return; }
  const v = await dialog({
    title: 'Inserir comentário',
    fields: [
      { key: 'author', type: 'text', label: 'Autor', value: 'Revisor' },
      { key: 'text', type: 'textarea', label: 'Comentário', rows: 3 },
    ],
  });
  if (!v || !(v.text || '').trim()) return;
  const ids = existingCommentIds();
  let n = 1; while (ids.has('c' + n)) n += 1;
  const id = 'c' + n;
  editor.chain().focus().setMark('comment', { commentId: id }).run();
  addCommentItem({ id, author: (v.author || '').trim() || 'Revisor', date: nowStamp(), text: v.text.trim(), resolved: false });
}

// ---- table cell attribute controls -----------------------------------------
function tableSyntaxAt($from) {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return $from.node(d).attrs.tcuSyntax || 'block';
  }
  return 'block';
}

function updateCells(changes) {
  const view = editor.view;
  const { state } = view;
  const sel = state.selection;
  const isBlock = tableSyntaxAt(sel.$from) !== 'markdown';
  const cells = [];
  if (sel instanceof CellSelection) {
    sel.forEachCell((node, pos) => cells.push({ node, pos }));
  } else {
    const $p = sel.$from;
    for (let d = $p.depth; d > 0; d--) {
      const n = $p.node(d);
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') { cells.push({ node: n, pos: $p.before(d) }); break; }
    }
  }
  if (!cells.length) { notify('Clique numa célula da tabela primeiro.'); return; }
  let tr = state.tr;
  for (const { node, pos } of cells) {
    const raw = editCellRaw(node.attrs.tcuHeaderRaw, changes, isBlock);
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, tcuHeaderRaw: raw, tcuCss: cellCss(cellAttrString(raw, isBlock)) });
  }
  view.dispatch(tr);
  view.focus();
}

function labelEl(text, control) {
  const w = document.createElement('label'); w.className = 'pop-field';
  const s = document.createElement('span'); s.textContent = text;
  w.append(s, control); return w;
}

// Word's modern table-style gallery (Grid Table / List Table / Plain Table,
// Word 2013+). The picker writes `style:<id>` into the :::table header; the parser
// injects the definition from table_styles.xml. (table_styles.xml also carries the
// legacy gallery — Light/Medium/Colorful — so imported docs using those still work.)
const TABLE_STYLES = [
  { id: '', label: 'Sem estilo' },
  { id: 'TableGrid', label: 'Grade simples' },
  { id: 'GridTable1Light-Accent1', label: 'Grade clara · Azul' },
  { id: 'GridTable4-Accent1', label: 'Grade c/ cabeçalho · Azul' },
  { id: 'GridTable4-Accent2', label: 'Grade c/ cabeçalho · Laranja' },
  { id: 'GridTable4-Accent6', label: 'Grade c/ cabeçalho · Verde' },
  { id: 'GridTable4-Accent4', label: 'Grade c/ cabeçalho · Dourado' },
  { id: 'GridTable5Dark-Accent1', label: 'Grade escura · Azul' },
  { id: 'GridTable6Colorful-Accent1', label: 'Grade colorida · Azul' },
  { id: 'GridTable6Colorful-Accent6', label: 'Grade colorida · Verde' },
  { id: 'ListTable3-Accent1', label: 'Lista · Azul' },
  { id: 'ListTable4-Accent1', label: 'Lista realçada · Azul' },
  { id: 'ListTable6Colorful-Accent1', label: 'Lista colorida · Azul' },
  { id: 'ListTable7Colorful-Accent5', label: 'Lista colorida · Azul claro' },
  { id: 'PlainTable1', label: 'Tabela simples' },
  { id: 'PlainTable3', label: 'Tabela simples (faixas)' },
];
function setTableHeaderStyle(header, styleId) {
  let braces = (/\{([^}]*)\}/.exec(header || '') || [, ''])[1];
  braces = braces.replace(/\bstyle:[A-Za-z0-9_-]+\s*/, '').trim();
  if (styleId) braces = (braces ? braces + ' ' : '') + 'style:' + styleId;
  return braces ? 'table{' + braces + '}' : 'table';
}
function applyTableStyle(styleId) {
  const { state, view } = editor;
  const $f = state.selection.$from;
  let tableNode = null, tablePos = null;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === 'table') { tableNode = $f.node(d); tablePos = $f.before(d); break; }
  }
  if (!tableNode) { notify('Clique numa tabela primeiro.', 'err'); return; }
  const header = setTableHeaderStyle(tableNode.attrs.tcuHeader, styleId);
  view.dispatch(state.tr.setNodeMarkup(tablePos, undefined, { ...tableNode.attrs, tcuHeader: header, tcuSyntax: 'block' }));
  view.focus();
  notify(styleId ? 'Estilo aplicado — veja a pré-visualização do .docx' : 'Estilo removido');
}

// Scale the whole table to a fraction of the page content width (16cm) by
// proportionally rescaling its column widths (the parser sets table width =
// sum of column widths, so this is the reliable way to size the table).
function setTableWidth(fraction) {
  const target = Math.round(TABLE_TARGET_PX * fraction);
  const { state, view } = editor;
  const $f = state.selection.$from;
  let tableNode = null, tablePos = null;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === 'table') { tableNode = $f.node(d); tablePos = $f.before(d); break; }
  }
  if (!tableNode) { notify('Clique numa tabela primeiro.'); return; }
  const cur = tableGridWidths(tableNode);
  const n = cur.length;
  if (n < 1) return;
  const eq = target / n;
  const filled = cur.map((x) => x || eq);
  const sum = filled.reduce((a, b) => a + b, 0) || target;
  const scaled = filled.map((x) => Math.max(24, Math.round((x * target) / sum)));
  scaled[n - 1] += target - scaled.reduce((a, b) => a + b, 0); // fix rounding -> exact total
  const tr = state.tr;
  applyGridWidths(tr, tableNode, tablePos, scaled);
  tr.setMeta('balanceTable', true);
  view.dispatch(tr);
  view.focus();
}

function buildTableRibbon() {
  const bar = tableRibbonEl;
  if (!bar) return;
  bar.innerHTML = '';
  let bw = '1', bc = 'black';
  const bspec = () => `${bw}pt-${bc}`;
  const allSides = { 'border-top': null, 'border-bottom': null, 'border-left': null, 'border-right': null };

  bar.appendChild(ribbonGroup('Linhas e colunas', [
    tbtn({ icon: 'rowAdd', title: 'Inserir linha abaixo', onClick: () => editor.chain().focus().addRowAfter().run() }),
    tbtn({ icon: 'colAdd', title: 'Inserir coluna à direita', onClick: () => editor.chain().focus().addColumnAfter().run() }),
    tbtn({ icon: 'rowDel', title: 'Excluir linha', onClick: () => editor.chain().focus().deleteRow().run() }),
    tbtn({ icon: 'colDel', title: 'Excluir coluna', onClick: () => editor.chain().focus().deleteColumn().run() }),
    tbtn({ icon: 'merge', title: 'Mesclar / dividir células', onClick: () => editor.chain().focus().mergeOrSplit().run() }),
    tbtn({ icon: 'trash', title: 'Excluir tabela', onClick: () => editor.chain().focus().deleteTable().run() }),
  ]));
  bar.appendChild(sep());

  const bgBtn = tbtn({
    label: 'Fundo ▾', title: 'Cor de fundo da célula',
    onClick: (b) => popover(b, colorGrid(spec.colors, (c) => updateCells({ bg: c.hex }), () => updateCells({ bg: null }))),
  });
  const bordersBtn = tbtn({
    label: 'Bordas ▾', title: 'Bordas da célula',
    onClick: (b) => popover(b, (pop) => {
      const row = document.createElement('div'); row.className = 'pop-row';
      const sw = document.createElement('select');
      sw.innerHTML = ['0.5', '1', '1.5', '2', '3'].map((w) => `<option>${w}</option>`).join(''); sw.value = bw;
      sw.onchange = () => { bw = sw.value; };
      const sc = document.createElement('select');
      sc.innerHTML = '<option value="black">preto</option>' + spec.colors.map((c) => `<option value="${c.hex}">${c.name}</option>`).join(''); sc.value = bc;
      sc.onchange = () => { bc = sc.value; };
      row.append(labelEl('Espessura (pt)', sw), labelEl('Cor', sc));
      pop.appendChild(row);
      const grid = document.createElement('div'); grid.className = 'border-grid';
      grid.append(
        tbtn({ icon: 'bAll', title: 'Todas', onClick: () => updateCells({ border: bspec(), ...allSides }) }),
        tbtn({ icon: 'bOut', title: 'Externas', onClick: () => updateCells({ border: bspec(), ...allSides }) }),
        tbtn({ icon: 'bNone', title: 'Nenhuma', onClick: () => updateCells({ border: 'none', ...allSides }) }),
        tbtn({ label: '▔', title: 'Superior', onClick: () => updateCells({ 'border-top': bspec() }) }),
        tbtn({ label: '▁', title: 'Inferior', onClick: () => updateCells({ 'border-bottom': bspec() }) }),
        tbtn({ label: '▏', title: 'Esquerda', onClick: () => updateCells({ 'border-left': bspec() }) }),
        tbtn({ label: '▕', title: 'Direita', onClick: () => updateCells({ 'border-right': bspec() }) }),
      );
      pop.appendChild(grid);
    }),
  });
  bar.appendChild(ribbonGroup('Sombreamento e bordas', [bgBtn, bordersBtn]));
  bar.appendChild(sep());

  bar.appendChild(ribbonGroup('Alinhamento', [
    tbtn({ icon: 'alignLeft', title: 'Esquerda', onClick: () => updateCells({ align: 'left' }) }),
    tbtn({ icon: 'alignCenter', title: 'Centro', onClick: () => updateCells({ align: 'center' }) }),
    tbtn({ icon: 'alignRight', title: 'Direita', onClick: () => updateCells({ align: 'right' }) }),
    tbtn({ label: '⊤', title: 'Topo', onClick: () => updateCells({ valign: 'top' }) }),
    tbtn({ label: '⊟', title: 'Meio', onClick: () => updateCells({ valign: 'center' }) }),
    tbtn({ label: '⊥', title: 'Base', onClick: () => updateCells({ valign: 'bottom' }) }),
  ]));
  bar.appendChild(sep());

  bar.appendChild(ribbonGroup('Estilo da tabela', [
    tbtn({
      label: 'Estilos ▾', title: 'Aplicar um estilo do Word (cabeçalho + linhas alternadas)', wide: true,
      onClick: (b) => popover(b, menu(TABLE_STYLES.map((s) => ({ label: s.label, onClick: () => applyTableStyle(s.id) })))),
    }),
  ]));
  bar.appendChild(sep());

  bar.appendChild(ribbonGroup('Largura da tabela', [
    tbtn({
      label: 'Largura ▾', title: 'Largura total da tabela', wide: true,
      onClick: (b) => popover(b, menu([
        { label: 'Automática (margens · 16 cm)', onClick: () => setTableWidth(1) },
        { label: '90% da página', onClick: () => setTableWidth(0.9) },
        { label: '75% da página', onClick: () => setTableWidth(0.75) },
        { label: '60% da página', onClick: () => setTableWidth(0.6) },
        { label: '50% da página', onClick: () => setTableWidth(0.5) },
      ])),
    }),
  ]));

  registerSync(() => {
    const on = isInTable();
    bar.hidden = !on;
    document.body.classList.toggle('in-table', on);
  });
}

function buildRibbon() {
  const bar = ribbonEl; bar.innerHTML = '';
  const chain = () => editor.chain().focus();

  bar.appendChild(ribbonGroup('Editar', [
    tbtn({ icon: 'undo', title: 'Desfazer (Ctrl+Z)', onClick: () => chain().undo().run() }),
    tbtn({ icon: 'redo', title: 'Refazer (Ctrl+Y)', onClick: () => chain().redo().run() }),
  ]));
  bar.appendChild(sep());

  const fontSel = document.createElement('select'); fontSel.className = 'combo-sel'; fontSel.title = 'Fonte';
  fontSel.innerHTML = '<option value="">(padrão)</option>'
    + ['Times New Roman', 'Arial', 'Calibri', 'Courier New', 'Verdana', 'Georgia', 'Tahoma'].map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('');
  fontSel.addEventListener('change', () => editor.chain().focus().setMark('textStyle', { fontFamily: fontSel.value || null }).run());
  registerSync(() => { fontSel.value = editor.getAttributes('textStyle').fontFamily || ''; });
  const sizeSel = document.createElement('select'); sizeSel.className = 'combo-sel size'; sizeSel.title = 'Tamanho';
  sizeSel.innerHTML = '<option value="">–</option>'
    + ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36'].map((s) => `<option value="${s}pt">${s}</option>`).join('');
  sizeSel.addEventListener('change', () => editor.chain().focus().setMark('textStyle', { fontSize: sizeSel.value || null }).run());
  registerSync(() => { sizeSel.value = editor.getAttributes('textStyle').fontSize || ''; });

  bar.appendChild(ribbonGroup('Fonte', [
    fontSel, sizeSel,
    bindActive(tbtn({ icon: 'bold', title: 'Negrito (Ctrl+B)', onClick: () => chain().toggleBold().run() }), () => editor.isActive('bold')),
    bindActive(tbtn({ icon: 'italic', title: 'Itálico (Ctrl+I)', onClick: () => chain().toggleItalic().run() }), () => editor.isActive('italic')),
    bindActive(tbtn({ icon: 'underline', title: 'Sublinhado (Ctrl+U)', onClick: () => chain().toggleUnderline().run() }), () => editor.isActive('underline')),
    bindActive(tbtn({ icon: 'strike', title: 'Tachado', onClick: () => chain().toggleStrike().run() }), () => editor.isActive('strike')),
    bindActive(tbtn({ icon: 'sup', title: 'Sobrescrito', onClick: () => chain().toggleMark('superscript').run() }), () => editor.isActive('superscript')),
    bindActive(tbtn({ icon: 'sub', title: 'Subscrito', onClick: () => chain().toggleMark('subscript').run() }), () => editor.isActive('subscript')),
    bindActive(tbtn({ icon: 'smallcaps', title: 'Versalete', onClick: () => chain().toggleMark('smallcaps').run() }), () => editor.isActive('smallcaps')),
    tbtn({ icon: 'color', label: '▾', title: 'Cor da fonte', onClick: (b) => popover(b, colorGrid(spec.colors, (c) => editor.chain().focus().setColor('#' + c.hex).run(), () => editor.chain().focus().unsetColor().run())) }),
    tbtn({ icon: 'highlight', label: '▾', title: 'Realce', onClick: (b) => popover(b, colorGrid(hlColors(), (c) => editor.chain().focus().toggleHighlight({ color: c.css }).run(), () => editor.chain().focus().unsetHighlight().run())) }),
    tbtn({ icon: 'clear', title: 'Limpar formatação', onClick: () => chain().unsetAllMarks().unsetColor().run() }),
  ]));
  bar.appendChild(sep());

  const al = (icon, a, title) => bindActive(tbtn({ icon, title, onClick: () => setTcuAlign(a) }), () => currentAlign() === a);
  bar.appendChild(ribbonGroup('Parágrafo', [
    al('alignLeft', 'left', 'Alinhar à esquerda'), al('alignCenter', 'center', 'Centralizar'),
    al('alignRight', 'right', 'Alinhar à direita'), al('justify', 'justify', 'Justificar'),
    tbtn({ label: 'a)', title: 'Lista (letra)', onClick: () => insertListItem('lower_letter', 'a', 0) }),
    tbtn({ label: '1)', title: 'Lista (número)', onClick: () => insertListItem('decimal', '1', 0) }),
    tbtn({ label: '+', title: 'Item hierárquico', onClick: () => insertListItem('multilevel', '+', 2) }),
    bindActive(tbtn({ icon: 'quote', title: 'Citação / transcrição', onClick: () => chain().toggleBlockquote().run() }), () => editor.isActive('blockquote')),
  ]));
  bar.appendChild(sep());

  const styleBtn = tbtn({
    label: 'Normal', title: 'Estilo do parágrafo', wide: true,
    onClick: (b) => popover(b, menu([
      { label: 'Normal', onClick: () => chain().setParagraph().run(), active: editor.isActive('paragraph') },
      ...[1, 2, 3, 4, 5, 6].map((l) => ({ label: 'Título ' + l, onClick: () => chain().toggleHeading({ level: l }).run(), active: editor.isActive('heading', { level: l }) })),
    ])),
  });
  const caret = document.createElement('span'); caret.textContent = ' ▾'; styleBtn.appendChild(caret);
  registerSync(() => { let lbl = 'Normal'; for (let l = 1; l <= 6; l++) if (editor.isActive('heading', { level: l })) lbl = 'Título ' + l; styleBtn.firstChild.textContent = lbl; });
  bar.appendChild(ribbonGroup('Estilos', [styleBtn]));
  bar.appendChild(sep());

  bar.appendChild(ribbonGroup('Inserir', [
    tbtn({ icon: 'table', title: 'Inserir tabela 3×3', onClick: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() }),
    tbtn({ icon: 'image', title: 'Inserir figura', onClick: (b) => popover(b, menu([
      { label: '📂  Procurar arquivo…', onClick: insertFigure },
      { label: '🔗  Por caminho / URL…', onClick: insertFigureUrl },
    ])) }),
    tbtn({ icon: 'formula', title: 'Inserir fórmula', onClick: insertFormula }),
    tbtn({ icon: 'anchor', title: 'Inserir âncora', onClick: insertAnchor }),
    tbtn({ icon: 'xref', title: 'Referência cruzada', onClick: insertXref }),
    tbtn({ icon: 'note', title: 'Nota (fim/rodapé)', onClick: insertNote }),
    bindActive(tbtn({ label: '🔗', title: 'Link (selecione o texto ou insira)', onClick: insertLink }), () => editor.isActive('link')),
    tbtn({ label: '💬', title: 'Comentário (selecione o texto)', onClick: insertComment }),
    tbtn({ label: '▤', title: 'Sumário (tabela de conteúdo)', onClick: () => chain().insertContent({ type: 'summary', attrs: { opts: 'title:"Sumário"' } }).run() }),
    tbtn({ icon: 'pagebreak', title: 'Quebra de página', onClick: () => chain().insertContent({ type: 'pageBreak' }).run() }),
    tbtn({ label: '⟳', title: 'Orientação da página', onClick: (b) => popover(b, menu([
      { label: 'Paisagem (landscape)', onClick: () => chain().insertContent({ type: 'pageOrientation', attrs: { orientation: 'landscape' } }).run() },
      { label: 'Retrato (portrait)', onClick: () => chain().insertContent({ type: 'pageOrientation', attrs: { orientation: 'portrait' } }).run() },
    ])) }),
  ]));
  bar.appendChild(sep());

  const trackBtn = bindActive(tbtn({
    label: '⟲ Controlar alterações', title: 'Registrar inserções/exclusões como alterações controladas (Word)', wide: true,
    onClick: () => { trackChangesState.enabled = !trackChangesState.enabled; refreshUI(); editor.view.focus(); },
  }), () => trackChangesState.enabled);
  const ar = (accept, all, doneMsg) => () => {
    const n = acceptRejectChanges(editor, accept, all);
    if (all) notify(n + ' alteração(ões) ' + doneMsg);
    else notify(n ? n + ' alteração(ões) ' + doneMsg : 'Nenhuma alteração no cursor/seleção.', n ? 'ok' : 'err');
  };
  bar.appendChild(ribbonGroup('Revisão', [
    trackBtn,
    tbtn({ label: '✓ Aceitar', title: 'Aceitar a alteração no cursor (ou as da seleção)', onClick: ar(true, false, 'aceita(s) ✓') }),
    tbtn({ label: '✗ Rejeitar', title: 'Rejeitar a alteração no cursor (ou as da seleção)', onClick: ar(false, false, 'rejeitada(s) ✗') }),
    tbtn({ label: 'Aceitar tudo', title: 'Aceitar todas as alterações', onClick: ar(true, true, 'aceita(s) ✓') }),
    tbtn({ label: 'Rejeitar tudo', title: 'Rejeitar todas as alterações', onClick: ar(false, true, 'rejeitada(s) ✗') }),
  ]));

  zoomLabelEl = document.createElement('button');
  zoomLabelEl.className = 'tbtn zoom-level'; zoomLabelEl.type = 'button';
  zoomLabelEl.textContent = '100%'; zoomLabelEl.title = 'Redefinir zoom (100%)';
  zoomLabelEl.addEventListener('click', () => setZoom(1));
  bar.appendChild(ribbonGroup('Zoom', [
    tbtn({ label: '−', title: 'Reduzir zoom (Ctrl+scroll)', onClick: zoomOut }),
    zoomLabelEl,
    tbtn({ label: '+', title: 'Aumentar zoom (Ctrl+scroll)', onClick: zoomIn }),
  ]));

  buildTableRibbon();
}
  editor = new Editor({
    element: editorElement,
    extensions: [
      StarterKit.configure({ bulletList: false, orderedList: false, listItem: false }),
      Underline, TcuTextStyle, Color, TcuHighlight.configure({ multicolor: true }), MarkStyle,
      XrefAnchor, XrefRef, TcuListItem, RawBlock, AutoNumber, SpecialBlock, SpecialLine, Formula, TcuImage, Endnote,
      PageBreak, PageOrientation, FigureGrid, ContinueList, RawList, Summary, Comment, CommentsBlock, Insertion, Deletion, Link,
      Frontmatter.configure({ metaVars: (spec && spec.metadataFields) || [] }),
      ...ATTR_MARKS,
      TcuTable.configure({ resizable: true }), TcuTableRow, TcuTableHeader, TcuTableCell, FixedTableWidth,
      TabIndent, TrackChanges,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: () => onChange(),
  });
  editor.on('selectionUpdate', refreshUI);
  editor.on('transaction', refreshUI);
  trackChangesState.getAuthor = () => getReviewer() || 'Autor'; // tracked edits use the reviewer name

  // --- Zoom: a core editing affordance. Scaling touches caret placement and the
  // body-appended popover coordinates, so the factory owns it (hosts call
  // api.setZoom and drop any shell-level zoom). Applied to the editing surface
  // only; the ribbon and popovers stay at 100%.
  let zoomLevel = 1; let zoomLabelEl = null;
  const ZOOM_MIN = 0.5, ZOOM_MAX = 2;
  const applyZoom = () => {
    editorElement.style.zoom = String(zoomLevel);
    if (zoomLabelEl) zoomLabelEl.textContent = Math.round(zoomLevel * 100) + '%';
  };
  const setZoom = (lvl) => { zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((lvl || 1) * 100) / 100)); applyZoom(); };
  const zoomIn = () => setZoom(zoomLevel + 0.1);
  const zoomOut = () => setZoom(zoomLevel - 0.1);

  buildRibbon();
  // Listeners the factory binds to host-provided elements; aborted in destroy()
  // so the factory is safe to mount/unmount repeatedly (re-mounting hosts).
  const hostListeners = new AbortController();
  // Ctrl+wheel zooms (factory-owned so it composes with the editor's own scroll).
  editorElement.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else zoomOut();
  }, { passive: false, signal: hostListeners.signal });
  if (commentsPanelEl) {
    registerSync(renderCommentsPanel);
    // editor -> panel: DOUBLE-click a commented span to open the panel + reveal
    // the thread (single click just places the caret to edit the text).
    editorElement.addEventListener('dblclick', (e) => {
      const anchor = e.target && e.target.closest ? e.target.closest('.comment-anchor') : null;
      if (anchor && anchor.dataset.comment) { onCommentFocus(); highlightThread(anchor.dataset.comment); }
    }, { signal: hostListeners.signal });
  }
  refreshUI();

  function setAst(ast) {
    docAttrs = ast.attrs || docAttrs;
    const m = /auto_number_paragraphs\s*:\s*(true|false)/i.exec(docAttrs.frontmatter || '');
    autoNumberState.enabled = !(m && m[1].toLowerCase() === 'false');
    // emitUpdate=false: loading content is not a user edit, so onChange must NOT
    // fire (re-mounting hosts wire onChange -> save-back). refreshUI still runs
    // via the transaction event.
    editor.commands.setContent(astToPM(ast, spec), false);
  }
  const getAst = () => pmToAst(editor.getJSON(), spec, docAttrs);

  return { editor, setAst, getAst, getDocAttrs: () => docAttrs, setTableWidth, setZoom, zoomIn, zoomOut, getZoom: () => zoomLevel, refreshUI, destroy: () => { hostListeners.abort(); editor.destroy(); } };
}
