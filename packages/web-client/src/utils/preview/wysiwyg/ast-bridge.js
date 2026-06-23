// Structural mapping between the Python AST (md_ast.py) and TipTap/ProseMirror
// JSON. This file contains ZERO markdown-syntax knowledge: it only renames node
// types and resolves colour names <-> CSS via the parser's capability manifest.

// ---- colour helpers -------------------------------------------------------
export function buildColorMaps(spec) {
  const nameToHex = {};
  const hexToName = {};
  for (const c of (spec.colors || [])) {
    const hex = '#' + c.hex.toUpperCase();
    nameToHex[c.name] = hex;
    if (!(hex in hexToName)) hexToName[hex] = c.name;
  }
  return { nameToHex, hexToName };
}

const HL_TO_CSS = {
  yellow: '#ffff00', green: '#92d050', bright_green: '#00ff00', cyan: '#00ffff',
  turquoise: '#40e0d0', pink: '#ffc0cb', blue: '#0070ff', red: '#ff0000',
  dark_blue: '#002060', teal: '#008080', dark_green: '#006400', violet: '#ee82ee',
  dark_red: '#8b0000', dark_yellow: '#808000', gray: '#808080', grey: '#808080',
};
const CSS_TO_HL = Object.fromEntries(
  Object.entries(HL_TO_CSS).map(([k, v]) => [v.toUpperCase(), k]));

function colorNameToCss(name, maps) {
  if (!name) return name;
  if (name[0] === '#') return name;
  if (/^[0-9a-fA-F]{6}$/.test(name)) return '#' + name;
  return maps.nameToHex[name] || name;
}
function cssToColorName(css, maps) {
  if (!css) return css;
  const key = css.toUpperCase();
  return maps.hexToName[key] || css; // fall back to literal #hex (parser accepts it)
}

// ---- image opts (the single canonical serializer for the whole system) ----
// Image opts live in the ![alt](src){…} brace. The canonical key order is the
// shared contract between the three emitters (parser, importer, editor) so they
// all produce byte-identical strings. width is FIRST; the value-less `lock` is a
// bare flag; unknown/custom tokens are preserved verbatim AFTER the known keys.
export const IMAGE_OPT_ORDER = ['width', 'wrap', 'side', 'align', 'x', 'hrel',
  'valign', 'y', 'vrel', 'gap', 'lock'];
const IMAGE_KNOWN_KEYS = new Set(IMAGE_OPT_ORDER);

// Tokenize an opts string into { known: Map, unknown: string[] }. Known keys are
// bucketed into the map (last write wins, like the parser); value-less `lock`
// stores the empty string; anything else keeps its original token order.
export function parseImageOpts(str) {
  const known = new Map();
  const unknown = [];
  for (const tok of (str || '').trim().split(/\s+/).filter(Boolean)) {
    const i = tok.indexOf('=');
    if (i < 0) {
      if (tok === 'lock') known.set('lock', '');
      else unknown.push(tok);
      continue;
    }
    const k = tok.slice(0, i);
    const v = tok.slice(i + 1);
    if (IMAGE_KNOWN_KEYS.has(k)) known.set(k, v);
    else unknown.push(tok);
  }
  return { known, unknown };
}

// Serialize a known-key map (+ optional unknown tokens) into the canonical
// string: known keys in IMAGE_OPT_ORDER, then unknowns verbatim, single-space
// joined, no surrounding whitespace. `lock` is emitted as a bare flag whenever
// it is present and truthy (or an empty string, the value-less form).
export function serializeImageOpts(map, unknown = []) {
  const get = (k) => (map instanceof Map ? map.get(k) : map[k]);
  const has = (k) => (map instanceof Map ? map.has(k) : Object.prototype.hasOwnProperty.call(map, k));
  const tokens = [];
  for (const k of IMAGE_OPT_ORDER) {
    if (!has(k)) continue;
    const v = get(k);
    if (k === 'lock') {
      if (v === '' || v === true || v === 'lock' || v === '1' || v === 'true') tokens.push('lock');
      continue;
    }
    if (v == null || v === '') continue;
    tokens.push(`${k}=${v}`);
  }
  for (const t of (unknown || [])) tokens.push(t);
  return tokens.join(' ');
}

// ---- inline ---------------------------------------------------------------
// Flag (value-less) attribute marks shared by both directions.
const FLAG_MARKS = ['superscript', 'subscript', 'smallcaps', 'allcaps',
  'doubleStrike', 'emboss', 'imprint', 'outline', 'shadow', 'hidden'];

