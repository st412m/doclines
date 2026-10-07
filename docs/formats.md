# Formats

What doclines reads from each format, the section markers it adds, what it skips and
what it refuses. Format ids, labels and extensions are listed in `FORMATS` and in the
README table.

## Common rules

- **Detection is by content.** The extension only breaks ties: `.htm`, `.html` and
  `.xhtml` make a text file HTML; `.eml` (or the content type `message/rfc822`) makes
  a text or HTML file an email message; for an encrypted OOXML file, whose type is
  inside the encrypted package, `.docx`/`.xlsx`/`.pptx` and their variants name the
  format. A text file that merely starts with `From:` stays plain text.
- **Lines.** `lines[n - 1]` is line n. A marker such as `--- page 3 ---` is not a line:
  it is in `markers` (`{ at, text }`, before `lines[at]`) and gives a section in
  `sections`.
- **Normalisation of extracted text** (every format except plain text): U+00AD (soft
  hyphen), U+200B, U+FEFF and `\r` removed, NBSP → space, Unicode NFC; a word broken
  across lines with a soft hyphen is joined within its section; trailing white space
  trimmed; leading and trailing blank lines dropped, runs of blank lines collapsed to
  one. No homoglyph folding: a Latin letter inside a Cyrillic word stays as it is.
- **Tables.** One row is one line, cells joined by ` | `. Empty cells between values
  stay as empty slots so columns do not shift; trailing empty cells are dropped; a row
  with no text is dropped.
- **Names in markers.** Sheet names, chapter titles and attachment names have control
  characters removed and line breaks turned into spaces, and are cut at 120
  characters.

| Marker | Section `kind` | Formats |
|---|---|---|
| `--- page N ---` | `page` | PDF |
| `--- footnotes ---`, `--- endnotes ---` | `footnotes`, `endnotes` | DOC, ODT; RTF footnotes |
| `--- sheet N: <name> ---` (+ ` (hidden)`) | `sheet` | XLSX, XLS, ODS |
| `--- slide N ---` (+ ` (hidden)`) | `slide` | PPTX, PPT, ODP |
| `--- notes N ---` | `notes` | PPTX, PPT, ODP |
| `--- chapter N: <title> ---`, `--- chapter N ---` | `chapter` | EPUB, FB2 |
| `--- notes ---` | `notes` | FB2 |
| `--- attachments ---` | `attachments` | EML, MSG |
| `--- attachment: <name> ---` | `attachment` | EML, MSG |

## Plain text (`text`)

- UTF-8, or UTF-16 LE/BE by its BOM (the BOM is dropped). A charset in `contentType`
  decodes a file without a BOM.
- Read as is: lines split at `\n`, `\r` removed, no other normalisation.
- Refused: NUL bytes in the first 8 KB → `binary`; larger than `maxTextBytes` →
  `text_too_large`; with `text: 'never'` → `not_allowed`.

## HTML (`html`)

- Charset: BOM, then the `contentType` charset, then `<meta charset>` /
  `<meta http-equiv>`, then UTF-8. windows-1252 and the labels mapped to it
  (`latin1`, `iso-8859-1`, `ascii`, `cp1252`, …) are decoded by an own table.
- The `<title>` is the first line. Block elements and `<br>` break lines; `<pre>` keeps
  its line breaks; a table row is one line. A row of 2000 characters or more, or one
  holding a nested table, is layout: its cells come out as lines in reading order.
- Skipped: the rest of `<head>`, `script`, `style`, `noscript`, `template`, `svg`,
  `math`, comments.
- Refused: a legacy charset on a Node build without full ICU → `unsupported`.

## PDF (`pdf`)

- Text layer through pdfjs-dist, with its CMaps and standard fonts (CJK included).
  Lines are rebuilt from the text items in content-stream order: an end of line, a
  change of baseline or a jump back to the left starts a new line; a horizontal gap is
  a space.
- `--- page N ---` before every page; `pageStarts` holds the first line of each page,
  `pagesWithoutText` the pages with no text.
- A word broken at a line end with a soft hyphen is joined back.
- Refused: less than 20 non-space characters per page on average → `no_text_layer`
  (a scan; no OCR); a password → `encrypted`; an invalid file → `damaged`.

## Word (`docx`, `doc`)

DOCX, DOCM, DOTX, DOTM:

- Converted by mammoth (main part from `_rels/.rels`), then read as HTML: paragraphs,
  headings, lists and tables (one row per line).
- Footnotes and endnotes follow the body without a marker; the reference stays in the
  text as `[1]`.
- Skipped: images, headers and footers, comments.
- Refused: Strict OOXML (ISO/IEC 29500 Strict namespaces, which mammoth does not read)
  → `damaged`; encrypted (an OLE file with `EncryptedPackage`) → `encrypted`; a broken
  package → `damaged`.

DOC (Word 97–2003):

- word-extractor: the body, then `--- footnotes ---` and `--- endnotes ---` when they
  have text. Table rows are one line; field codes are dropped and their results kept.
- Refused: Word 6/95 and older → `unsupported` (`Word document older than Word 97
  (.doc)`); `fEncrypted` → `encrypted`; a broken file → `damaged`.

