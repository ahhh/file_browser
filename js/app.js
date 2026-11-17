/* File Object Browser — UI */
(function () {
  'use strict';
  const F = window.FOB, RP = window.FOBRepair;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hx = (v, w = 2) => F.hex(v, w);
  const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fob.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fob.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  /* ================= state ================= */
  const S = {
    grammars: [],          // {g, src, builtin, file}
    stack: [],             // open files: {name, bytes, grammarId, result, cursor, scroll}
    file: null,
    result: null,
    nodes: [],             // id -> node
    view: store.get('view', 'hex'),
    depth: store.get('depth', 2),
    bpr: store.get('bpr', 16),
    notes: store.get('notes', true),
    colors: store.get('colors', true),
    cursor: 0,
    anchor: null,
    sel: null,             // [start, end)
    node: null,            // selected node
    hover: null,           // hovered leaf
    rows: null,            // annotated rows
    collapsed: new Set(),
    expandedRuns: new Set(),
    treeOpen: new Set(),
    grammarLoadError: null,
  };
  const ROW = 20;

  /* ================= grammars ================= */
  async function loadBuiltinGrammars() {
    try {
      const list = await (await fetch('grammars/index.json', { cache: 'no-cache' })).json();
      const texts = await Promise.all(list.map(f => fetch('grammars/' + f, { cache: 'no-cache' }).then(r => r.text()).then(t => [f, t])));
      for (const [f, t] of texts) {
        try { S.grammars.push({ g: F.prepareGrammar(t), src: t, builtin: true, file: f }); }
        catch (e) { console.error('Grammar', f, e); toast(`Grammar ${f} failed to load: ${e.message}`); }
      }
    } catch (e) {
      S.grammarLoadError = e;
    }
    for (const src of store.get('customGrammars', [])) {
      try { addGrammar(src, false, true); } catch (e) { console.warn('custom grammar', e); }
    }
    refreshGrammarSelect();
  }
  function addGrammar(src, persist, quiet) {
    const g = F.prepareGrammar(src);
    const i = S.grammars.findIndex(x => x.g.id === g.id && !x.builtin);
    const entry = { g, src, builtin: false };
    if (i >= 0) S.grammars[i] = entry; else S.grammars.push(entry);
    if (persist) {
      const list = S.grammars.filter(x => !x.builtin).map(x => x.src);
      store.set('customGrammars', list);
    }
    if (!quiet) refreshGrammarSelect();
    return entry;
  }
  function grammarEntry(id) {
    return S.grammars.slice().reverse().find(x => x.g.id === id) || null;
  }
  function refreshGrammarSelect() {
    const sel = $('#grammarSelect');
    const cur = S.file ? S.file.grammarId : '';
    sel.innerHTML = `<option value="">(raw bytes — no grammar)</option>` + S.grammars.map(x =>
      `<option value="${esc(x.g.id)}"${x.g.id === cur ? ' selected' : ''}>${esc(x.g.name)}${x.builtin ? '' : ' (custom)'}</option>`).join('');
    $('#grammarCount').textContent = S.grammarLoadError
      ? 'Built-in grammars could not be loaded. If you opened index.html from disk, serve the folder instead: python3 -m http.server'
      : `${S.grammars.length} grammars loaded: ${S.grammars.map(x => x.g.name).join(', ')}.`;
  }

  /* ================= opening files ================= */
  async function openBlob(blob, name, opts = {}) {
    busy(`Reading ${name}…`);
    const buf = new Uint8Array(await blob.arrayBuffer());
    openBytes(buf, name, opts);
  }
  function openBytes(bytes, name, opts = {}) {
    saveFileState();
    const file = { name, bytes, grammarId: null, cursor: 0, scroll: 0 };
    if (opts.grammarId !== undefined) file.grammarId = opts.grammarId;
    else {
      const d = F.detect(S.grammars.map(x => x.g), bytes, name);
      file.grammarId = d ? d.grammar.id : null;
    }
    if (opts.child) S.stack.push(file); else S.stack = [file];
    activate(file);
  }
  function saveFileState() {
    if (!S.file) return;
    S.file.cursor = S.cursor;
    S.file.scroll = $('#hexScroll').scrollTop;
    S.file.sel = S.sel;
  }
  function activate(file) {
    S.file = file;
    S.cursor = file.cursor || 0;
    S.sel = file.sel || null;
    S.anchor = null;
    S.node = null;
    S.hover = null;
    S.collapsed = new Set();
    S.expandedRuns = new Set();
    S.treeOpen = new Set();
    $('#empty').classList.add('hidden');
    refreshGrammarSelect();
    reparse();
    startEnrichment(file);
    renderCrumbs();
    requestAnimationFrame(() => { scrollToOffset(S.cursor, true); });
  }

  function reparse() {
    const file = S.file;
    if (!file) return;
    busy('Parsing…');
    const entry = file.grammarId ? grammarEntry(file.grammarId) : null;
    const t0 = performance.now();
    let result;
    try {
      result = entry ? F.parseBuffer(file.bytes, entry.g) : rawResult(file.bytes);
    } catch (e) {
      console.error(e);
      toast(`Parser error: ${e.message}`);
      result = rawResult(file.bytes);
    }
    result.ms = performance.now() - t0;
    file.result = result;
    S.result = result;
    indexNodes(result);
    colorize(result);
    S.rows = null;
    S.treeOpen = new Set([result.root.id]);
    for (const c of result.root.children || []) if ((c.children || []).length <= 64) S.treeOpen.add(c.id);
    busy(false);
    renderAll();
  }
  function rawResult(bytes) {
    const root = { id: 1, name: 'raw bytes', kind: 'struct', type: 'raw', start: 0, end: bytes.length, children: [], depth: 0, parent: null, spec: {} };
    return { root, issues: [], leaves: [], grammar: null, size: bytes.length, nodeCount: 1 };
  }
  function indexNodes(result) {
    const nodes = [];
    const starts = [];
    const stack = [result.root];
    while (stack.length) {
      const n = stack.pop();
      nodes[n.id] = n;
      if (n !== result.root && n.kind !== 'bits' && n.kind !== 'calc') starts.push(n);
      if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    starts.sort((a, b) => a.start - b.start || a.depth - b.depth);
    S.nodes = nodes;
    S.starts = starts;
    // Precompute worst issue level per node subtree for tree icons.
    const rank = { error: 3, warn: 2, info: 1 };
    for (const it of result.issues) {
      for (let n = it.node; n; n = n.parent) {
        const r = rank[it.level];
        if ((n._worst || 0) < r) n._worst = r; else break;
      }
    }
  }

  /* ================= colours ================= */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function hueOf(n) {
    for (let p = n.kind === 'struct' ? n : n.parent; p && p.parent; p = p.parent) {
      if (p.colorKey !== undefined) return hash(p.colorKey + '/' + p.type) % 360;
      const c = p.spec && p.spec.color !== undefined ? p.spec.color : p.def && p.def.color;
      if (typeof c === 'number') return c;
    }
    let top = n;
    while (top.parent && top.parent.parent) top = top.parent;
    return hash(String(top.type) + '/' + String(top.name).replace(/\[\d+\]$/, '')) % 360;
  }
  function colorize(result) {
    const leaves = result.leaves;
    for (let i = 0; i < leaves.length; i++) {
      const l = leaves[i];
      l._hue = hueOf(l);
      l._alt = i & 1;
    }
  }
  function bgOf(l) {
    if (!S.colors || !l) return '';
    if (l.kind === 'gap') return '';
    return `hsl(${l._hue} 80% var(--sec-l) / var(${l._alt ? '--sec-a2' : '--sec-a1'}))`;
  }
  function swatch(n) {
    if (n.kind === 'gap') return 'repeating-linear-gradient(135deg, var(--fg3) 0 2px, transparent 2px 4px)';
    const h = n._hue !== undefined ? n._hue : hueOf(n);
    return `hsl(${h} 75% 58%)`;
  }

  /* ================= rows model ================= */
  function totalRows() {
    if (!S.file) return 0;
    if (S.view === 'annotated') return annotatedRows().length;
    return Math.ceil(S.file.bytes.length / S.bpr) || 1;
  }
  function annotatedRows() {
    if (S.rows) return S.rows;
    const rows = [];
    const byteRows = [];
    const bpr = S.bpr, D = S.depth;
    const ELIDE = 4096;
    const pushBytes = (s, e, level) => {
      if (e <= s) return;
      const n = Math.ceil((e - s) / bpr);
      const key = s;
      if (n > ELIDE && !S.expandedRuns.has(key)) {
        for (let i = 0; i < 128; i++) { byteRows.push([s + i * bpr, rows.length]); rows.push({ t: 'b', s: s + i * bpr, e: Math.min(e, s + (i + 1) * bpr), level }); }
        const skipS = s + 128 * bpr, skipE = s + (n - 32) * bpr;
        rows.push({ t: 'e', s: skipS, e: skipE, key, level });
        for (let i = n - 32; i < n; i++) { byteRows.push([s + i * bpr, rows.length]); rows.push({ t: 'b', s: s + i * bpr, e: Math.min(e, s + (i + 1) * bpr), level }); }
        return;
      }
      for (let i = 0; i < n; i++) { byteRows.push([s + i * bpr, rows.length]); rows.push({ t: 'b', s: s + i * bpr, e: Math.min(e, s + (i + 1) * bpr), level }); }
    };
    const isContainer = n => n.kind === 'struct' || n.kind === 'array';
    const emit = (node, level) => {
      rows.push({ t: 'h', node, level });
      if (S.collapsed.has(node.id)) return;
      if (isContainer(node) && level < D - 1 && node.children && node.children.length) walk(node, level + 1);
      else pushBytes(node.start, node.end, level + 1);
    };
    const walk = (node, level) => {
      let run = null;
      const flush = () => { if (run) { pushBytes(run[0], run[1], level); run = null; } };
      for (const c of node.children) {
        if (c.kind === 'calc' || c.kind === 'bits') continue;
        if (isContainer(c) || c.kind === 'gap') { flush(); emit(c, level); continue; }
        if (c.end <= c.start) continue;
        if (run && c.start === run[1]) run[1] = c.end;
        else { flush(); run = [c.start, c.end]; }
      }
      flush();
    };
    if (S.result.root.children.length) walk(S.result.root, 0);
    else pushBytes(0, S.file.bytes.length, 0);
    byteRows.sort((a, b) => a[0] - b[0]);
    rows.byteRows = byteRows;
    S.rows = rows;
    return rows;
  }
  function rowForOffset(off) {
    if (S.view !== 'annotated') return Math.floor(off / S.bpr);
    const br = annotatedRows().byteRows;
    let lo = 0, hi = br.length - 1, best = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (br[m][0] <= off) { best = m; lo = m + 1; } else hi = m - 1; }
    return br.length ? br[best][1] : 0;
  }
  function rowForNode(n) {
    if (S.view !== 'annotated') return Math.floor(n.start / S.bpr);
    const rows = annotatedRows();
    for (let p = n; p; p = p.parent) {
      const i = rows.findIndex(r => r.t === 'h' && r.node === p);
      if (i >= 0) return i;
    }
    return rowForOffset(n.start);
  }

  /* ================= virtual scroll ================= */
  const MAX_H = 8000000;
  function geometry() {
    const sc = $('#hexScroll');
    const total = totalRows();
    const fullH = total * ROW;
    const scaled = fullH > MAX_H;
    const spacerH = scaled ? MAX_H : fullH;
    const visible = Math.ceil(sc.clientHeight / ROW);
    return { sc, total, scaled, spacerH, visible, maxScroll: Math.max(1, spacerH - sc.clientHeight), rowsMax: Math.max(1, total - visible + 1) };
  }
  function firstRow(g) {
    if (!g.scaled) return Math.floor(g.sc.scrollTop / ROW);
    return Math.round(g.sc.scrollTop / g.maxScroll * g.rowsMax);
  }
  function scrollToRow(r, center) {
    const g = geometry();
    const target = Math.max(0, r - (center ? Math.floor(g.visible / 3) : 0));
    if (!g.scaled) g.sc.scrollTop = target * ROW;
    else g.sc.scrollTop = target / g.rowsMax * g.maxScroll;
    renderHex();
  }
  function ensureRowVisible(r) {
    const g = geometry();
    const f = firstRow(g);
    if (r < f || r >= f + g.visible - 1) scrollToRow(r, true);
  }
  function scrollToOffset(off, center) {
    const r = rowForOffset(off);
    if (center) scrollToRow(r, true); else ensureRowVisible(r);
  }

  /* ================= hex rendering ================= */
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderHex(); renderMinimapView(); });
  }
  function offWidth() {
    const n = S.file ? S.file.bytes.length : 0;
    return n > 0xFFFFFFFF ? 12 : 8;
  }
  function renderHeader() {
    const w = offWidth();
    let h = `<span style="display:inline-block;width:${w + 2}ch">Offset</span>`;
    for (let i = 0; i < S.bpr; i++) h += `<span style="display:inline-block;width:3ch;text-align:center${i % 8 === 7 && i !== S.bpr - 1 ? ';margin-right:1ch' : ''}">${i.toString(16).toUpperCase().padStart(2, '0')}</span>`;
    h += `<span style="display:inline-block;margin-left:2ch;padding-left:1ch;border-left:1px solid transparent;width:calc(${S.bpr + 1}ch + 1px)">Text</span>`;
    if (S.notes) h += `<span style="display:inline-block;margin-left:2ch">Sections</span>`;
    $('#hexHead').innerHTML = S.view === 'text' ? '' : h;
    document.documentElement.style.setProperty('--offw', (w + 2) + 'ch');
  }

  function renderHex() {
    if (!S.file || S.view === 'text') return;
    const g = geometry();
    $('#hexSpacer').style.height = g.spacerH + 'px';
    const f = Math.max(0, firstRow(g) - (g.scaled ? 0 : 2));
    const n = Math.min(g.total - f, g.visible + 4);
    const top = g.scaled ? g.sc.scrollTop - (firstRow(g) - f) * ROW : f * ROW;
    const host = $('#hexRows');
    host.style.transform = `translateY(${top}px)`;
    const out = [];
    const rows = S.view === 'annotated' ? annotatedRows() : null;
    for (let i = f; i < f + n; i++) {
      if (rows) {
        const r = rows[i];
        if (r.t === 'h') out.push(headerRow(r, i));
        else if (r.t === 'e') out.push(`<div class="r el" data-el="${r.key}" style="padding-left:${r.level * 14 + 4}px">… ${(r.e - r.s).toLocaleString()} more bytes (${hx(r.s)}–${hx(r.e)}) — click to expand</div>`);
        else out.push(byteRow(r.s, r.e, r.level));
      } else {
        const s = i * S.bpr;
        out.push(byteRow(s, Math.min(S.file.bytes.length, s + S.bpr), 0));
      }
    }
    host.innerHTML = out.join('');
  }

  function headerRow(r, i) {
    const n = r.node;
    const isC = (n.kind === 'struct' || n.kind === 'array');
    const collapsed = S.collapsed.has(n.id);
    const lbl = n.label ? `<span class="lb">${esc(n.label)}</span>` : (n.display ? `<span class="lb">${esc(n.display)}</span>` : '');
    const cnt = n.kind === 'array' ? ` [${n.count}]` : '';
    const ic = n._worst >= 2 ? `<span class="ic ${n._worst === 3 ? 'error' : 'warn'}">${n._worst === 3 ? '✕' : '!'}</span>` : '';
    return `<div class="r hd${S.node === n ? ' sel' : ''}" data-node="${n.id}" style="padding-left:${r.level * 14}px">` +
      `<span class="tw" data-toggle="${n.id}">${isC || n.end - n.start > 0 ? (collapsed ? '▸' : '▾') : ''}</span>` +
      `<span class="sw" style="background:${swatch(n)}"></span>` +
      `<span class="nm">${esc(n.name)}${cnt}</span>${lbl}` +
      `<span class="meta">${hx(n.start, 4)}–${hx(n.end, 4)} · ${fmtSize(n.end - n.start)}</span>${ic}</div>`;
  }

  function byteRow(s, e, level) {
    const b = S.file.bytes, bpr = S.bpr;
    const leaves = S.result.leaves;
    const sel = S.sel, cur = S.cursor, hov = S.hover;
    const indent = level ? ` style="padding-left:${level * 14}px"` : '';
    let hex = '', txt = '';
    let li = leaves.length ? leafIndexAt(s) : -1;
    for (let k = 0; k < bpr; k++) {
      const o = s + k;
      const g = (k % 8 === 7 && k !== bpr - 1) ? ' g' : '';
      if (o >= e) { hex += `<span class="b pad${g}">  </span>`; txt += `<span class="c pad"> </span>`; continue; }
      while (li >= 0 && li < leaves.length && leaves[li].end <= o) li++;
      const leaf = li >= 0 && li < leaves.length && leaves[li].start <= o ? leaves[li] : (leaves.length ? F.leafAt(leaves, o) : null);
      const v = b[o];
      let cls = v === 0 ? ' z' : v === 0xFF ? ' f' : '';
      let tcls = v < 32 || v > 126 ? ' np' : '';
      let extra = '';
      if (leaf) {
        if (leaf.kind === 'gap') extra += ' gap';
        else if (leaf.bad || leaf.truncated) extra += ' bad';
        if (hov && leaf === hov) extra += ' h';
      }
      if (sel && o >= sel[0] && o < sel[1]) extra += ' s';
      if (o === cur) extra += ' cur';
      const bg = bgOf(leaf);
      const st = bg ? ` style="background:${bg}"` : '';
      hex += `<span class="b${cls}${extra}${g}" data-o="${o}"${st}>${HEX[v]}</span>`;
      txt += `<span class="c${tcls}${extra}" data-o="${o}"${st}>${CHR[v]}</span>`;
    }
    let notes = '';
    if (S.notes) notes = `<span class="nt">${notesFor(s, e)}</span>`;
    const off = s.toString(16).toUpperCase().padStart(offWidth(), '0');
    return `<div class="r"${indent}><span class="o">${off}</span><span class="hx">${hex}</span><span class="tx">${txt}</span>${notes}</div>`;
  }
  function leafIndexAt(off) {
    const L = S.result.leaves;
    let lo = 0, hi = L.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].start <= off) { best = m; lo = m + 1; } else hi = m - 1; }
    if (best >= 0 && L[best].end > off) return best;
    return best + 1 < L.length ? Math.max(0, best) : best;
  }
  function notesFor(s, e) {
    const A = S.starts;
    if (!A || !A.length) return '';
    let lo = 0, hi = A.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (A[m].start < s) lo = m + 1; else hi = m; }
    const picks = [];
    for (let i = lo; i < A.length && A[i].start < e && picks.length < 40; i++) {
      const n = A[i];
      if (n.kind === 'array' && !n.children.length) continue;
      picks.push(n);
    }
    if (!picks.length) return '';
    // Prefer the outermost labelled sections, then leaves, and keep the row compact.
    picks.sort((a, b) => a.depth - b.depth || a.start - b.start);
    const shown = [];
    const seenLabel = new Set();
    for (const n of picks) {
      if (shown.length >= 4) break;
      if (n.kind === 'array') continue;
      const text = n.label || n.name;
      if (seenLabel.has(text)) continue;
      seenLabel.add(text);
      shown.push(n);
    }
    shown.sort((a, b) => a.start - b.start || a.depth - b.depth);
    return shown.map(n => {
      const leaf = n.kind === 'field' || n.kind === 'gap';
      const err = n.issues && n.issues.some(i => i.level === 'error');
      const st = S.colors && n.kind !== 'gap' ? ` style="background:hsl(${n._hue !== undefined ? n._hue : hueOf(n)} 70% var(--sec-l) / .22)"` : '';
      return `<span class="chip${leaf ? ' leaf' : ''}${err ? ' err' : ''}" data-node="${n.id}"${st} title="${esc(nodePath(n))}">${err ? '✕ ' : ''}${esc(n.label || n.name)}</span>`;
    }).join('');
  }
  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));
  const CHR = Array.from({ length: 256 }, (_, i) => i >= 32 && i < 127 ? esc(String.fromCharCode(i)) : '.');

  /* ================= minimap ================= */
  function renderMinimap() {
    const cv = $('#minimapCanvas');
    const mm = $('#minimap');
    if (!S.file || S.view === 'text') { mm.classList.add('hidden'); return; }
    mm.classList.remove('hidden');
    const H = mm.clientHeight, W = mm.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const size = S.file.bytes.length || 1;
    const leaves = S.result.leaves;
    const light = document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);
    for (let y = 0; y < H; y++) {
      const off = Math.floor((y + 0.5) / H * size);
      const l = leaves.length ? F.leafAt(leaves, off) : null;
      if (!l) ctx.fillStyle = light ? '#ddd' : '#2a2f3b';
      else if (l.kind === 'gap') ctx.fillStyle = l.zero ? (light ? '#ccc' : '#333') : (light ? '#b8b8b8' : '#555');
      else ctx.fillStyle = `hsl(${l._hue} 65% ${light ? 60 : 45}%)`;
      ctx.fillRect(0, y, W - 5, 1);
    }
    const css = getComputedStyle(document.documentElement);
    const col = { error: css.getPropertyValue('--err'), warn: css.getPropertyValue('--warn') };
    for (const it of S.result.issues) {
      if (!it.node || it.level === 'info') continue;
      const y = Math.floor(it.node.start / size * H);
      ctx.fillStyle = col[it.level];
      ctx.fillRect(W - 5, y, 5, Math.max(2, (it.node.end - it.node.start) / size * H));
    }
    renderMinimapView();
  }
  function renderMinimapView() {
    if (!S.file || S.view === 'text') return;
    const g = geometry();
    const f = firstRow(g);
    const size = S.file.bytes.length || 1;
    const H = $('#minimap').clientHeight;
    const startOff = rowStartOffset(f), endOff = rowStartOffset(Math.min(g.total - 1, f + g.visible));
    const v = $('#minimapView');
    v.style.top = (startOff / size * H) + 'px';
    v.style.height = Math.max(3, (endOff - startOff) / size * H) + 'px';
  }
  function rowStartOffset(r) {
    if (S.view !== 'annotated') return r * S.bpr;
    const rows = annotatedRows();
    const x = rows[Math.max(0, Math.min(rows.length - 1, r))];
    return x ? (x.t === 'h' ? x.node.start : x.s) : 0;
  }

  /* ================= tree ================= */
  function renderTree() {
    const host = $('#tree');
    host.innerHTML = '';
    if (!S.result) return;
    const filter = $('#treeFilter').value.trim().toLowerCase();
    if (filter) { renderTreeFiltered(host, filter); return; }
    host.appendChild(treeItem(S.result.root, 0));
    if (S.treeOpen.has(S.result.root.id)) host.appendChild(treeChildren(S.result.root, 1));
  }
  function renderTreeFiltered(host, q) {
    const hits = [];
    for (const n of S.nodes) {
      if (!n) continue;
      if ((n.name && n.name.toLowerCase().includes(q)) || (n.label && n.label.toLowerCase().includes(q)) || (n.display && String(n.display).toLowerCase().includes(q))) {
        hits.push(n);
        if (hits.length >= 2000) break;
      }
    }
    if (!hits.length) { host.innerHTML = '<div class="empty-note">No matching fields.</div>'; return; }
    for (const n of hits) { const it = treeItem(n, 0, true); host.appendChild(it); }
  }
  function nodeText(n) {
    if (n.kind === 'array') return { nm: `${n.name} [${n.count}]`, lb: '', vl: '' };
    return { nm: n.name, lb: n.label || '', vl: n.display || '' };
  }
  function treeItem(n, depth, flat) {
    const d = document.createElement('div');
    d.className = 'ti' + (n.kind === 'gap' ? ' gap' : '') + (n.kind === 'calc' ? ' calc' : '') + (n.kind === 'bits' ? ' bits' : '') + (S.node === n ? ' sel' : '');
    d.dataset.id = n.id;
    d.setAttribute('role', 'treeitem');
    d.style.paddingLeft = (depth * 14 + 4) + 'px';
    const has = n.children && n.children.length;
    const t = nodeText(n);
    const ic = n._worst === 3 ? '<span class="ic error">✕</span>' : n._worst === 2 ? '<span class="ic warn">!</span>' : '';
    const typ = n.kind === 'field' || n.kind === 'calc' || n.kind === 'bits' ? `<span class="ty">${esc(n.type || '')}</span>` : (n.kind === 'struct' && n.type !== 'struct' && n.depth ? `<span class="ty">${esc(n.type)}</span>` : '');
    d.innerHTML = `<span class="tw">${has && !flat ? (S.treeOpen.has(n.id) ? '▾' : '▸') : ''}</span>` +
      `<span class="sw" style="background:${n.kind === 'calc' || n.kind === 'bits' ? 'transparent' : swatch(n)}"></span>` +
      `<span class="nm">${esc(flat ? nodePath(n) : t.nm)}</span>` +
      (t.lb ? `<span class="lb">${esc(t.lb)}</span>` : '') +
      (t.vl ? `<span class="vl">${esc(t.vl)}</span>` : '') + typ + ic +
      `<span class="of">${n.kind === 'calc' ? '' : hx(n.start, 4)}</span>`;
    return d;
  }
  const TREE_PAGE = 500;
  function treeChildren(n, depth, from = 0) {
    const frag = document.createElement('div');
    frag.className = 'tc';
    frag.dataset.parent = n.id;
    const kids = n.children || [];
    const end = Math.min(kids.length, from + TREE_PAGE);
    for (let i = from; i < end; i++) {
      const c = kids[i];
      frag.appendChild(treeItem(c, depth));
      if (S.treeOpen.has(c.id) && c.children && c.children.length) frag.appendChild(treeChildren(c, depth + 1));
    }
    if (end < kids.length) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = `Show ${Math.min(TREE_PAGE, kids.length - end).toLocaleString()} more of ${(kids.length - end).toLocaleString()}…`;
      more.style.marginLeft = (depth * 14 + 20) + 'px';
      more.onclick = e => { e.stopPropagation(); more.replaceWith(...treeChildren(n, depth, end).childNodes); };
      frag.appendChild(more);
    }
    return frag;
  }
  function toggleTree(id) {
    const n = S.nodes[id];
    if (!n || !n.children || !n.children.length) return;
    const item = $(`#tree .ti[data-id="${id}"]`);
    if (S.treeOpen.has(id)) {
      S.treeOpen.delete(id);
      if (item && item.nextSibling && item.nextSibling.classList && item.nextSibling.classList.contains('tc') && item.nextSibling.dataset.parent == id) item.nextSibling.remove();
    } else {
      S.treeOpen.add(id);
      if (item) item.after(treeChildren(n, n.depth + 1));
    }
    if (item) item.querySelector('.tw').textContent = S.treeOpen.has(id) ? '▾' : '▸';
  }
  function revealInTree(n) {
    if ($('#treeFilter').value) { $('#treeFilter').value = ''; renderTree(); }
    const chain = [];
    for (let p = n.parent; p; p = p.parent) chain.unshift(p);
    for (const p of chain) {
      if (!S.treeOpen.has(p.id)) {
        let item = $(`#tree .ti[data-id="${p.id}"]`);
        if (!item) { renderTree(); item = $(`#tree .ti[data-id="${p.id}"]`); }
        if (item) toggleTree(p.id);
        else S.treeOpen.add(p.id);
      }
    }
    let item = $(`#tree .ti[data-id="${n.id}"]`);
    if (!item) {
      // Child is beyond a "show more" page: render that parent's children fully up to it.
      const par = n.parent;
      const pi = par && $(`#tree .ti[data-id="${par.id}"]`);
      if (pi && pi.nextSibling && pi.nextSibling.classList.contains('tc')) {
        const idx = par.children.indexOf(n);
        const fresh = treeChildren(par, par.depth + 1, 0);
        // Re-render with enough pages to include idx.
        let html = fresh;
        while (!html.querySelector(`.ti[data-id="${n.id}"]`) && html.querySelector('.more')) {
          const more = html.querySelector('.more');
          more.click();
          if (idx < 0) break;
        }
        pi.nextSibling.replaceWith(html);
      }
      item = $(`#tree .ti[data-id="${n.id}"]`);
    }
    document.querySelectorAll('#tree .ti.sel').forEach(x => x.classList.remove('sel'));
    if (item) { item.classList.add('sel'); item.scrollIntoView({ block: 'nearest' }); }
  }
  function nodePath(n) {
    const parts = [];
    for (let p = n; p && p.parent; p = p.parent) parts.unshift(p.name);
    return parts.join('.').replace(/\.\[/g, '[');
  }

  /* ================= selection ================= */
  function selectNode(n, opts = {}) {
    if (!n) return;
    S.node = n;
    if (n.kind !== 'calc' && n !== S.result.root) {
      S.sel = n.end > n.start ? [n.start, n.end] : null;
      S.cursor = n.start;
    }
    if (!opts.noTree) revealInTree(n);
    if (!opts.noScroll) {
      if (S.view === 'annotated') ensureRowVisible(rowForNode(n));
      else scrollToOffset(n.start, false);
    }
    renderInspector();
    renderInterp();
    renderStatus();
    requestRender();
  }
  function setCursor(o, extend) {
    if (!S.file) return;
    const size = S.file.bytes.length;
    o = Math.max(0, Math.min(size - 1, o));
    if (extend) {
      if (S.anchor === null) S.anchor = S.cursor;
      S.sel = [Math.min(S.anchor, o), Math.max(S.anchor, o) + 1];
    } else { S.anchor = null; }
    S.cursor = o;
    scrollToOffset(o, false);
    renderInterp();
    renderStatus();
    requestRender();
  }

  /* ================= inspector ================= */
  function renderInspector() {
    const host = $('#inspector');
    const n = S.node;
    if (!S.file) { host.innerHTML = ''; return; }
    if (!n) {
      const r = S.result, g = r.grammar;
      const cnt = countIssues();
      host.innerHTML = `<h3>File</h3><div class="ins-title">${esc(S.file.name)}</div>
        <dl class="kv"><dt>size</dt><dd>${S.file.bytes.length.toLocaleString()} bytes (${fmtSize(S.file.bytes.length)})</dd>
        <dt>grammar</dt><dd>${g ? esc(g.name) : '— none —'}</dd>
        ${g ? `<dt>nodes</dt><dd>${r.nodeCount.toLocaleString()} parsed in ${r.ms.toFixed(1)} ms</dd>` : ''}
        <dt>issues</dt><dd>${cnt.error} errors · ${cnt.warn} warnings · ${cnt.info} notes</dd>
        <dt>coverage</dt><dd>${coverage()}</dd>
        </dl>
        ${g && g.doc ? `<div class="doc">${esc(g.doc)}</div>` : ''}
        ${!g ? `<div class="doc">No grammar matched this file. Pick one from the Grammar menu, write one (Grammar ▸ New grammar…), or use Tools ▸ Find embedded files to look for known signatures inside it.</div>` : ''}
        <div class="btnrow">${toolButtons()}</div>
        <h3>Hashes &amp; lookups</h3><div id="enrich">${enrichHtml()}</div>
        <p class="fine">Click a byte to select its field. Shift-click or drag to select a range. Double-click selects the enclosing structure.</p>`;
      return;
    }
    const doc = (n.spec && n.spec.doc) || (n.def && n.def.doc);
    const size = n.end - n.start;
    const v = n.value;
    let valueHtml = '';
    if (n.kind === 'field' || n.kind === 'calc' || n.kind === 'bits') {
      if (typeof v === 'number' || typeof v === 'bigint') {
        const num = Number(v);
        valueHtml = `<dt>value</dt><dd>${esc(n.display)}</dd>` +
          (Number.isInteger(num) ? `<dt>hex</dt><dd>${hx(v)}</dd><dt>binary</dt><dd>${num >= 0 && num < 2 ** 32 ? num.toString(2).replace(/\B(?=(\d{8})+(?!\d))/g, ' ') : '—'}</dd>` : '') +
          (n.le !== undefined ? `<dt>byte order</dt><dd>${n.le ? 'little-endian' : 'big-endian'}</dd>` : '');
      } else if (typeof v === 'string') {
        valueHtml = `<dt>value</dt><dd>${esc(JSON.stringify(v.length > 2000 ? v.slice(0, 2000) + '…' : v))}</dd><dt>length</dt><dd>${v.length} chars</dd>`;
      } else if (v instanceof Uint8Array) {
        valueHtml = `<dt>value</dt><dd>${v.length.toLocaleString()} bytes</dd>`;
      }
      if (n.enumName !== undefined) valueHtml += `<dt>meaning</dt><dd>${esc(typeof n.enumName === 'string' ? n.enumName : JSON.stringify(n.enumName))}</dd>`;
      else if (n.unknownEnum) valueHtml += `<dt>meaning</dt><dd class="bad-t">not a known ${esc(n.spec.enum)} value</dd>`;
    }
    if (n.checksum) {
      const c = n.checksum;
      valueHtml += `<dt>${esc(c.algo)}</dt><dd class="${c.ok ? 'ok' : 'bad-t'}">${c.ok ? '✓ valid' : '✕ mismatch'} — computed ${hx(c.computed, 8)} over ${hx(c.start)}…${hx(c.end)}</dd>`;
    }
    let bits = '';
    if (n.kind === 'field' && n.children && n.children.length) {
      bits = `<h3>Bit fields</h3><table class="bits">` + n.children.map(b =>
        `<tr data-node="${b.id}"><td>${b.bitWidth > 1 ? `${b.bitShift + b.bitWidth - 1}…${b.bitShift}` : b.bitShift}</td><td>${esc(b.name)}</td><td>${esc(b.display)}</td></tr>`).join('') + `</table>`;
    }
    let kids = '';
    if ((n.kind === 'struct') && n.children && n.children.length && n.children.length <= 64) {
      kids = `<h3>Fields</h3><table class="bits">` + n.children.filter(c => c.kind !== 'gap' || true).map(c =>
        `<tr data-node="${c.id}" style="cursor:pointer"><td>${esc(c.name)}</td><td>${esc(c.kind === 'array' ? `[${c.count}]` : (c.label || c.display || ''))}</td></tr>`).join('') + `</table>`;
    }
    const issues = (n.issues || []).map(i => `<div class="ins-issue ${i.level}">${esc(i.msg)}</div>`).join('');
    const pathHtml = (() => {
      const chain = [];
      for (let p = n; p; p = p.parent) chain.unshift(p);
      return chain.map(p => `<button data-node="${p.id}">${esc(p.parent ? p.name : '⌂')}</button>`).join('<span>›</span>');
    })();
    const preview = size > 0 && n.kind !== 'calc' ? `<h3>Bytes</h3><div class="dump">${esc(miniDump(n.start, Math.min(n.end, n.start + 256)))}${size > 256 ? `\n… ${(size - 256).toLocaleString()} more bytes` : ''}</div>` : '';
    host.innerHTML = `<h3>${esc(n.kind === 'gap' ? 'Undescribed bytes' : n.kind)}</h3>
      <div class="ins-title">${esc(n.name)}</div>
      ${n.label ? `<div class="ins-label">${esc(n.label)}</div>` : ''}
      <div class="path">${pathHtml}</div>
      ${issues}
      ${doc ? `<div class="doc">${esc(doc)}</div>` : ''}
      <dl class="kv">
        <dt>type</dt><dd>${esc(n.type || n.kind)}${n.kind === 'array' ? ` × ${n.count}` : ''}</dd>
        ${n.kind !== 'calc' ? `<dt>offset</dt><dd>${hx(n.start, 4)} (${n.start.toLocaleString()})</dd><dt>end</dt><dd>${hx(n.end, 4)}</dd><dt>size</dt><dd>${size.toLocaleString()} B${size >= 1024 ? ` (${fmtSize(size)})` : ''}</dd>` : '<dt>kind</dt><dd>computed value (no bytes)</dd>'}
        ${valueHtml}
      </dl>
      ${bits}${kids}${preview}
      <div class="btnrow">
        ${size > 0 ? `<button class="btn" data-act="openNode">Open as file</button><button class="btn" data-act="exportNode">Download bytes</button><button class="btn" data-act="copyHex">Copy hex</button>` : ''}
        ${n.parent && n.parent.parent ? `<button class="btn" data-act="selectParent">Select parent</button>` : ''}
      </div>`;
  }
  function toolButtons() {
    const g = S.result && S.result.grammar;
    let h = '';
    if (g && g.repair && RP.REPAIRERS[g.repair]) h += `<button class="btn primary" data-act="repair">Repair / reconstruct</button>`;
    if (g && g.preview) h += `<button class="btn" data-act="preview">Preview contents</button>`;
    h += `<button class="btn" data-act="carve">Find embedded files</button>`;
    return h;
  }
  function miniDump(s, e) {
    const b = S.file.bytes;
    const lines = [];
    for (let o = s; o < e; o += 16) {
      const row = b.subarray(o, Math.min(e, o + 16));
      lines.push(o.toString(16).padStart(6, '0') + '  ' + Array.from(row, x => HEX[x]).join(' ').padEnd(48) + '  ' + Array.from(row, x => x >= 32 && x < 127 ? String.fromCharCode(x) : '.').join(''));
    }
    return lines.join('\n');
  }
  function coverage() {
    if (!S.result.grammar) return '—';
    let covered = 0;
    for (const l of S.result.leaves) if (l.kind !== 'gap') covered += l.end - l.start;
    const size = S.file.bytes.length || 1;
    return `${Math.min(100, covered / size * 100).toFixed(1)}% of bytes described by the grammar`;
  }

  /* ================= data interpreter ================= */
  function renderInterp() {
    const host = $('#interp');
    if (!S.file || !S.file.bytes.length) { host.innerHTML = ''; return; }
    const b = S.file.bytes, o = S.cursor;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const avail = b.length - o;
    const rd = (fn, n, le) => avail >= n ? fn(le) : '—';
    const types = [
      ['u8', 1, () => dv.getUint8(o)], ['i8', 1, () => dv.getInt8(o)],
      ['u16', 2, le => dv.getUint16(o, le)], ['i16', 2, le => dv.getInt16(o, le)],
      ['u32', 4, le => dv.getUint32(o, le)], ['i32', 4, le => dv.getInt32(o, le)],
      ['u64', 8, le => dv.getBigUint64(o, le).toString()], ['i64', 8, le => dv.getBigInt64(o, le).toString()],
      ['f32', 4, le => +dv.getFloat32(o, le).toPrecision(7)], ['f64', 8, le => +dv.getFloat64(o, le).toPrecision(12)],
    ];
    let rows = types.map(([t, n, fn]) => `<tr><td>${t}</td><td>${rd(fn, n, true)}</td><td>${n === 1 ? '' : rd(fn, n, false)}</td></tr>`).join('');
    const v = b[o];
    const utf8 = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(o, Math.min(b.length, o + 4))).slice(0, 1); } catch (e) { return '—'; } })();
    const t32 = avail >= 4 ? dv.getUint32(o, true) : null;
    rows += `<tr><td>binary</td><td colspan="2">${v.toString(2).padStart(8, '0')}</td></tr>
      <tr><td>char</td><td colspan="2">${v >= 32 && v < 127 ? esc(JSON.stringify(String.fromCharCode(v))) : '—'} · utf-8 ${esc(utf8 && utf8 !== '—' ? JSON.stringify(utf8) : '—')}</td></tr>
      <tr><td>unix32</td><td colspan="2">${t32 !== null && t32 > 0 ? new Date(t32 * 1000).toISOString().replace('.000Z', 'Z') : '—'}</td></tr>`;
    host.innerHTML = `<h3>At cursor ${hx(o, 4)}</h3><table><tr><th></th><th>little-endian</th><th>big-endian</th></tr>${rows}</table>`;
  }

  /* ================= issues ================= */
  function countIssues() {
    const c = { error: 0, warn: 0, info: 0 };
    if (S.result) for (const i of S.result.issues) c[i.level]++;
    return c;
  }
  function renderIssues() {
    const host = $('#issues');
    const want = new Set([...document.querySelectorAll('.issue-filters input:checked')].map(x => x.dataset.lvl));
    const list = S.result ? S.result.issues.filter(i => want.has(i.level)) : [];
    const c = countIssues();
    const badge = $('#issueBadge');
    badge.textContent = c.error + c.warn;
    badge.className = 'badge' + (c.error ? ' err' : c.warn ? ' warn' : '');
    if (!list.length) {
      host.innerHTML = `<div class="empty-note">${S.result && S.result.grammar ? (c.error + c.warn ? 'No issues at the selected levels.' : '✓ No problems found. The file matches its grammar.') : 'Select a grammar to validate the file.'}</div>`;
      return;
    }
    const sym = { error: '✕', warn: '!', info: 'i' };
    host.innerHTML = list.slice(0, 3000).map((it, i) => `<div class="issue" data-issue="${S.result.issues.indexOf(it)}">
      <span class="ic ${it.level}">${sym[it.level]}</span><span>${esc(it.msg)}</span>
      <span class="where">${it.node ? `${esc(nodePath(it.node) || it.node.name)} @ ${hx(it.node.start, 4)}` : ''}</span></div>`).join('') +
      (list.length > 3000 ? `<div class="empty-note">…and ${(list.length - 3000).toLocaleString()} more</div>` : '');
  }

  /* ================= status / crumbs ================= */
  function renderStatus() {
    if (!S.file) return;
    const c = countIssues();
    $('#stFile').textContent = `${S.file.name} · ${fmtSize(S.file.bytes.length)}`;
    $('#stGrammar').textContent = S.result.grammar ? S.result.grammar.name : 'raw';
    $('#stIssues').innerHTML = S.result.grammar ? `<span class="${c.error ? 'e' : ''}">${c.error} errors</span> · <span class="${c.warn ? 'w' : ''}">${c.warn} warnings</span>` : '';
    $('#stCursor').textContent = `@ ${hx(S.cursor, 4)} (${S.cursor.toLocaleString()})`;
    $('#stSel').textContent = S.sel ? `sel ${hx(S.sel[0])}–${hx(S.sel[1])} · ${(S.sel[1] - S.sel[0]).toLocaleString()} B` : '';
  }
  function renderCrumbs() {
    $('#crumbs').innerHTML = S.stack.map((f, i) =>
      `${i ? '<span class="sep">›</span>' : ''}<button data-crumb="${i}" class="${f === S.file ? 'cur' : ''}" title="${esc(f.name)}">${esc(f.name)}</button>`).join('');
    document.title = S.file ? `${S.file.name} — File Object Browser` : 'File Object Browser';
  }

  /* ================= text view ================= */
  function renderText() {
    const tv = $('#textView');
    if (S.view !== 'text' || !S.file) { tv.classList.add('hidden'); return; }
    tv.classList.remove('hidden');
    const MAX = 4 * 1048576;
    const b = S.file.bytes.subarray(0, MAX);
    let txt;
    try { txt = new TextDecoder('utf-8', { fatal: false }).decode(b); } catch (e) { txt = F.latin1(b); }
    // Make control characters visible without destroying layout.
    const html = esc(txt).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, ch => `<span class="np">${ch === '\uFFFD' ? '�' : '·'}</span>`);
    tv.innerHTML = html + (S.file.bytes.length > MAX ? `\n\n<span class="np">… showing the first ${fmtSize(MAX)} of ${fmtSize(S.file.bytes.length)}</span>` : '');
  }

  function renderAll() {
    const textMode = S.view === 'text';
    $('#hexScroll').classList.toggle('hidden', textMode);
    $('#hexHead').classList.toggle('hidden', textMode);
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
    $('#depthSelect').value = String(S.depth);
    $('#widthSelect').value = String(S.bpr);
    $('#chkNotes').checked = S.notes;
    $('#chkColors').checked = S.colors;
    renderHeader();
    renderTree();
    renderIssues();
    renderInspector();
    renderInterp();
    renderStatus();
    renderText();
    renderHex();
    renderMinimap();
    const g = S.result && S.result.grammar;
    $('#actRepair').disabled = !(g && g.repair && RP.REPAIRERS[g.repair]);
    $('#actPreview').disabled = !(g && g.preview);
  }

  /* ================= modal helpers ================= */
  function modal(title, html) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    const d = $('#modal');
    if (!d.open) d.showModal();
    return $('#modalBody');
  }
  let toastTimer;
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:200;background:var(--bg3);border:1px solid var(--line);padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:80vw';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4200);
  }
  function busy(msg) {
    const el = $('#busy');
    if (msg === false) { clearTimeout(busy.t); el.classList.add('hidden'); return; }
    $('#busyMsg').textContent = msg;
    // Only show for slow operations; most parses finish within a frame.
    el.classList.add('hidden');
    clearTimeout(busy.t);
    busy.t = setTimeout(() => el.classList.remove('hidden'), 150);
  }
  function download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function baseName(name) { return name.replace(/\.[^.]*$/, ''); }
  function extOf(name) { const m = /\.([^.]+)$/.exec(name); return m ? m[1] : 'bin'; }
  function guessExt(bytes) {
    const d = F.detect(S.grammars.map(x => x.g), bytes, '');
    return d && d.score === 1 && d.grammar.extensions ? d.grammar.extensions[0] : 'bin';
  }

  /* ================= enrichment (hashes, VirusTotal) ================= */
  const EN = window.FOBEnrich;
  const vtCfg = () => store.get('vt', { proxy: '', key: '', auto: false });
  function startEnrichment(file) {
    if (file.hashes || file.hashing) return;
    file.hashing = EN.computeHashes(file.bytes, f => { file.hashProgress = f; if (S.file === file && !S.node) updateEnrich(); })
      .then(h => {
        h.crc32 = F.hex(F.crc32(file.bytes), 8).slice(2).toLowerCase();
        file.hashes = h;
        const cfg = vtCfg();
        if (cfg.auto && cfg.proxy) return vtLookup(file);
      })
      .catch(e => { file.hashError = e.message; })
      .finally(() => { if (S.file === file && !S.node) updateEnrich(); });
  }
  async function vtLookup(file) {
    if (!file.hashes) return;
    file.vt = { status: 'loading' };
    if (S.file === file && !S.node) updateEnrich();
    file.vt = await EN.lookupVT(file.hashes.sha256, vtCfg());
    if (S.file === file && !S.node) updateEnrich();
  }
  function updateEnrich() { const el = $('#enrich'); if (el) el.innerHTML = enrichHtml(); }
  function enrichHtml() {
    const f = S.file;
    if (!f) return '';
    if (f.hashError) return `<div class="ins-issue warn">Hashing failed: ${esc(f.hashError)}</div>`;
    if (!f.hashes) return `<p class="fine">Computing hashes…${f.hashProgress ? ` ${Math.round(f.hashProgress * 100)}%` : ''}</p>`;
    const h = f.hashes;
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd><button data-copy="${v}" title="Copy">⧉</button>`;
    const cfg = vtCfg();
    let vt;
    if (!cfg.proxy) vt = `<p class="fine">To show VirusTotal results here, set up a proxy in <a href="#" data-act="lookupSettings">lookup settings</a>. Browsers can't call the VirusTotal API directly.</p>`;
    else if (!f.vt) vt = `<div class="btnrow"><button class="btn" data-act="vtLookup">Fetch VirusTotal report</button></div>`;
    else if (f.vt.status === 'loading') vt = `<p class="fine">Asking VirusTotal…</p>`;
    else vt = EN.renderVT(f.vt, esc, h.sha256) + `<div class="btnrow"><button class="btn" data-act="vtLookup">Refresh</button></div>`;
    return `<dl class="hashes">${row('md5', h.md5)}${row('sha1', h.sha1)}${row('sha256', h.sha256)}${row('crc32', h.crc32)}</dl>
      <div class="lookups">${EN.LINKS.map(l => `<a href="${esc(l.url(h))}" target="_blank" rel="noopener noreferrer" title="${esc(l.desc || 'Look up this SHA-256')} (sends only the hash)">${esc(l.name)} ↗</a>`).join('')}</div>${vt}`;
  }
  function lookupSettings() {
    const cfg = vtCfg();
    const body = modal('Hash lookup settings', `<div class="settings">
      <p class="fine">FOB never uploads files. A lookup sends only the file's SHA-256, and only when you ask, or on open if you enable auto-lookup below.</p>
      <p class="fine">VirusTotal's API doesn't allow calls from web pages (no CORS headers), so in-page reports go through a small proxy you deploy yourself: <code>tools/vt-proxy-worker.js</code>, a free Cloudflare Worker. The file has step-by-step instructions. It only forwards <code>GET /files/&lt;hash&gt;</code> lookups to VirusTotal.</p>
      <label>Proxy URL</label><input type="text" id="vtProxy" placeholder="https://fob-vt.yourname.workers.dev" value="${esc(cfg.proxy || '')}">
      <label>VirusTotal API key (free account → profile → API key). Leave empty if the proxy has VT_API_KEY set.</label>
      <input type="password" id="vtKey" autocomplete="off" value="${esc(cfg.key || '')}">
      <p class="fine">The key is stored in this browser's localStorage and sent only to the proxy URL above.</p>
      <label class="check" style="color:var(--fg)"><input type="checkbox" id="vtAuto" ${cfg.auto ? 'checked' : ''}> Look up automatically when a file is opened</label>
      <div class="btnrow"><button class="btn primary" id="vtSave">Save</button><button class="btn" id="vtTest">Save &amp; test with the EICAR test file</button><button class="btn" id="vtClear">Forget settings</button></div>
      <div id="vtTestOut"></div></div>`);
    const save = () => { store.set('vt', { proxy: body.querySelector('#vtProxy').value.trim(), key: body.querySelector('#vtKey').value.trim(), auto: body.querySelector('#vtAuto').checked }); if (S.file) { S.file.vt = null; if (!S.node) updateEnrich(); } };
    body.querySelector('#vtSave').onclick = () => { save(); $('#modal').close(); toast('Lookup settings saved.'); };
    body.querySelector('#vtClear').onclick = () => { store.set('vt', { proxy: '', key: '', auto: false }); $('#modal').close(); if (S.file && !S.node) { S.file.vt = null; updateEnrich(); } toast('Lookup settings cleared.'); };
    body.querySelector('#vtTest').onclick = async () => {
      save();
      const out = body.querySelector('#vtTestOut');
      out.innerHTML = '<p class="fine">Testing…</p>';
      const eicar = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f';
      const r = await EN.lookupVT(eicar, vtCfg());
      out.innerHTML = r.status === 'found' ? '<div class="ins-issue info">✓ Proxy and key work. EICAR test file:</div>' + EN.renderVT(r, esc, eicar) : EN.renderVT(r, esc, eicar);
    };
  }

  /* ================= tools ================= */
  async function doRepair() {
    const g = S.result.grammar;
    const r = g && RP.REPAIRERS[g.repair];
    if (!r) { toast('No repair tool for this format.'); return; }
    busy('Reconstructing…');
    let res;
    try { res = await r.run(S.file.bytes); } catch (e) { busy(false); toast(`Repair failed: ${e.message}`); return; }
    busy(false);
    const name = `${baseName(S.file.name)}.repaired.${extOf(S.file.name)}`;
    const reparsed = F.parseBuffer(res.bytes, g);
    const after = { error: 0, warn: 0 };
    for (const i of reparsed.issues) if (after[i.level] !== undefined) after[i.level]++;
    const before = countIssues();
    const body = modal(r.label, `
      <ul class="log">${res.log.map(l => `<li class="${l.level}">${esc(l.msg)}</li>`).join('')}</ul>
      <dl class="kv"><dt>before</dt><dd>${fmtSize(S.file.bytes.length)} · ${before.error} errors · ${before.warn} warnings</dd>
      <dt>after</dt><dd>${fmtSize(res.bytes.length)} · <span class="${after.error ? 'bad-t' : 'ok'}">${after.error} errors</span> · ${after.warn} warnings</dd></dl>
      <div class="btnrow"><button class="btn primary" id="rpOpen">Open repaired file</button><button class="btn" id="rpDl">Download ${esc(name)}</button></div>
      <div id="rpPreview"></div>
      <p class="fine">The original file is not modified. Reconstruction recovers structure; data that is physically missing cannot be recreated.</p>`);
    body.querySelector('#rpOpen').onclick = () => { $('#modal').close(); openBytes(res.bytes, name, { child: true, grammarId: g.id }); };
    body.querySelector('#rpDl').onclick = () => download(res.bytes, name, g.mime);
    if (g.preview === 'image') imagePreview(body.querySelector('#rpPreview'), res.bytes, g.mime);
  }
  function imagePreview(host, bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const img = new Image();
    img.className = 'preview-media';
    img.onload = () => { if (img.naturalWidth < 256) img.style.width = Math.min(256, img.naturalWidth * 8) + 'px'; host.insertAdjacentHTML('afterbegin', `<p class="fine">Decoded by the browser: ${img.naturalWidth}×${img.naturalHeight}</p>`); };
    img.onerror = () => { host.innerHTML = '<div class="banner">The browser could not decode this image. Try Tools ▸ Repair first.</div>'; };
    img.src = url;
    host.appendChild(img);
  }
  async function doPreview() {
    const g = S.result.grammar;
    if (!g || !g.preview) { toast('No preview for this format.'); return; }
    const bytes = S.file.bytes;
    if (g.preview === 'image') {
      const body = modal(`Preview · ${S.file.name}`, '<div id="pv"></div>');
      imagePreview(body.querySelector('#pv'), bytes, g.mime);
    } else if (g.preview === 'media') {
      const isAudio = /audio|mp3|wav/i.test(g.mime || '') || ['mp3', 'wav', 'm4a', 'mka', 'ogg', 'flac'].includes(extOf(S.file.name).toLowerCase()) || (g.id === 'riff' && S.result.root.value && S.result.root.value.riff && S.result.root.value.riff.form === 'WAVE');
      const mime = g.id === 'riff' ? (isAudio ? 'audio/wav' : (S.result.root.value.riff && S.result.root.value.riff.form === 'WEBP' ? 'image/webp' : 'video/x-msvideo')) : (g.id === 'mkv' && extOf(S.file.name).toLowerCase() === 'webm' ? 'video/webm' : g.mime);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (mime === 'image/webp') { const body = modal('Preview', '<div id="pv"></div>'); imagePreview(body.querySelector('#pv'), bytes, mime); return; }
      const tag = isAudio ? 'audio' : 'video';
      const body = modal(`Preview · ${S.file.name}`, `<${tag} class="preview-media" controls src="${url}" ${tag === 'video' ? 'playsinline' : 'style="width:100%;background:none"'}></${tag}><p class="fine" id="pvMsg">Playback uses the browser's own decoder; support for codecs inside ${esc(g.name)} varies by browser.</p>`);
      body.querySelector(tag).onerror = () => { body.querySelector('#pvMsg').innerHTML = '<span class="bad-t">The browser could not play this file (unsupported codec, or the file is damaged).</span>'; };
    } else if (g.preview === 'zip') {
      zipContents();
    } else if (g.preview === 'gzip') {
      busy('Decompressing…');
      const r = await RP.gunzip(bytes);
      busy(false);
      const fname = (S.result.root.value.header && S.result.root.value.header.fileName) || baseName(S.file.name);
      const body = modal(`Decompress · ${S.file.name}`, r.data ? `
        <dl class="kv"><dt>output</dt><dd>${esc(fname)} · ${r.data.length.toLocaleString()} bytes</dd>
        <dt>crc32</dt><dd class="${r.crcOk ? 'ok' : 'bad-t'}">${r.crcOk ? '✓ matches trailer' : r.error ? '✕ ' + esc(r.error) + ' (partial data recovered)' : '✕ does not match trailer'}</dd></dl>
        <div class="btnrow"><button class="btn primary" id="gzOpen">Open decompressed data</button><button class="btn" id="gzDl">Download</button></div>
        <div class="dump">${esc(miniDumpOf(r.data, 512))}</div>` : `<div class="banner">Could not decompress: ${esc(r.error || 'unknown error')}</div>`);
      if (r.data) {
        body.querySelector('#gzOpen').onclick = () => { $('#modal').close(); openBytes(r.data, fname, { child: true }); };
        body.querySelector('#gzDl').onclick = () => download(r.data, fname);
      }
    }
  }
  function miniDumpOf(b, max) {
    const lines = [];
    for (let o = 0; o < Math.min(b.length, max); o += 16) {
      const row = b.subarray(o, Math.min(b.length, o + 16));
      lines.push(o.toString(16).padStart(6, '0') + '  ' + Array.from(row, x => HEX[x]).join(' ').padEnd(48) + '  ' + Array.from(row, x => x >= 32 && x < 127 ? String.fromCharCode(x) : '.').join(''));
    }
    return lines.join('\n');
  }
  async function zipContents() {
    const bytes = S.file.bytes;
    const { entries } = RP.scanZipEntries(bytes);
    const methods = { 0: 'stored', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 99: 'AES' };
    const body = modal(`Contents · ${S.file.name}`, entries.length ? `
      <p class="fine">Entries found by scanning for local file headers — this works even when the central directory is missing or damaged.</p>
      <table class="tbl"><tr><th>name</th><th>method</th><th>compressed</th><th>size</th><th>status</th><th></th></tr>
      ${entries.map((e, i) => `<tr><td class="name">${esc(e.name)}</td><td>${methods[e.method] || e.method}</td><td>${e.csize.toLocaleString()}</td><td>${e.usize.toLocaleString()}</td>
        <td id="zs${i}">${e.truncated ? '<span class="bad-t">truncated</span>' : e.sizeRecovered ? 'size recovered' : ''}</td>
        <td style="white-space:nowrap">${e.name.endsWith('/') ? '' : `<button class="btn" data-zopen="${i}">Open</button> <button class="btn" data-zdl="${i}">Save</button>`}</td></tr>`).join('')}
      </table><div class="btnrow"><button class="btn" id="zVerify">Verify all CRCs</button></div>` : '<div class="banner">No local file headers found.</div>');
    const get = async i => {
      const e = entries[i];
      const r = await RP.extractZipEntry(bytes, e);
      const cell = body.querySelector('#zs' + i);
      if (cell) cell.innerHTML = (e.truncated ? '<span class="bad-t">truncated</span> · ' : '') + (r.error ? `<span class="bad-t">${esc(r.error)}</span>` : r.crcOk ? '<span class="ok">✓ CRC ok</span>' : '<span class="bad-t">✕ CRC mismatch</span>');
      return r;
    };
    body.onclick = async ev => {
      const o = ev.target.dataset.zopen, d = ev.target.dataset.zdl;
      if (o !== undefined) { const r = await get(+o); if (r.data) { $('#modal').close(); openBytes(r.data, entries[+o].name.split('/').pop(), { child: true }); } }
      if (d !== undefined) { const r = await get(+d); if (r.data) download(r.data, entries[+d].name.split('/').pop()); }
      if (ev.target.id === 'zVerify') for (let i = 0; i < entries.length; i++) if (!entries[i].name.endsWith('/')) await get(i);
    };
  }
  function doCarve() {
    const hits = RP.carve(S.file.bytes, S.grammars.map(x => x.g));
    const body = modal(`Embedded signatures · ${S.file.name}`, hits.length ? `
      <p class="fine">Known magic numbers found anywhere in the file. Useful for files hidden inside other files, data with a garbage prefix, or disk/memory images. Expect some false positives for short signatures (e.g. "MZ", "BM").</p>
      <table class="tbl"><tr><th>offset</th><th>format</th><th></th></tr>
      ${hits.slice(0, 500).map((h, i) => `<tr><td>${hx(h.offset, 8)}</td><td>${esc(h.grammar.name)}</td><td style="white-space:nowrap"><button class="btn" data-cjump="${i}">Jump</button> <button class="btn" data-copen="${i}">Open from here</button></td></tr>`).join('')}
      </table>${hits.length > 500 ? `<p class="fine">${hits.length - 500} more not shown.</p>` : ''}` : '<div class="banner">No known signatures found.</div>');
    body.onclick = ev => {
      const j = ev.target.dataset.cjump, o = ev.target.dataset.copen;
      if (j !== undefined) { $('#modal').close(); setCursor(hits[+j].offset); }
      if (o !== undefined) {
        const h = hits[+o];
        $('#modal').close();
        openBytes(S.file.bytes.subarray(h.offset), `${baseName(S.file.name)}@${hx(h.offset)}.${(h.grammar.extensions || ['bin'])[0]}`, { child: true, grammarId: h.grammar.id });
      }
    };
  }
  function selectionBytes() {
    const r = S.sel || (S.node && S.node.end > S.node.start ? [S.node.start, S.node.end] : null);
    return r ? { range: r, bytes: S.file.bytes.subarray(r[0], r[1]) } : null;
  }
  function openSelection() {
    const s = selectionBytes();
    if (!s) { toast('Select some bytes first (click a field, or shift-click / drag in the hex view).'); return; }
    const nm = S.node && S.node.start === s.range[0] && S.node.end === s.range[1] ? S.node.name.replace(/[^\w.-]+/g, '_') : `${hx(s.range[0])}-${hx(s.range[1])}`;
    openBytes(s.bytes.slice(), `${nm}.${guessExt(s.bytes)}`, { child: true });
  }
  function exportSelection() {
    const s = selectionBytes();
    if (!s) { toast('Select some bytes first.'); return; }
    download(s.bytes.slice(), `${baseName(S.file.name)}_${hx(s.range[0])}-${hx(s.range[1])}.${guessExt(s.bytes)}`);
  }
  async function copyHex() {
    const s = selectionBytes();
    if (!s) { toast('Select some bytes first.'); return; }
    const max = 1048576;
    const txt = Array.from(s.bytes.subarray(0, max), x => HEX[x]).join(' ');
    try { await navigator.clipboard.writeText(txt); toast(`Copied ${Math.min(max, s.bytes.length).toLocaleString()} bytes as hex.`); }
    catch (e) { toast('Clipboard is not available here.'); }
  }

  /* ================= grammar editor ================= */
  const TEMPLATE = {
    id: 'my-format',
    name: 'My format',
    doc: 'Describe the format here. Shown in the inspector.',
    extensions: ['myf'],
    magic: [{ offset: 0, ascii: 'MYF1' }],
    endian: 'little',
    root: [
      { name: 'magic', type: 'string', length: 4, expect: 'MYF1' },
      { name: 'version', type: 'u16' },
      { name: 'count', type: 'u16', doc: 'Number of records that follow' },
      { name: 'records', type: 'record', count: 'count' },
    ],
    structs: {
      record: {
        label: '${kind} · ${length} B',
        colorBy: 'kind',
        fields: [
          { name: 'kind', type: 'u8', enum: 'kind' },
          { name: 'length', type: 'u32' },
          { name: 'data', type: 'bytes', length: 'length' },
        ],
      },
    },
    enums: { kind: { 1: 'header', 2: 'body', 3: 'trailer' } },
  };
  function editGrammar(src, title) {
    const body = modal(title, `
      <p class="fine">Edit the JSON and press <b>Apply</b> to re-parse the open file. Saved grammars are kept in this browser and are listed as "(custom)". See Grammar ▸ format reference for every option.</p>
      <textarea id="gText" spellcheck="false"></textarea>
      <div class="lint" id="gLint"></div>
      <div class="btnrow">
        <button class="btn primary" id="gApply">Apply &amp; re-parse</button>
        <button class="btn" id="gSave">Save as custom grammar</button>
        <button class="btn" id="gDl">Download .json</button>
        <button class="btn" id="gDel">Delete custom version</button>
      </div>`);
    const ta = body.querySelector('#gText');
    ta.value = src;
    const lint = () => {
      const out = body.querySelector('#gLint');
      try {
        const g = F.prepareGrammar(ta.value);
        const w = F.lintGrammar(g);
        out.innerHTML = w.length ? w.map(x => `<div class="e">⚠ ${esc(x)}</div>`).join('') : `<div class="ok">✓ "${esc(g.name)}" (${esc(g.id)}) looks valid.</div>`;
        return g;
      } catch (e) { out.innerHTML = `<div class="e">✕ ${esc(e.message)}</div>`; return null; }
    };
    let lt;
    ta.oninput = () => { clearTimeout(lt); lt = setTimeout(lint, 250); };
    ta.onkeydown = e => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') body.querySelector('#gApply').click();
    };
    lint();
    body.querySelector('#gApply').onclick = () => {
      const g = lint();
      if (!g) return;
      const entry = addGrammar(ta.value, false);
      if (S.file) { S.file.grammarId = entry.g.id; refreshGrammarSelect(); reparse(); }
      toast(`Applied "${g.name}". Use "Save" to keep it.`);
    };
    body.querySelector('#gSave').onclick = () => {
      const g = lint();
      if (!g) return;
      const entry = addGrammar(ta.value, true);
      if (S.file) { S.file.grammarId = entry.g.id; refreshGrammarSelect(); reparse(); }
      toast(`Saved "${g.name}" in this browser.`);
    };
    body.querySelector('#gDl').onclick = () => {
      const g = lint();
      download(new TextEncoder().encode(ta.value), `${g ? g.id : 'grammar'}.json`, 'application/json');
    };
    body.querySelector('#gDel').onclick = () => {
      const g = lint();
      if (!g) return;
      const i = S.grammars.findIndex(x => x.g.id === g.id && !x.builtin);
      if (i < 0) { toast('There is no saved custom version of this grammar.'); return; }
      S.grammars.splice(i, 1);
      store.set('customGrammars', S.grammars.filter(x => !x.builtin).map(x => x.src));
      refreshGrammarSelect();
      if (S.file) reparse();
      toast('Custom version deleted.');
    };
  }
  function currentGrammarSrc() {
    const e = S.file && S.file.grammarId ? grammarEntry(S.file.grammarId) : null;
    return e ? e.src : JSON.stringify(TEMPLATE, null, 2);
  }

  function showHelp() {
    modal('Grammar format reference', HELP_HTML);
  }

  /* ================= samples ================= */
  async function loadSamples() {
    let list = [];
    try { list = await (await fetch('samples/index.json', { cache: 'no-cache' })).json(); } catch (e) { /* offline */ }
    const menu = $('#samplesMenu'), chips = $('#emptySamples');
    menu.innerHTML = list.length ? list.map((s, i) => `<button data-sample="${i}">${esc(s.file)}<span class="desc">${esc(s.desc)}</span></button>`).join('') : '<button disabled>No samples available</button>';
    chips.innerHTML = list.map((s, i) => `<button data-sample="${i}" class="${s.broken ? 'broken' : ''}" title="${esc(s.desc)}">${esc(s.file)}</button>`).join('');
    const go = async i => {
      const s = list[i];
      try {
        const r = await fetch('samples/' + s.file);
        if (!r.ok) throw new Error(r.status);
        openBlob(await r.blob(), s.file);
      } catch (e) { toast(`Could not load sample: ${e.message}`); }
    };
    menu.onclick = e => { const b = e.target.closest('[data-sample]'); if (b) { closeMenus(); go(+b.dataset.sample); } };
    chips.onclick = e => { const b = e.target.closest('[data-sample]'); if (b) go(+b.dataset.sample); };
  }

  /* ================= search / goto ================= */
  function parseOffset(s) {
    s = s.trim().replace(/_/g, '');
    let rel = 0;
    if (s[0] === '+' || s[0] === '-') { rel = s[0] === '+' ? 1 : -1; s = s.slice(1); }
    let v;
    if (/^0x[0-9a-f]+$/i.test(s)) v = parseInt(s, 16);
    else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
    else if (/^[0-9a-f]+h?$/i.test(s)) v = parseInt(s.replace(/h$/i, ''), 16);
    else return null;
    return rel ? S.cursor + rel * v : v;
  }
  function findNext(q, backwards) {
    const b = S.file.bytes;
    let pat;
    const forceHex = q.startsWith('x:'), forceText = q.startsWith('"');
    const hexish = /^([0-9a-f]{2}\s*)+$/i.test(q.replace(/^x:/, '').trim()) || /^0x[0-9a-f]+$/i.test(q) || q.includes('??');
    if (!forceText && (forceHex || (hexish && q.replace(/\s/g, '').length % 2 === 0 && /\s|^0x|^x:|\?\?/.test(q)))) {
      try { pat = F.compilePattern(q.replace(/^x:/, '').replace(/^0x/i, '')); } catch (e) { $('#findStatus').textContent = 'bad hex'; return; }
    } else {
      const t = forceText ? q.replace(/^"|"$/g, '') : q;
      pat = Array.from(new TextEncoder().encode(t), x => { const s = new Uint8Array(256); s[x] = 1; return s; });
    }
    if (!pat.length) return;
    const start = S.sel && S.sel[1] - S.sel[0] === pat.length ? S.sel[0] : S.cursor;
    let at = -1;
    if (!backwards) {
      at = F.findPattern(b, pat, start + 1, b.length);
      if (at < 0) at = F.findPattern(b, pat, 0, Math.min(b.length, start + pat.length));
    } else {
      for (let i = start - 1; i >= 0 && at < 0; i--) if (F.findPattern(b, pat, i, Math.min(b.length, i + pat.length)) === i) at = i;
    }
    if (at < 0) { $('#findStatus').textContent = 'not found'; return; }
    $('#findStatus').textContent = hx(at);
    S.sel = [at, at + pat.length];
    S.cursor = at;
    S.anchor = null;
    S.node = null;
    scrollToOffset(at, true);
    renderInspector(); renderInterp(); renderStatus(); requestRender();
  }

  /* ================= events ================= */
  function closeMenus() { document.querySelectorAll('.menu-pop.open').forEach(m => m.classList.remove('open')); }
  function act(name) {
    closeMenus();
    if (name === 'help') return showHelp();
    if (name === 'lookupSettings') return lookupSettings();
    if (name === 'newGrammar') return editGrammar(JSON.stringify(TEMPLATE, null, 2), 'New grammar');
    if (name === 'importGrammar') return $('#grammarInput').click();
    if (name === 'editGrammar') return editGrammar(currentGrammarSrc(), 'Edit grammar');
    if (name === 'exportGrammar') {
      const src = currentGrammarSrc();
      let id = 'grammar';
      try { id = JSON.parse(src).id || id; } catch (e) { /* ignore */ }
      return download(new TextEncoder().encode(src), `${id}.json`, 'application/json');
    }
    if (!S.file) { toast('Open a file first.'); return; }
    switch (name) {
      case 'repair': return doRepair();
      case 'preview': return doPreview();
      case 'carve': return doCarve();
      case 'vtLookup': return vtLookup(S.file);
      case 'openSelection': return openSelection();
      case 'exportSelection': return exportSelection();
      case 'copyHex': return copyHex();
      case 'download': return download(S.file.bytes, S.file.name);
      case 'openNode': return openSelection();
      case 'exportNode': return exportSelection();
      case 'selectParent': if (S.node && S.node.parent) selectNode(S.node.parent); return;
    }
  }

  function bind() {
    $('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { const f = e.target.files[0]; if (f) openBlob(f, f.name); e.target.value = ''; };
    $('#grammarInput').onchange = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const src = await f.text();
      try {
        const entry = addGrammar(src, true);
        toast(`Loaded grammar "${entry.g.name}".`);
        if (S.file) { S.file.grammarId = entry.g.id; refreshGrammarSelect(); reparse(); }
      } catch (err) { editGrammar(src, `Fix grammar: ${f.name}`); }
    };
    $('#grammarSelect').onchange = e => { if (!S.file) return; S.file.grammarId = e.target.value || null; S.node = null; reparse(); };

    document.addEventListener('click', e => {
      const m = e.target.closest('[data-menu]');
      if (m) {
        const pop = $('#' + m.dataset.menu);
        const was = pop.classList.contains('open');
        closeMenus();
        if (!was) pop.classList.add('open');
        e.stopPropagation();
        return;
      }
      const a = e.target.closest('[data-act]');
      if (a && !a.disabled) { e.preventDefault(); act(a.dataset.act); return; }
      const cp = e.target.closest('[data-copy]');
      if (cp) { navigator.clipboard.writeText(cp.dataset.copy).then(() => toast('Copied.'), () => toast('Clipboard is not available here.')); return; }
      if (!e.target.closest('.menu-pop')) closeMenus();
      const cr = e.target.closest('[data-crumb]');
      if (cr) {
        const i = +cr.dataset.crumb;
        saveFileState();
        S.stack = S.stack.slice(0, i + 1);
        activate(S.stack[i]);
      }
    });

    $('#btnTheme').onclick = () => {
      const root = document.documentElement;
      const sysLight = matchMedia('(prefers-color-scheme: light)').matches;
      const cur = root.dataset.theme || (sysLight ? 'light' : 'dark');
      root.dataset.theme = cur === 'light' ? 'dark' : 'light';
      store.set('theme', root.dataset.theme);
      renderMinimap();
    };

    $('#viewSeg').onclick = e => {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.dataset.view);
    };
    $('#depthSelect').onchange = e => { S.depth = +e.target.value; store.set('depth', S.depth); S.rows = null; if (S.file) { renderHex(); ensureRowVisible(rowForOffset(S.cursor)); } };
    $('#widthSelect').onchange = e => { S.bpr = +e.target.value; store.set('bpr', S.bpr); S.rows = null; if (S.file) { renderHeader(); scrollToOffset(S.cursor, true); } };
    $('#chkNotes').onchange = e => { S.notes = e.target.checked; store.set('notes', S.notes); renderHeader(); requestRender(); };
    $('#chkColors').onchange = e => { S.colors = e.target.checked; store.set('colors', S.colors); requestRender(); };

    // tree
    $('#tree').onclick = e => {
      const it = e.target.closest('.ti');
      if (!it) return;
      const id = +it.dataset.id;
      if (e.target.classList.contains('tw')) { toggleTree(id); return; }
      selectNode(S.nodes[id], { noTree: true });
      document.querySelectorAll('#tree .ti.sel').forEach(x => x.classList.remove('sel'));
      it.classList.add('sel');
    };
    $('#tree').ondblclick = e => { const it = e.target.closest('.ti'); if (it) toggleTree(+it.dataset.id); };
    let ft;
    $('#treeFilter').oninput = () => { clearTimeout(ft); ft = setTimeout(renderTree, 200); };

    document.querySelectorAll('.tabs .tab').forEach(t => t.onclick = () => {
      document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('on', x === t));
      $('#treeWrap').classList.toggle('hidden', t.dataset.tab !== 'tree');
      $('#issuesWrap').classList.toggle('hidden', t.dataset.tab !== 'issues');
    });
    document.querySelectorAll('.issue-filters input').forEach(i => i.onchange = renderIssues);
    $('#issues').onclick = e => {
      const it = e.target.closest('.issue');
      if (!it) return;
      const iss = S.result.issues[+it.dataset.issue];
      if (iss && iss.node) selectNode(iss.node);
    };

    // inspector / chips / path navigation
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-node]');
      if (!t || t.closest('#tree') || t.closest('.r.hd')) return;
      const n = S.nodes[+t.dataset.node];
      if (n) selectNode(n);
    });

    // hex interaction
    const rowsEl = $('#hexRows');
    let dragging = false, dragFrom = null, moved = false;
    rowsEl.addEventListener('mousedown', e => {
      const t = e.target.closest('[data-o]');
      if (e.button !== 0) return;
      if (t) {
        e.preventDefault();
        $('#hexScroll').focus({ preventScroll: true });
        const o = +t.dataset.o;
        if (e.shiftKey) { if (S.anchor === null) S.anchor = S.cursor; setCursor(o, true); S.node = null; renderInspector(); return; }
        dragging = true; moved = false; dragFrom = o;
        S.anchor = o;
        S.cursor = o;
        requestRender();
      }
    });
    rowsEl.addEventListener('mousemove', e => {
      const t = e.target.closest('[data-o]');
      if (dragging && t) {
        const o = +t.dataset.o;
        if (o !== dragFrom) moved = true;
        if (moved) { S.sel = [Math.min(dragFrom, o), Math.max(dragFrom, o) + 1]; S.cursor = o; S.node = null; renderStatus(); requestRender(); }
      }
      hoverAt(t ? +t.dataset.o : null, e);
    });
    rowsEl.addEventListener('mouseleave', () => hoverAt(null));
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        const leaf = S.result.leaves.length ? F.leafAt(S.result.leaves, dragFrom) : null;
        if (leaf) selectNode(leaf, { noScroll: true });
        else { S.sel = null; S.node = null; renderInspector(); }
        S.cursor = dragFrom;
      } else { renderInspector(); }
      renderInterp(); renderStatus(); requestRender();
    });
    rowsEl.addEventListener('dblclick', e => {
      const t = e.target.closest('[data-o]');
      if (!t) return;
      const leaf = F.leafAt(S.result.leaves, +t.dataset.o);
      if (leaf && leaf.parent && leaf.parent.parent) selectNode(leaf.parent, { noScroll: true });
    });
    rowsEl.addEventListener('click', e => {
      const tg = e.target.closest('[data-toggle]');
      const hd = e.target.closest('.r.hd');
      const el = e.target.closest('.r.el');
      if (el) { S.expandedRuns.add(+el.dataset.el); S.rows = null; renderHex(); return; }
      if (tg) {
        const id = +tg.dataset.toggle;
        if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
        S.rows = null; renderHex(); renderMinimapView();
        return;
      }
      if (hd) selectNode(S.nodes[+hd.dataset.node], { noScroll: true });
    });
    $('#hexScroll').addEventListener('scroll', requestRender, { passive: true });
    window.addEventListener('resize', () => { requestRender(); clearTimeout(bind.rt); bind.rt = setTimeout(renderMinimap, 120); });

    // minimap
    const mm = $('#minimap');
    let mmDrag = false;
    const mmGo = e => {
      const r = mm.getBoundingClientRect();
      const off = Math.floor(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * S.file.bytes.length);
      scrollToRow(rowForOffset(off), true);
    };
    mm.addEventListener('mousedown', e => { if (!S.file) return; mmDrag = true; mmGo(e); e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (mmDrag) mmGo(e); });
    window.addEventListener('mouseup', () => { mmDrag = false; });

    // keyboard
    $('#hexScroll').addEventListener('keydown', e => {
      if (!S.file) return;
      const k = e.key, ext = e.shiftKey;
      const page = Math.max(1, geometry().visible - 2) * S.bpr;
      const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -S.bpr, ArrowDown: S.bpr, PageUp: -page, PageDown: page };
      if (map[k] !== undefined) { e.preventDefault(); setCursor(S.cursor + map[k], ext); if (!ext) { S.sel = null; S.node = null; renderInspector(); } }
      else if (k === 'Home') { e.preventDefault(); setCursor(e.ctrlKey || e.metaKey ? 0 : S.cursor - (S.cursor % S.bpr), ext); }
      else if (k === 'End') { e.preventDefault(); setCursor(e.ctrlKey || e.metaKey ? S.file.bytes.length - 1 : S.cursor - (S.cursor % S.bpr) + S.bpr - 1, ext); }
      else if (k === 'Enter') { const l = F.leafAt(S.result.leaves, S.cursor); if (l) selectNode(l); }
      else if (k === 'Escape') { S.sel = null; S.node = null; S.anchor = null; renderInspector(); renderStatus(); requestRender(); }
    });
    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); }
      else if (mod && e.key.toLowerCase() === 'f' && S.file && !$('#modal').open) { e.preventDefault(); $('#findInput').focus(); $('#findInput').select(); }
      else if (mod && e.key.toLowerCase() === 'g' && S.file) { e.preventDefault(); $('#gotoInput').focus(); $('#gotoInput').select(); }
      else if (!inField && !mod && S.file && !$('#modal').open && ['1', '2', '3'].includes(e.key)) setView(['hex', 'annotated', 'text'][+e.key - 1]);
    });
    $('#gotoForm').onsubmit = e => {
      e.preventDefault();
      if (!S.file) return;
      const v = parseOffset($('#gotoInput').value);
      if (v === null || !(v >= 0)) { toast('Offsets look like 0x1A2B, 6699, 1A2Bh, +16 or -0x10'); return; }
      setCursor(v);
      S.sel = null; S.node = null;
      scrollToOffset(S.cursor, true);
      renderInspector();
      $('#hexScroll').focus({ preventScroll: true });
    };
    $('#findForm').onsubmit = e => { e.preventDefault(); if (S.file && $('#findInput').value) findNext($('#findInput').value, false); };
    $('#findInput').onkeydown = e => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); if (S.file) findNext($('#findInput').value, true); } };

    // drag & drop
    let depth = 0;
    window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { depth++; $('#dropzone').classList.remove('hidden'); } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dropzone').classList.add('hidden'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      $('#dropzone').classList.add('hidden');
      const f = e.dataTransfer.files[0];
      if (f) openBlob(f, f.name);
    });

    // column resizers
    document.querySelectorAll('.resizer').forEach(r => {
      r.addEventListener('mousedown', e => {
        e.preventDefault();
        const side = r.dataset.resize;
        const startX = e.clientX;
        const startW = side === 'left' ? $('#leftPanel').offsetWidth : $('#rightPanel').offsetWidth;
        r.classList.add('drag');
        const mv = ev => {
          const w = Math.max(180, Math.min(window.innerWidth * 0.5, startW + (side === 'left' ? ev.clientX - startX : startX - ev.clientX)));
          document.documentElement.style.setProperty(side === 'left' ? '--left' : '--right', w + 'px');
          requestRender();
        };
        const up = () => { r.classList.remove('drag'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); renderMinimap(); };
        window.addEventListener('mousemove', mv);
        window.addEventListener('mouseup', up);
      });
    });
  }

  function setView(v) {
    if (!S.file) { S.view = v; return; }
    const keep = S.cursor;
    S.view = v;
    store.set('view', v);
    S.rows = null;
    renderAll();
    if (v !== 'text') requestAnimationFrame(() => scrollToOffset(keep, true));
  }

  let lastHover = null;
  function hoverAt(o, e) {
    const tip = $('#tooltip');
    if (o === null || !S.file) {
      tip.classList.add('hidden');
      if (S.hover) { S.hover = null; requestRender(); }
      $('#stHover').textContent = '';
      return;
    }
    const leaf = S.result.leaves.length ? F.leafAt(S.result.leaves, o) : null;
    if (leaf !== S.hover) { S.hover = leaf; requestRender(); }
    $('#stHover').textContent = leaf ? `${nodePath(leaf)} ` : `${hx(o, 4)} `;
    if (leaf && e) {
      if (lastHover !== leaf) {
        const iss = leaf.issues && leaf.issues.find(i => i.level !== 'info');
        let ctx = '';
        for (let p = leaf.parent; p && p.parent; p = p.parent) if (p.label) { ctx = p.label; break; }
        tip.innerHTML = `<div class="tp">${esc(nodePath(leaf))}</div>` +
          (ctx ? `<div style="color:var(--accent2)">${esc(ctx)}</div>` : '') +
          `<div class="tv">${esc(leaf.display || '')}</div>` +
          `<div class="tp">${esc(leaf.type || '')} · ${hx(leaf.start, 4)} · ${(leaf.end - leaf.start).toLocaleString()} B</div>` +
          (iss ? `<div class="ic ${iss.level}" style="margin-top:3px">${esc(iss.msg)}</div>` : '');
        lastHover = leaf;
      }
      tip.classList.remove('hidden');
      const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
      const y = e.clientY + 18 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    } else tip.classList.add('hidden');
  }

  /* ================= help ================= */
  const HELP_HTML = `<div class="help">
<p>A grammar is a JSON file that tells FOB how to slice a file into named, typed fields. Fields are read in order; structs nest; anything not described shows up as an <i>unparsed</i> gap. The full reference is in <a href="GRAMMAR.md" target="_blank" rel="noopener">GRAMMAR.md</a>; the built-in grammars in <code>grammars/</code> are worked examples.</p>
<h4>Top level</h4>
<pre>{
  "id": "png", "name": "PNG image", "doc": "…",
  "extensions": ["png"],
  "magic": [{ "offset": 0, "hex": "89 50 4E 47" }],   // or "ascii": "GIF8"
  "endian": "big",            // default for numbers: little | big
  "bitOrder": "msb",          // order of "bits" sub-fields: msb | lsb
  "root": [ …fields… ],       // or the name of a struct
  "structs": { "chunk": { "fields": [ … ], "label": "\${type}", "size": "…" } },
  "enums": { "colorType": { "2": "RGB", "6": "RGBA" } },
  "bitsets": { "flags": [ { "name": "a", "bits": 1 } ] },
  "constants": { "table": [0, 32, 64] },
  "repair": "png" | "zip",    "preview": "image" | "media" | "zip" | "gzip"
}</pre>
<h4>Field types</h4>
<table>
<tr><td>u8 u16 u24 u32 u64<br>i8 … i64, f32 f64</td><td>Fixed-size numbers. Suffix <code>le</code>/<code>be</code> to force byte order (<code>u32be</code>).</td></tr>
<tr><td>uint sint float</td><td>Numbers whose byte length comes from <code>length</code> (used by EBML).</td></tr>
<tr><td>vint ebmlid</td><td>EBML variable-length integers (size / element id).</td></tr>
<tr><td>bytes</td><td>Raw bytes: <code>length</code>, or <code>terminator</code> (byte pattern), or the rest of the enclosing struct.</td></tr>
<tr><td>string cstring</td><td>Text with <code>length</code> or null-terminated; <code>encoding</code>: ascii, utf-8, utf-16, utf-16be.</td></tr>
<tr><td>&lt;struct name&gt; / struct</td><td>A named struct from <code>structs</code>, or inline with <code>"fields": […]</code>.</td></tr>
<tr><td>switch</td><td><code>"on": expr, "cases": { "IHDR": "ihdr", "0x21": {…} }, "default": "bytes"</code></td></tr>
<tr><td>calc</td><td>Computed value, no bytes: <code>"value": "duration / timescale"</code></td></tr>
</table>
<h4>Field options</h4>
<table>
<tr><td>name, doc</td><td>Identifier (referenced by later expressions) and a description shown in the inspector.</td></tr>
<tr><td>length / size</td><td>Expression. On a struct, <code>size</code> bounds it: overruns are errors, leftovers are flagged.</td></tr>
<tr><td>if</td><td>Expression; field is skipped when false.</td></tr>
<tr><td>count · repeat:"eof" · until · while</td><td>Repetition. <code>until</code> sees the last item as <code>_last</code>.</td></tr>
<tr><td>offset</td><td>Read this field at an absolute offset (expression); parsing then continues where it was.</td></tr>
<tr><td>expect</td><td>Required value (number, string, or hex for bytes; array = any of). Mismatch → error.</td></tr>
<tr><td>valid, validMsg, validLevel</td><td>Expression check with <code>_</code> = value. Default level: warn.</td></tr>
<tr><td>checksum</td><td><code>{ "algo": "crc32", "from": "type", "to": "data" }</code> — also adler32, sum8.</td></tr>
<tr><td>enum, enumStrict</td><td>Name values via <code>enums</code>; strict flags unknown values.</td></tr>
<tr><td>bits</td><td>Split an integer into bit fields: <code>[{ "name": "flag", "bits": 1 }]</code> or <code>"@bitsetName"</code>.</td></tr>
<tr><td>format</td><td>hex, bin, dec, char, bool, unixtime, dostime, dosdate, fourcc, ascii.</td></tr>
<tr><td>label, colorBy</td><td>Struct title template (<code>"\${type} · \${length} B"</code>) and colour key.</td></tr>
<tr><td>warn, error</td><td>Emit a message whenever this field is parsed (good for <code>default</code> cases).</td></tr>
</table>
<h4>Expressions</h4>
<p>JavaScript-like but sandboxed: <code>+ - * / % ** &amp; | ^ &lt;&lt; &gt;&gt; == != &lt; &gt; &amp;&amp; || ! ?:</code>, member access <code>a.b</code>, <code>a[i]</code>, and string methods <code>startsWith endsWith includes slice</code>. Names resolve to earlier fields in the current struct, then enclosing structs.</p>
<table>
<tr><td>_pos _size _remaining</td><td>Current offset, file size, bytes left in the enclosing struct.</td></tr>
<tr><td>_index _last _ _root _parent</td><td>Repeat index, previous item, current value, root / parent field values.</td></tr>
<tr><td>peek('u32', rel) read('u16', off)</td><td>Look at bytes without consuming them.</td></tr>
<tr><td>match(off, 'FF D8 ??') cstr(off) ascii(off, n)</td><td>Pattern test and string reads at any offset.</td></tr>
<tr><td>min max abs floor ceil align len has hex str int chr enumName syncsafe32</td><td>Helpers.</td></tr>
</table>
<h4>Byte patterns</h4>
<p>Used by <code>terminator</code>, <code>match()</code> and Find: <code>"50 4B 03 04"</code>, <code>"??"</code> any byte, <code>"01-08"</code> range, <code>"01,03,05"</code> set, <code>"!00,D0-D7"</code> anything except.</p>
</div>`;

  /* ================= boot ================= */
  async function boot() {
    const th = store.get('theme', null);
    if (th) document.documentElement.dataset.theme = th;
    bind();
    renderAll();
    await Promise.all([loadBuiltinGrammars(), loadSamples()]);
    if (S.grammarLoadError) {
      $('#grammarCount').innerHTML = `<span class="banner" style="display:block">Built-in grammars could not be fetched (${esc(S.grammarLoadError.message)}). Browsers block fetch() on file:// pages — serve the folder instead, e.g. <code>python3 -m http.server</code>, or load grammar files from the Grammar menu.</span>`;
    }
  }
  boot();
})();