// Block-level attributes ({center}, {size:N}, {space-after:Npt}, {line-height},
// {first-line-indent}, {font}) on paragraphs/headings. Kept verbatim as a raw
// string for round-trip; rendered to CSS; align extracted for the UI.
export function setBlockAlignRaw(raw, align) {
  const toks = (raw || '').split(/\s+/).filter((t) => t && !['left', 'center', 'right', 'justify'].includes(t));
  if (align && align !== 'justify') toks.unshift(align);
  return toks.join(' ');
}

// Adjust a paragraph/heading left indent by dir steps of 1.25cm (Word's default
// Tab). Floors at 0 (removes the token). Used by the Tab/Shift+Tab/Backspace keymap.
export function setBlockIndentRaw(raw, dir) {
  const STEP = 1.25;
  const m = /(?:^|\s)indent:([\d.]+)cm/.exec(raw || '');
  const cur = m ? parseFloat(m[1]) : 0;
  const next = Math.max(0, Math.round((cur + dir * STEP) * 100) / 100);
  const toks = (raw || '').split(/\s+/).filter((t) => t && !/^indent:/.test(t));
  if (next > 0) toks.push('indent:' + next + 'cm');
  return toks.join(' ');
}
export function blockCss(raw, maps) {
  if (!raw) return null;
  const len = (v) => (/^[\d.]+$/.test(v) ? v + 'pt' : v);
  const truthy = (v) => /^(true|1|yes)$/i.test(v);
  // Resolve a colour token (palette name / bare hex / #hex) to a CSS colour.
  // Degrades gracefully when `maps` is absent (named colours pass through).
  const colorCss = (v) => {
    if (!v) return v;
    if (v[0] === '#') return v;
    if (/^[0-9a-fA-F]{6}$/.test(v)) return '#' + v;
    return (maps && maps.nameToHex && maps.nameToHex[v]) || v;
  };
  const decls = [];
  for (const tok of raw.split(/\s+/)) {
    if (['left', 'center', 'right', 'justify'].includes(tok)) { decls.push(`text-align:${tok}`); continue; }
    const i = tok.indexOf(':'); if (i < 0) continue;
    const k = tok.slice(0, i); const v = tok.slice(i + 1);
    if (k === 'size') decls.push(`font-size:${len(v)}`);
    else if (k === 'font') decls.push(`font-family:${v}`);
    else if (k === 'space-after') decls.push(`margin-bottom:${len(v)}`);
    else if (k === 'space-before') decls.push(`margin-top:${len(v)}`);
    else if (k === 'line-height') decls.push(`line-height:${/^[\d.]+$/.test(v) ? v : len(v)}`);
    else if (k === 'first-line-indent') decls.push(`text-indent:${len(v)}`);
    else if (k === 'indent') decls.push(`margin-left:${len(v)}`);
    // text formatting carried at block scope (per-instance heading/para overrides)
    else if (k === 'color') decls.push(`color:${colorCss(v)}`);
    else if (k === 'bg' && v !== 'none') decls.push(`background-color:${colorCss(v)}`);
    else if (k === 'highlight') decls.push(`background-color:${(HL_TO_CSS[v] || colorCss(v))}`);
    else if (k === 'bold' && truthy(v)) decls.push('font-weight:bold');
    else if (k === 'italic' && truthy(v)) decls.push('font-style:italic');
    else if (k === 'underline' && truthy(v)) decls.push('text-decoration:underline');
    else if (k === 'strikethrough' && truthy(v)) decls.push('text-decoration:line-through');
    else if (k === 'allcaps' && truthy(v)) decls.push('text-transform:uppercase');
    else if (k === 'smallcaps' && truthy(v)) decls.push('font-variant:small-caps');
    // borders: "2pt-dark_blue" / "1pt" / "0" (palette colours use '_', not '-')
    else if (k === 'border' || k.startsWith('border-')) {
      const side = k === 'border' ? '' : '-' + k.slice('border-'.length);
      if (v === '0') decls.push(`border${side}:none`);
      else {
        const j = v.indexOf('-');
        const w = j < 0 ? v : v.slice(0, j);
        const col = j < 0 ? '#000' : colorCss(v.slice(j + 1));
        decls.push(`border${side}:${w} solid ${col}`);
      }
    }
  }
  return decls.length ? decls.join(';') : null;
}
function blockAlignOf(raw) {
  const m = /(?:^|\s)(left|center|right|justify)(?:\s|$)/.exec(raw || '');
  return m ? m[1] : null;
}
function blockAlignToPM(b, maps) {
  const raw = b.attrs?.block;
  if (!raw) return {};
  return { tcuBlockRaw: raw, tcuAlign: blockAlignOf(raw), tcuBlockCss: blockCss(raw, maps) };
}
function blockAlignFromPM(n) {
  return n.attrs?.tcuBlockRaw ? { block: n.attrs.tcuBlockRaw } : {};
}

