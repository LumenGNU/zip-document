// НЕОДНОЗНАЧНОСТИ:
// - 3.4 генератор: «отказывает» для тройки без URI; выбрано: build бросает исключение (index не целое, <0, >2^53-1; P с "&"/"=" или P != toString(Uri.parse(P)); имя не Uint8Array).
// - 3.2 шаг 8: «начинается с /X:» при X-сегменте, у которого после двоеточия ничего нет (путь "/C:"); выбрано: заменяется (проверяется только префикс "/X:").
// - 3.2 шаг 8: проверка после шага 6/7 — если первым сегментом стал "⟦#N⟧", префикса нет; выбрано: по готовому path буквально.
// - 3.3 E: «каноническая форма» base64url; выбрано: символы [A-Za-z0-9_-], без "=", повторное кодирование декодированных байт даёт ту же строку.
// - 3.3 N: верхняя граница 2^53-1 включительно; выбрано: сравнение через BigInt, затем Number.
// - 3.4 parse: значения query "как есть"; P с "=" внутри (после префикса) -> неканонично; выбрано: так. Значение P с "?"/"#" не специально проверяется, только равенство toString(Uri.parse(P)); исключение Uri.parse -> null.
// - 3.4 parse: сравнение с построенным URI по path и query строго; scheme/authority/fragment сравниваются строго со значениями "zip-document"/"v1"/"".
// - 3.2 шаг 1: «корректная последовательность» в оборванных/избыточных случаях; выбрано: на первом байте, не начинающем полную корректную последовательность, экранируется один байт, чтение идёт со следующего.
// - 3.2 шаг 2: nFFFE–nFFFF в плоскостях 1–16 реализовано как (cp & 0xFFFF) >= 0xFFFE при cp > 0xFFFF.
// - 3.2 шаг 4/5: имя "/" -> после снятия "/" остаётся "" -> один сегмент ""; выбрано как в примере.
'use strict';
const { URI } = require('vscode-uri');

const RANGES = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD], [0x034F], [0x0600, 0x0605], [0x061C], [0x06DD], [0x070F],
  [0x0890, 0x0891], [0x08E2], [0x115F, 0x1160], [0x1680], [0x17B4, 0x17B5], [0x180E], [0x2000, 0x200B],
  [0x200E, 0x200F], [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6], [0x3000], [0x3164], [0xFDD0, 0xFDEF],
  [0xFEFF], [0xFFA0], [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF], [0x110BD], [0x110CD], [0x13430, 0x1343F],
  [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF],
];
function listed(cp) {
  if (cp > 0xFFFF && cp <= 0x10FFFF && (cp & 0xFFFF) >= 0xFFFE) return true;
  for (const r of RANGES) {
    if (cp >= r[0] && cp <= (r.length > 1 ? r[1] : r[0])) return true;
  }
  return false;
}
function hex(n, min) {
  let s = n.toString(16).toUpperCase();
  while (s.length < min) s = '0' + s;
  return s;
}
const MAXI = 9007199254740991;

// returns array of pieces (strings), each either a char or an escape
function labelPieces(b) {
  const out = [];
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    let cp = -1, len = 0;
    if (c < 0x80) { cp = c; len = 1; }
    else if (c >= 0xC2 && c <= 0xDF) {
      if (i + 1 < n && (b[i + 1] & 0xC0) === 0x80) { cp = ((c & 0x1F) << 6) | (b[i + 1] & 0x3F); len = 2; }
    } else if (c >= 0xE0 && c <= 0xEF) {
      if (i + 2 < n && (b[i + 1] & 0xC0) === 0x80 && (b[i + 2] & 0xC0) === 0x80) {
        const v = ((c & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
        if (v >= 0x800 && !(v >= 0xD800 && v <= 0xDFFF)) { cp = v; len = 3; }
      }
    } else if (c >= 0xF0 && c <= 0xF4) {
      if (i + 3 < n && (b[i + 1] & 0xC0) === 0x80 && (b[i + 2] & 0xC0) === 0x80 && (b[i + 3] & 0xC0) === 0x80) {
        const v = ((c & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F);
        if (v >= 0x10000 && v <= 0x10FFFF) { cp = v; len = 4; }
      }
    }
    if (cp < 0) { out.push('\u27E6' + hex(c, 2) + '\u27E7'); i++; continue; }
    if (listed(cp)) out.push('\u27E6U+' + hex(cp, 4) + '\u27E7');
    else out.push(String.fromCodePoint(cp));
    i += len;
  }
  return out;
}

function makeLabel(b, index) {
  const pieces = labelPieces(b);
  let dir = false;
  if (pieces.length && pieces[pieces.length - 1] === '/') { pieces.pop(); dir = true; }
  const segs = [];
  let cur = '';
  for (const p of pieces) {
    if (p === '/') { segs.push(cur); cur = ''; } else cur += p;
  }
  segs.push(cur);
  for (let k = 0; k < segs.length; k++) {
    if (segs[k] === '') segs[k] = '\u27E6\u27E7';
    else if (segs[k] === '.') segs[k] = '\u27E6.\u27E7';
    else if (segs[k] === '..') segs[k] = '\u27E6..\u27E7';
  }
  if (dir) segs[segs.length - 1] += '\u27E6U+002F\u27E7';
  if (index >= 1) segs.splice(segs.length - 1, 0, '\u27E6#' + String(index) + '\u27E7');
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/\u27E6U+' + hex(m[1].charCodeAt(0), 4) + '\u27E7' + path.slice(2);
  return path;
}

function b64u(b) { return Buffer.from(b).toString('base64url'); }

function archiveP(archive) {
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=') || URI.parse(P).toString() !== P) {
    throw new Error('archive URI is not representable');
  }
  return P;
}

function buildParts(P, name, index) {
  if (!(name instanceof Uint8Array)) throw new Error('name must be Uint8Array');
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAXI) {
    throw new Error('bad index');
  }
  const path = makeLabel(name, index);
  let query = 'archive=' + P + '&entry=' + b64u(name);
  if (index >= 1) query += '&index=' + String(index);
  return { path, query };
}

function build(archive, name, index) {
  const P = archiveP(archive);
  const { path, query } = buildParts(P, name, index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path, query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
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
      if (BigInt(N) > BigInt(MAXI)) return null;
      index = Number(N);
    }
    if (P === '' || P.includes('=')) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    if (E.length % 4 === 1) return null;
    const bytes = new Uint8Array(Buffer.from(E, 'base64url'));
    if (b64u(bytes) !== E) return null;
    const archive = URI.parse(P);
    if (archive.toString() !== P) return null;
    const exp = buildParts(P, bytes, index);
    if (uri.path !== exp.path || uri.query !== exp.query) return null;
    return { archive, name: bytes, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
