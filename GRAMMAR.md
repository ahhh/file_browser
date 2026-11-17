# FOB grammar format

A grammar is a JSON document that describes how to cut a file into named, typed
fields. FOB reads fields in order, nests structs, evaluates expressions for
lengths/conditions, and records **issues** (bad magic, failed checks, CRC
mismatches, truncation, undescribed bytes) instead of stopping. The built-in
grammars in [`grammars/`](grammars/) are complete worked examples. Start with
`png.json` (simple), then `zip.json` (switches, bitsets), then `mp4.json`
(recursive boxes).

To add a grammar to the site, drop the JSON into `grammars/` and add its file
name to `grammars/index.json`. To try one without deploying, use
**Grammar ▸ Load grammar file** or **Grammar ▸ New grammar** in the app. Custom
grammars are saved in your browser's local storage.

## Top level

```jsonc
{
  "id": "png",                       // unique id (defaults to a slug of name)
  "name": "PNG image",
  "doc": "Shown in the inspector when no field is selected.",
  "extensions": ["png"],             // used for detection when magic doesn't match
  "mime": "image/png",               // used for previews and downloads
  "magic": [                         // alternatives; any one may match
    { "offset": 0, "hex": "89 50 4E 47 0D 0A 1A 0A" },
    { "offset": 4, "ascii": "ftyp" },
    [ { "offset": 0, "ascii": "RIFF" }, { "offset": 8, "ascii": "WAVE" } ]   // all must match
  ],
  "endian": "big",                   // default byte order: "little" (default) | "big"
  "bitOrder": "msb",                 // order of "bits" sub-fields: "msb" (default) | "lsb"
  "root": [ /* fields */ ],          // or the name of a struct
  "structs": { "name": { "fields": [ ], "label": "", "colorBy": "", "size": "", "endian": "", "doc": "" } },
  "enums": { "name": { "0": "zero", "0x21": "hex keys work", "IHDR": "string keys work" } },
  "bitsets": { "name": [ { "name": "flag", "bits": 1 } ] },
  "constants": { "table": [0, 32, 64], "map": { "3": [44100, 48000] } },
  "repair": "png",                   // optional repair tool: "png" | "zip"
  "preview": "image"                 // optional preview: "image" | "media" | "zip" | "gzip"
}
```

Detection scores every grammar. A full magic match wins. A mostly matching
magic (50% or more of the bytes) or a matching extension still selects the
grammar, so files with damaged signatures open with the right grammar.

## Fields

Every field has a `name` and a `type`. Names become variables that later
expressions can use.

| type | meaning |
|---|---|
| `u8 u16 u24 u32 u64`, `i8 … i64`, `f32 f64` | fixed-size numbers; add `le`/`be` to force byte order (`u32be`) |
| `uint` `sint` `float` | numbers whose byte length is given by `length` |
| `vint` `ebmlid` | EBML variable-length integer (size, with all-ones = -1 "unknown") and element ID |
| `bytes` | raw bytes, sized by `length`, by `terminator`, or to the end of the enclosing struct |
| `string` / `cstring` | text sized by `length`, or terminated (cstring = NUL); `encoding`: `ascii` (default), `utf-8`, `utf-16`, `utf-16be` |
| *struct name* | a struct from `structs` |
| `struct` | inline struct: `{ "type": "struct", "fields": [ … ] }` |
| `switch` | choose a type at parse time (see below) |
| `calc` | computed value that takes no bytes: `{ "name": "seconds", "type": "calc", "value": "duration / timescale" }` |

### Field options

