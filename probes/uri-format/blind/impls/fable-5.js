// НЕОДНОЗНАЧНОСТИ:
// - 3.4 «генератор отказывает»: форма отказа не задана; выбрано: build бросает Error.
// - 3.3 P = toString() URI архива: не сказано, с каким skipEncoding; выбрано: toString() без аргументов (с кодированием).
// - 3.3/3.5 Uri.parse(P): не сказано, strict или нет; выбрано: URI.parse(P) по умолчанию (нестрогий).
// - 3.3 index: допустимые типы входа не заданы; выбрано: только Number, целое, 0 <= index <= 2^53 − 1, иначе отказ.
// - 3.2 шаг 1: при недопустимом продолжении экранируется только первый байт, чтение со следующего
//   (F0 80 80 80 -> "⟦F0⟧⟦80⟧⟦80⟧⟦80⟧"); выбрано так, по буквальному тексту.
// - 3.2 шаг 8: строчная буква ("/c:") не заменяется — текст говорит только о заглавных A–Z; выбрано: только A–Z.
// - 3.4 проверка каноничности в parse: выбрано — извлечь тройку из query по 3.4, проверить P, E (строгий
//   base64url: повторное кодирование равно E), N, затем построить URI по 3.1–3.3 и сравнить все пять компонент.
'use strict';
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 2 ** 53 - 1;

const RANGES = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F],
  [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
  [0x0890, 0x0891], [0x08E2, 0x08E2], [0x115F, 0x1160], [0x1680, 0x1680],
  [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B], [0x200E, 0x200F],
  [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
  [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD],
  [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A],
  [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF],
];

function isEscapedChar(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true; // nFFFE–nFFFF, планы 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// Шаги 1–2: байты -> строка с экранированиями.
function decodeName(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let len = 0, lo = 0x80, hi = 0xBF, cp = 0;
    if (b0 < 0x80) { len = 1; cp = b0; }
    else if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; }
    else if (b0 === 0xE0) { len = 3; lo = 0xA0; cp = b0 & 0x0F; }
    else if ((b0 >= 0xE1 && b0 <= 0xEC) || b0 === 0xEE || b0 === 0xEF) { len = 3; cp = b0 & 0x0F; }
    else if (b0 === 0xED) { len = 3; hi = 0x9F; cp = b0 & 0x0F; }
    else if (b0 === 0xF0) { len = 4; lo = 0x90; cp = b0 & 0x07; }
    else if (b0 >= 0xF1 && b0 <= 0xF3) { len = 4; cp = b0 & 0x07; }
    else if (b0 === 0xF4) { len = 4; hi = 0x8F; cp = b0 & 0x07; }
    let ok = len > 0 && i + len <= n;
    if (ok) {
      for (let k = 1; k < len; k++) {
        const b = bytes[i + k];
        const l = k === 1 ? lo : 0x80, h = k === 1 ? hi : 0xBF;
        if (b < l || b > h) { ok = false; break; }
        cp = (cp << 6) | (b & 0x3F);
      }
    }
    if (!ok) {
      out += '⟦' + hex(b0, 2) + '⟧';
      i += 1;
      continue;
    }
    out += isEscapedChar(cp) ? '⟦U+' + hex(cp, 4) + '⟧' : String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

function makeLabel(bytes, index) {
  let s = decodeName(bytes);
  let dir = false;
  if (s.endsWith('/')) { s = s.slice(0, -1); dir = true; }
  const segs = s.split('/').map((seg) =>
    seg === '' ? '⟦⟧' : seg === '.' ? '⟦.⟧' : seg === '..' ? '⟦..⟧' : seg);
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  let path = '/' + segs.join('/');
  if (path.length >= 3 && path[2] === ':' && path[1] >= 'A' && path[1] <= 'Z') {
    path = '/⟦U+' + hex(path.charCodeAt(1), 4) + '⟧' + path.slice(2);
  }
  return path;
}

function archiveStringOk(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('&') || p.includes('=')) return false;
  return URI.parse(p).toString() === p;
}

function indexOk(index) {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= MAX_INDEX;
}

function build(archive, name, index) {
  if (!indexOk(index)) throw new Error('zip-document: no URI for this index');
  if (!(name instanceof Uint8Array)) throw new Error('zip-document: name must be Uint8Array');
  const p = archive.toString();
  if (!archiveStringOk(p)) throw new Error('zip-document: no URI for this archive');
  const e = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
  let query = 'archive=' + p + '&entry=' + e;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: makeLabel(name, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string') return null;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    if (!archiveStringOk(p)) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(e)) return null;
    const buf = Buffer.from(e, 'base64url');
    if (buf.toString('base64url') !== e) return null;
    let index = 0;
    if (parts.length === 3) {
      const nstr = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(nstr) || nstr.length > 16) return null;
      index = Number(nstr);
      if (!indexOk(index) || String(index) !== nstr) return null;
    }
    const archive = URI.parse(p);
    const name = new Uint8Array(buf);
    const c = build(archive, name, index);
    if (c.scheme !== uri.scheme || c.authority !== uri.authority || c.path !== uri.path ||
        c.query !== uri.query || c.fragment !== uri.fragment) return null;
    return { archive, name, index };
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
