# File Object Browser (FOB)

A static, single-page web app for looking inside binary files. Open any file and
you get:

- **Hex view.** xxd-style offset, hex and ASCII columns, with every byte tinted
  by the grammar section it belongs to and a **Sections** overlay column that
  labels what starts on each row.
- **Annotated view.** The same bytes split into collapsible, labelled section
  headers (chunks, boxes, records, segments). The **Depth** setting controls how
  many levels are broken out.
- **Text view.** The whole file decoded as UTF-8.
- **Structure tree, inspector and issues list.** You get field values, enums,
  bit fields, docs from the grammar, CRC verification, and every problem found
  (bad magic, checksum mismatches, truncation, impossible lengths, undescribed
  or trailing bytes).
- **Data interpreter.** It shows the bytes at the cursor as u8…u64, i8…i64,
  f32/f64, binary and Unix time, in both byte orders.
- **Minimap.** A file-wide colour map with errors marked; click it to jump.
- **Tools:**
  - **Repair / reconstruct** for **PNG** fixes the signature, chunk lengths
    (by resynchronising on chunk types), and CRCs. It recovers the image rows
    that survived truncation, fills in the rest, recompresses, and appends IEND.
  - **Repair / reconstruct** for **ZIP** rescans local headers, recovers
    streamed sizes, salvages truncated entries, checks CRCs, and writes a fresh
    central directory and EOCD.
  - **Preview contents:** image and audio/video preview, a ZIP entry browser
    with extraction (it works without a central directory), and GZIP
    decompression.
  - **Find embedded files:** a signature carver. Use "Open from here" to parse
    a file hidden inside another file.
  - **Open selection as a new file:** drill into nested data such as a JPEG
    inside an MP3 tag or a file inside a ZIP. The breadcrumb bar lets you go
    back.

- **Hashes and lookups.** MD5, SHA-1, SHA-256 and CRC-32 are computed in the
  browser, with one-click links to VirusTotal, MalwareBazaar and CIRCL
  hashlookup. You can also get an in-page **VirusTotal report** (detections,
  threat label, names, first seen, signer) through an optional proxy, described
  below.

Files are read locally with the File API and never uploaded. Lookups send only
the SHA-256, and only when you click (or when you turn on auto-lookup).

## VirusTotal enrichment (optional)

VirusTotal's API sends no CORS headers, so a GitHub Pages site can't read its
responses directly. `tools/vt-proxy-worker.js` is a small Cloudflare Worker
(free plan). It forwards only `GET /files/<md5|sha1|sha256>` to VirusTotal and
adds CORS headers for the origins you list, so it can't be used as an open proxy.

1. Create a Worker in the Cloudflare dashboard, paste the file in, and deploy.
2. Set the variable `ALLOWED_ORIGINS` to `https://<you>.github.io,http://localhost:8000`.
3. In FOB, open **Tools ▸ Hash lookup settings**. Enter the worker URL and your
   VirusTotal API key (a free account allows 4 lookups/min and 500/day), then
   click **Save & test**.

The key stays in your browser's localStorage and is sent only to your proxy.
You can instead set `VT_API_KEY` as a Worker secret, but then anyone who can
load your page can use your quota. Without a proxy, the "VirusTotal ↗" link
still works.

## Built-in grammars

PNG · JPEG · GIF · BMP · ZIP (also DOCX/XLSX/JAR/APK/EPUB) · GZIP ·
MP4/MOV/M4A/HEIC (ISO-BMFF) · MKV/WebM (EBML) · MP3 (ID3v2 + MPEG frames + ID3v1) ·
RIFF (WAV/AVI/WebP) · PE (EXE/DLL) · ELF · Mach-O (thin and universal)

Grammars are plain JSON in [`grammars/`](grammars/). See [GRAMMAR.md](GRAMMAR.md)
for the format. You can also write, edit and load grammars in the app
(**Grammar ▸ Edit / New / Load**). Custom grammars are kept in local storage.

## Running

There is no build step. Because the app `fetch()`es the grammar JSON, serve the
folder instead of opening `index.html` directly:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

### GitHub Pages

Push this folder to a repository, then go to **Settings ▸ Pages ▸ Deploy from
branch** and pick the branch and `/ (root)`. The `.nojekyll` file makes Pages
serve everything as-is.

## Layout

```
index.html         page shell
css/style.css      styles (dark + light)
js/expr.js         sandboxed expression language used by grammars
js/engine.js       grammar interpreter → node tree + issues
js/repair.js       PNG/ZIP reconstruction, ZIP extraction, gunzip, signature carving
js/enrich.js       MD5/SHA hashing and VirusTotal lookup client
tools/vt-proxy-worker.js  optional Cloudflare Worker CORS proxy for VirusTotal
js/app.js          UI: virtualised hex view, tree, inspector, tools
grammars/*.json    format grammars (+ index.json listing them)
samples/           small valid and deliberately broken files for the Samples menu
```

## Keyboard

| key | action |
|---|---|
| Ctrl/⌘ O | open file |
| Ctrl/⌘ F, Enter / Shift+Enter | find (text or hex like `FF D8 ?? E0`) next / previous |
| Ctrl/⌘ G | go to offset (`0x1F`, `1234`, `+16`, `-0x10`) |
| arrows, PgUp/PgDn, Home/End | move cursor (Shift extends the selection) |
| Enter | select the field under the cursor |
| 1 / 2 / 3 | Hex / Annotated / Text view |
| Esc | clear selection |

The engine has no DOM dependencies (`js/expr.js` + `js/engine.js`), so it also
runs under Node for testing grammars.