function marksAstToPM(marks, maps) {
  const out = [];
  let ts = null; // colour + size + font all live on a single textStyle mark
  for (const m of (marks || [])) {
    if (m.type === 'bold' || m.type === 'italic' || m.type === 'underline') {
      const mk = { type: m.type };
      if (m.style === 'brace') mk.attrs = { tcuStyle: 'brace' };
      out.push(mk);
    } else if (m.type === 'strike') {
      out.push({ type: 'strike' });
    } else if (m.type === 'textColor') {
      ts = ts || {}; ts.color = colorNameToCss(m.attrs.color, maps); ts.tcuColor = m.attrs.color;
    } else if (m.type === 'fontSize') {
      ts = ts || {}; ts.fontSize = m.value;
    } else if (m.type === 'fontFamily') {
      ts = ts || {}; ts.fontFamily = m.value;
    } else if (m.type === 'highlight') {
      out.push({ type: 'highlight', attrs: { color: HL_TO_CSS[m.attrs.color] || '#ffff00', tcuColor: m.attrs.color } });
    } else if (m.type === 'comment') {
      out.push({ type: 'comment', attrs: { commentId: m.attrs.id } });
    } else if (m.type === 'ins' || m.type === 'del') {
      out.push({ type: m.type, attrs: { author: m.attrs.author || '', date: m.attrs.date || '' } });
    } else if (m.type === 'link') {
      out.push({ type: 'link', attrs: { href: m.attrs.href || '' } });
    } else if (FLAG_MARKS.includes(m.type)) {
      out.push({ type: m.type });
    }
  }
  if (ts) out.push({ type: 'textStyle', attrs: ts });
  return out;
}

function marksPMToAst(marks, maps) {
  const out = [];
  for (const m of (marks || [])) {
    if (m.type === 'bold' || m.type === 'italic' || m.type === 'underline') {
      const ast = { type: m.type };
      if (m.attrs?.tcuStyle === 'brace') ast.style = 'brace';
      out.push(ast);
    } else if (m.type === 'strike') {
      out.push({ type: 'strike' });
    } else if (m.type === 'textStyle') {
      const a = m.attrs || {};
      if (a.color) {
        const orig = a.tcuColor;
        const token = (orig && colorNameToCss(orig, maps) === a.color) ? orig : cssToColorName(a.color, maps);
        out.push({ type: 'textColor', attrs: { color: token } });
      }
      if (a.fontSize) out.push({ type: 'fontSize', value: a.fontSize });
      if (a.fontFamily) out.push({ type: 'fontFamily', value: a.fontFamily });
    } else if (m.type === 'highlight') {
      const orig = m.attrs?.tcuColor;
      const token = (orig && (HL_TO_CSS[orig] || '#ffff00') === m.attrs?.color)
        ? orig : (CSS_TO_HL[(m.attrs?.color || '').toUpperCase()] || 'yellow');
      out.push({ type: 'highlight', attrs: { color: token } });
    } else if (m.type === 'comment') {
      out.push({ type: 'comment', attrs: { id: m.attrs?.commentId || '' } });
    } else if (m.type === 'ins' || m.type === 'del') {
      out.push({ type: m.type, attrs: { author: m.attrs?.author || '', date: m.attrs?.date || '' } });
    } else if (m.type === 'link') {
      out.push({ type: 'link', attrs: { href: m.attrs?.href || '' } });
    } else if (FLAG_MARKS.includes(m.type)) {
      out.push({ type: m.type });
    }
  }
  return out;
}

function inlineAstToPM(nodes, maps) {
  const out = [];
  for (const nd of (nodes || [])) {
    if (nd.type === 'text') {
      const pm = { type: 'text', text: nd.text };
      const marks = marksAstToPM(nd.marks, maps);
      if (marks.length) pm.marks = marks;
      out.push(pm);
    } else if (nd.type === 'xrefAnchor' || nd.type === 'xrefRef' || nd.type === 'formula' || nd.type === 'endnote') {
      out.push({ type: nd.type, attrs: { ...nd.attrs } });
    }
  }
  return out;
}

function inlinePMToAst(nodes, maps) {
  const out = [];
  for (const nd of (nodes || [])) {
    if (nd.type === 'text') {
      const ast = { type: 'text', text: nd.text };
      const marks = marksPMToAst(nd.marks, maps);
      if (marks.length) ast.marks = marks;
      out.push(ast);
    } else if (nd.type === 'xrefAnchor' || nd.type === 'xrefRef' || nd.type === 'formula' || nd.type === 'endnote') {
      out.push({ type: nd.type, attrs: { ...nd.attrs } });
    }
  }
  return out;
}