## RTF (`rtf`)

- Code page from `\ansicpgN`, overridden per font by `\fcharsetN`; `\'hh` bytes decoded
  by code page; `\uN` gives the Unicode character and its `\ucN` fallback characters are
  skipped. `\cell` → ` | `, `\row` → new line.
- Footnotes go to a trailing `--- footnotes ---` section.
- Skipped: destinations that are not document text (font and colour tables, styles,
  pictures, objects, document info, …).
- Refused: a code page this Node build has no decoder for → `unsupported`.

## Spreadsheets (`xlsx`, `xls`, `ods`)

- One section per sheet in workbook order: `--- sheet N: <name> ---`; hidden sheets
  are included and marked `(hidden)`. Chart, dialog and macro sheets give the marker
  only.
- A row is `[R] v1 | v2 | …`, where R is the spreadsheet row number. Cells start at
  column A; empty cells between values are empty slots, but a run of more than 64 is
  shown as one `…` with a warning. Empty rows are skipped (the row number keeps the
  position).
- Values: strings as text (rich text runs joined, phonetic runs skipped); numbers as
  stored, in the shortest round-trip form (`3605044`, `0.15`, `-40`), number formats
  not applied; booleans `TRUE`/`FALSE`; errors as text (`#N/A`); formulas by their
  cached value (none → empty slot); a line break inside a cell → space. In a merged
  range only the top-left cell has the value.
- Dates: a number with a date or time format (built-in ids 14–22, 27–36, 45–47,
  50–58, or a custom format with `y`, `m`, `d`, `h` or `s` outside quotes, brackets and
  escapes) → `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`, or `HH:MM:SS` for a time. An elapsed
  time format (built-in 46, or `[h]`, `[m]`, `[s]` in a custom format) → a duration
  `H:MM:SS` with hours not wrapped at 24 (`1.5` → `36:00:00`). The 1900 date system
  keeps Excel's 29 February 1900 (serial 60); the 1904 system is used when the
  workbook sets it.
- Skipped: comments, charts, images, headers and footers, defined names.

XLSX, XLSM, XLTX, XLTM: `xl/workbook.xml` and its relationships, shared strings,
`styles.xml` number formats; cell types `s`, `inlineStr`, `str`, `b`, `e`, `n`, and
`d` (an ISO date string, as written). Refused: XLSB → `unsupported` (`Excel binary
workbook (.xlsb)`); encrypted → `encrypted`.

XLS (Excel 97–2003, BIFF8): own reader of the `Workbook` stream ([MS-XLS]): shared
strings including strings split across `Continue` records, `Label`, `Number`, `RK`,
`MulRk`, `BoolErr`, `Formula` with its cached result. Refused: Excel 5/95 and older
(`Book` stream or BIFF5 BOF) → `unsupported` (`Excel workbook older than Excel 97
(.xls)`); `FilePass` → `encrypted`; inconsistent records → `damaged`.

ODS: `content.xml`. Values from `office:value` (numbers), `office:date-value` (ISO, as
for XLSX), `office:time-value` (a duration `H:MM:SS`, `PT36H00M00S` → `36:00:00`),
`office:boolean-value` (`TRUE`/`FALSE`), else the cell's paragraphs. A sheet is hidden
when its style has `table:display="false"`. An empty repeated row or cell only moves
the position (files often repeat empty rows up to row 1 048 576); a non-empty one is
written out at most 1000 times, with a warning. Refused: encrypted (`manifest.xml`
with `encryption-data`) → `encrypted`.

## Presentations (`pptx`, `ppt`, `odp`)

- One section per slide in presentation order: `--- slide N ---`, hidden slides marked
  `(hidden)` and included; then `--- notes N ---` when the slide's notes have text.
- Paragraphs are lines; a line break inside a paragraph starts a new line.
- Skipped: slide numbers, dates, footers and headers from placeholders and fields;
  images, charts, media.

PPTX, PPTM, POTX, POTM, PPSX: slides from `p:sldIdLst`, hidden by `show="0"`. Shapes
in document order, groups recursed, tables one row per line. SmartArt text (the
diagram data part) follows the slide's shapes. Notes: only body placeholders of the
notes slide. Refused: encrypted → `encrypted`.

PPT (PowerPoint 97–2003): own reader ([MS-PPT]): `Current User` → the chain of user
edits → the persist directory → the live document; objects left behind by incremental
saves are never read. Text of each slide's text boxes in drawing order, outline text
included. Hidden from `SlideShowSlideInfoAtom`. A table comes out one cell per line: in
the PPT format a table is a group of separate shapes. Refused: PowerPoint 95 and older
→ `unsupported` (`PowerPoint presentation older than PowerPoint 97 (.ppt)`); an
encrypted file (`CryptSession10Container`, or the encrypted Current User token) →
`encrypted`; inconsistent records → `damaged`.

ODP, OTP: `draw:page` in order, hidden by `presentation:visibility="hidden"` in the
page's style; frames, text boxes and tables (one row per line); speaker notes from
`presentation:notes`. Refused: encrypted → `encrypted`.

