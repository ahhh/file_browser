/*
 * FOB parse engine. Interprets a JSON grammar against a byte buffer and builds a
 * tree of nodes. It is deliberately fault tolerant: truncation, bad magic, bad
 * checksums, impossible lengths and unparsed regions all become "issues" on the
 * tree instead of aborting the parse, so broken files can still be explored.
 * See GRAMMAR.md for the grammar format.
 */
(function (G) {
  'use strict';
  const X = G.FOBExpr;
  const OK = 1, EOF = 0;
  const hasOwn = Object.prototype.hasOwnProperty;

  /* ---------------- checksums ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b, start = 0, end = b.length, seed = 0) {
    let c = (seed ^ 0xFFFFFFFF) >>> 0;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function adler32(b, start = 0, end = b.length) {
    let a = 1, s = 0;
    for (let i = start; i < end; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; }
    return ((s << 16) | a) >>> 0;
  }
  const CHECKSUMS = { crc32, adler32, sum8: (b, s, e) => { let x = 0; for (let i = s; i < e; i++) x = (x + b[i]) & 0xFF; return x; } };

  /* ---------------- byte patterns ----------------
   * "50 4B 03 04"  exact bytes          "??"          any byte
   * "01-08"        range               "01,03,05-07" set
   * "!00,D0-D7"    anything but        "504B0304"    compact hex also works
   */
  const patCache = new Map();
  function compilePattern(src) {
    src = String(src).trim();
    let p = patCache.get(src);
    if (p) return p;
    const toks = [];
    for (const t of src.split(/\s+/)) {
      if (/^[0-9a-f]+$/i.test(t) && t.length > 2 && t.length % 2 === 0) {
        for (let i = 0; i < t.length; i += 2) toks.push(t.substr(i, 2));
      } else toks.push(t);
    }
    p = toks.map(t => {
      if (t === '??') return null;
      const neg = t[0] === '!';
      if (neg) t = t.slice(1);
      const set = new Uint8Array(256);
      for (const part of t.split(',')) {
        const [a, b] = part.split('-');
        const lo = parseInt(a, 16), hi = b === undefined ? lo : parseInt(b, 16);
        if (isNaN(lo) || isNaN(hi)) throw new Error(`Bad byte pattern token '${t}'`);
        for (let v = lo; v <= hi; v++) set[v] = 1;
      }
      if (neg) for (let v = 0; v < 256; v++) set[v] ^= 1;
      return set;
    });
    patCache.set(src, p);
    return p;
  }
  function findPattern(buf, pat, from, to) {
    const n = pat.length, first = pat[0];
    outer: for (let i = from; i + n <= to; i++) {
      if (first && !first[buf[i]]) continue;
      for (let k = 1; k < n; k++) { const s = pat[k]; if (s && !s[buf[i + k]]) continue outer; }
      return i;
    }
    return -1;
  }
  function hexToBytes(h) {
    h = String(h).replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(h.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  const hex = (v, w = 2) => '0x' + (typeof v === 'bigint' ? v.toString(16) : (v >>> 0 === v ? v.toString(16) : Math.floor(v).toString(16))).toUpperCase().padStart(w, '0');
  const bytesHex = (b, max = 16) => Array.from(b.subarray(0, max), x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ') + (b.length > max ? ' …' : '');

  /* ---------------- primitive types ---------------- */
  const primCache = new Map();
  function primInfo(type) {
    if (primCache.has(type)) return primCache.get(type);
    const m = /^(u|i|f)(8|16|24|32|64)(le|be)?$/.exec(type);
    let info = null;
    if (m) {
      const size = Number(m[2]) / 8;
      if (!(m[1] === 'f' && size !== 4 && size !== 8)) info = { kind: m[1], size, endian: m[3] || null };
    }
    primCache.set(type, info);
    return info;
  }
  function readPrimAt(dv, off, info, le) {
    const { kind, size } = info;
    if (kind === 'f') return size === 4 ? dv.getFloat32(off, le) : dv.getFloat64(off, le);
    switch (size) {
      case 1: return kind === 'u' ? dv.getUint8(off) : dv.getInt8(off);
      case 2: return kind === 'u' ? dv.getUint16(off, le) : dv.getInt16(off, le);
      case 3: {
        const a = dv.getUint8(off), b = dv.getUint8(off + 1), c = dv.getUint8(off + 2);
        let v = le ? a | (b << 8) | (c << 16) : (a << 16) | (b << 8) | c;
        if (kind === 'i' && v & 0x800000) v -= 0x1000000;
        return v;
      }
      case 4: return kind === 'u' ? dv.getUint32(off, le) : dv.getInt32(off, le);
      case 8: {
        const v = kind === 'u' ? dv.getBigUint64(off, le) : dv.getBigInt64(off, le);
        return (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : v;
      }
    }
  }

  const VARNUM = new Set(['vint', 'ebmlid', 'uint', 'sint', 'float']);

  /* ---------------- grammar preparation ---------------- */
  function parseKey(k) {
    if (typeof k === 'number') return k;
    const s = String(k).trim();
    if (/^-?(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(s)) return s.startsWith('-') ? -Number(s.slice(1)) : Number(s);
    return s;
  }
  function prepareGrammar(src) {
    const g = typeof src === 'string' ? JSON.parse(src) : JSON.parse(JSON.stringify(src));
    if (!g || typeof g !== 'object') throw new Error('Grammar must be a JSON object');
    if (!g.name) g.name = g.id || 'Untitled grammar';
    if (!g.id) g.id = String(g.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!g.root) throw new Error('Grammar needs a "root" (array of fields or a struct name)');
    g.structs = g.structs || {};
    for (const k of Object.keys(g.structs)) {
      if (Array.isArray(g.structs[k])) g.structs[k] = { fields: g.structs[k] };
      if (!Array.isArray(g.structs[k].fields)) throw new Error(`Struct "${k}" needs a "fields" array`);
    }
    const enums = {};
    for (const [name, map] of Object.entries(g.enums || {})) {
      const m = new Map();
      for (const [k, v] of Object.entries(map)) m.set(parseKey(k), v);
      enums[name] = m;
    }
    g._enums = enums;
    return g;
  }

  /** Static checks for the grammar editor. Returns a list of warning strings. */
  function lintGrammar(g) {
    const out = [];
    const seen = new Set();
    const checkType = (t, where) => {
      if (typeof t !== 'string') return;
      if (['bytes', 'string', 'cstring', 'struct', 'switch', 'calc', 'vint', 'ebmlid', 'uint', 'sint', 'float'].includes(t) || primInfo(t) || g.structs[t]) return;
      out.push(`${where}: unknown type "${t}"`);
    };
    const exprProps = ['if', 'offset', 'count', 'until', 'while', 'length', 'size', 'on', 'valid'];
    const walk = (fields, where) => {
      if (!Array.isArray(fields)) { out.push(`${where}: "fields" must be an array`); return; }
      fields.forEach((f, i) => {
        const w = `${where} › ${f.name || '#' + i}`;
        if (!f.name) out.push(`${w}: field has no "name"`);
        if (!f.type) out.push(`${w}: field has no "type"`);
        checkType(f.type, w);
        for (const p of exprProps) {
          if (typeof f[p] === 'string') { try { X.compile(f[p]); } catch (e) { out.push(`${w}.${p}: ${e.message}`); } }
        }
        if (f.enum && !g._enums[f.enum]) out.push(`${w}: unknown enum "${f.enum}"`);
        if (f.type === 'switch') {
          if (!f.on) out.push(`${w}: switch needs "on"`);
          for (const c of Object.values(f.cases || {})) checkType(typeof c === 'string' ? c : c.type, w + ' (case)');
          if (f.default) checkType(typeof f.default === 'string' ? f.default : f.default.type, w + ' (default)');
        }
        if (f.type === 'struct' && f.fields) walk(f.fields, w);
        if (f.terminator) { try { compilePattern(f.terminator); } catch (e) { out.push(`${w}.terminator: ${e.message}`); } }
      });
    };
    walk(Array.isArray(g.root) ? g.root : (g.structs[g.root] || {}).fields, 'root');
    for (const [k, s] of Object.entries(g.structs)) { if (!seen.has(k)) walk(s.fields, k); }
    return out;
  }

  /* ---------------- detection ---------------- */
  /** Returns a 0..1 score for how well buf matches grammar g (magic first, extension second). */
  function detectScore(g, buf, filename) {
    let best = 0;
    const alts = g.magic || [];
    for (const alt of alts) {
      const parts = Array.isArray(alt) ? alt : [alt];
      let total = 0, hit = 0;
      for (const m of parts) {
        const bytes = m.hex !== undefined ? hexToBytes(m.hex) : new TextEncoder().encode(m.ascii || '');
        const off = m.offset || 0;
        for (let i = 0; i < bytes.length; i++) { total++; if (buf[off + i] === bytes[i]) hit++; }
      }
      if (total) best = Math.max(best, hit / total);
    }
    const ext = (filename || '').toLowerCase().split('.').pop();
    const extHit = (g.extensions || []).includes(ext);
    if (best === 1) return 1;
    // A damaged signature still counts if most bytes match, or if the extension agrees.
    return Math.max(best >= 0.5 ? best * 0.9 : 0, extHit ? 0.6 : 0, best * (extHit ? 1 : 0.5));
  }
  function detect(grammars, buf, filename) {
    let best = null, score = 0;
    for (const g of grammars) {
      const s = detectScore(g, buf, filename);
      if (s > score) { score = s; best = g; }
    }
    return score >= 0.5 ? { grammar: best, score } : null;
  }

  /* ---------------- parser ---------------- */
  class Ctx {
    constructor(parent, node, le) {
      this.parent = parent;
      this.node = node;
      this.vars = Object.create(null);
      this.root = parent ? parent.root : this;
      this.le = le;
    }
  }

  class Parser {
    constructor(bytes, grammar, opts = {}) {
      this.b = bytes;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.g = grammar.structs && grammar._enums ? grammar : prepareGrammar(grammar);
      this.size = bytes.length;
      this.pos = 0;
      this.limit = this.size;
      this.issues = [];
      this.idx = [];
      this.nodeCount = 0;
      this.maxNodes = opts.maxNodes || 1500000;
      this.maxRepeat = opts.maxRepeat || 1000000;
      this.labelQueue = [];
      this.aborted = false;
    }

    node(o, parent) {
      if (++this.nodeCount > this.maxNodes && !this.aborted) {
        this.aborted = true;
        this.issue(parent, 'error', `Node limit (${this.maxNodes.toLocaleString()}) reached — parse stopped. The grammar may be looping, or the file is very large.`);
      }
      o.id = this.nodeCount;
      o.parent = parent || null;
      o.depth = parent ? parent.depth + 1 : 0;
      if (parent) parent.children.push(o);
      return o;
    }
    issue(node, level, msg) {
      const it = { level, msg, node };
      if (node) (node.issues || (node.issues = [])).push(it);
      this.issues.push(it);
    }

    /* ---- expressions ---- */
    env(ctx, extra) {
      return {
        get: name => this.lookup(name, ctx, extra),
        call: (name, args) => this.call(name, args, ctx),
      };
    }
    ev(src, ctx, extra, at) {
      if (typeof src !== 'string') return src;
      try { return X.compile(src)(this.env(ctx, extra)); }
      catch (e) { this.issue(at || ctx.node, 'error', `Expression "${src}": ${e.message}`); return undefined; }
    }
    num(src, ctx, extra, at) {
      const v = X.num(this.ev(src, ctx, extra, at));
      return v;
    }
    lookup(name, ctx, extra) {
      if (extra && hasOwn.call(extra, name)) return extra[name];
      switch (name) {
        case '_pos': return this.pos;
        case '_size': return this.size;
        case '_remaining': return Math.max(0, this.limit - this.pos);
        case '_index': return this.idx.length ? this.idx[this.idx.length - 1] : undefined;
        case '_root': return ctx.root.vars;
        case '_parent': return ctx.parent ? ctx.parent.vars : undefined;
      }
      for (let c = ctx; c; c = c.parent) if (name in c.vars) return c.vars[name];
      if (this.g.constants && hasOwn.call(this.g.constants, name)) return this.g.constants[name];
      return undefined;
    }
    call(name, a, ctx) {
      const N = X.num;
      switch (name) {
        case 'min': return Math.min(...a.map(N));
        case 'max': return Math.max(...a.map(N));
        case 'abs': return Math.abs(N(a[0]));
        case 'floor': return Math.floor(N(a[0]));
        case 'ceil': return Math.ceil(N(a[0]));
        case 'align': { const n = N(a[1]); return Math.ceil(N(a[0]) / n) * n; }
        case 'len': { const v = X.prim(a[0]); return v == null ? 0 : (v.length !== undefined ? v.length : 0); }
        case 'has': return a[0] !== undefined;
        case 'hex': return hex(N(a[0]), a[1] === undefined ? 2 : N(a[1]));
        case 'str': return X.str(X.prim(a[0]));
        case 'int': return parseInt(String(X.prim(a[0])), a[1] === undefined ? 10 : N(a[1]));
        case 'read': case 'peek': {
          const info = primInfo(String(a[0]));
          if (!info) throw new Error(`${name}(): unknown type ${a[0]}`);
          const off = name === 'peek' ? this.pos + (a[1] === undefined ? 0 : N(a[1])) : N(a[1]);
          if (!(off >= 0) || off + info.size > this.size) return undefined;
          const le = info.endian ? info.endian === 'le' : ctx.le;
          return readPrimAt(this.dv, off, info, le);
        }
        case 'cstr': {
          const off = N(a[0]);
          if (!(off >= 0) || off >= this.size) return undefined;
          let e = off;
          const max = Math.min(this.size, off + (a[1] === undefined ? 1024 : N(a[1])));
          while (e < max && this.b[e] !== 0) e++;
          return latin1(this.b.subarray(off, e));
        }
        case 'ascii': {
          const off = N(a[0]), n = N(a[1]);
          if (!(off >= 0) || off >= this.size) return undefined;
          return latin1(this.b.subarray(off, Math.min(this.size, off + n)));
        }
        case 'match': {
          const off = name === 'match' ? N(a[0]) : this.pos;
          const pat = compilePattern(String(a[1]));
          return off >= 0 && findPattern(this.b, pat, off, Math.min(this.size, off + pat.length)) === off;
        }
        case 'chr': return String.fromCharCode(N(a[0]));
        case 'syncsafe32': {
          const off = N(a[0]);
          if (!(off >= 0) || off + 4 > this.size) return undefined;
          const b = this.b;
          return ((b[off] & 127) << 21) | ((b[off + 1] & 127) << 14) | ((b[off + 2] & 127) << 7) | (b[off + 3] & 127);
        }
        case 'enumName': {
          const e = this.g._enums[String(a[0])];
          return e ? e.get(X.prim(a[1])) : undefined;
        }
      }
      throw new Error(`Unknown function ${name}()`);
    }
    endianOf(spec, ctx) {
      const e = spec.endian;
      if (e === undefined) return ctx.le;
      const v = (e === 'little' || e === 'le' || e === 'big' || e === 'be') ? e : this.ev(e, ctx);
      return v === 'little' || v === 'le';
    }

    /* ---- entry ---- */
    parse() {
      const g = this.g;
      const rootDef = Array.isArray(g.root) ? { fields: g.root } : (typeof g.root === 'string' ? g.structs[g.root] : g.root);
      if (!rootDef) throw new Error(`Root struct "${g.root}" not found`);
      const root = this.node({ name: g.name, kind: 'struct', type: typeof g.root === 'string' ? g.root : 'root', start: 0, end: 0, children: [], spec: {}, def: rootDef }, null);
      const le = (rootDef.endian || g.endian || 'little').startsWith('l');
      const ctx = new Ctx(null, root, le);
      root.ctx = ctx;
      for (const f of rootDef.fields) {
        if (this.parseField(f, ctx, root, this.size) === EOF) break;
      }
      root.end = this.pos;
      root.value = ctx.vars;
      this.finish(root);
      return { root, issues: this.issues, leaves: this.leaves, grammar: g, size: this.size, nodeCount: this.nodeCount };
    }

    parseField(spec, ctx, parent, limit) {
      if (this.aborted) return EOF;
      if (spec.if !== undefined && !X.truthy(this.ev(spec.if, ctx, null, parent))) return OK;
      const prevLimit = this.limit;
      let saved = null;
      if (spec.offset !== undefined) {
        const off = this.num(spec.offset, ctx, null, parent);
        if (!(off >= 0 && off <= this.size)) {
          this.issue(parent, 'error', `"${spec.name}": offset ${isNaN(off) ? 'is undefined' : hex(off)} is outside the file (size ${hex(this.size)})`);
          return OK;
        }
        saved = this.pos;
        this.pos = off;
        limit = this.size;
      }
      this.limit = limit;
      let st;
      if (spec.repeat !== undefined || spec.count !== undefined || spec.until !== undefined || spec.while !== undefined) {
        st = this.parseRepeat(spec, ctx, parent, limit);
      } else {
        const r = this.parseSingle(spec, ctx, parent, limit, spec.name);
        if (spec.name) ctx.vars[spec.name] = r.value;
        st = r.st;
      }
      this.limit = prevLimit;
      if (saved !== null) { this.pos = saved; st = OK; }
      return st;
    }

    parseRepeat(spec, ctx, parent, limit) {
      const arr = this.node({ name: spec.name, kind: 'array', type: spec.type, start: this.pos, end: this.pos, children: [], spec }, parent);
      const values = [];
      if (spec.name) ctx.vars[spec.name] = values;
      let count = spec.count !== undefined ? this.num(spec.count, ctx, null, arr) : Infinity;
      if (spec.count !== undefined && !(count >= 0)) {
        this.issue(arr, 'error', `Repeat count "${spec.count}" evaluated to ${count}`);
        count = 0;
      }
      if (count !== Infinity && count > this.maxRepeat) {
        this.issue(arr, 'error', `Repeat count ${count.toLocaleString()} is implausible; limited to ${this.maxRepeat.toLocaleString()}`);
        count = this.maxRepeat;
      }
      let i = 0, st = OK, ended = false;
      while (i < count) {
        if (this.aborted) { st = EOF; break; }
        this.limit = limit;
        if (this.pos >= limit) {
          if (count !== Infinity) {
            this.issue(arr, 'error', `Expected ${count} items but data ended after ${i}`);
            st = EOF;
          } else if (spec.until !== undefined && spec.repeat !== 'eof') {
            this.issue(arr, 'warn', `Data ended before the terminating item (until: ${spec.until})`);
          }
          break;
        }
        if (spec.while !== undefined && !X.truthy(this.ev(spec.while, ctx, { _: values[i - 1], _last: values[i - 1] }, arr))) break;
        const before = this.pos;
        this.idx.push(i);
        const r = this.parseSingle(spec, ctx, arr, limit, `${spec.name}[${i}]`);
        this.idx.pop();
        if (r.node) r.node.index = i;
        values.push(r.value);
        i++;
        if (r.st === EOF) { st = EOF; break; }
        if (spec.until !== undefined && X.truthy(this.ev(spec.until, ctx, { _: r.value, _last: r.value }, arr))) { ended = true; break; }
        if (this.pos === before) {
          this.issue(arr, 'warn', `Item ${i - 1} consumed no bytes; stopping repetition to avoid an infinite loop`);
          break;
        }
        if (i >= this.maxRepeat) { this.issue(arr, 'error', `Repetition limit (${this.maxRepeat}) reached`); break; }
      }
      arr.end = Math.max(this.pos, arr.start);
      if (arr.children.length) arr.start = Math.min(arr.start, arr.children[0].start);
      arr.value = values;
      arr.count = i;
      arr.ended = ended;
      return st;
    }

    parseSingle(spec, ctx, parent, limit, name) {
      let type = spec.type;
      if (type === 'switch') {
        const v = X.prim(this.ev(spec.on, ctx, null, parent));
        let c;
        for (const [k, sub] of Object.entries(spec.cases || {})) {
          const key = parseKey(k);
          if (key === v || (typeof v === 'string' && String(key) === v) || (typeof v === 'number' && Number(key) === v)) { c = sub; break; }
        }
        if (c === undefined) c = spec.default;
        if (c === undefined) {
          this.issue(parent, 'warn', `"${name}": no case for value ${typeof v === 'number' ? `${v} (${hex(v)})` : JSON.stringify(v)}`);
          return { st: OK, value: undefined };
        }
        const merged = Object.assign({}, spec, typeof c === 'string' ? { type: c } : c);
        delete merged.on; delete merged.cases; delete merged.default;
        merged.switchValue = v;
        return this.parseSingle(merged, ctx, parent, limit, name);
      }
      let r;
      const info = primInfo(type);
      if (info) r = this.readPrim(spec, info, ctx, parent, limit, name);
      else if (type === 'bytes') r = this.readBytes(spec, ctx, parent, limit, name);
      else if (type === 'calc') r = this.calc(spec, ctx, parent, name);
      else if (VARNUM.has(type)) r = this.readVarNum(spec, ctx, parent, limit, name);
      else if (type === 'string' || type === 'cstring') r = this.readString(spec, ctx, parent, limit, name);
      else if (type === 'struct' || this.g.structs[type]) r = this.parseStruct(spec, type === 'struct' ? spec : this.g.structs[type], ctx, parent, limit, name);
      else {
        this.issue(parent, 'error', `"${name}": unknown type "${type}"`);
        return { st: OK, value: undefined };
      }
      if (r.node) {
        if (spec.warn) this.issue(r.node, 'warn', this.tmpl(spec.warn, ctx, r.node));
        if (spec.error) this.issue(r.node, 'error', this.tmpl(spec.error, ctx, r.node));
      }
      return r;
    }
    tmpl(src, ctx, node) {
      try { return X.template(src)(this.env(ctx, { _: node && node.value })); }
      catch (e) { return `${src} (template error: ${e.message})`; }
    }

    truncated(node, need, have, limit) {
      const what = limit >= this.size ? 'Unexpected end of file' : 'Field runs past the end of its enclosing structure';
      node.truncated = true;
      this.issue(node, 'error', `${what}: needed ${need.toLocaleString()} bytes at ${hex(node.start, 4)}, only ${have.toLocaleString()} available`);
    }

    readPrim(spec, info, ctx, parent, limit, name) {
      const start = this.pos;
      const node = this.node({ name, kind: 'field', type: spec.type, start, end: start, spec }, parent);
      if (start + info.size > limit) {
        node.end = Math.max(start, limit);
        this.truncated(node, info.size, Math.max(0, limit - start), limit);
        this.pos = node.end;
        return { st: EOF, value: undefined, node };
      }
      const le = info.endian ? info.endian === 'le' : this.endianOf(spec, ctx);
      const v = readPrimAt(this.dv, start, info, le);
      this.pos = node.end = start + info.size;
      node.value = v;
      node.le = le;
      let value = v;
      if (spec.bits) value = this.readBits(spec, node, v, info);
      this.checkValue(spec, node, v, ctx);
      return { st: OK, value, node };
    }

    readBits(spec, node, v, info) {
      const total = info.size * 8;
      const order = spec.bitOrder || this.g.bitOrder || 'msb';
      const out = Object.create(null);
      out._value = v;
      node.children = [];
      let acc = 0;
      const n = Number(v);
      let bits = spec.bits;
      if (typeof bits === 'string') {
        bits = (this.g.bitsets || {})[bits.replace(/^@/, '')];
        if (!bits) { this.issue(node, 'error', `Unknown bitset ${spec.bits}`); return v; }
      }
      for (const b of bits) {
        const w = b.bits || 1;
        const shift = order === 'lsb' ? acc : total - acc - w;
        acc += w;
        const val = Math.floor(n / 2 ** shift) % 2 ** w;
        if (b.name) out[b.name] = val;
        if (!b.name || b.hidden) continue;
        const bn = this.node({ name: b.name, kind: 'bits', type: `bit${w > 1 ? 's' : ''} ${shift + w - 1 === shift ? shift : `${shift + w - 1}…${shift}`}`, start: node.start, end: node.end, value: val, spec: b, bitShift: shift, bitWidth: w }, node);
        bn.display = this.display(b, val, bn);
      }
      node.bitsValue = out;
      return out;
    }

    checkValue(spec, node, v, ctx) {
      if (spec.expect !== undefined) {
        const want = Array.isArray(spec.expect) ? spec.expect : [spec.expect];
        let ok;
        if (v instanceof Uint8Array) {
          ok = want.some(w => { const e = hexToBytes(w); return e.length === v.length && e.every((x, i) => x === v[i]); });
        } else if (typeof v === 'string') ok = want.some(w => String(w) === v);
        else ok = want.some(w => parseKey(w) === v || Number(parseKey(w)) === Number(v));
        if (!ok) {
          node.bad = true;
          const show = x => v instanceof Uint8Array ? bytesHex(x instanceof Uint8Array ? x : hexToBytes(x), 32) : typeof v === 'string' ? JSON.stringify(x) : (typeof x === 'number' || typeof x === 'bigint' ? `${x} (${hex(x)})` : String(x));
          this.issue(node, spec.expectLevel || 'error', `${spec.expectMsg ? spec.expectMsg + ': ' : ''}expected ${want.map(show).join(' or ')}, found ${show(v)}`);
        }
      }
      if (spec.valid !== undefined) {
        const r = this.ev(spec.valid, ctx, { _: node.bitsValue || v }, node);
        if (!X.truthy(r)) {
          node.bad = true;
          this.issue(node, spec.validLevel || 'warn', spec.validMsg ? this.tmpl(spec.validMsg, ctx, node) : `Value failed check: ${spec.valid}`);
        }
      }
      if (spec.enum) {
        const e = this.g._enums[spec.enum];
        const key = v instanceof Uint8Array ? bytesHex(v, 64).replace(/ /g, '') : v;
        const nm = e && (e.get(key) !== undefined ? e.get(key) : e.get(Number(key)));
        if (e && nm === undefined) {
          node.unknownEnum = true;
          if (spec.enumStrict) { node.bad = true; this.issue(node, 'warn', `Value ${typeof v === 'number' ? hex(v) : v} is not a known ${spec.enum}`); }
        }
        node.enumName = nm;
      }
      if (spec.checksum) this.checkChecksum(spec, node, v, ctx);
      if (node.kind !== 'struct') node.display = this.display(spec, v, node);
    }

    checkChecksum(spec, node, v, ctx) {
      const c = spec.checksum;
      const fn = CHECKSUMS[c.algo || 'crc32'];
      if (!fn) { this.issue(node, 'error', `Unknown checksum algorithm ${c.algo}`); return; }
      let s, e;
      if (c.from !== undefined) {
        const sib = n => { const kids = node.parent.children; for (let i = kids.length - 1; i >= 0; i--) if (kids[i].name === n) return kids[i]; return null; };
        const a = sib(c.from), b = sib(c.to || c.from);
        if (!a || !b) return;
        s = a.start; e = b.end;
      } else {
        s = this.num(c.start, ctx, null, node); e = this.num(c.end, ctx, null, node);
      }
      if (!(s >= 0 && e <= this.size && e >= s)) return;
      const got = fn(this.b, s, e);
      node.checksum = { algo: c.algo || 'crc32', computed: got, start: s, end: e, ok: got === Number(v) };
      if (got !== Number(v)) {
        node.bad = true;
        this.issue(node, 'error', `${(c.algo || 'crc32').toUpperCase()} mismatch: stored ${hex(Number(v), 8)}, computed ${hex(got, 8)} over ${hex(s)}…${hex(e)}`);
      }
    }

    /** A computed value: occupies no bytes, but shows in the tree and can be referenced. */
    calc(spec, ctx, parent, name) {
      const node = this.node({ name, kind: 'calc', type: 'calc', start: this.pos, end: this.pos, spec }, parent);
      const v = X.prim(this.ev(spec.value, ctx, null, node));
      node.value = v;
      this.checkValue(spec, node, v, ctx);
      return { st: OK, value: v, node };
    }

    /** vint / ebmlid (EBML variable-length integers) and uint/sint/float with a runtime length. */
    readVarNum(spec, ctx, parent, limit, name) {
      const type = spec.type, start = this.pos, b = this.b;
      const node = this.node({ name, kind: 'field', type, start, end: start, spec }, parent);
      let len, v;
      if (type === 'vint' || type === 'ebmlid') {
        if (start >= limit) { this.truncated(node, 1, 0, limit); return { st: EOF, value: undefined, node }; }
        const first = b[start];
        len = first === 0 ? 9 : Math.clz32(first) - 23;
        if (len > 8) {
          node.end = this.pos = start + 1;
          node.bad = true;
          this.issue(node, 'error', 'Invalid variable-length integer (lead byte 0x00)');
          return { st: OK, value: undefined, node };
        }
      } else {
        len = this.num(spec.length !== undefined ? spec.length : spec.size, ctx, null, node);
        if (!(len >= 0)) { this.issue(node, 'error', `Length evaluated to ${len}`); len = 0; }
        if (type === 'float' && len !== 0 && len !== 4 && len !== 8) { this.issue(node, 'error', `Float must be 4 or 8 bytes, not ${len}`); }
        if (len > 8 && type !== 'float') this.issue(node, 'warn', `${len}-byte integer; only the low 8 bytes are shown`);
      }
      if (start + len > limit) {
        node.end = this.pos = Math.max(start, limit);
        this.truncated(node, len, Math.max(0, limit - start), limit);
        return { st: EOF, value: undefined, node };
      }
      this.pos = node.end = start + len;
      if (type === 'float') v = len === 4 ? this.dv.getFloat32(start, !this.endianOf(spec, ctx) ? false : true) : len === 8 ? this.dv.getFloat64(start, this.endianOf(spec, ctx)) : 0;
      else {
        const le = type === 'vint' || type === 'ebmlid' ? false : this.endianOf(spec, ctx);
        v = 0;
        let allOnes = true;
        for (let i = 0; i < len; i++) {
          let x = b[le ? start + len - 1 - i : start + i];
          if (type === 'vint' && i === 0) { x &= 0xFF >> len; if (x !== (0xFF >> len)) allOnes = false; }
          else if (x !== 0xFF) allOnes = false;
          v = v * 256 + x;
        }
        if (type === 'vint' && allOnes) { v = -1; node.unknownSize = true; }
        if (type === 'sint' && len > 0 && len <= 6 && v >= 2 ** (len * 8 - 1)) v -= 2 ** (len * 8);
      }
      node.value = v;
      this.checkValue(spec, node, v, ctx);
      if (node.unknownSize) node.display = 'unknown (-1)';
      return { st: OK, value: v, node };
    }

    readBytes(spec, ctx, parent, limit, name) {
      const start = this.pos;
      const node = this.node({ name, kind: 'field', type: 'bytes', start, end: start, spec }, parent);
      let end, st = OK;
      const lenSrc = spec.length !== undefined ? spec.length : spec.size;
      if (spec.terminator !== undefined) {
        const pat = compilePattern(spec.terminator);
        const at = findPattern(this.b, pat, start, limit);
        if (at < 0) {
          end = limit;
          this.issue(node, spec.terminatorLevel || 'warn', `Terminator ${spec.terminator} not found; consumed to ${limit >= this.size ? 'end of file' : 'end of structure'}`);
          node.unterminated = true;
        } else end = spec.consume || spec.includeTerminator ? at + pat.length : at;
      } else if (lenSrc !== undefined) {
        let len = this.num(lenSrc, ctx, null, node);
        if (!(len >= 0)) {
          this.issue(node, 'error', `Length "${lenSrc}" evaluated to ${len}`);
          len = 0;
        }
        end = start + len;
        if (end > limit) {
          node.end = limit;
          this.truncated(node, len, Math.max(0, limit - start), limit);
          end = Math.max(start, limit);
          st = EOF;
        }
      } else end = limit;
      this.pos = node.end = end;
      const v = this.b.subarray(start, Math.min(end, this.size));
      node.value = v;
      this.checkValue(spec, node, v, ctx);
      return { st, value: v, node };
    }

    readString(spec, ctx, parent, limit, name) {
      const start = this.pos;
      const node = this.node({ name, kind: 'field', type: spec.type, start, end: start, spec }, parent);
      let end, textEnd, st = OK;
      const lenSrc = spec.length !== undefined ? spec.length : spec.size;
      if (spec.type === 'cstring' || spec.terminator !== undefined) {
        const pat = compilePattern(spec.terminator || '00');
        const at = findPattern(this.b, pat, start, lenSrc !== undefined ? Math.min(limit, start + this.num(lenSrc, ctx, null, node)) : limit);
        if (at < 0) {
          textEnd = end = lenSrc !== undefined ? Math.min(limit, start + this.num(lenSrc, ctx, null, node)) : limit;
          if (lenSrc === undefined) { this.issue(node, 'warn', 'String terminator not found'); node.unterminated = true; }
        } else {
          textEnd = at;
          end = lenSrc !== undefined ? start + this.num(lenSrc, ctx, null, node) : (spec.consume === false ? at : at + pat.length);
        }
      } else if (lenSrc !== undefined) {
        let len = this.num(lenSrc, ctx, null, node);
        if (!(len >= 0)) { this.issue(node, 'error', `Length "${lenSrc}" evaluated to ${len}`); len = 0; }
        textEnd = end = start + len;
        if (end > limit) {
          node.end = limit;
          this.truncated(node, len, Math.max(0, limit - start), limit);
          textEnd = end = Math.max(start, limit);
          st = EOF;
        }
      } else textEnd = end = limit;
      this.pos = node.end = end;
      let v = decode(this.b.subarray(start, textEnd), spec.encoding);
      if (spec.type !== 'cstring' && spec.trim !== false) v = v.replace(/\0+$/, '');
      node.value = v;
      this.checkValue(spec, node, v, ctx);
      return { st, value: v, node };
    }

    parseStruct(spec, def, ctx, parent, limit, name) {
      const start = this.pos;
      const node = this.node({ name, kind: 'struct', type: spec.type === 'struct' ? 'struct' : spec.type, start, end: start, children: [], spec, def }, parent);
      const sub = new Ctx(ctx, node, def.endian !== undefined ? this.endianOf(def, ctx) : (spec.endian !== undefined ? this.endianOf(spec, ctx) : ctx.le));
      node.ctx = sub;
      const sizeSrc = spec.size !== undefined ? spec.size : def.size;
      let inner = limit, bounded = false, truncated = false;
      if (sizeSrc !== undefined) {
        let sz = this.num(sizeSrc, ctx, null, node);
        if (!(sz >= 0)) { this.issue(node, 'error', `Size "${sizeSrc}" evaluated to ${sz}`); sz = 0; }
        let e = start + sz;
        if (e > limit) {
          this.truncated(node, sz, Math.max(0, limit - start), limit);
          e = limit;
          truncated = true;
        }
        inner = e;
        bounded = true;
      }
      let st = OK;
      for (const f of def.fields) {
        st = this.parseField(f, sub, node, inner);
        this.limit = inner;
        if (st === EOF) break;
      }
      if (bounded) {
        if (this.pos < inner && !this.aborted) {
          const gap = this.node({ name: '(unparsed)', kind: 'gap', type: 'bytes', start: this.pos, end: inner, spec: {} }, node);
          gap.value = this.b.subarray(gap.start, gap.end);
          gap.display = `${(inner - this.pos).toLocaleString()} B`;
          if (!spec.allowSlack && !def.allowSlack) this.issue(gap, 'info', `${(inner - this.pos).toLocaleString()} bytes inside "${name}" not described by the grammar`);
        }
        this.pos = inner;
        st = truncated ? EOF : (this.aborted ? EOF : OK);
      }
      node.end = Math.max(this.pos, start);
      node.value = sub.vars;
      const label = spec.label !== undefined ? spec.label : def.label;
      const colorBy = spec.colorBy !== undefined ? spec.colorBy : def.colorBy;
      if (label || colorBy) this.labelQueue.push({ node, ctx: sub, label, colorBy });
      this.checkValue(Object.assign({}, spec, { expect: undefined, enum: undefined, checksum: undefined }), node, sub.vars, sub);
      node.display = '';
      return { st, value: sub.vars, node };
    }

    display(spec, v, node) {
      if (v === undefined) return '';
      if (v instanceof Uint8Array) {
        if (spec.format === 'ascii' || spec.format === 'text') return JSON.stringify(latin1(v.subarray(0, 64))) + (v.length > 64 ? '…' : '');
        return v.length ? bytesHex(v, 8) : '(empty)';
      }
      if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v);
      let s;
      const n = Number(v);
      switch (spec.format) {
        case 'hex': s = hex(v, (node.end - node.start) * 2 || 2); break;
        case 'bin': s = '0b' + n.toString(2).padStart(node.bitWidth || (node.end - node.start) * 8, '0'); break;
        case 'char': s = JSON.stringify(String.fromCharCode(n)); break;
        case 'bool': s = n ? 'true' : 'false'; break;
        case 'unixtime': s = n ? new Date(n * 1000).toISOString().replace('.000Z', 'Z') : '0'; break;
        case 'dostime': s = `${String(n >> 11).padStart(2, '0')}:${String((n >> 5) & 63).padStart(2, '0')}:${String((n & 31) * 2).padStart(2, '0')}`; break;
        case 'dosdate': s = `${(n >> 9) + 1980}-${String((n >> 5) & 15).padStart(2, '0')}-${String(n & 31).padStart(2, '0')}`; break;
        case 'fourcc': s = JSON.stringify(String.fromCharCode(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)); break;
        default: s = typeof v === 'number' && !Number.isInteger(v) ? String(+v.toPrecision(8)) : String(v);
      }
      if (spec.scale) s += ` (= ${+(n * spec.scale).toPrecision(8)}${spec.unit ? ' ' + spec.unit : ''})`;
      else if (spec.unit) s += ' ' + spec.unit;
      const nm = node.enumName !== undefined ? node.enumName : (spec.enum && this.g._enums[spec.enum] ? this.g._enums[spec.enum].get(v) : undefined);
      if (nm !== undefined) s += ` · ${typeof nm === 'string' ? nm : nm.name}`;
      return s;
    }

    /* ---- post processing ---- */
    finish(root) {
      for (const q of this.labelQueue) {
        const extra = { _start: q.node.start, _end: q.node.end, _length: q.node.end - q.node.start, _index: q.node.index };
        if (q.label) {
          try { q.node.label = X.template(q.label)(this.env(q.ctx, extra)); }
          catch (e) { q.node.label = `(label error: ${e.message})`; }
        }
        if (q.colorBy) {
          try { q.node.colorKey = X.str(X.prim(X.compile(q.colorBy)(this.env(q.ctx, extra)))); } catch (e) { /* ignore */ }
        }
      }
      // Coverage: anything not described by a leaf becomes a visible gap at the root.
      let leaves = collectLeaves(root);
      leaves.sort((a, b) => a.start - b.start || a.end - b.end);
      const gaps = [];
      let covered = 0;
      for (const l of leaves) {
        if (l.start > covered) gaps.push([covered, l.start]);
        covered = Math.max(covered, l.end);
      }
      if (covered < this.size) gaps.push([covered, this.size]);
      for (const [s, e] of gaps) {
        const trailing = e === this.size && s >= root.end;
        let zero = true;
        for (let i = s; i < e; i++) if (this.b[i] !== 0) { zero = false; break; }
        const gap = this.node({ name: zero ? '(zero padding)' : trailing ? '(trailing data)' : '(unparsed)', kind: 'gap', type: 'bytes', start: s, end: e, spec: {}, zero }, root);
        gap.value = this.b.subarray(s, e);
        gap.display = `${(e - s).toLocaleString()} B`;
        if (zero && !trailing) { this.issue(gap, 'info', `${(e - s).toLocaleString()} zero bytes (alignment padding?) at ${hex(s)}…${hex(e)}`); continue; }
        this.issue(gap, zero ? 'info' : 'warn', trailing
          ? `${(e - s).toLocaleString()} bytes of trailing data after the end of the format (${hex(s)}…${hex(e)})`
          : `${(e - s).toLocaleString()} bytes not described by the grammar (${hex(s)}…${hex(e)})`);
      }
      if (gaps.length) {
        root.children.sort((a, b) => a.start - b.start);
        leaves = collectLeaves(root).sort((a, b) => a.start - b.start || a.end - b.end);
      }
      root.end = this.size;
      root.start = 0;
      this.leaves = leaves;
      const rank = { error: 0, warn: 1, info: 2 };
      this.issues.sort((a, b) => (a.node ? a.node.start : 0) - (b.node ? b.node.start : 0) || rank[a.level] - rank[b.level]);
    }
  }

  function collectLeaves(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if ((n.kind === 'field' || n.kind === 'gap')) { if (n.end > n.start) out.push(n); continue; }
      if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return out;
  }

  function latin1(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return s;
  }
  function decode(b, enc) {
    enc = (enc || 'ascii').toLowerCase();
    if (enc === 'ascii' || enc === 'latin1' || enc === 'iso-8859-1') return latin1(b);
    try { return new TextDecoder(enc === 'utf16le' ? 'utf-16le' : enc === 'utf16be' ? 'utf-16be' : enc, { fatal: false }).decode(b); }
    catch (e) { return latin1(b); }
  }

  /** Find the leaf covering a byte offset (leaves sorted by start). */
  function leafAt(leaves, off) {
    let lo = 0, hi = leaves.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (leaves[mid].start <= off) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = best, k = 0; i >= 0 && k < 16; i--, k++) if (leaves[i].end > off) return leaves[i];
    return null;
  }

  function parseBuffer(bytes, grammar, opts) {
    return new Parser(bytes, grammar, opts).parse();
  }

  G.FOB = {
    Parser, parseBuffer, prepareGrammar, lintGrammar, detect, detectScore, leafAt,
    crc32, adler32, compilePattern, findPattern, hexToBytes, hex, bytesHex, latin1, primInfo, readPrimAt,
  };
})(typeof window !== 'undefined' ? window : globalThis);
