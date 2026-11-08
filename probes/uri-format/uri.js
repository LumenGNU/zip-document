// Implementation of the entry URI format for cross-checking. The format is defined by
// docs/URI.txt, section 3; this file only illustrates it. Where they differ, this file is wrong.
//
// Works with any URI class with the vscode.Uri interface (`from`, `parse`, `toString`):
// `vscode.Uri` inside VS Code, `URI` from the `vscode-uri` package in plain Node.
// No I/O: whether the entry exists is the provider's business, not the format's.

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';

// The path component is a label: what a human and VS Code see of the entry (tab title,
// tab description, breadcrumbs, hover, language mode, icon). It carries no address (the query
// does), but it is injective: different entries of one archive get different labels, and the
// difference is visible. Everything that would hide or fake a difference is escaped as
// ESC_OPEN ... ESC_CLOSE, and so is ESC_OPEN itself, which keeps the escapes unambiguous.
const ESC_OPEN = '\u27e6', ESC_CLOSE = '\u27e7';
const esc = s => ESC_OPEN + s + ESC_CLOSE;
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');

// Code points shown as an escape: invisible, acting (controls, bidi, line separators, format
// characters), space-like other than U+0020, noncharacters, and ESC_OPEN. Frozen list
// (derived from Unicode 17.0 Cc, Cf, Zl, Zp, Zs, Default_Ignorable_Code_Point,
// Noncharacter_Code_Point), so that labels do not change with the Unicode version of the
// runtime. Kept as they are, because text is not rendered right without them: ZWJ U+200D,
// ZWNJ U+200C, variation selectors U+FE00-FE0F, U+E0100-E01EF, Mongolian U+180B-180D, U+180F.
const SHOWN_AS_ESCAPE = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F], [0x0600, 0x0605],
  [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F], [0x0890, 0x0891], [0x08E2, 0x08E2],
  [0x115F, 0x1160], [0x1680, 0x1680], [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B],
  [0x200E, 0x200F], [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB],
  [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD], [0x13430, 0x1343F],
  [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF],
  // U+nFFFE-U+nFFFF in planes 1-16
  ...Array.from({ length: 16 }, (_, k) => [(k + 1) * 0x10000 + 0xFFFE, (k + 1) * 0x10000 + 0xFFFF]),
];
const shownAsEscape = c => SHOWN_AS_ESCAPE.some(([a, b]) => c >= a && c <= b);

// One UTF-8 sequence at bytes[i] (RFC 3629: no overlong forms, no surrogates, <= U+10FFFF):
// [code point, length], or null.
function utf8At(bytes, i) {
  const b0 = bytes[i];
  if (b0 < 0x80) return [b0, 1];
  let len, lo = 0x80, hi = 0xBF, cp;
  if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; }
  else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; cp = b0 & 0x0F; if (b0 === 0xE0) lo = 0xA0; if (b0 === 0xED) hi = 0x9F; }
  else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; cp = b0 & 0x07; if (b0 === 0xF0) lo = 0x90; if (b0 === 0xF4) hi = 0x8F; }
  else return null;
  if (i + len > bytes.length) return null;
  for (let k = 1; k < len; k++) {
    const b = bytes[i + k];
    if (b < (k === 1 ? lo : 0x80) || b > (k === 1 ? hi : 0xBF)) return null;
    cp = (cp << 6) | (b & 0x3F);
  }
  return [cp, len];
}

// Name bytes -> text: each well-formed UTF-8 sequence -> its character (or its escape,
// U+XXXX), every other byte -> its escape (two hex digits). Never fails; the bytes can be
// read back from the text.
function renderName(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const r = utf8At(bytes, i);
    if (!r) { s += esc(hex(bytes[i], 2)); i++; continue; }
    const [cp, len] = r;
    s += shownAsEscape(cp) ? esc('U+' + hex(cp, 4)) : String.fromCodePoint(cp);
    i += len;
  }
  return s;
}

const STRANGE = new Set(['', '.', '..']);
// (name bytes, index) -> path. A fixed point of VS Code: no "", "." or ".." segment
// (normalizePath would collapse or resolve it), no trailing "/", no upper-case ASCII drive
// letter at the start (toString() would lower-case it).
function labelPath(bytes, index = 0) {
  let name = renderName(bytes);
  const dir = name.endsWith('/'); // one trailing "/" marks a directory record
  if (dir) name = name.slice(0, -1);
  const segments = name.split('/').map(s => STRANGE.has(s) ? esc(s) : s);
  if (dir) segments[segments.length - 1] += esc('U+002F'); // shown, not a separator
  if (index > 0) segments.splice(segments.length - 1, 0, esc('#' + index));
  let path = '/' + segments.join('/');
  if (/^\/[A-Z]:/.test(path)) path = '/' + esc('U+' + hex(path.charCodeAt(1), 4)) + path.slice(2);
  return path;
}

const b64 = bytes => Buffer.from(bytes).toString('base64url');

// (archive URI, name bytes, index among entries with these bytes) → entry URI.
function build(Uri, archive, bytes, index = 0) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`index ${index}`);
  let query = `pkg=${archive.toString()}&entry=${b64(bytes)}`;
  if (index > 0) query += `&index=${index}`;
  return Uri.from({ scheme: SCHEME, authority: AUTHORITY, path: labelPath(bytes, index), query, fragment: '' });
}

const same = (a, b) => ['scheme', 'authority', 'path', 'query', 'fragment'].every(k => a[k] === b[k]);

// Entry URI → { archive, bytes, index }, or null when the URI is not canonical.
// Canonical means: building it again from what was parsed gives exactly the same URI.
function parse(Uri, uri) {
  const parts = uri.query.split('&');
  if (parts.length < 2 || parts.length > 3) return null;
  const [p, e, i] = parts;
  if (!p.startsWith('pkg=') || !e.startsWith('entry=') || (i !== undefined && !i.startsWith('index='))) return null;
  let archive;
  try { archive = Uri.parse(p.slice(4), true); } catch { return null; }
  const bytes = Buffer.from(e.slice(6), 'base64url');
  const index = i === undefined ? 0 : Number(i.slice(6));
  if (!Number.isSafeInteger(index) || index < 0) return null;
  let canonical;
  try { canonical = build(Uri, archive, bytes, index); } catch { return null; }
  return same(uri, canonical) ? { archive, bytes: new Uint8Array(bytes), index } : null;
}

module.exports = { SCHEME, AUTHORITY, ESC_OPEN, ESC_CLOSE, SHOWN_AS_ESCAPE, shownAsEscape, utf8At, renderName, labelPath, build, parse, same };
