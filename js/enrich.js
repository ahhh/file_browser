/*
 * Metadata enrichment: local file hashes and (optional) VirusTotal lookups.
 *
 * Hashes are computed in the browser. Nothing is sent anywhere unless the user
 * clicks a lookup link/button (or enables auto-lookup), and even then only the
 * hash is sent; file contents are never uploaded.
 *
 * VirusTotal's API does not send CORS headers, so a page on github.io cannot
 * call it directly. In-page reports go through a tiny proxy the user deploys
 * themselves (tools/vt-proxy-worker.js). Without a proxy, the "open on
 * VirusTotal" link still works.
 */
(function (G) {
  'use strict';

  /* ---------- MD5 (RFC 1321) — WebCrypto doesn't provide it ---------- */
  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const MD5_R = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_G = new Uint8Array(64);
  for (let i = 0; i < 64; i++) MD5_G[i] = i < 16 ? i : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16;

  /** Incremental MD5 so large files can be hashed in slices without freezing the page. */
  class MD5 {
    constructor() { this.h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]); this.M = new Int32Array(16); this.len = 0; this.tail = new Uint8Array(0); }
    block(b, off) {
      const M = this.M, h = this.h;
      for (let i = 0; i < 16; i++) { const o = off + i * 4; M[i] = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
      let A = h[0], B = h[1], C = h[2], D = h[3];
      for (let i = 0; i < 64; i++) {
        let F;
        if (i < 16) F = (B & C) | (~B & D);
        else if (i < 32) F = (D & B) | (~D & C);
        else if (i < 48) F = B ^ C ^ D;
        else F = C ^ (B | ~D);
        F = (F + A + MD5_K[i] + M[MD5_G[i]]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_R[i]) | (F >>> (32 - MD5_R[i])))) | 0;
      }
      h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0;
    }
    update(b) {
      this.len += b.length;
      let off = 0;
      if (this.tail.length) {
        const need = 64 - this.tail.length;
        const t = new Uint8Array(64);
        t.set(this.tail);
        t.set(b.subarray(0, need), this.tail.length);
        if (b.length < need) { this.tail = t.subarray(0, this.tail.length + b.length).slice(); return this; }
        this.block(t, 0);
        off = need;
      }
      for (; off + 64 <= b.length; off += 64) this.block(b, off);
      this.tail = b.slice(off);
      return this;
    }
    hex() {
      const n = this.len, r = this.tail.length;
      const pad = new Uint8Array(r < 56 ? 64 : 128);
      pad.set(this.tail);
      pad[r] = 0x80;
      const bits = n * 8, lo = bits % 2 ** 32, hi = Math.floor(bits / 2 ** 32);
      const p = pad.length - 8;
      for (let i = 0; i < 4; i++) { pad[p + i] = (lo >>> (8 * i)) & 255; pad[p + 4 + i] = (hi >>> (8 * i)) & 255; }
      for (let o = 0; o < pad.length; o += 64) this.block(pad, o);
      let s = '';
      for (const w of this.h) for (let i = 0; i < 4; i++) s += ((w >>> (8 * i)) & 255).toString(16).padStart(2, '0');
      return s;
    }
  }
  const md5 = bytes => new MD5().update(bytes).hex();

  const toHex = buf => Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2, '0')).join('');

  /** Compute MD5, SHA-1 and SHA-256. onProgress(fraction) is called while MD5 runs in slices. */
  async function computeHashes(bytes, onProgress) {
    if (!(G.crypto && G.crypto.subtle)) throw new Error('WebCrypto is unavailable (the page must be served over https or localhost)');
    const shaP = Promise.all([G.crypto.subtle.digest('SHA-1', bytes), G.crypto.subtle.digest('SHA-256', bytes)]);
    const m = new MD5();
    const SLICE = 8 << 20;
    for (let o = 0; o < bytes.length; o += SLICE) {
      m.update(bytes.subarray(o, Math.min(bytes.length, o + SLICE)));
      if (bytes.length > SLICE) { if (onProgress) onProgress(o / bytes.length); await new Promise(r => setTimeout(r, 0)); }
    }
    const [s1, s256] = await shaP;
    return { md5: m.hex(), sha1: toHex(s1), sha256: toHex(s256) };
  }

  /* ---------- external lookups ---------- */
  const LINKS = [
    { id: 'vt', name: 'VirusTotal', url: h => `https://www.virustotal.com/gui/file/${h.sha256}` },
    { id: 'mb', name: 'MalwareBazaar', url: h => `https://bazaar.abuse.ch/sample/${h.sha256}/` },
    { id: 'circl', name: 'CIRCL hashlookup', url: h => `https://hashlookup.circl.lu/lookup/sha256/${h.sha256}`, desc: 'known-good software (NIST NSRL etc.)' },
  ];

  /** Query VirusTotal through the user's CORS proxy. Returns {status, data?, error?}. */
  async function lookupVT(sha256, cfg) {
    if (!cfg || !cfg.proxy) return { status: 'unconfigured' };
    const base = cfg.proxy.trim().replace(/\/+$/, '');
    let r;
    try {
      r = await fetch(`${base}/files/${sha256}`, { headers: cfg.key ? { 'x-apikey': cfg.key } : {}, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      return { status: 'network', error: `Could not reach the proxy (${e.message}). Check the URL, and that this site's origin is in the proxy's allowed list.` };
    }
    let body = null;
    try { body = await r.json(); } catch (e) { /* not json */ }
    if (r.status === 200 && body && body.data) return { status: 'found', data: body.data };
    if (r.status === 404) return { status: 'notfound' };
    const msg = body && body.error ? `${body.error.code || ''} ${body.error.message || ''}`.trim() : `HTTP ${r.status}`;
    if (r.status === 401) return { status: 'auth', error: `VirusTotal rejected the API key (${msg}).` };
    if (r.status === 429) return { status: 'quota', error: 'Rate limited. The free VirusTotal API allows 4 lookups per minute and 500 per day.' };
    if (r.status === 403) return { status: 'forbidden', error: `Forbidden (${msg}). If this came from the proxy, add this site's origin to ALLOWED_ORIGINS.` };
    return { status: 'error', error: msg };
  }

  /** Render a VirusTotal file object as HTML. esc() must HTML-escape (all VT strings are untrusted). */
  function renderVT(res, esc, sha256) {
    const link = `<a href="https://www.virustotal.com/gui/file/${esc(sha256)}" target="_blank" rel="noopener noreferrer">full report ↗</a>`;
    if (res.status === 'notfound') return `<div class="vt-card"><div class="vt-verdict none">Not in VirusTotal</div><p class="fine">VirusTotal has never seen a file with this hash. Nothing was uploaded; FOB never uploads files.</p></div>`;
    if (res.status !== 'found') return `<div class="ins-issue warn">${esc(res.error || res.status)}</div>`;
    const a = res.data.attributes || {};
    const st = a.last_analysis_stats || {};
    const mal = st.malicious || 0, sus = st.suspicious || 0;
    const total = mal + sus + (st.undetected || 0) + (st.harmless || 0);
    const cls = mal > 0 ? 'bad' : sus > 0 ? 'sus' : 'clean';
    const date = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : '—';
    const label = a.popular_threat_classification && a.popular_threat_classification.suggested_threat_label;
    const hits = Object.entries(a.last_analysis_results || {})
      .filter(([, v]) => v && (v.category === 'malicious' || v.category === 'suspicious'))
      .slice(0, 12);
    const sig = a.signature_info || {};
    const rows = [
      ['name', a.meaningful_name || (a.names || [])[0]],
      ['type', a.type_description],
      ['first seen', date(a.first_submission_date)],
      ['last analysed', date(a.last_analysis_date)],
      ['submissions', a.times_submitted],
      ['reputation', a.reputation],
      ['signed by', sig.signers],
      ['signature', sig.verified],
      ['product', sig.product],
      ['tags', (a.tags || []).slice(0, 12).join(', ')],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    const names = (a.names || []).slice(0, 8);
    return `<div class="vt-card">
      <div class="vt-verdict ${cls}">${mal ? `${mal} / ${total} engines flag this file` : sus ? `${sus} / ${total} engines: suspicious` : `0 / ${total} detections`}</div>
      ${label ? `<div class="vt-label">${esc(label)}</div>` : ''}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${hits.length ? `<table class="bits">${hits.map(([eng, v]) => `<tr><td>${esc(eng)}</td><td class="bad-t">${esc(v.result || v.category)}</td></tr>`).join('')}</table>` : ''}
      ${names.length > 1 ? `<p class="fine">Also seen as: ${names.map(esc).join(', ')}</p>` : ''}
      <p class="fine">${link}</p>
    </div>`;
  }

  G.FOBEnrich = { md5, MD5, computeHashes, lookupVT, renderVT, LINKS };
})(typeof window !== 'undefined' ? window : globalThis);
