// НЕОДНОЗНАЧНОСТИ:
// - 3.2 шаг 1: что делать с оборванной/некорректной многобайтной последовательностью; выбрано: первый байт -> "⟦HH⟧", чтение продолжается со следующего байта (каждый байт проверяется заново)
// - 3.2 шаг 3: "завершающий /" берётся из строки после шагов 1-2 (экранирования "/" не содержат), снимается ровно один
// - 3.2 шаг 8: проверка "/X:" делается по итоговому path после шага 7 (в т.ч. при наличии сегмента "⟦#N⟧")
// - 3.3/3.4: генератор для архива, у которого P содержит "&"/"=" или P != toString(Uri.parse(P)), и для index вне 0..2^53-1 или нецелого; выбрано: бросает исключение
// - 3.4: "каноничен" проверяется как полное совпадение с build(parse-тройка); при ошибке разбора P (исключение Uri.parse) результат null
// - 3.3: E: допустимы только символы A-Za-z0-9_-, длина %4 != 1, и перекодирование декодированных байт даёт ту же строку (иначе не канонично)
// - 3.4: пустой P считается неканоничным (не равен toString(Uri.parse("")))
// - 3.4: query делится по "&" на 2 или 3 части; значения берутся как есть; "archive=" с пустым значением -> null
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
function isEscaped(cp) {
  if (cp > 0xFFFF && (cp & 0xFFFF) >= 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexU = (cp) => cp.toString(16).toUpperCase().padStart(4, '0');

function label(name, index) {
  let s = '';
  const n = name.length;
  let i = 0;
  while (i < n) {
    const b = name[i];
    let len = 0, cp = -1;
    const c = (k) => i + k < n && (name[i + k] & 0xC0) === 0x80;
    if (b < 0x80) { len = 1; cp = b; }
    else if (b >= 0xC2 && b <= 0xDF) {
      if (c(1)) { len = 2; cp = ((b & 0x1F) << 6) | (name[i + 1] & 0x3F); }
    } else if (b >= 0xE0 && b <= 0xEF) {
      if (c(1) && c(2)) {
        const v = ((b & 0x0F) << 12) | ((name[i + 1] & 0x3F) << 6) | (name[i + 2] & 0x3F);
        if (v >= 0x800 && !(v >= 0xD800 && v <= 0xDFFF)) { len = 3; cp = v; }
      }
    } else if (b >= 0xF0 && b <= 0xF4) {
      if (c(1) && c(2) && c(3)) {
        const v = ((b & 0x07) << 18) | ((name[i + 1] & 0x3F) << 12) | ((name[i + 2] & 0x3F) << 6) | (name[i + 3] & 0x3F);
        if (v >= 0x10000 && v <= 0x10FFFF) { len = 4; cp = v; }
      }
    }
    if (len === 0) { s += '\u27E6' + hex2(b) + '\u27E7'; i++; continue; }
    s += isEscaped(cp) ? '\u27E6U+' + hexU(cp) + '\u27E7' : String.fromCodePoint(cp);
    i += len;
  }
  let trailing = false;
  if (s.endsWith('/')) { trailing = true; s = s.slice(0, -1); }
  const segs = s.split('/').map((x) => (x === '' ? '\u27E6\u27E7' : x === '.' ? '\u27E6.\u27E7' : x === '..' ? '\u27E6..\u27E7' : x));
  if (trailing) segs[segs.length - 1] += '\u27E6U+002F\u27E7';
  if (index >= 1) segs.splice(segs.length - 1, 0, '\u27E6#' + String(index) + '\u27E7');
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/\u27E6U+' + hexU(m[1].charCodeAt(0)) + '\u27E7' + path.slice(2);
  return path;
}

const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function goodP(P) {
  if (P === '' || P.includes('&') || P.includes('=')) return false;
  return URI.parse(P).toString() === P;
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('bad index');
  const P = archive.toString();
  if (!goodP(P)) throw new Error('bad archive');
  let query = 'archive=' + P + '&entry=' + b64u(name);
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: label(name, index), query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const parts = uri.query.split('&');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice(8);
    const E = parts[1].slice(6);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > 9007199254740991n) return null;
      index = Number(N);
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E) || E.length % 4 === 1) return null;
    const name = new Uint8Array(Buffer.from(E, 'base64'));
    if (b64u(name) !== E) return null;
    if (!goodP(P)) return null;
    const archive = URI.parse(P);
    if (uri.path !== label(name, index)) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
