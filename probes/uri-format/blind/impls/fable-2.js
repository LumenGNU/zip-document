// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4 генератор: «для тройки, у которой URI нет» — названо явно только index > 2^53 − 1;
//   не сказано, что делать, если toString() архива не совпадает с toString(Uri.parse(P)), содержит
//   "&"/"=" или пуст; выбрано: генератор отказывает (бросает Error) во всех этих случаях, а также
//   при нецелом/отрицательном index и name не Uint8Array.
// - 3.2 шаг 8: не сказано, применяется ли он, если "X:" получилось уже после вставки "⟦#N⟧" или
//   экранирований; выбрано: шаг 8 проверяет итоговую строку path после шага 7, буквально.
// - 3.2 шаг 1: «любой другой байт» при неполной последовательности (например E2 82 41) —
//   выбрано: экранируется только первый байт, чтение продолжается со следующего (82 снова
//   проверяется как начало последовательности и тоже экранируется, т.к. это не ведущий байт).
// - 3.4: «строгое равенство» в parse — сравнение path/query полей полученного URI с построенными
//   build(Uri.parse(P), декодированное E, N); E декодируется строго: E обязан совпасть со своим
//   повторным кодированием base64url без паддинга (иначе null).
'use strict';
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 - 1

const RANGES = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F],
  [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
  [0x0890, 0x0891], [0x08E2, 0x08E2], [0x115F, 0x1160], [0x1680, 0x1680],
  [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B], [0x200E, 0x200F],
  [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
  [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD],
  [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE00FF],
  [0xE01F0, 0xE0FFF],
];

function isEscaped(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true; // nFFFE–nFFFF, planes 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// Returns [codePoint, length] for a valid UTF-8 sequence at i, or null.
function decodeAt(b, i) {
  const n = b.length;
  const b0 = b[i];
  const cont = (k, lo = 0x80, hi = 0xBF) => i + k < n && b[i + k] >= lo && b[i + k] <= hi;
  if (b0 <= 0x7F) return [b0, 1];
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    if (cont(1)) return [((b0 & 0x1F) << 6) | (b[i + 1] & 0x3F), 2];
    return null;
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
    if (cont(1, lo, hi) && cont(2)) {
      return [((b0 & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F), 3];
    }
    return null;
  }
  if (b0 >= 0xF0 && b0 <= 0xF4) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
    if (cont(1, lo, hi) && cont(2) && cont(3)) {
      return [((b0 & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F), 4];
    }
    return null;
  }
  return null;
}

function makeLabel(name, index) {
  // Steps 1–2
  let s = '';
  let i = 0;
  while (i < name.length) {
    const r = decodeAt(name, i);
    if (r === null) {
      s += '⟦' + hex(name[i], 2) + '⟧';
      i += 1;
    } else {
      const cp = r[0];
      s += isEscaped(cp) ? '⟦U+' + hex(cp, 4) + '⟧' : String.fromCodePoint(cp);
      i += r[1];
    }
  }
  // Step 3
  let dir = false;
  if (s.endsWith('/')) { dir = true; s = s.slice(0, -1); }
  // Step 4
  const segs = s.split('/').map((g) =>
    g === '' ? '⟦⟧' : g === '.' ? '⟦.⟧' : g === '..' ? '⟦..⟧' : g);
  // Step 5
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  // Step 6
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Step 7
  let path = '/' + segs.join('/');
  // Step 8
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/⟦U+' + hex(m[1].charCodeAt(0), 4) + '⟧' + path.slice(2);
  return path;
}

function archiveString(archive) {
  const P = archive.toString();
  if (typeof P !== 'string' || P === '' || P.includes('&') || P.includes('=')) return null;
  if (URI.parse(P).toString() !== P) return null;
  return P;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new TypeError('name must be Uint8Array');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError('index out of range');
  }
  if (!archive || typeof archive.toString !== 'function') throw new TypeError('bad archive');
  const P = archiveString(archive);
  if (P === null) throw new Error('archive URI has no canonical string form');
  const E = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
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
    if (!uri || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    for (const v of [scheme, authority, path, query, fragment]) if (typeof v !== 'string') return null;
    if (scheme !== SCHEME || authority !== AUTHORITY || fragment !== '') return null;
    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const P = parts[0].slice('archive='.length);
    const E = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      const N = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]{0,15}$/.test(N)) return null;
      index = Number(N);
      if (!Number.isSafeInteger(index) || index > MAX_INDEX) return null;
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const buf = Buffer.from(E, 'base64url');
    if (buf.toString('base64url') !== E) return null;
    const name = new Uint8Array(buf);
    if (P === '') return null;
    const archive = URI.parse(P);
    if (archiveString(archive) !== P) return null;
    const c = build(archive, name, index);
    if (c.scheme !== scheme || c.authority !== authority || c.path !== path ||
        c.query !== query || c.fragment !== fragment) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
