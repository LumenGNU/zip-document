// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4 генератор «отказывает»: форма отказа не задана; выбрано: build бросает Error (для P, не прошедшего проверку, и для index > 2^53-1).
// - 3.3 «P не содержит "=" »: проверяется на всей строке P (включая значение после "archive="); выбрано: любой "=" или "&" в P — отказ/неканоничность.
// - 3.4 query делится по "&" на 2 или 3 части: если частей иное число или префиксы не по порядку — не каноничен; значение index проверяется как /^[1-9][0-9]*$/ и <= 2^53-1.
// - 3.2 шаг 8: "/X:" проверяется на готовом path после вставки сегмента номера; заменяется только X (двоеточие остаётся).
// - 3.2 шаг 6: при единственном сегменте номер вставляется перед ним (путь /⟦#1⟧/seg).
// - 3.2 «корректная последовательность UTF-8»: стандартные границы RFC 3629 (E0 A0.., ED ..9F, F0 90.., F4 ..8F); при сбое экранируется только первый байт.
// - parse: канонический ли URI, проверяется перестроением через build из извлечённой тройки и строгим сравнением всех компонентов; не-URI-объект/исключение -> null.
// - 3.3 E: строгий base64url без паддинга; длина mod 4 == 1 или неканонические хвостовые биты — неканонично (проверка повторным кодированием).
const { URI } = require('vscode-uri');

const RANGES = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F], [0x0600, 0x0605],
  [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F], [0x0890, 0x0891], [0x08E2, 0x08E2],
  [0x115F, 0x1160], [0x1680, 0x1680], [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B],
  [0x200E, 0x200F], [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB],
  [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD], [0x13430, 0x1343F],
  [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF],
];
function isEsc(cp) {
  if (cp > 0xFFFF && (cp & 0xFFFE) === 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
const uesc = (cp) => '\u27E6U+' + hex(cp, 4) + '\u27E7';

function label(name, index) {
  let s = '';
  const n = name.length;
  let i = 0;
  while (i < n) {
    const b = name[i];
    let len = 0, cp = 0, lo = 0x80, hi = 0xBF;
    if (b < 0x80) { s += isEsc(b) ? uesc(b) : String.fromCharCode(b); i++; continue; }
    if (b >= 0xC2 && b <= 0xDF) { len = 2; cp = b & 0x1F; }
    else if (b >= 0xE0 && b <= 0xEF) { len = 3; cp = b & 0x0F; if (b === 0xE0) lo = 0xA0; if (b === 0xED) hi = 0x9F; }
    else if (b >= 0xF0 && b <= 0xF4) { len = 4; cp = b & 0x07; if (b === 0xF0) lo = 0x90; if (b === 0xF4) hi = 0x8F; }
    let ok = len > 0 && i + len <= n;
    if (ok) {
      for (let k = 1; k < len; k++) {
        const c = name[i + k];
        const l = k === 1 ? lo : 0x80, h = k === 1 ? hi : 0xBF;
        if (c < l || c > h) { ok = false; break; }
        cp = (cp << 6) | (c & 0x3F);
      }
    }
    if (!ok) { s += '\u27E6' + hex(b, 2) + '\u27E7'; i++; continue; }
    s += isEsc(cp) ? uesc(cp) : String.fromCodePoint(cp);
    i += len;
  }
  let dir = false;
  if (s.endsWith('/')) { s = s.slice(0, -1); dir = true; }
  const segs = s.split('/').map((x) => x === '' ? '\u27E6\u27E7' : x === '.' ? '\u27E6.\u27E7' : x === '..' ? '\u27E6..\u27E7' : x);
  if (dir) segs[segs.length - 1] += '\u27E6U+002F\u27E7';
  if (index >= 1) segs.splice(segs.length - 1, 0, '\u27E6#' + index + '\u27E7');
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/' + uesc(m[1].charCodeAt(0)) + path.slice(2);
  return path;
}

const MAXI = 9007199254740991n;

function build(archive, name, index) {
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=') || URI.parse(P).toString() !== P) {
    throw new Error('no URI for this archive');
  }
  if (!Number.isInteger(index) || index < 0 || BigInt(index) > MAXI) throw new Error('bad index');
  const E = Buffer.from(name).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + index;
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: label(name, index), query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const parts = uri.query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice(8);
    const E = parts[1].slice(6);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N) || BigInt(N) > MAXI) return null;
      index = Number(N);
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E) || E.length % 4 === 1) return null;
    const bytes = new Uint8Array(Buffer.from(E, 'base64url'));
    if (Buffer.from(bytes).toString('base64url') !== E) return null;
    if (P === '' || P.includes('&') || P.includes('=')) return null;
    const archive = URI.parse(P);
    if (archive.toString() !== P) return null;
    const rebuilt = build(archive, bytes, index);
    if (rebuilt.scheme !== uri.scheme || rebuilt.authority !== uri.authority || rebuilt.path !== uri.path ||
        rebuilt.query !== uri.query || rebuilt.fragment !== uri.fragment) return null;
    return { archive, name: bytes, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
