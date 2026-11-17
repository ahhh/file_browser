/*
 * Format-specific reconstruction tools. These do not use the grammar tree for
 * the heavy lifting — a broken file is exactly the case where the tree can't be
 * trusted — so each repairer rescans the raw bytes with format knowledge.
 *
 * Every repairer returns { bytes: Uint8Array, log: [{level, msg}] }.
 */
(function (G) {
  'use strict';
  const F = G.FOB;
  const { crc32, hex } = F;

  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  class Out {
    constructor(cap) { this.b = new Uint8Array(Math.max(64, cap)); this.n = 0; }
    ensure(k) { if (this.n + k > this.b.length) { const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k)); nb.set(this.b.subarray(0, this.n)); this.b = nb; } }
    bytes(a) { this.ensure(a.length); this.b.set(a, this.n); this.n += a.length; }
    u8(v) { this.ensure(1); this.b[this.n++] = v & 255; }
    u16le(v) { this.u8(v); this.u8(v >>> 8); }
    u32le(v) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); }
    u32be(v) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
    done() { return this.b.slice(0, this.n); }
  }

  /* ======================= PNG ======================= */
  const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const PNG_KNOWN = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi',
    'tEXt', 'zTXt', 'iTXt', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'tIME', 'acTL', 'fcTL', 'fdAT', 'eXIf', 'oFFs', 'pCAL', 'sCAL', 'CgBI'];
  const isLetter = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const typeAt = (b, o) => o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : '';
  const validType = (b, o) => o + 4 <= b.length && isLetter(b[o]) && isLetter(b[o + 1]) && isLetter(b[o + 2]) && isLetter(b[o + 3]);

  /** Search forward for the next plausible chunk header (a known type code). Returns the chunk start (type offset - 4). */
  function pngResync(b, from) {
    for (let i = Math.max(from, 4); i + 4 <= b.length; i++) {
      if (!isLetter(b[i])) continue;
      const t = typeAt(b, i);
      if (PNG_KNOWN.includes(t)) return i - 4;
    }
    return -1;
  }

  async function repairPNG(b) {
    const log = [];
    const chunks = [];
    let idatDamaged = false;

    // 1. Signature. Find where the chunk stream actually starts.
    let pos = 8;
    const sigOk = PNG_SIG.every((x, i) => b[i] === x);
    if (!sigOk) {
      const ih = findAscii(b, 'IHDR', 0, Math.min(b.length, 64));
      pos = ih >= 4 ? ih - 4 : 8;
      if (b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0A && b[5] === 0x1A) {
        log.push({ level: 'warn', msg: 'Signature has LF where CR LF was expected — the file was probably sent through a text-mode (ASCII) transfer, which also corrupts every CR LF inside the image data. CRCs below will show where.' });
      }
      log.push({ level: 'fix', msg: `Rewrote the PNG signature (chunk stream starts at ${hex(pos)}).` });
    }

    // 2. Walk chunks, resynchronising when a length is clearly wrong.
    let sawIHDR = false, sawIEND = false, count = 0, idat = 0;
    while (pos + 8 <= b.length) {
      let len = u32be(b, pos);
      const tOff = pos + 4;
      if (!validType(b, tOff)) {
        const next = pngResync(b, pos + 1);
        if (next < 0) { log.push({ level: 'warn', msg: `Unrecognisable bytes at ${hex(pos)}…${hex(b.length)} dropped.` }); break; }
        log.push({ level: 'fix', msg: `Skipped ${next - pos} garbage bytes at ${hex(pos)} (resynchronised on ${typeAt(b, next + 4)}).` });
        pos = next;
        continue;
      }
      const type = typeAt(b, tOff);
      const dataStart = pos + 8;
      let dataEnd = dataStart + len;
      const declaredOk = len <= 0x7FFFFFFF && dataEnd + 4 <= b.length && (dataEnd + 4 === b.length || validType(b, dataEnd + 8) || type === 'IEND');
      let truncated = false;
      if (!declaredOk) {
        // Length is wrong or the file is cut short. Find where the next chunk really begins.
        const next = pngResync(b, dataStart);
        if (next >= 0 && next - 4 >= dataStart) {
          dataEnd = next - 4;
          log.push({ level: 'fix', msg: `${type} at ${hex(pos)}: length said ${len.toLocaleString()}, next chunk found after ${(dataEnd - dataStart).toLocaleString()} bytes — length corrected.` });
        } else {
          dataEnd = b.length;
          truncated = true;
          log.push({ level: 'fix', msg: `${type} at ${hex(pos)} is truncated: ${(dataEnd - dataStart).toLocaleString()} of ${len.toLocaleString()} bytes present. Kept what remains${type === 'IDAT' ? ' (the image will decode partially)' : ''}.` });
        }
        len = dataEnd - dataStart;
      }
      if (type === 'IHDR') sawIHDR = true;
      if (type === 'IDAT') idat++;
      const stored = truncated ? null : u32be(b, dataEnd);
      const crc = crc32(b, tOff, dataEnd);
      if (stored !== null && stored !== crc) log.push({ level: 'fix', msg: `${type} at ${hex(pos)}: CRC ${hex(stored, 8)} → ${hex(crc, 8)}.` });
      chunks.push({ type, data: b.subarray(dataStart, dataEnd) });
      if (type === 'IDAT' && (truncated || !declaredOk)) idatDamaged = true;
      count++;
      pos = truncated ? b.length : dataEnd + 4;
      if (type === 'IEND') { sawIEND = true; break; }
      if (truncated) break;
    }
    if (!sawIHDR) log.push({ level: 'error', msg: 'No IHDR chunk found — image dimensions are unknown; viewers will refuse this file.' });
    if (!idat) log.push({ level: 'error', msg: 'No IDAT (image data) chunks found.' });
    if (sawIEND && pos < b.length) log.push({ level: 'fix', msg: `Dropped ${(b.length - pos).toLocaleString()} bytes of trailing data after IEND.` });
    if (!sawIEND) {
      chunks.push({ type: 'IEND', data: new Uint8Array(0) });
      log.push({ level: 'fix', msg: 'Appended missing IEND chunk.' });
    }

    // 3. Make the image data decodable: inflate what survives, pad missing scanlines, recompress.
    const ihdr = chunks.find(c => c.type === 'IHDR');
    if (ihdr && ihdr.data.length >= 13 && idat && typeof CompressionStream !== 'undefined') {
      const d = ihdr.data;
      const width = u32be(d, 0), height = u32be(d, 4), depth = d[8], ctype = d[9], interlace = d[12];
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
      const all = concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data), chunks.reduce((n, c) => n + (c.type === 'IDAT' ? c.data.length : 0), 0));
      let raw, inflateError = null;
      try { raw = await inflate(all, 'deflate'); } catch (e) { raw = e.partial || new Uint8Array(0); inflateError = e; }
      if (channels && !interlace && width && height && width * height < 1e8) {
        const stride = Math.ceil(width * channels * depth / 8) + 1;
        const expected = stride * height;
        if (raw.length < expected || inflateError || idatDamaged) {
          const rowsOk = Math.floor(raw.length / stride);
          const fixed = new Uint8Array(expected);
          fixed.set(raw.subarray(0, Math.min(raw.length, expected)));
          // A partial last row may hold a bad filter byte; start padding from a clean row boundary.
          fixed.fill(0, rowsOk * stride);
          const z = await deflate(fixed);
          const kept = chunks.filter(c => c.type !== 'IDAT');
          const at = chunks.findIndex(c => c.type === 'IDAT');
          kept.splice(chunks.slice(0, at).filter(c => c.type !== 'IDAT').length, 0, { type: 'IDAT', data: z });
          chunks.length = 0; chunks.push(...kept);
          log.push({ level: 'fix', msg: `Image data ${idatDamaged ? 'is incomplete' : 'is corrupt'}: recovered ${rowsOk} of ${height} scanlines (${Math.round(rowsOk / height * 100)}%), filled the rest with zeros and recompressed into one valid IDAT.` });
        }
      } else if (inflateError) log.push({ level: 'warn', msg: 'Image data does not decompress cleanly; interlaced images cannot be padded automatically.' });
    }

    const out = new Out(b.length + 256);
    out.bytes(PNG_SIG);
    const tb = new Uint8Array(4);
    for (const c of chunks) {
      for (let k = 0; k < 4; k++) tb[k] = c.type.charCodeAt(k);
      out.u32be(c.data.length); out.bytes(tb); out.bytes(c.data);
      out.u32be(crc32(c.data, 0, c.data.length, crc32(tb)));
    }
    log.unshift({ level: 'info', msg: `Rebuilt ${count} chunk${count === 1 ? '' : 's'} (${idat} IDAT).` });
    return { bytes: out.done(), log };
  }

  /* ======================= ZIP ======================= */
  const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_DESC = 0x08074b50, SIG_EOCD = 0x06054b50;
  const KNOWN_METHODS = new Set([0, 1, 6, 8, 9, 12, 14, 93, 95, 98, 99]);

  function nextSignature(b, from) {
    for (let i = from; i + 4 <= b.length; i++) {
      if (b[i] !== 0x50 || b[i + 1] !== 0x4B) continue;
      const s = u32le(b, i);
      if (s === SIG_LOCAL || s === SIG_CENTRAL || s === SIG_DESC || s === SIG_EOCD) return i;
    }
    return -1;
  }

  /** Scan raw bytes for local file headers. Works without a central directory. */
  function scanZipEntries(b) {
    const entries = [];
    const log = [];
    let i = 0;
    while (i + 30 <= b.length) {
      if (!(b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 3 && b[i + 3] === 4)) { i++; continue; }
      const h = {
        offset: i, version: u16le(b, i + 4), flags: u16le(b, i + 6), method: u16le(b, i + 8),
        time: u16le(b, i + 10), date: u16le(b, i + 12), crc: u32le(b, i + 14),
        csize: u32le(b, i + 18), usize: u32le(b, i + 22), nlen: u16le(b, i + 26), xlen: u16le(b, i + 28),
      };
      const nameStart = i + 30;
      if (!KNOWN_METHODS.has(h.method) || h.nlen === 0 || h.nlen > 4096 || nameStart + h.nlen + h.xlen > b.length) { i++; continue; }
      h.nameBytes = b.subarray(nameStart, nameStart + h.nlen);
      h.name = new TextDecoder().decode(h.nameBytes);
      h.extra = b.subarray(nameStart + h.nlen, nameStart + h.nlen + h.xlen);
      h.dataStart = nameStart + h.nlen + h.xlen;

      const sizeKnown = !(h.flags & 8) || h.csize !== 0;
      let end = h.dataStart + h.csize;
      const plausible = sizeKnown && h.csize !== 0xFFFFFFFF && end <= b.length &&
        (end === b.length || nextSignature(b, end) === end || (h.flags & 8));
      if (!plausible) {
        // Size missing (streamed) or wrong: the data runs to the next signature.
        const n = nextSignature(b, h.dataStart);
        if (n < 0) {
          h.truncated = true;
          end = b.length;
        } else end = n;
        h.sizeRecovered = true;
      }
      h.csize = end - h.dataStart;
      h.dataEnd = end;
      // Data descriptor following the data supplies the CRC/sizes for streamed entries.
      if (end + 16 <= b.length && u32le(b, end) === SIG_DESC) {
        h.descriptor = { crc: u32le(b, end + 4), csize: u32le(b, end + 8), usize: u32le(b, end + 12) };
        if (h.crc === 0) h.crc = h.descriptor.crc;
        if (h.usize === 0) h.usize = h.descriptor.usize;
        end += 16;
      } else if ((h.flags & 8) && end + 12 <= b.length && u32le(b, end + 4) === h.csize) {
        h.descriptor = { crc: u32le(b, end), csize: u32le(b, end + 4), usize: u32le(b, end + 8) };
        if (h.crc === 0) h.crc = h.descriptor.crc;
        if (h.usize === 0) h.usize = h.descriptor.usize;
        h.dataEnd = end; end += 12;
      }
      h.recordEnd = end;
      entries.push(h);
      i = Math.max(end, i + 1);
    }
    return { entries, log };
  }

  async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const inflateRaw = data => inflate(data, 'deflate-raw');
  async function inflate(data, format) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser has no DecompressionStream');
    const ds = new DecompressionStream(format);
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const chunks = [];
    let total = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
      }
    } catch (e) {
      const partial = concat(chunks, total);
      e.partial = partial;
      throw e;
    }
    return concat(chunks, total);
  }
  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** Decompress one entry. Returns { data, crcOk, error }. */
  async function extractZipEntry(b, e) {
    const raw = b.subarray(e.dataStart, e.dataEnd);
    let data, error = null;
    if (e.flags & 1) return { data: null, error: 'Entry is encrypted' };
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      try { data = await inflateRaw(raw); }
      catch (err) { data = err.partial || null; error = `Inflate failed: ${err.message}${data ? ` (${data.length.toLocaleString()} bytes recovered)` : ''}`; }
    } else return { data: null, error: `Compression method ${e.method} is not supported in the browser` };
    const crc = data ? crc32(data) : null;
    return { data, crc, crcOk: crc === e.crc, error };
  }

  async function repairZIP(b) {
    const log = [];
    const { entries } = scanZipEntries(b);
    if (!entries.length) return { bytes: b, log: [{ level: 'error', msg: 'No local file headers (PK\\x03\\x04) found — nothing to rebuild.' }] };
    const firstOffset = entries[0].offset;
    if (firstOffset > 0) log.push({ level: 'fix', msg: `Dropped ${firstOffset.toLocaleString()} bytes before the first entry (self-extractor stub or garbage).` });

    const out = new Out(b.length + 1024);
    const central = [];
    let kept = 0;
    for (const e of entries) {
      let { crc, usize } = e;
      const csize = e.csize;
      let method = e.method;
      let data = b.subarray(e.dataStart, e.dataEnd);
      if (e.truncated) {
        // Try to salvage a truncated deflate stream by inflating what's there and storing it uncompressed.
        if (e.method === 8) {
          const r = await extractZipEntry(b, e);
          if (r.data && r.data.length) {
            data = r.data; method = 0; crc = crc32(data); usize = data.length;
            log.push({ level: 'fix', msg: `"${e.name}" is truncated; salvaged ${usize.toLocaleString()} decompressed bytes and stored them uncompressed.` });
          } else { log.push({ level: 'error', msg: `"${e.name}" is truncated and nothing could be decompressed — skipped.` }); continue; }
        } else if (e.method === 0) {
          crc = crc32(data); usize = data.length;
          log.push({ level: 'fix', msg: `"${e.name}" is truncated; kept ${usize.toLocaleString()} stored bytes.` });
        } else { log.push({ level: 'error', msg: `"${e.name}" is truncated — skipped.` }); continue; }
      } else {
        if (e.sizeRecovered) log.push({ level: 'fix', msg: `"${e.name}": compressed size recovered from layout (${csize.toLocaleString()} B).` });
        // Verify / recover CRC and uncompressed size by actually decompressing.
        const r = await extractZipEntry(b, e);
        if (r.data) {
          if (!r.crcOk) {
            if (r.error) log.push({ level: 'warn', msg: `"${e.name}": ${r.error}. Data may be corrupt.` });
            else if (e.crc === 0 || e.sizeRecovered) log.push({ level: 'fix', msg: `"${e.name}": CRC recomputed (${hex(r.crc, 8)}).` });
            else log.push({ level: 'warn', msg: `"${e.name}": stored CRC ${hex(e.crc, 8)} ≠ actual ${hex(r.crc, 8)} — contents are corrupt; header updated to match so extractors will not refuse it.` });
            crc = r.crc;
          }
          if (!r.error && usize !== r.data.length) { log.push({ level: 'fix', msg: `"${e.name}": uncompressed size ${usize} → ${r.data.length}.` }); usize = r.data.length; }
        } else if (r.error) log.push({ level: 'warn', msg: `"${e.name}": ${r.error}; copied as-is.` });
      }
      const flags = e.flags & ~8; // sizes are now in the header; no data descriptor
      const offset = out.n;
      out.u32le(SIG_LOCAL); out.u16le(e.version || 20); out.u16le(flags); out.u16le(method);
      out.u16le(e.time); out.u16le(e.date); out.u32le(crc); out.u32le(data.length); out.u32le(usize);
      out.u16le(e.nameBytes.length); out.u16le(e.extra.length);
      out.bytes(e.nameBytes); out.bytes(e.extra); out.bytes(data);
      central.push({ e, flags, method, crc, csize: data.length, usize, offset });
      kept++;
    }
    const cdStart = out.n;
    for (const c of central) {
      const e = c.e;
      out.u32le(SIG_CENTRAL); out.u16le(0x031E); out.u16le(e.version || 20); out.u16le(c.flags); out.u16le(c.method);
      out.u16le(e.time); out.u16le(e.date); out.u32le(c.crc); out.u32le(c.csize); out.u32le(c.usize);
      out.u16le(e.nameBytes.length); out.u16le(0); out.u16le(0); out.u16le(0); out.u16le(0);
      out.u32le(e.name.endsWith('/') ? 0x41ED0010 : 0x81A40000); out.u32le(c.offset);
      out.bytes(e.nameBytes);
    }
    const cdSize = out.n - cdStart;
    out.u32le(SIG_EOCD); out.u16le(0); out.u16le(0); out.u16le(central.length); out.u16le(central.length);
    out.u32le(cdSize); out.u32le(cdStart); out.u16le(0);
    log.unshift({ level: 'info', msg: `Recovered ${kept} of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; wrote a fresh central directory and end record.` });
    return { bytes: out.done(), log };
  }

  /* ======================= GZIP ======================= */
  async function gunzip(b) {
    let p = 10;
    const flg = b[3];
    if (flg & 4) p += 2 + u16le(b, 10);
    if (flg & 8) { while (p < b.length && b[p]) p++; p++; }
    if (flg & 16) { while (p < b.length && b[p]) p++; p++; }
    if (flg & 2) p += 2;
    const end = Math.max(p, b.length - 8);
    try {
      const data = await inflateRaw(b.subarray(p, end));
      return { data, crcOk: crc32(data) === u32le(b, b.length - 4 - 4) };
    } catch (e) {
      return { data: e.partial || null, error: e.message };
    }
  }

  /* ======================= signature carving ======================= */
  /** Find embedded files by magic number. Returns [{offset, grammar}]. */
  function carve(b, grammars, max = 2000) {
    const hits = [];
    const sigs = [];
    for (const g of grammars) {
      for (const alt of g.magic || []) {
        const m = Array.isArray(alt) ? alt[0] : alt;
        if ((m.offset || 0) !== 0) continue;
        const bytes = m.hex !== undefined ? F.hexToBytes(m.hex) : new TextEncoder().encode(m.ascii || '');
        if (bytes.length >= 2) sigs.push({ g, bytes });
      }
    }
    const byFirst = new Map();
    for (const s of sigs) { const k = s.bytes[0]; if (!byFirst.has(k)) byFirst.set(k, []); byFirst.get(k).push(s); }
    for (let i = 0; i < b.length && hits.length < max; i++) {
      const list = byFirst.get(b[i]);
      if (!list) continue;
      for (const s of list) {
        let ok = true;
        for (let k = 1; k < s.bytes.length; k++) if (b[i + k] !== s.bytes[k]) { ok = false; break; }
        if (ok) { hits.push({ offset: i, grammar: s.g }); break; }
      }
    }
    return hits;
  }

  function findAscii(b, s, from, to) {
    outer: for (let i = from; i + s.length <= to; i++) {
      for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer;
      return i;
    }
    return -1;
  }

  const REPAIRERS = {
    png: { label: 'Rebuild PNG (signature, lengths, CRCs, image data, IEND)', run: repairPNG },
    zip: { label: 'Rebuild ZIP (rescan entries, new central directory)', run: repairZIP },
  };

  G.FOBRepair = { REPAIRERS, repairPNG, repairZIP, scanZipEntries, extractZipEntry, inflate, inflateRaw, deflate, gunzip, carve };
})(typeof window !== 'undefined' ? window : globalThis);
