// НЕОДНОЗНАЧНОСТИ:
// - 3.4 «генератор отказывает»: способ отказа не задан; выбрано: build бросает Error.
// - 3.3 «toString(Uri.parse(P))»: не сказано, строгий ли разбор (у Uri.parse есть флаг strict); выбрано: URI.parse(P) по умолчанию (нестрогий), toString() без skipEncoding; исключение при разборе — отказ.
// - 3.2 шаг 1: «оборванная последовательность экранируется по одному байту» — выбрано: при любой неудаче на ведущем байте экранируется только он, чтение продолжается со следующего байта (продолжения затем экранируются как одиночные байты), что совпадает с примером E2 82 41.
// - 3.2 шаг 8: проверяется только заглавная A–Z непосредственно после начального "/" и за ней ":"; строчные не трогаются; применяется один раз к готовому path.
// - build: входной index не целое, < 0 или > 2^53 − 1 — отказ (Error); name принимается как Uint8Array/Buffer.
// - parse: имя возвращается как обычный Uint8Array (не Buffer); archive — URI.parse(P).
const { URI } = require('vscode-uri');

const MAX_INDEX = 9007199254740991;
const L = '\u27E6', R = '\u27E7';

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

function inTable(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex2(b) { return b.toString(16).toUpperCase().padStart(2, '0'); }
function escCp(cp) { return L + 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') + R; }

// Strict UTF-8 (RFC 3629) decode of one sequence at i; returns [cp, len] or null.
function decodeAt(b, i) {
  const b0 = b[i];
  if (b0 < 0x80) return [b0, 1];
  const cont = (k, lo = 0x80, hi = 0xBF) => i + k < b.length && b[i + k] >= lo && b[i + k] <= hi;
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    if (cont(1)) return [((b0 & 0x1F) << 6) | (b[i + 1] & 0x3F), 2];
    return null;
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
    if (cont(1, lo, hi) && cont(2))
      return [((b0 & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F), 3];
    return null;
  }
  if (b0 >= 0xF0 && b0 <= 0xF4) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
    if (cont(1, lo, hi) && cont(2) && cont(3))
      return [((b0 & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F), 4];
    return null;
  }
  return null;
}

function label(name, index) {
  // Steps 1–2
  let s = '';
  for (let i = 0; i < name.length;) {
    const r = decodeAt(name, i);
    if (r === null) { s += L + hex2(name[i]) + R; i += 1; continue; }
    const [cp, len] = r;
    s += inTable(cp) ? escCp(cp) : String.fromCodePoint(cp);
    i += len;
  }
  // Step 3
  let dir = false;
  if (s.endsWith('/')) { dir = true; s = s.slice(0, -1); }
  // Step 4
  const segs = s.split('/').map(x =>
    x === '' ? L + R : x === '.' ? L + '.' + R : x === '..' ? L + '..' + R : x);
  // Step 5
  if (dir) segs[segs.length - 1] += escCp(0x2F);
  // Step 6
  if (index >= 1) segs.splice(segs.length - 1, 0, L + '#' + String(index) + R);
  // Step 7
  let path = '/' + segs.join('/');
  // Step 8
  if (path.length >= 3 && path[1] >= 'A' && path[1] <= 'Z' && path[2] === ':')
    path = '/' + escCp(path.charCodeAt(1)) + path.slice(2);
  return path;
}

function validP(P) {
  if (typeof P !== 'string' || P === '' || P.includes('&') || P.includes('=')) return false;
  try { return URI.parse(P).toString() === P; } catch { return false; }
}

function b64(name) { return Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url'); }

function compose(P, name, index) {
  let query = 'archive=' + P + '&entry=' + b64(name);
  if (index >= 1) query += '&index=' + String(index);
  return { scheme: 'zip-document', authority: 'v1', path: label(name, index), query, fragment: '' };
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) throw new Error('no URI: bad index');
  if (!(name instanceof Uint8Array)) throw new Error('no URI: name must be Uint8Array');
  const P = archive.toString();
  if (!validP(P)) throw new Error('no URI: bad archive URI');
  return URI.from(compose(P, name, index));
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string' || typeof uri.path !== 'string') return null;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const P = parts[0].slice(8);
    const E = parts[1].slice(6);
    if (!validP(P)) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const buf = Buffer.from(E, 'base64url');
    if (buf.toString('base64url') !== E) return null;
    const name = new Uint8Array(buf);
    let index = 0;
    if (parts.length === 3) {
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N) || N.length > 16) return null;
      index = Number(N);
      if (!(index <= MAX_INDEX)) return null;
    }
    const c = compose(P, name, index);
    if (uri.path !== c.path || q !== c.query) return null;
    return { archive: URI.parse(P), name, index };
  } catch {
    return null;
  }
}

module.exports = { build, parse };
