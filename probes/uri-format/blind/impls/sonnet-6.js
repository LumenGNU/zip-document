// НЕОДНОЗНАЧНОСТИ:
// - 3.3 P: режим Uri.parse не задан; выбрано: URI.parse(P) в режиме по умолчанию (нестрогий)
// - 3.4 имя в query: "значения берутся как есть"; выбрано: E считается каноничным, только если это base64url без паддинга и повторное кодирование декодированного даёт ту же строку (то есть и нулевые лишние биты)
// - 3.2 шаг 8: "начинается с /X:" проверяется по готовому path, включая случай, когда path равен ровно "/X:"; выбрано: заменяется и в этом случае
'use strict';
const { URI } = require('vscode-uri');

const MAXI = Number.MAX_SAFE_INTEGER;
const RANGES = [
  [0x0, 0x1F], [0x7F, 0xA0], [0xAD, 0xAD], [0x34F, 0x34F], [0x600, 0x605], [0x61C, 0x61C],
  [0x6DD, 0x6DD], [0x70F, 0x70F], [0x890, 0x891], [0x8E2, 0x8E2], [0x115F, 0x1160],
  [0x1680, 0x1680], [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B], [0x200E, 0x200F],
  [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000], [0x3164, 0x3164],
  [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF],
  [0x110BD, 0x110BD], [0x110CD, 0x110CD], [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3],
  [0x1D173, 0x1D17A], [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF],
];
function special(cp) {
  if (cp > 0xFFFF && (cp & 0xFFFE) === 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
const O = '\u27E6', C = '\u27E7';
const uform = cp => O + 'U+' + hex(cp, 4) + C;

function label(name, index) {
  const b = name;
  let s = '';
  let i = 0;
  const n = b.length;
  const cont = k => k < n && b[k] >= 0x80 && b[k] <= 0xBF;
  while (i < n) {
    const x = b[i];
    let len = 0, cp = 0;
    if (x < 0x80) { len = 1; cp = x; }
    else if (x >= 0xC2 && x <= 0xDF && cont(i + 1)) { len = 2; cp = ((x & 0x1F) << 6) | (b[i + 1] & 0x3F); }
    else if (x >= 0xE0 && x <= 0xEF && i + 2 < n && cont(i + 1) && cont(i + 2)) {
      const y = b[i + 1];
      if ((x === 0xE0 && y < 0xA0) || (x === 0xED && y > 0x9F)) len = 0;
      else { len = 3; cp = ((x & 0x0F) << 12) | ((y & 0x3F) << 6) | (b[i + 2] & 0x3F); }
    } else if (x >= 0xF0 && x <= 0xF4 && i + 3 < n && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const y = b[i + 1];
      if ((x === 0xF0 && y < 0x90) || (x === 0xF4 && y > 0x8F)) len = 0;
      else { len = 4; cp = ((x & 0x07) << 18) | ((y & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F); }
    }
    if (len === 0) { s += O + hex(x, 2) + C; i += 1; continue; }
    s += special(cp) ? uform(cp) : String.fromCodePoint(cp);
    i += len;
  }
  let trailing = false;
  if (s.endsWith('/')) { trailing = true; s = s.slice(0, -1); }
  const segs = s.split('/').map(g => g === '' ? O + C : g === '.' ? O + '.' + C : g === '..' ? O + '..' + C : g);
  if (trailing) segs[segs.length - 1] += uform(0x2F);
  if (index >= 1) segs.splice(segs.length - 1, 0, O + '#' + String(index) + C);
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/' + uform(m[1].charCodeAt(0)) + path.slice(2);
  return path;
}

function build(archive, name, index) {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAXI) throw new Error('index');
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=') || URI.parse(P).toString() !== P) throw new Error('archive');
  const bytes = Uint8Array.from(name);
  const E = Buffer.from(bytes).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: label(bytes, index), query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string') return null;
    const parts = q.split('&');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice(8), E = parts[1].slice(6);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > BigInt(MAXI)) return null;
      index = Number(N);
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const name = Buffer.from(E, 'base64url');
    if (name.toString('base64url') !== E) return null;
    const archive = URI.parse(P);
    const expected = build(archive, name, index);
    if (expected.scheme !== uri.scheme || expected.authority !== uri.authority || expected.path !== uri.path ||
        expected.query !== uri.query || expected.fragment !== uri.fragment) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
