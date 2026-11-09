// НЕОДНОЗНАЧНОСТИ:
// - нет
'use strict';
const { URI } = require('vscode-uri');

const MAX = 2 ** 53 - 1;
const L = '⟦', R = '⟧';

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

function hex(n, w) {
  return n.toString(16).toUpperCase().padStart(w, '0');
}

// Steps 1-2: tokens; literal "/" is kept as a separate marker.
function decode(bytes) {
  const out = []; // strings; '/' entries are separators (only literal slash)
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    let cp = -1, len = 0;
    if (b < 0x80) { cp = b; len = 1; }
    else if (b >= 0xC2 && b <= 0xDF) {
      if (i + 1 < n && (bytes[i + 1] & 0xC0) === 0x80) { cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F); len = 2; }
    } else if (b >= 0xE0 && b <= 0xEF) {
      const lo = b === 0xE0 ? 0xA0 : 0x80, hi = b === 0xED ? 0x9F : 0xBF;
      if (i + 2 < n && bytes[i + 1] >= lo && bytes[i + 1] <= hi && (bytes[i + 2] & 0xC0) === 0x80) {
        cp = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F); len = 3;
      }
    } else if (b >= 0xF0 && b <= 0xF4) {
      const lo = b === 0xF0 ? 0x90 : 0x80, hi = b === 0xF4 ? 0x8F : 0xBF;
      if (i + 3 < n && bytes[i + 1] >= lo && bytes[i + 1] <= hi &&
          (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) {
        cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        len = 4;
      }
    }
    if (len === 0) {
      out.push({ s: L + hex(b, 2) + R });
      i += 1;
      continue;
    }
    i += len;
    if (cp === 0x2F) out.push({ slash: true });
    else if (inTable(cp)) out.push({ s: L + 'U+' + hex(cp, 4) + R });
    else out.push({ s: String.fromCodePoint(cp) });
  }
  return out;
}

function label(bytes, index) {
  const toks = decode(bytes);
  let dir = false;
  if (toks.length && toks[toks.length - 1].slash) { toks.pop(); dir = true; }
  const segs = [''];
  for (const t of toks) {
    if (t.slash) segs.push('');
    else segs[segs.length - 1] += t.s;
  }
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s === '' || s === '.' || s === '..') segs[k] = L + s + R;
  }
  if (dir) segs[segs.length - 1] += L + 'U+002F' + R;
  if (index >= 1) segs.splice(segs.length - 1, 0, L + '#' + String(index) + R);
  let path = '/' + segs.join('/');
  if (path.length >= 3 && path[2] === ':' && path[1] >= 'A' && path[1] <= 'Z') {
    path = '/' + L + 'U+' + hex(path.charCodeAt(1), 4) + R + path.slice(2);
  }
  return path;
}

function archiveString(archive) {
  const P = archive.toString();
  if (typeof P !== 'string' || P === '' || P.includes('&') || P.includes('=')) {
    throw new Error('no URI: bad archive');
  }
  if (URI.parse(P).toString() !== P) throw new Error('no URI: archive not canonical');
  return P;
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('no URI: bad index');
  const P = archiveString(archive);
  const bytes = Buffer.from(name.buffer, name.byteOffset, name.byteLength);
  const E = bytes.toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: 'zip-document',
    authority: 'v1',
    path: label(bytes, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document') return null;
    const q = uri.query;
    if (typeof q !== 'string') return null;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const P = parts[0].slice(8);
    const E = parts[1].slice(6);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice(6);
      if (!/^[1-9][0-9]*$/.test(N) || N.length > 16) return null;
      index = Number(N);
      if (!Number.isSafeInteger(index) || String(index) !== N) return null;
    }
    if (!/^[A-Za-z0-9_-]*$/.test(E) || E.length % 4 === 1) return null;
    const name = Buffer.from(E, 'base64url');
    if (name.toString('base64url') !== E) return null;
    if (P === '') return null;
    const archive = URI.parse(P);
    const c = build(archive, name, index);
    if (c.scheme !== uri.scheme || c.authority !== uri.authority || c.path !== uri.path ||
        c.query !== uri.query || c.fragment !== uri.fragment) return null;
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
