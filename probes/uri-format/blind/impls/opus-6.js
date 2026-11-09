// НЕОДНОЗНАЧНОСТИ:
// нет
'use strict';
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 2 ** 53 - 1;

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
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true; // nFFFE–nFFFF, planes 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// Length of a valid UTF-8 sequence (RFC 3629) starting at i, and its code point; null if none.
function utf8At(b, i) {
  const b0 = b[i];
  if (b0 < 0x80) return [1, b0];
  let len, min, cp;
  if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; min = 0x80; }
  else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; cp = b0 & 0x0F; min = 0x800; }
  else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; cp = b0 & 0x07; min = 0x10000; }
  else return null;
  if (i + len > b.length) return null;
  for (let k = 1; k < len; k++) {
    const c = b[i + k];
    if ((c & 0xC0) !== 0x80) return null;
    cp = (cp << 6) | (c & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
  return [len, cp];
}

function makeLabel(name, index) {
  // Steps 1–2
  let s = '';
  let i = 0;
  while (i < name.length) {
    const r = utf8At(name, i);
    if (r === null) {
      s += '⟦' + hex(name[i], 2) + '⟧';
      i += 1;
    } else {
      const cp = r[1];
      s += isEscapedChar(cp) ? '⟦U+' + hex(cp, 4) + '⟧' : String.fromCodePoint(cp);
      i += r[0];
    }
  }
  // Step 3
  let dir = false;
  if (s.endsWith('/')) { dir = true; s = s.slice(0, -1); }
  // Step 4
  const segs = s.split('/').map((seg) => {
    if (seg === '') return '⟦⟧';
    if (seg === '.') return '⟦.⟧';
    if (seg === '..') return '⟦..⟧';
    return seg;
  });
  // Step 5
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  // Step 6
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Step 7
  let path = '/' + segs.join('/');
  // Step 8
  if (path.length >= 3 && path[0] === '/' && path[2] === ':' && path[1] >= 'A' && path[1] <= 'Z') {
    path = '/⟦U+' + hex(path.charCodeAt(1), 4) + '⟧' + path.slice(2);
  }
  return path;
}

function validP(P) {
  if (typeof P !== 'string' || P === '' || P.includes('&') || P.includes('=')) return false;
  try {
    return URI.parse(P).toString() === P;
  } catch (e) {
    return false;
  }
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) throw new Error('bad index');
  const bytes = name instanceof Uint8Array ? name : new Uint8Array(name);
  const P = archive.toString();
  if (!validP(P)) throw new Error('archive URI has no entry URI');
  const E = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: makeLabel(bytes, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') return null;
    const parts = uri.query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice('archive='.length);
    const E = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > BigInt(MAX_INDEX)) return null;
      index = Number(N);
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const name = Buffer.from(E, 'base64url');
    if (name.toString('base64url') !== E) return null;
    if (!validP(P)) return null;
    const archive = URI.parse(P);
    const expected = build(archive, name, index);
    if (expected.scheme !== uri.scheme || expected.authority !== uri.authority ||
        expected.path !== uri.path || expected.query !== uri.query ||
        expected.fragment !== uri.fragment) return null;
    return { archive, name: new Uint8Array(name), index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
