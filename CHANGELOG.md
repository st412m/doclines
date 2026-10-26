# Changelog

## 0.1.1 — 2026-10-26

- postal-mime 4.0.4 → 4.1.4: fixes GHSA-f2hq-32vh-53cc (quadratic CPU time when
  decoding a header made of many joinable RFC 2047 base64 encoded words in an EML).
- EML output changes with the parser fixes of postal-mime 4.0.5–4.1.4: body text
  that 4.0.4 dropped in some malformed messages is extracted; a `message/rfc822` or
  `message/delivery-status` attachment keeps the line endings of the message, so its
  size in the attachment list can differ.

## 0.1.0 — 2026-10-09

- `extract(input, options)`: a file path or bytes → numbered lines, section markers,
  sections, page starts for PDF, warnings, size and SHA-256 of the input.
- `detect(input, options)`: the format and whether it can be extracted, without
  running an extractor.
- `DoclinesError` with codes `unsupported`, `not_allowed`, `encrypted`,
  `no_text_layer`, `damaged`, `too_large`, `text_too_large`, `timeout`,
  `out_of_memory`, `binary`, `not_a_file`.
- `FORMATS` and helpers `sectionOf`, `pageOf`, `pageRanges`, `normalizeText`,
  `foldSpace`, `version`.
- Formats: plain text, HTML, PDF (pdfjs-dist), DOCX/DOCM/DOTX/DOTM (mammoth), DOC
  (word-extractor), RTF, XLSX/XLSM/XLTX/XLTM, XLS (BIFF8), ODS, PPTX/PPTM/POTX/POTM/PPSX,
  PPT, ODT/OTT, ODP/OTP, EPUB 2 and 3, FB2 and FB2 in ZIP, EML (postal-mime), MSG
  (@kenjiuno/msgreader) with attachments.
- Recognised and refused with a label: XLSB, Excel 5/95, Word 6/95, PowerPoint 95,
  Apple iWork, XPS, DjVu, OpenDocument drawings, images, archives, SQLite, other OLE
  and ZIP files. Encrypted PDF, OOXML, DOC, XLS, PPT, ODF and EPUB are refused as
  encrypted.
- Extraction in a worker thread with a timeout and a heap cap; nothing written to
  stdout or stderr; `--max-old-space-size` on the host that overrides the cap is
  reported in `warnings`.
- Own ZIP reader on `node:zlib` with entry count, size and name checks; XML without
  entity expansion; detection on the calling thread reads only container directories
  and metadata entries.
- windows-1252 decoded by an own table on every Node version.
- CLI `doclines <file>` with `--json`, `--detect`, `--formats`, `--max-text-bytes`,
  `--timeout`.
