// НЕОДНОЗНАЧНОСТИ:
// нет
'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 9007199254740991; // 2^53 - 1

// 3.2, таблица шага 2.
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
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [lo, hi] of RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function cpForm(cp) {
  return '⟦U+' + cp.toString(16).toUpperCase().padStart(4, '0') + '⟧';
}

// Длина корректной последовательности UTF-8 (RFC 3629), начинающейся в i, или 0.
function utf8SeqLen(b, i) {
  const n = b.length;
  const b0 = b[i];
  const cont = (k, lo = 0x80, hi = 0xBF) => i + k < n && b[i + k] >= lo && b[i + k] <= hi;
  if (b0 <= 0x7F) return 1;
  if (b0 >= 0xC2 && b0 <= 0xDF) return cont(1) ? 2 : 0;
  if (b0 === 0xE0) return cont(1, 0xA0, 0xBF) && cont(2) ? 3 : 0;
  if ((b0 >= 0xE1 && b0 <= 0xEC) || b0 === 0xEE || b0 === 0xEF) return cont(1) && cont(2) ? 3 : 0;
  if (b0 === 0xED) return cont(1, 0x80, 0x9F) && cont(2) ? 3 : 0;
  if (b0 === 0xF0) return cont(1, 0x90, 0xBF) && cont(2) && cont(3) ? 4 : 0;
  if (b0 >= 0xF1 && b0 <= 0xF3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (b0 === 0xF4) return cont(1, 0x80, 0x8F) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

function decodeCp(b, i, len) {
  if (len === 1) return b[i];
  if (len === 2) return ((b[i] & 0x1F) << 6) | (b[i + 1] & 0x3F);
  if (len === 3) return ((b[i] & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
  return ((b[i] & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F);
}

function makeLabel(name, index) {
  const b = name;
  // Шаги 1–2: токены. Каждый токен — { text, slash }; slash — настоящий "/" имени.
  const tokens = [];
  let i = 0;
  while (i < b.length) {
    const len = utf8SeqLen(b, i);
    if (len === 0) {
      tokens.push({ text: '⟦' + hex2(b[i]) + '⟧', slash: false });
      i += 1;
      continue;
    }
    const cp = decodeCp(b, i, len);
    i += len;
    if (cp === 0x2F) {
      tokens.push({ text: '/', slash: true });
    } else if (isEscapedChar(cp)) {
      tokens.push({ text: cpForm(cp), slash: false });
    } else {
      tokens.push({ text: String.fromCodePoint(cp), slash: false });
    }
  }

  // Шаг 3.
  let trailing = false;
  if (tokens.length > 0 && tokens[tokens.length - 1].slash) {
    tokens.pop();
    trailing = true;
  }

  // Шаг 4.
  const segments = [];
  let cur = '';
  for (const t of tokens) {
    if (t.slash) {
      segments.push(cur);
      cur = '';
    } else {
      cur += t.text;
    }
  }
  segments.push(cur);
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    if (s === '' || s === '.' || s === '..') segments[k] = '⟦' + s + '⟧';
  }

  // Шаг 5.
  if (trailing) segments[segments.length - 1] += cpForm(0x2F);

  // Шаг 6.
  if (index >= 1) segments.splice(segments.length - 1, 0, '⟦#' + String(index) + '⟧');

  // Шаг 7.
  let path = '/' + segments.join('/');

  // Шаг 8.
  if (path.length >= 3 && path[2] === ':') {
    const c = path.charCodeAt(1);
    if (c >= 0x41 && c <= 0x5A) path = '/' + cpForm(c) + path.slice(2);
  }
  return path;
}

function checkP(P) {
  if (typeof P !== 'string' || P === '') return false;
  if (P.includes('&') || P.includes('=')) return false;
  let re;
  try {
    re = URI.parse(P).toString();
  } catch (e) {
    return false;
  }
  return re === P;
}

function toBytes(name) {
  if (!(name instanceof Uint8Array)) throw new TypeError('name must be Uint8Array');
  return name;
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError('invalid index');
  }
  const bytes = toBytes(name);
  const P = archive.toString();
  if (!checkP(P)) throw new Error('archive URI has no entry URI form');
  const E = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  const path = makeLabel(bytes, index);
  return URI.from({ scheme: SCHEME, authority: AUTHORITY, path, query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') return null;
    const query = uri.query;
    if (typeof query !== 'string' || typeof uri.path !== 'string') return null;
    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice('archive='.length);
    const E = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      const n = Number(N);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_INDEX || String(n) !== N) return null;
      index = n;
    }
    if (!checkP(P)) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const name = Buffer.from(E, 'base64url');
    if (name.toString('base64url') !== E) return null;
    const archive = URI.parse(P);
    const canon = build(archive, new Uint8Array(name), index);
    if (canon.scheme !== uri.scheme || canon.authority !== uri.authority || canon.path !== uri.path ||
        canon.query !== uri.query || canon.fragment !== uri.fragment) {
      return null;
    }
    return { archive, name: new Uint8Array(name), index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
