// НЕОДНОЗНАЧНОСТИ:
// - 3.4 «генератор отказывает»: форма отказа в JS не задана; выбрано: build бросает Error.
// - 3.3 N / интерфейс build: тип index не задан строго (Number или BigInt); выбрано: только
//   Number, целое 0..2^53−1 (Number.isSafeInteger), иначе отказ; NaN, дробные, BigInt — отказ.
// - 3.3 P: «Uri.parse(P)» — в vscode-uri есть строгий и нестрогий режим (_strict); выбрано:
//   URI.parse(P) по умолчанию (нестрогий), сравнение URI.parse(P).toString() === P.
// - 3.2 шаг 8: «/X:» — только заглавные A–Z, строчные не трогаются; заменяется только X, ":" как
//   есть; проверка на готовом path, в т.ч. path ровно "/C:" (без продолжения) тоже попадает.
// - 3.2 шаг 3: «один завершающий "/"» — снимается ровно один, даже если их несколько ("a//" →
//   "/a/⟦⟧⟦U+002F⟧"); выбрано буквальное прочтение.
// - 3.4 провайдер/parse: каноничность проверяется только по полям полученного объекта
//   (scheme, authority, path, query, fragment строгим равенством с построенным по тройке);
//   круговой toString()/parse (Т3) не проверяется. parse возвращает archive = URI.parse(P).
// - 3.3 E при разборе: строгий base64url — только алфавит A–Z a–z 0–9 - _, без "=",
//   длина mod 4 ≠ 1, и повторное кодирование декодированных байт должно дать ровно E.
'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 − 1

const ESC_OPEN = '⟦';
const ESC_CLOSE = '⟧';

// Список символов шага 2 (3.2), замороженный.
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

function isListed(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFE) === 0xFFFE) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [a, b] of RANGES) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function escCp(cp) {
  return ESC_OPEN + 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ESC_CLOSE;
}

function isCont(b) {
  return b >= 0x80 && b <= 0xBF;
}

// Шаг 1: строгое декодирование UTF-8 (RFC 3629). Возвращает [cp, len] или null.
function decodeAt(bytes, i) {
  const b0 = bytes[i];
  const n = bytes.length;
  if (b0 <= 0x7F) return [b0, 1];
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    if (i + 1 < n && isCont(bytes[i + 1])) {
      return [((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F), 2];
    }
    return null;
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    if (i + 2 >= n) return null;
    const b1 = bytes[i + 1], b2 = bytes[i + 2];
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
    if (b1 < lo || b1 > hi || !isCont(b2)) return null;
    return [((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F), 3];
  }
  if (b0 >= 0xF0 && b0 <= 0xF4) {
    if (i + 3 >= n) return null;
    const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3];
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
    if (b1 < lo || b1 > hi || !isCont(b2) || !isCont(b3)) return null;
    return [((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F), 4];
  }
  return null;
}

function makeLabel(bytes, index) {
  // Шаги 1–2.
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const d = decodeAt(bytes, i);
    if (d === null) {
      s += ESC_OPEN + hex2(bytes[i]) + ESC_CLOSE;
      i += 1;
      continue;
    }
    const cp = d[0];
    s += isListed(cp) ? escCp(cp) : String.fromCodePoint(cp);
    i += d[1];
  }
  // Шаг 3.
  let dir = false;
  if (s.endsWith('/')) {
    dir = true;
    s = s.slice(0, -1);
  }
  // Шаг 4.
  const segs = s.split('/').map((seg) => {
    if (seg === '') return ESC_OPEN + ESC_CLOSE;
    if (seg === '.') return ESC_OPEN + '.' + ESC_CLOSE;
    if (seg === '..') return ESC_OPEN + '..' + ESC_CLOSE;
    return seg;
  });
  // Шаг 5.
  if (dir) segs[segs.length - 1] += escCp(0x2F);
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, ESC_OPEN + '#' + String(index) + ESC_CLOSE);
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (/^\/[A-Z]:/.test(path)) {
    path = '/' + escCp(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

function archiveString(archive) {
  const p = archive.toString();
  if (typeof p !== 'string' || p === '' || p.includes('&') || p.includes('=')) return null;
  if (URI.parse(p).toString() !== p) return null;
  return p;
}

function buildParts(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('zip-document: index out of range');
  }
  if (!(name instanceof Uint8Array)) throw new Error('zip-document: name must be Uint8Array');
  const p = archiveString(archive);
  if (p === null) throw new Error('zip-document: archive URI has no canonical string form');
  const e = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
  let query = 'archive=' + p + '&entry=' + e;
  if (index >= 1) query += '&index=' + String(index);
  return {
    scheme: SCHEME,
    authority: AUTHORITY,
    path: makeLabel(name, index),
    query,
    fragment: '',
  };
}

function build(archive, name, index) {
  return URI.from(buildParts(archive, name, index));
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const N_RE = /^[1-9][0-9]*$/;

function parse(uri) {
  try {
    if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') {
      return null;
    }
    const query = uri.query;
    if (typeof query !== 'string' || typeof uri.path !== 'string') return null;
    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      const n = parts[2].slice('index='.length);
      if (!N_RE.test(n)) return null;
      index = Number(n);
      if (!Number.isSafeInteger(index) || String(index) !== n) return null;
    }
    if (!B64URL_RE.test(e) || e.length % 4 === 1) return null;
    const buf = Buffer.from(e, 'base64url');
    if (buf.toString('base64url') !== e) return null;
    const name = new Uint8Array(buf);
    if (p === '' || p.includes('=')) return null;
    const archive = URI.parse(p);
    if (archive.toString() !== p) return null;
    const c = buildParts(archive, name, index);
    if (c.scheme !== uri.scheme || c.authority !== uri.authority || c.path !== uri.path ||
        c.query !== uri.query || c.fragment !== uri.fragment) {
      return null;
    }
    return { archive, name, index };
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