// ---- tables ---------------------------------------------------------------
function cellParagraphFromInline(content, maps) {
  const inl = inlineAstToPM(content, maps);
  return inl.length ? { type: 'paragraph', content: inl } : { type: 'paragraph' };
}

function tableAstToPM(t, maps) {
  return (t.attrs?.syntax === 'markdown') ? mdTableAstToPM(t, maps) : blockTableAstToPM(t, maps);
}

// Parse the span/merge/bg bits out of a "Col {attrs}" header (display only;
// Python still owns the syntax for serialisation via the stashed original).
function parseCellSpan(headerRaw) {
  const a = { colspan: 1, rowspan: 1, merge: null, mergeInto: null, bg: null };
  const m = /\{([^}]*)\}/.exec(headerRaw || '');
  if (m) {
    for (const tok of m[1].split(/\s+/)) {
      const i = tok.indexOf(':');
      const k = i < 0 ? tok : tok.slice(0, i);
      const v = i < 0 ? '' : tok.slice(i + 1);
      if (k === 'colspan') a.colspan = parseInt(v, 10) || 1;
      else if (k === 'rowspan') a.rowspan = parseInt(v, 10) || 1;
      else if (k === 'merge') a.merge = v;
      else if (k === 'merge-into') a.mergeInto = v;
      else if (k === 'bg' || k === 'fill') a.bg = v.replace(/^#/, '');
    }
  }
  return a;
}

// Turn a cell attribute string ("bg:E7E6E6 border-top:1.5pt-black border-left:none")
// into display CSS. Display-only; the attrs round-trip via headerRaw/markdown.
export function cellCss(attrStr) {
  if (!attrStr) return null;
  const col = (c) => (/^[0-9a-fA-F]{6}$/.test(c) ? '#' + c : c);
  const len = (v) => (/^[\d.]+$/.test(v) ? v + 'pt' : v); // bare number -> pt
  const decls = [];
  for (const tok of attrStr.split(/\s+/)) {
    let m;
    if ((m = /^(?:bg|fill):(.+)$/.exec(tok))) { if (m[1] !== 'none') decls.push(`background-color:${col(m[1])}`); }
    else if ((m = /^border(-top|-bottom|-left|-right)?:(.+)$/.exec(tok))) {
      const sides = m[1] ? [m[1].slice(1)] : ['top', 'bottom', 'left', 'right'];
      const mm = /^([\d.]+)pt-(.+)$/.exec(m[2]);
      for (const s of sides) {
        if (m[2] === 'none') decls.push(`border-${s}:none`);
        else if (mm) decls.push(`border-${s}:${mm[1]}pt solid ${col(mm[2])}`);
      }
    }
    else if ((m = /^align:(.+)$/.exec(tok))) decls.push(`text-align:${m[1]}`);
    else if ((m = /^valign:(.+)$/.exec(tok))) decls.push(`vertical-align:${m[1] === 'center' ? 'middle' : m[1]}`);
    else if ((m = /^font:(.+)$/.exec(tok))) decls.push(`font-family:${m[1]}`);
    else if ((m = /^size:(.+)$/.exec(tok))) decls.push(`font-size:${len(m[1])}`);
    else if ((m = /^width:(.+)$/.exec(tok))) decls.push(`width:${len(m[1])}`);
    else if ((m = /^padding:(.+)$/.exec(tok))) decls.push(`padding:${len(m[1])}`);
    else if ((m = /^padding-(top|bottom|left|right):(.+)$/.exec(tok))) decls.push(`padding-${m[1]}:${len(m[2])}`);
    else if ((m = /^line-height:(.+)$/.exec(tok))) decls.push(`line-height:${/^[\d.]+$/.test(m[1]) ? m[1] : len(m[1])}`);
    else if ((m = /^bold:(true|false)$/.exec(tok))) decls.push(`font-weight:${m[1] === 'true' ? '700' : '400'}`);
    else if ((m = /^italic:(true|false)$/.exec(tok))) decls.push(`font-style:${m[1] === 'true' ? 'italic' : 'normal'}`);
    else if ((m = /^text-direction:(.+)$/.exec(tok))) {
      if (/^(vertical|tbRl|btLr|vertical-rl)$/.test(m[1])) decls.push('writing-mode:vertical-rl', 'white-space:nowrap');
    }
  }
  return decls.length ? decls.join(';') : null;
}
const bracesOf = (headerRaw) => (/\{([^}]*)\}/.exec(headerRaw || '') || [, ''])[1];

