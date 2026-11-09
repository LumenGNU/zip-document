// НЕОДНОЗНАЧНОСТИ:
// - 3.4 генератор «отказывает»: форма отказа не задана; выбрано: build бросает Error (для невалидного P, index вне 0..2^53-1, нецелого index).
// - 3.2 шаг 3: «завершающий "/"» — после шага 2; выбрано: снимается последний символ "/" строки (экранированные "⟦U+002F⟧" в строке не появляются на этом шаге, т.к. "/" не в таблице).
// - 3.2 шаг 6: при одном сегменте "перед последним сегментом" — выбрано: "⟦#N⟧" становится первым из двух сегментов.
// - 3.2 шаг 8: «начинается с "/X:"» — выбрано: проверка только трёх символов "/", A–Z, ":" (после ":" любое продолжение, в т.ч. конец пути).
// - 3.3 P «не содержит "="»: выбрано, что проверяется весь P (в том числе после "archive="), т.е. любой "=" в P делает URI недействительным; parse при этом делит query по "&" и снимает префикс только один раз.
// - 3.4 parse: «неканонический -> null» реализован как пересборка URI из извлечённой тройки и строгое сравнение пяти полей; нестроковые/битые поля -> null.
// - 3.3 N «до 2^53−1»: проверка по BigInt для строки; для build — Number.isSafeInteger.
// - 3.2 «корректная последовательность UTF-8»: символы U+0000 и т.п. в таблице экранируются; чтение — собственный строгий декодер RFC 3629.
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
function inTable(cp) {
  if (cp >= 0x10000 && cp <= 0x10FFFF && (cp & 0xFFFF) >= 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
function hex(n, min) {
  let s = n.toString(16).toUpperCase();
  while (s.length < min) s = '0' + s;
  return s;
}
const OPEN = '\u27E6', CLOSE = '\u27E7';
const esc = (s) => OPEN + s + CLOSE;

function isCont(b) { return b !== undefined && b >= 0x80 && b <= 0xBF; }

function labelOf(name, index) {
  let out = '';
  const n = name.length;
  let i = 0;
  while (i < n) {
    const b = name[i];
    let cp = -1, len = 1;
    if (b < 0x80) { cp = b; }
    else if (b >= 0xC2 && b <= 0xDF) {
      if (isCont(name[i + 1])) { cp = ((b & 0x1F) << 6) | (name[i + 1] & 0x3F); len = 2; }
    } else if (b >= 0xE0 && b <= 0xEF) {
      const b1 = name[i + 1], b2 = name[i + 2];
      let lo = 0x80, hi = 0xBF;
      if (b === 0xE0) lo = 0xA0;
      if (b === 0xED) hi = 0x9F;
      if (b1 !== undefined && b1 >= lo && b1 <= hi && isCont(b2)) {
        cp = ((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F); len = 3;
      }
    } else if (b >= 0xF0 && b <= 0xF4) {
      const b1 = name[i + 1], b2 = name[i + 2], b3 = name[i + 3];
      let lo = 0x80, hi = 0xBF;
      if (b === 0xF0) lo = 0x90;
      if (b === 0xF4) hi = 0x8F;
      if (b1 !== undefined && b1 >= lo && b1 <= hi && isCont(b2) && isCont(b3)) {
        cp = ((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F); len = 4;
      }
    }
    if (cp < 0) { out += esc(hex(b, 2)); i += 1; continue; }
    out += inTable(cp) ? esc('U+' + hex(cp, 4)) : String.fromCodePoint(cp);
    i += len;
  }
  let trailing = false;
  if (out.endsWith('/')) { out = out.slice(0, -1); trailing = true; }
  const segs = out.split('/').map((s) => (s === '' ? esc('') : s === '.' ? esc('.') : s === '..' ? esc('..') : s));
  if (trailing) segs[segs.length - 1] += esc('U+002F');
  if (index >= 1) segs.splice(segs.length - 1, 0, esc('#' + String(index)));
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/' + esc('U+' + hex(m[1].charCodeAt(0), 4)) + path.slice(2);
  return path;
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index out of range');
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=') || URI.parse(P).toString() !== P) {
    throw new Error('archive URI not representable');
  }
  let query = 'archive=' + P + '&entry=' + b64url(name);
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: labelOf(name, index), query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string' || typeof uri.path !== 'string') return null;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
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
    const bytes = new Uint8Array(Buffer.from(E, 'base64url'));
    if (b64url(bytes) !== E) return null;
    if (P === '' || P.includes('=')) return null;
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
