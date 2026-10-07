# doclines

Turns a document into numbered lines of text with section markers: PDF, Word, RTF,
HTML, spreadsheets, presentations, OpenDocument, EPUB, FB2 and email.

## What it looks like

```js
import { extract } from 'doclines';

const r = await extract('text.xlsx');
r.lines[0];   // '[1] Parameter | Min | Max | Date | Note'
r.markers[0]; // { at: 0, text: '--- sheet 1: Данные ---' }
```

The same through the CLI, a workbook and a presentation (trimmed). `L1|` is
`r.lines[0]`; markers stand between the lines and have no number:

```text
$ npx doclines text.xlsx
--- sheet 1: Данные ---
L1| [1] Parameter | Min | Max | Date | Note
L2| [2] Temperature | -40 | 105 | 2026-11-27 | Мука, 2 м
L3| [3] Voltage | 3 | 3.6 | 2026-02-17 11:00:00 | TRUE
L4| [5] НМЦК | 3605044 | 7210088 | 11:00:00 | #N/A
L7| [8] Far | … | Far right
L8| [1000] Row one thousand | 36:00:00
--- sheet 2: Скрытый (hidden) ---
L9| [1] Hidden sheet text

$ npx doclines text.pptx
--- slide 1 ---
L1| Fixture: doclines slides
L2| Срок исполнения контракта — 27 ноября 2026 года
--- notes 1 ---
L4| Speaker notes for slide one
--- slide 2 ---
L5| Table slide
L6| Parameter | Min | Max
L7| Temperature | −40 | 105
--- slide 3 (hidden) ---
L9| Hidden slide text
```

In a sheet, `[R]` is the spreadsheet row number. Table rows are one line with cells
joined by ` | `.

## Requirements

| | |
|---|---|
| Runtime | Node.js 22.17 or later, or Node.js 24 |
| OS | Linux (glibc and musl), Windows, macOS |
| Disk | about 45 MB installed without optional dependencies, most of it `pdfjs-dist` with its CMaps and fonts |

## Installation

```sh
npm install doclines
```

In container images and on servers install without optional dependencies:

```sh
npm ci --omit=optional
```

`pdfjs-dist` lists `@napi-rs/canvas` (a native binary, about 37 MB) as an optional
dependency. doclines never loads it, text extraction does not need it, and on a CPU
without AVX a process that loads it crashes. `--omit=optional` keeps it off the disk.
npm may leave an empty `node_modules/@napi-rs` folder; it holds nothing and can be
removed.

## Usage

```js
import { extract, DoclinesError } from 'doclines';

try {
  const r = await extract('/data/contract.pdf', { maxTextBytes: 10 * 2 ** 20 });
  console.log(r.label, r.lines.length);
} catch (e) {
  if (!(e instanceof DoclinesError)) throw e; // an I/O error, a bad option
  console.log(e.code, e.message); // 'no_text_layer', 'no usable text layer (scanned PDF?): contract.pdf'
}
```

### `extract(input, options)`

`input` is a file path or a `Buffer`/`Uint8Array`. Returns a promise of the result, or
rejects with `DoclinesError` when the input cannot be turned into lines. A bad option
is a `TypeError`.

| Option | Default | Meaning |
|---|---|---|
| `name` | basename of the path, else `'input'` | file name used in messages |
| `ext` | extension of the path, else of `name` | extension used to break ties in detection |
| `contentType` | `null` | an HTTP `Content-Type`: `text/html` counts as `.html`, `message/rfc822` as `.eml`; its charset decodes HTML and plain text without a BOM |
| `formats` | `'all'` | `'all'` or an array of format ids; a detected format outside it is refused with `not_allowed` |
| `text` | `'auto'` | `'auto'`: plain text is read as is; `'never'`: plain text is refused with `not_allowed` |
| `maxDocBytes` | `52428800` (50 MB) | input size limit, and the base of the ZIP limits |
| `maxTextBytes` | `2097152` (2 MB) | limit on the text: UTF-8 bytes of the lines plus one per line break |
| `timeoutMs` | `60000` | extraction time limit |
| `heapMb` | `1024` | heap limit of the extraction worker |
| `attachments` | `{ depth: 1 }` | `depth: 1` extracts the attachments of EML and MSG messages, `depth: 0` only lists them |

The result:

| Field | Meaning |
|---|---|
| `format`, `label` | format id and its human name, e.g. `'xlsx'`, `'Excel workbook (.xlsx)'` |
| `charset` | decoded charset for plain text (`utf-8`, `utf-16le`, `utf-16be`, or the `contentType` charset), HTML, FB2 and single-part EML; else `null` |
| `lines` | the lines, without line breaks; line n is `lines[n - 1]` |
| `markers` | `[{ at, text }]`: the marker `text` stands before `lines[at]` and is not a line |
| `sections` | `[{ kind, n, label, start, end }]`; `kind` is one of `page`, `sheet`, `slide`, `notes`, `chapter`, `footnotes`, `endnotes`, `attachments`, `attachment`; `start`/`end` are 1-based line numbers, `end` inclusive (an empty section has `end = start - 1`) |
| `pageStarts` | PDF: the first line of each page (1-based); else `null` |
| `pagesWithoutText` | PDF: pages with no text; else `[]` |
| `warnings` | strings: parser warnings, collapsed cells, heap cap not in effect |
| `bytes`, `sha256` | size and SHA-256 (hex) of the input |
| `doclinesVersion` | version of doclines that produced the result |

### `detect(input, options)`

The format without extracting: `{ format, label, family, textOnDisk, extractable,
refusal }`. `refusal` is `{ code, message }` when `extractable` is `false`, else `null`.
Takes the options of `extract`; `formats` and `text` apply as there. Reads the first
8 KB; a ZIP or OLE file is read whole (up to `maxDocBytes`) for its directory. No
extractor runs, so a scanned PDF or a damaged document can still be `extractable`.

### `DoclinesError`

A refusal. Fields: `code`, `message` (English, for people), `format` and `label` (the
detected format, or `null`), `reason` (a short form of the message), and for `damaged`
also `detail` (the internal error text, never part of `message`).

| `code` | When |
|---|---|
| `unsupported` | a recognised format that is not read (the label names it: `'image (PNG), no OCR'`, `'Excel binary workbook (.xlsb)'`, …), or a charset this Node build has no decoder for |
| `not_allowed` | the format is not in `formats`, or plain text with `text: 'never'` |
| `encrypted` | password-protected or DRM-encrypted |
| `no_text_layer` | a PDF with less than 20 non-space characters per page on average (a scan) |
| `damaged` | a file of a known format that cannot be read |
| `too_large` | the input is over `maxDocBytes`, a ZIP is over its limits, or attachments are over the rest of `maxDocBytes` |
| `text_too_large` | the text is over `maxTextBytes` |
| `timeout` | extraction ran longer than `timeoutMs` |
| `out_of_memory` | extraction ran out of the worker heap |
| `binary` | not a known format and not text (NUL bytes in the first 8 KB) |
| `not_a_file` | the path does not exist or is not a regular file |

Other I/O errors on a path (`EACCES`, `EIO`, …) are thrown as the Node errors they
are.

### Helpers