// Column-width helpers: prosemirror stores a pixel `colwidth`; the parser wants
// {width:Npt} (96-dpi: 1pt = 1.3333px). Used to round-trip column resizing.
const PT_PER_PX = 0.75;
export function pxToPtStr(px) { return (Math.round(px * PT_PER_PX * 10) / 10) + 'pt'; }
export function widthAttrToPx(widthStr) {
  const m = /^([\d.]+)(pt|cm|mm|in|px|%)?$/.exec(widthStr || '');
  if (!m || m[2] === '%') return null; // % can't map to a fixed pixel colwidth
  const v = parseFloat(m[1]); const u = m[2] || 'pt';
  const pt = u === 'cm' ? v * 28.3465 : u === 'mm' ? v * 2.83465 : u === 'in' ? v * 72 : u === 'px' ? v * PT_PER_PX : v;
  return Math.round(pt / PT_PER_PX);
}
export function widthOfAttrStr(attrStr) {
  const m = /(?:^|\s)width:([\d.]+(?:pt|cm|mm|in|px|%)?)/.exec(attrStr || '');
  return m ? m[1] : null;
}
const colwidthOf = (cell) => (cell.attrs && Array.isArray(cell.attrs.colwidth) && cell.attrs.colwidth[0]) || null;

// The editable attr part of a cell's raw string (markdown = whole, block = braces).
export function cellAttrString(raw, isBlock) {
  return isBlock ? bracesOf(raw) : (raw || '');
}

// Apply attribute changes ({key:value|null}) to a cell's raw string, preserving
// the block column-name prefix and attribute order. Used by the table controls.
export function editCellRaw(raw, changes, isBlock) {
  raw = raw || '';
  let prefix = '', body = '';
  if (isBlock) {
    const bi = raw.indexOf('{');
    if (bi >= 0) { prefix = raw.slice(0, bi).trimEnd(); body = raw.slice(bi + 1).replace(/\}\s*$/, ''); }
    else { prefix = raw.trim(); body = ''; }
  } else {
    body = raw;
  }
  const pairs = [];
  for (const tok of body.split(/\s+/).filter(Boolean)) {
    const i = tok.indexOf(':');
    pairs.push(i < 0 ? [tok, null] : [tok.slice(0, i), tok.slice(i + 1)]);
  }
  for (const [k, v] of Object.entries(changes)) {
    const e = pairs.find((p) => p[0] === k);
    if (v === null) { if (e) pairs.splice(pairs.indexOf(e), 1); }
    else if (e) e[1] = v;
    else pairs.push([k, v]);
  }
  const newBody = pairs.map(([k, v]) => (v === null ? k : `${k}:${v}`)).join(' ');
  if (isBlock) return prefix + (newBody ? (prefix ? ' ' : '') + `{${newBody}}` : '');
  return newBody;
}

function blockTableHasMerges(rows) {
  return (rows || []).some((r) => (r.cells || []).some((c) => {
    const s = parseCellSpan(c.headerRaw);
    return s.colspan > 1 || s.rowspan > 1 || s.merge || s.mergeInto;
  }));
}

function blockTableAstToPM(t, maps) {
  return blockTableHasMerges(t.rows) ? blockTableMergedToPM(t, maps) : blockTableEditableToPM(t, maps);
}

// Simple tables: 1 source cell -> 1 PM cell, fully editable (add/remove rows).
function blockTableEditableToPM(t, maps) {
  const colDefs = t.columnDefaults || [];
  const colW = colDefs.map((d) => widthAttrToPx(widthOfAttrStr(bracesOf(d))));
  return {
    type: 'table',
    attrs: { tcuSyntax: 'block', tcuHeader: t.attrs.header,
      tcuColumnDefaults: colDefs, tcuRowDefaults: t.rowDefaults || [], tcuOriginal: null },
    content: (t.rows || []).map((r) => ({
      type: 'tableRow', attrs: { tcuHeaderRaw: r.headerRaw || '' },
      content: (r.cells || []).map((c, ci) => ({
        type: 'tableCell',
        attrs: { tcuHeaderRaw: c.headerRaw || '', tcuCss: cellCss(bracesOf(c.headerRaw)), colwidth: colW[ci] ? [colW[ci]] : null },
        content: [cellParagraphFromInline(c.content, maps)],
      })),
    })),
  };
}

