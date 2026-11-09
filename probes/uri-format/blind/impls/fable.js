// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4, build: не сказано, что делать генератору, если тройки нет (index не целое, < 0 или > 2^53 − 1;
//   name не Uint8Array; toString() архива содержит "&"/"=" или не совпадает с toString(Uri.parse(P)) либо пуст);
//   выбрано: build бросает исключение (URI для такой тройки нет, а неканонический генератор строить не должен).
// - 3.4, проверка P: «совпадает со своим toString(Uri.parse(P))» — какой Uri.parse (strict или нет) и какой toString
//   (с skipEncoding или без); выбрано: URI.parse(P) по умолчанию (нестрогий) и toString() без аргументов.
// - 3.4, провайдер: определение каноничности — «равен URI, построенному из какой-либо тройки»; выбрано: тройка
//   извлекается из query (archive=URI.parse(P), имя — строгое декодирование E, index — N), затем URI строится
//   заново через build и сравнивается покомпонентно строгим равенством; любые исключения -> null.
// - 3.4, E: «нестрогое декодирование» не определено; выбрано: E допускается только из алфавита base64url
//   без "=", длина mod 4 != 1, и повторное кодирование декодированных байт обязано дать ровно E.
// - 3.2 шаг 1: «любой другой байт» — неясно, сколько байт отбрасывать при обрыве многобайтовой
//   последовательности; выбрано: всегда ровно один байт -> "⟦HH⟧", разбор продолжается со следующего байта
//   (для побайтового экранирования это совпадает с «максимальной частью» WHATWG).
// - 3.2 шаг 5: дописывать "⟦U+002F⟧" к сегменту после его замены на "⟦⟧"/"⟦.⟧"/"⟦..⟧" (имя "/" -> "/⟦⟧⟦U+002F⟧",
//   "a/../" -> "/a/⟦..⟧⟦U+002F⟧"); выбрано: да, строго в порядке шагов 4 -> 5.
// - 3.2 шаг 8: только заглавная X (A–Z); "/c:" не трогается (toString VS Code понижает регистр только A–Z, так что
//   строчная форма переживает toString -> parse); выбрано: по тексту, только A–Z.
// - 3.1: fragment «пустой» — выбрано: строго "" (а также scheme/authority/path/query должны быть строками).
// - parse, вход: «объект URI» — выбрано: читаются только поля scheme/authority/path/query/fragment, класс не проверяется.
'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 − 1

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
  if (cp >= 0x10000 && (cp & 0xFFFE) === 0xFFFE) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [lo, hi] of RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function ucode(cp) {
  return '⟦U+' + cp.toString(16).toUpperCase().padStart(4, '0') + '⟧';
}

// Шаг 1: строгий UTF-8 (RFC 3629). Возвращает длину корректной последовательности в позиции i и код, или null.
function decodeAt(b, i) {
  const n = b.length;
  const b0 = b[i];
  if (b0 < 0x80) return [b0, 1];
  let len, min, cp;
  if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; min = 0x80; }
  else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; cp = b0 & 0x0F; min = 0x800; }
  else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; cp = b0 & 0x07; min = 0x10000; }
  else return null;
  if (i + len > n) return null;
  for (let k = 1; k < len; k++) {
    const c = b[i + k];
    if ((c & 0xC0) !== 0x80) return null;
    cp = (cp << 6) | (c & 0x3F);
  }
  if (cp < min) return null;
  if (cp > 0x10FFFF) return null;
  if (cp >= 0xD800 && cp <= 0xDFFF) return null;
  return [cp, len];
}

function makeLabel(name, index) {
  // Шаги 1–2
  let s = '';
  let i = 0;
  while (i < name.length) {
    const r = decodeAt(name, i);
    if (r === null) {
      s += '⟦' + hex2(name[i]) + '⟧';
      i += 1;
    } else {
      const cp = r[0];
      s += isEscapedChar(cp) ? ucode(cp) : String.fromCodePoint(cp);
      i += r[1];
    }
  }
  // Шаг 3
  let dir = false;
  if (s.endsWith('/')) { s = s.slice(0, -1); dir = true; }
  // Шаг 4
  const segs = s.split('/').map((seg) => {
    if (seg === '') return '⟦⟧';
    if (seg === '.') return '⟦.⟧';
    if (seg === '..') return '⟦..⟧';
    return seg;
  });
  // Шаг 5
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  // Шаг 6
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Шаг 7
  let path = '/' + segs.join('/');
  // Шаг 8
  if (path.length >= 3 && path[2] === ':' && path[1] >= 'A' && path[1] <= 'Z') {
    path = '/' + ucode(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

function archiveString(archive) {
  const p = archive.toString();
  if (typeof p !== 'string' || p === '') throw new Error('empty archive URI');
  if (p.includes('&') || p.includes('=')) throw new Error('archive URI contains & or =');
  if (URI.parse(p).toString() !== p) throw new Error('archive URI does not round-trip');
  return p;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new TypeError('name must be Uint8Array');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) throw new RangeError('bad index');
  const p = archiveString(archive);
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

function decodeEntry(e) {
  if (!/^[A-Za-z0-9_-]*$/.test(e)) return null;
  if (e.length % 4 === 1) return null;
  const buf = Buffer.from(e, 'base64url');
  if (buf.toString('base64url') !== e) return null;
  return new Uint8Array(buf);
}

function parse(uri) {
  try {
    if (uri === null || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    if (typeof scheme !== 'string' || typeof authority !== 'string' || typeof path !== 'string'
      || typeof query !== 'string' || typeof fragment !== 'string') return null;
    if (scheme !== SCHEME || authority !== AUTHORITY || fragment !== '') return null;

    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=')) return null;
    if (!parts[1].startsWith('entry=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const n = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(n)) return null;
      if (n.length > 16) return null;
      index = Number(n);
      if (!Number.isSafeInteger(index) || index > MAX_INDEX) return null;
    }
    if (p === '') return null;
    const name = decodeEntry(e);
    if (name === null) return null;
    const archive = URI.parse(p);
    if (archive.toString() !== p) return null;

    const c = build(archive, name, index);
    if (c.scheme !== scheme || c.authority !== authority || c.path !== path
      || c.query !== query || c.fragment !== fragment) return null;
    return { archive, name, index };
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
