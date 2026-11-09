// НЕОДНОЗНАЧНОСТИ:
// - нет
'use strict';
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

function isHidden(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true;
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex2(b) { return b.toString(16).toUpperCase().padStart(2, '0'); }
function uform(cp) { return '⟦U+' + cp.toString(16).toUpperCase().padStart(4, '0') + '⟧'; }

// Returns array of tokens: each is a string (already escaped or plain char).
function decodeName(bytes) {
  const out = [];
  const n = bytes.length;
  let i = 0;
  const cont = (k) => k < n && bytes[k] >= 0x80 && bytes[k] <= 0xBF;
  while (i < n) {
    const b = bytes[i];
    let len = 0;
    let cp = 0;
    if (b < 0x80) { len = 1; cp = b; }
    else if (b >= 0xC2 && b <= 0xDF) {
      if (cont(i + 1)) { len = 2; cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F); }
    } else if (b >= 0xE0 && b <= 0xEF) {
      let lo = 0x80, hi = 0xBF;
      if (b === 0xE0) lo = 0xA0;
      if (b === 0xED) hi = 0x9F;
      if (i + 1 < n && bytes[i + 1] >= lo && bytes[i + 1] <= hi && cont(i + 2)) {
        len = 3;
        cp = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
      }
    } else if (b >= 0xF0 && b <= 0xF4) {
      let lo = 0x80, hi = 0xBF;
      if (b === 0xF0) lo = 0x90;
      if (b === 0xF4) hi = 0x8F;
      if (i + 1 < n && bytes[i + 1] >= lo && bytes[i + 1] <= hi && cont(i + 2) && cont(i + 3)) {
        len = 4;
        cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      }
    }
    if (len === 0) {
      out.push('⟦' + hex2(b) + '⟧');
      i += 1;
    } else {
      out.push(isHidden(cp) ? uform(cp) : String.fromCodePoint(cp));
      i += len;
    }
  }
  return out;
}

function makeLabel(name, index) {
  let s = decodeName(name).join('');
  let dir = false;
  if (s.endsWith('/')) { dir = true; s = s.slice(0, -1); }
  const segs = s.split('/').map((x) => (x === '' ? '⟦⟧' : x === '.' ? '⟦.⟧' : x === '..' ? '⟦..⟧' : x));
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  let path = '/' + segs.join('/');
  const m = /^\/([A-Z]):/.exec(path);
  if (m) path = '/' + uform(m[1].charCodeAt(0)) + path.slice(2);
  return path;
}

function build(archive, name, index) {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > Number.MAX_SAFE_INTEGER) {
    throw new Error('bad index');
  }
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=') || URI.parse(P).toString() !== P) {
    throw new Error('no URI for archive');
  }
  const bytes = Uint8Array.from(name);
  const E = Buffer.from(bytes).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: 'zip-document',
    authority: 'v1',
    path: makeLabel(bytes, index),
    query,
    fragment: '',
  });
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
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      index = Number(N);
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E) || E.length % 4 === 1) return null;
    const name = Buffer.from(E, 'base64url');
    const archive = URI.parse(P);
    const rebuilt = build(archive, name, index);
    if (
      rebuilt.scheme !== uri.scheme ||
      rebuilt.authority !== uri.authority ||
      rebuilt.path !== uri.path ||
      rebuilt.query !== uri.query ||
      rebuilt.fragment !== uri.fragment
    ) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