// Merged tables: resolve colspan/rowspan + merge:id groups into a valid PM grid
// (covered cells dropped). The original AST is stashed for a byte-exact
// round-trip; only cell CONTENT edits are read back (via tcuSrc).
function blockTableMergedToPM(t, maps) {
  const rows = t.rows || [];
  const parsed = rows.map((r) => (r.cells || []).map((c) => ({
    content: c.content, headerRaw: c.headerRaw, span: parseCellSpan(c.headerRaw),
  })));
  // simple per-row column index (matches the parser's merge-group column calc)
  parsed.forEach((row) => { let col = 0; row.forEach((c) => { c.col = col; col += c.span.colspan; }); });
  // resolve merge groups (explicit merge/merge-into + implicit merge-on-all)
  const groups = {};
  parsed.forEach((row, ri) => row.forEach((c) => {
    const id = c.span.merge || c.span.mergeInto;
    if (id) (groups[id] = groups[id] || []).push({ ri, c, main: !!c.span.merge });
  }));
  for (const members of Object.values(groups)) {
    const main = (members.find((m) => m.main) || members[0]).c;
    const minCol = Math.min(...members.map((m) => m.c.col));
    const maxEnd = Math.max(...members.map((m) => m.c.col + m.c.span.colspan));
    const minRow = Math.min(...members.map((m) => m.ri));
    const maxRow = Math.max(...members.map((m) => m.ri));
    main.span.colspan = maxEnd - minCol;
    main.span.rowspan = maxRow - minRow + 1;
    members.forEach((m) => { if (m.c !== main) m.c.dropped = true; });
  }
  // lay out the grid, skipping positions covered by a rowspan from above
  const occupied = new Set();
  const content = parsed.map((row, r) => {
    const cells = [];
    let col = 0;
    for (let ci = 0; ci < row.length; ci++) {
      const c = row[ci];
      if (c.dropped) continue;
      while (occupied.has(`${r},${col}`)) col++;
      const cs = c.span.colspan, rs = c.span.rowspan;
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) if (dr || dc) occupied.add(`${r + dr},${col + dc}`);
      cells.push({
        type: 'tableCell',
        attrs: { tcuHeaderRaw: c.headerRaw || '', tcuSrc: `${r},${ci}`, tcuCss: cellCss(bracesOf(c.headerRaw)), colspan: cs, rowspan: rs },
        content: [cellParagraphFromInline(c.content, maps)],
      });
      col += cs;
    }
    return { type: 'tableRow', attrs: { tcuHeaderRaw: rows[r].headerRaw || '' }, content: cells };
  });
  return {
    type: 'table',
    attrs: { tcuSyntax: 'block', tcuHeader: t.attrs.header,
      tcuColumnDefaults: t.columnDefaults || [], tcuRowDefaults: t.rowDefaults || [], tcuOriginal: t },
    content,
  };
}

function mdTableAstToPM(t, maps) {
  const headerCells = (t.rows || []).find((r) => r.header)?.cells || [];
  const colW = headerCells.map((c) => widthAttrToPx(widthOfAttrStr(c.attrs)));
  return {
    type: 'table',
    attrs: { tcuSyntax: 'markdown', tcuCaption: t.attrs.caption || null },
    content: (t.rows || []).map((r) => ({
      type: 'tableRow',
      content: (r.cells || []).map((c, ci) => ({
        type: r.header ? 'tableHeader' : 'tableCell',
        attrs: { tcuHeaderRaw: c.attrs || '', tcuCss: cellCss(c.attrs), colwidth: colW[ci] ? [colW[ci]] : null },
        content: [cellParagraphFromInline(c.content, maps)],
      })),
    })),
  };
}

function cellInlineFromPM(blocks, maps) {
  // Concatenate the inline content of each paragraph, separated by a blank line.
  const out = [];
  (blocks || []).forEach((blk, i) => {
    if (i > 0) out.push({ type: 'text', text: '\n\n' });
    out.push(...inlinePMToAst(blk.content, maps));
  });
  return out;
}

function tablePMToAst(n, maps) {
  return (n.attrs?.tcuSyntax === 'markdown') ? mdTablePMToAst(n, maps) : blockTablePMToAst(n, maps);
}

function blockTablePMToAst(n, maps) {
  // Merged table: the covered cells only exist in the stash (the parser's block
  // tables need them present), so structure stays frozen. We DO overlay both the
  // edited content AND the edited cell attributes (bg/borders/align from the
  // table controls), matched back via tcuSrc.
  if (n.attrs?.tcuOriginal) {
    const orig = JSON.parse(JSON.stringify(n.attrs.tcuOriginal));
    for (const row of (n.content || [])) {
      for (const c of (row.content || [])) {
        const src = (c.attrs?.tcuSrc || '').split(',').map(Number);
        const cell = (src.length === 2) ? orig.rows?.[src[0]]?.cells?.[src[1]] : null;
        if (cell) {
          cell.content = cellInlineFromPM(c.content, maps);
          if (c.attrs?.tcuHeaderRaw) cell.headerRaw = c.attrs.tcuHeaderRaw;
        }
      }
    }
    // fold any resized column widths into the stashed column defaults
    orig.columnDefaults = colDefsWithWidths(n, orig.columnDefaults || []);
    return orig;
  }
  return {
    type: 'table',
    attrs: { syntax: 'block', header: n.attrs?.tcuHeader || 'table' },
    columnDefaults: colDefsWithWidths(n, n.attrs?.tcuColumnDefaults || []),
    rowDefaults: n.attrs?.tcuRowDefaults || [],
    rows: (n.content || []).map((r, ri) => ({
      headerRaw: (r.attrs?.tcuHeaderRaw && r.attrs.tcuHeaderRaw.trim()) || `Row ${ri}`,
      cells: (r.content || []).map((c, ci) => ({
        headerRaw: (c.attrs?.tcuHeaderRaw && c.attrs.tcuHeaderRaw.trim()) || `Col${ci}`,
        content: cellInlineFromPM(c.content, maps),
      })),
    })),
  };
}

