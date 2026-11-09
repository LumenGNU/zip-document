// НЕОДНОЗНАЧНОСТИ:
// - 3.3 build при index > 2^53-1 или нечисловом/дробном/отрицательном index: "URI нет", а интерфейс требует URI; выбрано: бросать RangeError/TypeError
// - 3.3 P в build: не сказано, что делать, если toString() архива не совпадает со своим toString(Uri.parse(P)); выбрано: брать toString() как есть, не проверять
// - 3.2 шаг 5 для последнего сегмента "" (имя "/" или "a//"): "⟦⟧" заменяется до дописывания; выбрано: "⟦⟧⟦U+002F⟧"
// - 3.2 шаг 8: "/X:" проверяется после шага 7 (с учётом вставленного "⟦#N⟧" и экранирований); заменяется только X
// - 3.4 parse: сравнение с каноническим URI реализовано пересборкой из извлечённой тройки и покомпонентным сравнением строк; вход не-URI даёт null
// - 3.2 шаг 1: после недопустимого байта чтение продолжается со следующего байта (в т.ч. при оборванной последовательности; по одному "⟦HH⟧" на каждый байт)
const { URI } = require('vscode-uri');

const RANGES = [
  [0x0000,0x001F],[0x007F,0x00A0],[0x00AD],[0x034F],[0x0600,0x0605],[0x061C],[0x06DD],[0x070F],
  [0x0890,0x0891],[0x08E2],[0x115F,0x1160],[0x1680],[0x17B4,0x17B5],[0x180E],[0x2000,0x200B],
  [0x200E,0x200F],[0x2028,0x202F],[0x205F,0x206F],[0x27E6],[0x3000],[0x3164],[0xFDD0,0xFDEF],
  [0xFEFF],[0xFFA0],[0xFFF0,0xFFFB],[0xFFFE,0xFFFF],[0x110BD],[0x110CD],[0x13430,0x1343F],
  [0x1BCA0,0x1BCA3],[0x1D173,0x1D17A],[0xE0000,0xE00FF],[0xE01F0,0xE0FFF],
];
function escapedChar(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFE) === 0xFFFE) return true;
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
function uesc(cp) { return '\u27E6U+' + hex(cp, 4) + '\u27E7'; }

function label(name, index) {
  const toks = []; // строки-токены; "/" — разделитель
  const n = name.length;
  let i = 0;
  const cont = (k) => k < n && (name[k] & 0xC0) === 0x80;
  while (i < n) {
    const b = name[i];
    let len = 0, cp = 0;
    if (b < 0x80) { len = 1; cp = b; }
    else if (b >= 0xC2 && b <= 0xDF && cont(i + 1)) { len = 2; cp = ((b & 0x1F) << 6) | (name[i+1] & 0x3F); }
    else if (b >= 0xE0 && b <= 0xEF && cont(i + 1) && cont(i + 2)) {
      const b1 = name[i+1];
      if (!((b === 0xE0 && b1 < 0xA0) || (b === 0xED && b1 > 0x9F))) {
        len = 3; cp = ((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (name[i+2] & 0x3F);
      }
    } else if (b >= 0xF0 && b <= 0xF4 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const b1 = name[i+1];
      if (!((b === 0xF0 && b1 < 0x90) || (b === 0xF4 && b1 > 0x8F))) {
        len = 4; cp = ((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((name[i+2] & 0x3F) << 6) | (name[i+3] & 0x3F);
      }
    }
    if (len === 0) { toks.push('\u27E6' + hex(b, 2) + '\u27E7'); i++; continue; }
    i += len;
    if (escapedChar(cp)) toks.push(uesc(cp));
    else toks.push(String.fromCodePoint(cp));
  }
  let trailing = false;
  if (toks.length && toks[toks.length - 1] === '/') { toks.pop(); trailing = true; }
  const segs = [];
  let cur = '';
  for (const t of toks) {
    if (t === '/') { segs.push(cur); cur = ''; } else cur += t;
  }
  segs.push(cur);
  for (let k = 0; k < segs.length; k++) {
    if (segs[k] === '') segs[k] = '\u27E6\u27E7';
    else if (segs[k] === '.') segs[k] = '\u27E6.\u27E7';
    else if (segs[k] === '..') segs[k] = '\u27E6..\u27E7';
  }
  if (trailing) segs[segs.length - 1] += uesc(0x2F);
  if (index >= 1) segs.splice(segs.length - 1, 0, '\u27E6#' + String(index) + '\u27E7');
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/' + uesc(m[1].charCodeAt(0)) + path.slice(2);
  return path;
}

function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function build(archive, name, index) {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new TypeError('bad index');
  if (index > Number.MAX_SAFE_INTEGER) throw new RangeError('index too large');
  let query = 'archive=' + archive.toString() + '&entry=' + b64u(name);
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: label(name, index), query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const P = parts[0].slice(8);
    const E = parts[1].slice(6);
    if (P === '' || P.includes('=')) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    let index = 0;
    if (parts.length === 3) {
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      index = Number(N);
    }
    const archive = URI.parse(P);
    if (archive.toString() !== P) return null;
    const name = new Uint8Array(Buffer.from(E, 'base64url'));
    if (b64u(name) !== E) return null;
    const c = build(archive, name, index);
    if (c.scheme !== uri.scheme || c.authority !== uri.authority || c.path !== uri.path ||
        c.query !== uri.query || c.fragment !== uri.fragment) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