| option | meaning |
|---|---|
| `doc` | description shown in the inspector |
| `length` / `size` | expression. On structs, `size` **bounds** the struct: fields that overrun it are errors, and leftover bytes become an `(unparsed)` node |
| `if` | expression. The field is skipped when it is false |
| `count` | repeat N times |
| `repeat: "eof"` | repeat until the end of the enclosing struct (or file) |
| `until` | repeat until the expression is true; `_last` / `_` is the item just read |
| `while` | checked before each item |
| `offset` | read this field at an absolute offset (expression), then continue from where parsing was. Good for pointer tables (ELF, PE, BMP pixel data) |
| `endian` | `"little"`, `"big"`, or an expression that returns one (`"ident.data == 2 ? 'big' : 'little'"`) |
| `expect` | required value: number, string, hex string for `bytes`, or an array of alternatives. Mismatch is an error (`expectLevel` changes the level, `expectMsg` adds context) |
| `valid` | expression with `_` = the value. If false, a warning (`validLevel`, `validMsg` template) |
| `checksum` | `{ "algo": "crc32", "from": "type", "to": "data" }` computes over sibling fields `from`…`to`; or `{ "algo": "crc32", "start": expr, "end": expr }`. Algorithms: `crc32`, `adler32`, `sum8` |
| `enum` | name the value via `enums`; `enumStrict: true` warns on unknown values |
| `bits` | split an integer into bit fields: `[{ "name": "flag", "bits": 1, "enum": "…", "hidden": true }]`, or `"@bitsetName"`. Access them as `flags.flag` |
| `bitOrder` | `msb` / `lsb` for this field |
| `format` | display: `hex`, `bin`, `dec`, `char`, `bool`, `unixtime`, `dostime`, `dosdate`, `fourcc`, `ascii` (for bytes) |
| `unit`, `scale` | display helpers (`"scale": 0.00001` shows the scaled value next to the raw one) |
| `terminator` | byte pattern ending a `bytes`/`string`. The terminator is not consumed for `bytes` unless `consume: true`; for `cstring` it is |
| `label` | struct title template, e.g. `"${type} · ${length} B"`. Evaluated after the whole file is parsed, so it can refer forward |
| `colorBy` | expression whose value picks the section colour (e.g. chunk type) |
| `warn` / `error` | template message raised whenever this field is parsed. Useful on `default` cases |
| `allowSlack` | on a sized struct: don't report leftover bytes |

### Switch

```json
{ "name": "data", "type": "switch", "on": "type", "size": "length",
  "cases": { "IHDR": "ihdr", "0x21": { "type": "bytes", "length": 4 } },
  "default": "bytes" }
```

Case keys are compared as numbers when they look like numbers (`"0x21"`,
`"33"`), otherwise as strings. A case value is a type name or an object that is
merged into the field. Options on the switch itself (`size`, `format`, `repeat`)
carry over to the chosen case. Combine `switch` with `repeat` and `peek()` to
parse tagged record streams:

```json
{ "name": "records", "type": "switch", "repeat": "eof", "on": "peek('u32')",
  "cases": { "0x04034b50": "localFile", "0x02014b50": "centralDir" },
  "default": { "type": "bytes", "terminator": "50 4B 01-08 02-08", "warn": "resync" } }
```

## Expressions

Expressions use JavaScript-like syntax, sandboxed: there is no `eval`, and only
own properties are accessible.

- Operators: `?: || && | ^ & == != < <= > >= << >> + - * / % ** ! ~ -`
- Access: `a.b`, `a[i]`, `.length`
- String methods: `startsWith endsWith includes slice toUpperCase toLowerCase trim charCodeAt padStart`
- Names resolve to fields already read in the current struct, then in enclosing structs, then `constants`.

| name | value |
|---|---|
| `_pos` | current offset |
| `_size` | file size |
| `_remaining` | bytes left in the enclosing (sized) struct, or file |
| `_index` | index of the current repeat item |
| `_`, `_last` | current value (in `valid`) / last item (in `until`/`while`) |
| `_root`, `_parent` | field values of the root / parent struct |
| `_start _end _length` | in `label` templates: the struct's own range |

| function | |
|---|---|
| `peek(type, rel=0)` | read a number at `_pos + rel` without consuming |
| `read(type, offset)` | read a number anywhere |
| `match(offset, pattern)` | does a byte pattern occur at offset? |
| `cstr(offset, max?)`, `ascii(offset, n)` | read strings anywhere |
| `syncsafe32(offset)` | ID3 7-bit-per-byte integer |
| `enumName(enum, value)` | look up an enum label |
| `min max abs floor ceil align(x, n) len has hex(x, width) str int chr` | helpers |

## Byte patterns

These are used by `terminator`, `match()` and the Find box. Tokens are separated by spaces:

| token | matches |
|---|---|
| `4B` | that byte |
| `??` | any byte |
| `01-08` | a range |
| `01,03,05-07` | a set |
| `!00,D0-D7` | anything except |
| `504B0304` | compact hex, split into bytes |

For example, JPEG entropy data ends at `FF !00,D0-D7`, which is a marker byte
that is not a stuffed zero or a restart marker.

## Tips for broken files

- Bound structs with `size` whenever the format has a length field. Damage then
  stays inside one chunk instead of desynchronising the rest of the parse.
- Use `valid` on type/tag fields (`match(_pos - 4, '41-5A,61-7A …')`) so that
  out-of-sync parsing is reported right where it starts.
- Give `switch` a `default` that resynchronises with a `terminator` that scans
  for the next known signature.
- Add `checksum` wherever the format has one. A CRC mismatch locates corruption
  precisely.