// Fold dragged column widths (px colwidth on the first row's cells, honouring
// colspan) into the block table's Column Defaults — by GRID column, only where
// the width actually changed, so unresized columns keep their original tokens.
// Produces a dense list (placeholder `ColN` for gaps) to keep index alignment.
function colDefsWithWidths(n, existing) {
  const row0 = n.content?.[0]?.content || [];
  const widths = {};
  let gc = 0;
  for (const c of row0) {
    const cw = Array.isArray(c.attrs?.colwidth) ? c.attrs.colwidth : null;
    const span = c.attrs?.colspan || 1;
    for (let k = 0; k < span; k++) if (cw && cw[k]) widths[gc + k] = cw[k];
    gc += span;
  }
  if (!Object.keys(widths).length) return existing; // nothing resized
  const maxCol = Math.max((existing.length || 0) - 1, ...Object.keys(widths).map(Number));
  const defs = [];
  for (let i = 0; i <= maxCol; i++) {
    let d = existing[i] || `Col${i}`;
    const px = widths[i];
    if (px) {
      const origW = widthOfAttrStr(bracesOf(d));
      if (!origW || widthAttrToPx(origW) !== px) d = editCellRaw(d, { width: pxToPtStr(px) }, true);
    }
    defs.push(d);
  }
  return defs;
}

function mdTablePMToAst(n, maps) {
  return {
    type: 'table',
    attrs: { syntax: 'markdown', caption: n.attrs?.tcuCaption || null },
    rows: (n.content || []).map((r) => {
      const isHeader = (r.content || []).some((c) => c.type === 'tableHeader');
      return {
        header: isHeader,
        cells: (r.content || []).map((c) => {
          let raw = c.attrs?.tcuHeaderRaw || '';
          if (isHeader) { // the parser reads markdown column widths from header cells
            const cw = colwidthOf(c);
            const origW = widthOfAttrStr(raw);
            if (cw && (!origW || widthAttrToPx(origW) !== cw)) raw = editCellRaw(raw, { width: pxToPtStr(cw) }, false);
          }
          const cell = { content: cellInlineFromPM(c.content, maps) };
          if (raw) cell.attrs = raw;
          return cell;
        }),
      };
    }),
  };
}

// ---- structural line blocks (title/preamble/fecho) ------------------------
function specialBlockAstToPM(b, maps) {
  return {
    type: 'specialBlock',
    attrs: { kind: b.attrs.kind, header: b.attrs.header },
    content: (b.content || []).map((ln) => ({
      type: 'specialLine',
      attrs: { indent: ln.attrs?.indent || 0, align: ln.attrs?.align || null, size: ln.attrs?.size || null },
      content: inlineAstToPM(ln.content, maps),
    })),
  };
}

function specialBlockPMToAst(n, maps) {
  return {
    type: 'specialBlock',
    attrs: { kind: n.attrs?.kind || 'title', header: n.attrs?.header || n.attrs?.kind || 'title' },
    content: (n.content || []).map((ln) => {
      const attrs = { indent: ln.attrs?.indent || 0 };
      if (ln.attrs?.align) attrs.align = ln.attrs.align;
      if (ln.attrs?.size != null) attrs.size = ln.attrs.size;
      return { type: 'specialLine', attrs, content: inlinePMToAst(ln.content, maps) };
    }),
  };
}

