/*
 * FOB expression language — a tiny, sandboxed, JS-like expression evaluator.
 * Grammars are data, so they may come from strangers: nothing here uses eval()
 * or new Function(), and property access is restricted to own properties.
 *
 *   literals   12  0x1F  0b101  'text'  "text"  true false null
 *   access     a.b   a[0]   name.length
 *   calls      min(a,b)  read('u32', off)   s.startsWith('I')
 *   operators  ?:  ||  &&  |  ^  &  == !=  < <= > >=  << >> >>>  + -  * / %  **  ! - ~
 */
(function (G) {
  'use strict';

  const OPS = ['>>>', '===', '!==', '**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '?', ':', '(', ')', '[', ']', ',', '.', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '<', '>'];

  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c >= '0' && c <= '9') {
        const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(s.slice(i));
        toks.push({ t: 'num', v: Number(m[0].replace(/_/g, '')) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
        toks.push({ t: 'id', v: m[0] });
        i += m[0].length;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, out = '';
        while (j < s.length && s[j] !== c) {
          if (s[j] === '\\') {
            j++;
            const e = s[j];
            if (e === 'n') out += '\n';
            else if (e === 't') out += '\t';
            else if (e === 'r') out += '\r';
            else if (e === '0') out += '\0';
            else if (e === 'x') { out += String.fromCharCode(parseInt(s.substr(j + 1, 2), 16)); j += 2; }
            else out += e;
            j++;
          } else out += s[j++];
        }
        if (j >= s.length) throw new Error('Unterminated string');
        toks.push({ t: 'str', v: out });
        i = j + 1;
        continue;
      }
      const op = OPS.find(o => s.startsWith(o, i));
      if (!op) throw new Error(`Unexpected character '${c}'`);
      toks.push({ t: 'op', v: op === '===' ? '==' : op === '!==' ? '!=' : op });
      i += op.length;
    }
    return toks;
  }

  const BIN = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
    '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8,
    '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
  };

  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const isOp = v => p < toks.length && toks[p].t === 'op' && toks[p].v === v;
    const expect = v => { if (!isOp(v)) throw new Error(`Expected '${v}'`); p++; };

    function ternary() {
      const c = binary(1);
      if (isOp('?')) {
        p++;
        const a = ternary();
        expect(':');
        const b = ternary();
        return { k: '?', c, a, b };
      }
      return c;
    }
    function binary(min) {
      let left = unary();
      for (;;) {
        const t = toks[p];
        if (!t || t.t !== 'op') break;
        const pr = BIN[t.v];
        if (pr === undefined || pr < min) break;
        p++;
        const right = binary(t.v === '**' ? pr : pr + 1);
        left = { k: 'b', op: t.v, a: left, b: right };
      }
      return left;
    }
    function unary() {
      const t = toks[p];
      if (t && t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '~' || t.v === '+')) {
        p++;
        return { k: 'u', op: t.v, a: unary() };
      }
      return postfix(primary());
    }
    function primary() {
      const t = toks[p++];
      if (!t) throw new Error('Unexpected end of expression');
      if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'id') {
        if (t.v === 'true') return { k: 'lit', v: true };
        if (t.v === 'false') return { k: 'lit', v: false };
        if (t.v === 'null' || t.v === 'undefined') return { k: 'lit', v: undefined };
        return { k: 'id', v: t.v };
      }
      if (t.t === 'op' && t.v === '(') {
        const e = ternary();
        expect(')');
        return e;
      }
      throw new Error(`Unexpected '${t.v}'`);
    }
    function args() {
      const list = [];
      if (isOp(')')) { p++; return list; }
      for (;;) {
        list.push(ternary());
        if (isOp(',')) { p++; continue; }
        expect(')');
        return list;
      }
    }
    function postfix(n) {
      for (;;) {
        if (isOp('.')) {
          p++;
          const t = toks[p++];
          if (!t || t.t !== 'id') throw new Error("Expected name after '.'");
          if (isOp('(')) { p++; n = { k: 'mcall', o: n, n: t.v, args: args() }; }
          else n = { k: '.', o: n, n: t.v };
        } else if (isOp('[')) {
          p++;
          const i = ternary();
          expect(']');
          n = { k: '[]', o: n, i };
        } else if (isOp('(')) {
          if (n.k !== 'id') throw new Error('Only named functions can be called');
          p++;
          n = { k: 'call', f: n.v, args: args() };
        } else return n;
      }
    }

    const ast = ternary();
    if (p < toks.length) throw new Error(`Unexpected '${toks[p].v}'`);
    return ast;
  }

  const has = Object.prototype.hasOwnProperty;
  const isBytes = v => v instanceof Uint8Array;

  /** Unwrap bitfield wrappers ({_value}) and BigInts into plain JS values. */
  function prim(v) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !isBytes(v) && has.call(v, '_value')) v = v._value;
    if (typeof v === 'bigint') v = Number(v);
    return v;
  }
  const num = v => { v = prim(v); return typeof v === 'number' ? v : Number(v); };
  const truthy = v => {
    v = prim(v);
    if (isBytes(v) || Array.isArray(v)) return v.length > 0;
    return !!v;
  };

  function member(o, key) {
    if (o === null || o === undefined) return undefined;
    if (Array.isArray(o) || typeof o === 'string' || isBytes(o)) {
      if (key === 'length') return o.length;
      if (typeof key === 'number' || /^\d+$/.test(key)) return o[Number(key)];
      return undefined;
    }
    if (typeof o === 'object') return has.call(o, key) ? o[key] : undefined;
    return undefined;
  }

  const STRING_METHODS = {
    startsWith: (s, a) => s.startsWith(String(a[0])),
    endsWith: (s, a) => s.endsWith(String(a[0])),
    includes: (s, a) => s.includes(String(a[0])),
    toUpperCase: s => s.toUpperCase(),
    toLowerCase: s => s.toLowerCase(),
    trim: s => s.trim(),
    slice: (s, a) => s.slice(num(a[0]), a[1] === undefined ? undefined : num(a[1])),
    charCodeAt: (s, a) => s.charCodeAt(num(a[0] || 0)),
    padStart: (s, a) => s.padStart(num(a[0]), a[1] === undefined ? ' ' : String(a[1])),
  };

  function evaluate(n, env) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'id': return env.get(n.v);
      case '.': return member(evaluate(n.o, env), n.n);
      case '[]': {
        const o = evaluate(n.o, env);
        const i = prim(evaluate(n.i, env));
        return member(o, typeof i === 'number' ? i : String(i));
      }
      case 'call': return env.call(n.f, n.args.map(a => evaluate(a, env)));
      case 'mcall': {
        let o = prim(evaluate(n.o, env));
        const fn = STRING_METHODS[n.n];
        if (!fn) throw new Error(`Unknown method '${n.n}'`);
        if (isBytes(o)) o = String.fromCharCode.apply(null, o.subarray(0, 4096));
        if (typeof o !== 'string') o = o === undefined ? '' : String(o);
        return fn(o, n.args.map(a => evaluate(a, env)));
      }
      case 'u': {
        const v = evaluate(n.a, env);
        if (n.op === '!') return !truthy(v);
        if (n.op === '-') return -num(v);
        if (n.op === '+') return num(v);
        return (~num(v)) >>> 0;
      }
      case '?': return truthy(evaluate(n.c, env)) ? evaluate(n.a, env) : evaluate(n.b, env);
      case 'b': {
        if (n.op === '&&') { const a = evaluate(n.a, env); return truthy(a) ? evaluate(n.b, env) : a; }
        if (n.op === '||') { const a = evaluate(n.a, env); return truthy(a) ? a : evaluate(n.b, env); }
        const a = prim(evaluate(n.a, env)), b = prim(evaluate(n.b, env));
        switch (n.op) {
          case '==': return looseEq(a, b);
          case '!=': return !looseEq(a, b);
          case '+': return (typeof a === 'string' || typeof b === 'string') ? str(a) + str(b) : num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(a) / num(b);
          case '%': return num(a) % num(b);
          case '**': return num(a) ** num(b);
          case '<': return cmp(a, b) < 0;
          case '<=': return cmp(a, b) <= 0;
          case '>': return cmp(a, b) > 0;
          case '>=': return cmp(a, b) >= 0;
          case '&': return (num(a) & num(b)) >>> 0;
          case '|': return (num(a) | num(b)) >>> 0;
          case '^': return (num(a) ^ num(b)) >>> 0;
          case '<<': return (num(a) << num(b)) >>> 0;
          case '>>': case '>>>': { const x = num(a); return x < 0 ? x >> num(b) : Math.floor(x / 2 ** num(b)); }
        }
      }
    }
    throw new Error('Bad expression node');
  }

  function str(v) {
    if (v === undefined || v === null) return '';
    if (isBytes(v)) return Array.from(v.subarray(0, 16), x => x.toString(16).padStart(2, '0')).join(' ') + (v.length > 16 ? '…' : '');
    if (Array.isArray(v)) return `[${v.length}]`;
    if (typeof v === 'object') return '{…}';
    return String(v);
  }
  function looseEq(a, b) {
    if (typeof a === 'string' && isBytes(b)) b = String.fromCharCode.apply(null, b);
    if (typeof b === 'string' && isBytes(a)) a = String.fromCharCode.apply(null, a);
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof b === 'number' && typeof a === 'string') return b === Number(a);
    if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
    return a === b;
  }
  function cmp(a, b) {
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return num(a) - num(b);
  }

  const cache = new Map();
  function compile(src) {
    src = String(src);
    let fn = cache.get(src);
    if (!fn) {
      const ast = parse(src);
      fn = env => evaluate(ast, env);
      cache.set(src, fn);
    }
    return fn;
  }

  /** Compile a template like "${type} · ${length} B" into fn(env) -> string. */
  const tcache = new Map();
  function template(src) {
    src = String(src);
    let fn = tcache.get(src);
    if (fn) return fn;
    const parts = [];
    let i = 0;
    while (i < src.length) {
      const j = src.indexOf('${', i);
      if (j < 0) { parts.push(src.slice(i)); break; }
      if (j > i) parts.push(src.slice(i, j));
      let depth = 1, k = j + 2, q = null;
      for (; k < src.length && depth > 0; k++) {
        const c = src[k];
        if (q) { if (c === '\\') k++; else if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      if (depth) throw new Error('Unterminated ${ in template');
      parts.push(compile(src.slice(j + 2, k - 1)));
      i = k;
    }
    fn = env => parts.map(p => typeof p === 'string' ? p : str(prim(p(env)))).join('');
    tcache.set(src, fn);
    return fn;
  }

  G.FOBExpr = { compile, template, prim, num, truthy, str, parse };
})(typeof window !== 'undefined' ? window : globalThis);