- `FORMATS` — frozen list of `{ id, label, family, extensions, textOnDisk }`, one per
  format id (see [Formats](#formats)).
- `sectionOf(result, n)` — the innermost section holding line n, or `null`.
- `pageOf(pageStarts, n)` — the page of line n, or `null`.
- `pageRanges(numbers)` — `[3, 7, 8, 9]` → `'3, 7–9'`.
- `normalizeText(s)` — the normalisation applied to extracted text: U+00AD, U+200B,
  U+FEFF and `\r` removed, NBSP → space, NFC.
- `foldSpace(s)` — runs of white space → one space, U+00AD removed, trimmed.
- `version` — the package version.

### CommonJS

The package is ESM. From CommonJS:

```js
const { extract } = await import('doclines');
```

No module uses top-level await, so `require('doclines')` works as well.

## Formats

Detection is by content; the extension only breaks ties (HTML, EML, encrypted OOXML).

<!-- formats-table:start (generated by tools/formats-table.mjs) -->
| id | Label | Family | Extensions | Text on disk |
|---|---|---|---|---|
| `text` | plain text | text | `.txt` `.md` `.csv` `.log` | yes |
| `html` | HTML page (.html) | document | `.html` `.htm` `.xhtml` | yes |
| `pdf` | PDF document (.pdf) | document | `.pdf` | no |
| `docx` | Word document (.docx) | document | `.docx` `.docm` `.dotx` `.dotm` | no |
| `doc` | Word document (.doc) | document | `.doc` | no |
| `rtf` | RTF document (.rtf) | document | `.rtf` | yes |
| `xlsx` | Excel workbook (.xlsx) | spreadsheet | `.xlsx` `.xlsm` `.xltx` `.xltm` | no |
| `xls` | Excel workbook (.xls) | spreadsheet | `.xls` | no |
| `ods` | OpenDocument spreadsheet (.ods) | spreadsheet | `.ods` | no |
| `pptx` | PowerPoint presentation (.pptx) | presentation | `.pptx` `.pptm` `.potx` `.potm` `.ppsx` | no |
| `ppt` | PowerPoint presentation (.ppt) | presentation | `.ppt` | no |
| `odt` | OpenDocument text (.odt) | document | `.odt` `.ott` | no |
| `odp` | OpenDocument presentation (.odp) | presentation | `.odp` `.otp` | no |
| `epub` | EPUB book (.epub) | book | `.epub` | no |
| `fb2` | FictionBook (.fb2) | book | `.fb2` `.fb2.zip` | yes |
| `eml` | email message (.eml) | message | `.eml` | yes |
| `msg` | Outlook message (.msg) | message | `.msg` | no |
<!-- formats-table:end -->

*Text on disk*: the file is text a person can read as is (`.fb2.zip` is not); the
others need extraction.

Recognised and refused with `unsupported` and a label: XLSB, Excel 5/95, Word 6/95,
PowerPoint 95 and older, Apple iWork, XPS/OXPS, DjVu, OpenDocument drawings, images
(PNG, JPEG, GIF, WebP, TIFF, BMP, HEIC: no OCR), archives (ZIP, 7z, RAR, gzip, bzip2,
xz, tar), SQLite, any other OLE file.

What each format gives, its markers, what is skipped and what is refused:
[docs/formats.md](https://github.com/st412m/doclines/blob/main/docs/formats.md).

## Limits and safety

- **Worker thread.** Every format except plain text is extracted in a worker thread,
  one per call. On `timeoutMs` the worker is terminated (`timeout`); when it runs out
  of heap, `out_of_memory`.
- **Heap cap.** `heapMb` is the worker's old-generation limit (V8 `resourceLimits`).
  V8 flags are process-wide: when the host process runs with `--max-old-space-size`
  (flag or `NODE_OPTIONS`) above `heapMb` + 512 MB, the worker gets the host's limit
  instead, and `warnings` says the cap is not in effect. A host limit below that gives
  no warning.
- **Size limits refuse, never truncate.** Over `maxDocBytes` → `too_large`; text over
  `maxTextBytes` → `text_too_large`, counted while the lines are produced.
- **ZIP.** Own reader on `node:zlib`: methods stored and deflate only; at most 10 000
  entries; the declared and the actual size of each entry, and their sum, at most
  `maxDocBytes` × 20 and never over 512 MB; a declared size that differs from the
  actual one, an absolute name, a drive letter, a backslash or a `..` segment →
  `damaged`.
- **OLE.** Sector chains are checked for loops and bounds.
- **XML.** No DTD processing: no internal or external entity is expanded; only the
  predefined XML entities and character references are decoded.
- **Calling thread.** Only detection runs there: the first 8 KB, the ZIP central
  directory, the OLE directory and stream heads, and the container metadata entries
  (`mimetype`, `[Content_Types].xml`, `_rels/.rels`, `META-INF/manifest.xml`,
  `META-INF/container.xml`, `META-INF/encryption.xml`), each inflated to at most 1 MB.
  Plain text is decoded there too.
- **Silent.** The library writes nothing to stdout or stderr. The worker's console is
  captured; pdfjs warnings come back in `warnings`. A stdio MCP server can import it.
- **Plain text.** UTF-8, or UTF-16 by its BOM; lines as in the file (split at `\n`,
  `\r` removed), no other normalisation. A `contentType` charset decodes text without
  a BOM.

## CLI

```text
doclines <file> [--json] [--detect] [--formats a,b] [--max-text-bytes N] [--timeout S]
```

| | |
|---|---|
| (default) | numbered lines `L123\| text`, markers unnumbered |
| `--json` | the whole result as JSON |
| `--detect` | the result of `detect` as JSON |
| `--formats a,b` | allowed format ids |
| `--max-text-bytes N` | `maxTextBytes` |
| `--timeout S` | `timeoutMs` in seconds |
| `--version`, `--help` | the version, the usage |

Exit codes: `0` success; `2` refusal (the message on stderr; with `--detect`, a file
that is not extractable); `1` any other error. Meant for debugging and comparing
outputs.

## License

[MIT](https://github.com/st412m/doclines/blob/main/LICENSE) — by st412m.