## OpenDocument text (`odt`)

- ODT, OTT: `office:text` — headings, paragraphs, lists, tables (one row per line),
  text boxes in frames; `text:s`, `text:tab` and `text:line-break` as space, tab and
  line break.
- Footnotes and endnotes move to trailing `--- footnotes ---` / `--- endnotes ---`
  sections; the citation number is removed from the body.
- Skipped: tracked changes (deleted text), annotations (comments), forms, images,
  embedded objects, index marks, bookmarks.
- Refused: encrypted (`manifest.xml` with `encryption-data`) → `encrypted`.

## EPUB (`epub`)

- EPUB 2 and 3: `META-INF/container.xml` → package document → spine order (`linear="no"`
  items included) → each XHTML item through the HTML extractor.
- One `--- chapter N: <title> ---` per spine item with text; N counts those items.
  Title: the first `h1`–`h3`, else `<title>`, else the file name.
- Footnote reference numbers stay glued to the text (`…2026 года.1`); the notes are
  where the book puts them.
- Skipped: navigation documents and NCX outside the spine, images, styles. A missing
  spine item gives a warning.
- Refused: `META-INF/encryption.xml` listing anything but obfuscated fonts
  (`http://www.idpf.org/2008/embedding`, `http://ns.adobe.com/pdf/enc#RC`), or listing
  any spine item → `encrypted`.

## FictionBook (`fb2`)

- FB2, or a ZIP holding exactly one `.fb2` file. Charset: BOM, then the XML
  declaration (often `windows-1251`), then UTF-8.
- First lines: book title and authors from `title-info`.
- Each top-level `section` of the main body: `--- chapter N: <title> ---`; a section
  without a title: `--- chapter N ---`.
- Text: `title`, `subtitle`, `p`, poems (`v` lines), `cite`, `epigraph`,
  `text-author`, `empty-line` (a blank line), tables (one row per line).
- The body named `notes` becomes a trailing `--- notes ---` section; note references
  in the text are dropped.
- Skipped: `binary` (embedded images), images.

## Email (`eml`, `msg`)

- Head lines, those present: `From:`, `To:`, `Cc:`, `Date:`, `Subject:`; then an empty
  line; then the body.
- EML (RFC 5322/2045/2047, postal-mime): only by the extension `.eml` or the content
  type `message/rfc822`. Body: the `text/plain` part, else the HTML part through the
  HTML extractor. `Date:` as written in the message. Encoded words and body charsets
  (koi8-r, windows-1251, …) are decoded.
- MSG (Outlook item, @kenjiuno/msgreader): body from the plain text, else the HTML,
  else the compressed RTF body through the RTF reader. `Date:` in ISO 8601 UTC.
- Attachments: `--- attachments ---` lists each as `name (mime type, N bytes)`. With
  `attachments.depth` 1 (the default) each attachment of a readable, allowed format is
  extracted after the list under `--- attachment: <name> ---`. Attached messages
  (`message/rfc822`, embedded MSG) are attachments too; their own attachments are
  listed, not extracted. A refused attachment gets one line `(not extracted:
  <reason>)`.
- Limits: the decoded bytes of all attachments together count toward `maxDocBytes`
  (apart from the message's own size); their text counts toward `maxTextBytes` of the
  whole call.

## Refused formats

`unsupported`, with the label shown here:

| Recognised by | Label |
|---|---|
| ZIP with `xl/workbook.bin` | `Excel binary workbook (.xlsb)` |
| OLE with a `Book` stream, or a BIFF5 BOF | `Excel workbook older than Excel 97 (.xls)` |
| OLE `WordDocument` not of Word 97+ | `Word document older than Word 97 (.doc)` |
| OLE with `PP40`, or an older Current User | `PowerPoint presentation older than PowerPoint 97 (.ppt)` |
| ZIP with `Index/Document.iwa` | `Apple iWork document (.pages, .numbers, .key)` |
| ZIP with `FixedDocumentSequence.fdseq` / `FixedDocSeq.fdseq` | `XPS document (.xps, .oxps)` |
| ODF drawing | `OpenDocument drawing (.odg)` |
| other ODF type | `OpenDocument file` |
| `AT&TFORM` | `DjVu document` |
| image signatures | `image (PNG), no OCR`, likewise JPEG, GIF, WebP, TIFF, BMP, HEIC |
| archive signatures | `7z archive`, `RAR archive`, `gzip archive`, `bzip2 archive`, `xz archive`, `tar archive` |
| `SQLite format 3` | `SQLite database` |
| ZIP with a `mimetype` of another kind | `ZIP archive (<mime type>)` |
| any other ZIP | `ZIP archive` |
| any other OLE file | `OLE compound file` |

`damaged`: an OLE file with a broken directory (`damaged OLE compound file`), a DOC
whose header cannot be read (`damaged Word document (.doc)`), and any file of a known
format its reader cannot parse.

`encrypted`: PDF with a password, OOXML in an OLE `EncryptedPackage`, DOC
`fEncrypted`, XLS `FilePass`, encrypted PPT, ODF with `manifest:encryption-data`,
EPUB with content listed in `encryption.xml`.