// ---- blocks ---------------------------------------------------------------
export function astToPM(ast, spec) {
  const maps = buildColorMaps(spec);
  const content = [];
  if (ast.attrs && ast.attrs.frontmatter) {
    content.push({ type: 'frontmatter', attrs: { raw: ast.attrs.frontmatter } });
  }
  for (const b of (ast.content || [])) {
    if (b.type === 'heading') {
      content.push({ type: 'heading', attrs: { level: b.attrs.level, ...blockAlignToPM(b, maps) }, content: inlineAstToPM(b.content, maps) });
    } else if (b.type === 'paragraph') {
      const c = inlineAstToPM(b.content, maps);
      const node = { type: 'paragraph' };
      const pa = blockAlignToPM(b, maps);
      if (Object.keys(pa).length) node.attrs = pa;
      if (c.length) node.content = c;
      content.push(node);
    } else if (b.type === 'list') {
      for (const it of b.content) {
        content.push({
          type: 'tcuListItem',
          attrs: { ...it.attrs },
          content: inlineAstToPM(it.content, maps),
        });
      }
    } else if (b.type === 'rawBlock') {
      content.push({ type: 'rawBlock', attrs: { ...b.attrs } });
    } else if (b.type === 'specialBlock') {
      content.push(specialBlockAstToPM(b, maps));
    } else if (b.type === 'quote') {
      content.push({
        type: 'blockquote',
        content: (b.content || []).map((p) => {
          const c = inlineAstToPM(p.content, maps);
          return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' };
        }),
      });
    } else if (b.type === 'image') {
      content.push({ type: 'image', attrs: { ...b.attrs } });
    } else if (b.type === 'pageBreak') {
      content.push({ type: 'pageBreak' });
    } else if (b.type === 'summary') {
      content.push({ type: 'summary', attrs: { opts: (b.attrs && b.attrs.opts) || '' } });
    } else if (b.type === 'comments') {
      content.push({ type: 'commentsBlock', attrs: { items: b.items || [] } });
    } else if (b.type === 'pageOrientation') {
      content.push({ type: 'pageOrientation', attrs: { orientation: b.attrs.orientation } });
    } else if (b.type === 'figureGrid') {
      content.push({ type: 'figureGrid', attrs: { opts: b.attrs.opts || '', caption: b.attrs.caption || null, raw: b.raw || '', images: b.images || [] } });
    } else if (b.type === 'continueList' || b.type === 'rawList') {
      content.push({ type: b.type, attrs: { raw: b.raw || '' } });
    } else if (b.type === 'table') {
      content.push(tableAstToPM(b, maps));
    }
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

export function pmToAst(pmDoc, spec, docAttrs) {
  const maps = buildColorMaps(spec);
  const blocks = [];
  let listRun = null;
  let frontmatter = (docAttrs && docAttrs.frontmatter) || null;
  const flushList = () => { if (listRun) { blocks.push(listRun); listRun = null; } };

  for (const n of (pmDoc.content || [])) {
    if (n.type === 'frontmatter') { frontmatter = n.attrs.raw; continue; } // canvas metadata card
    if (n.type === 'tcuListItem') {
      if (!listRun) listRun = { type: 'list', content: [] };
      listRun.content.push({ type: 'listItem', attrs: { ...n.attrs }, content: inlinePMToAst(n.content, maps) });
      continue;
    }
    flushList();
    if (n.type === 'heading') {
      blocks.push({ type: 'heading', attrs: { level: n.attrs.level, ...blockAlignFromPM(n) }, content: inlinePMToAst(n.content, maps) });
    } else if (n.type === 'paragraph') {
      const ast = { type: 'paragraph', content: inlinePMToAst(n.content, maps) };
      const ba = blockAlignFromPM(n);
      if (Object.keys(ba).length) ast.attrs = ba;
      blocks.push(ast);
    } else if (n.type === 'rawBlock') {
      blocks.push({ type: 'rawBlock', attrs: { ...n.attrs } });
    } else if (n.type === 'specialBlock') {
      blocks.push(specialBlockPMToAst(n, maps));
    } else if (n.type === 'blockquote') {
      blocks.push({
        type: 'quote',
        content: (n.content || []).map((p) => ({ type: 'quotePara', content: inlinePMToAst(p.content, maps) })),
      });
    } else if (n.type === 'image') {
      blocks.push({ type: 'image', attrs: { ...n.attrs } });
    } else if (n.type === 'pageBreak') {
      blocks.push({ type: 'pageBreak' });
    } else if (n.type === 'summary') {
      blocks.push({ type: 'summary', attrs: { opts: n.attrs.opts || '' } });
    } else if (n.type === 'commentsBlock') {
      blocks.push({ type: 'comments', items: n.attrs.items || [] });
    } else if (n.type === 'pageOrientation') {
      blocks.push({ type: 'pageOrientation', attrs: { orientation: n.attrs.orientation } });
    } else if (n.type === 'figureGrid') {
      blocks.push({ type: 'figureGrid', attrs: { opts: n.attrs.opts, caption: n.attrs.caption }, raw: n.attrs.raw, images: n.attrs.images });
    } else if (n.type === 'continueList' || n.type === 'rawList') {
      blocks.push({ type: n.type, raw: n.attrs.raw });
    } else if (n.type === 'table') {
      blocks.push(tablePMToAst(n, maps));
    }
  }
  flushList();
  return { type: 'doc', attrs: { ...(docAttrs || { trailingNewline: true }), frontmatter }, content: blocks };
}
