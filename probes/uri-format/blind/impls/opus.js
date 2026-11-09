// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4, генератор: не сказано, что делать build, если URI архива не даёт допустимого P
//   (toString() пустой, содержит "&"/"=", или toString(Uri.parse(P)) !== P), и при index > 2^53 − 1
//   («URI нет»); выбрано: build бросает исключение (канонического URI для такой тройки нет).
// - 3.4, провайдер: архив, который возвращает parse, — Uri.parse(P) (по 3.5), а каноничность
//   проверяется построением URI заново из (Uri.parse(P), имя, index) и покомпонентным сравнением;
//   отсюда же требование P === toString(Uri.parse(P)) и непустого P.
// - 3.3, E: «base64url без паддинга» — строгость декодирования явно задана только примерами;
//   выбрано: принимается E, только если он равен base64url-кодированию декодированных байт
//   (алфавит A–Z a–z 0–9 - _, длина mod 4 ≠ 1, нулевые хвостовые биты, без "=").
// - 3.2 шаг 1: «любой другой байт» — выбрано: при неудаче байт выводится как "⟦HH⟧", разбор
//   продолжается со следующего байта (последующие байты оборванной последовательности тоже
//   экранируются поштучно, т.к. сами по себе не начинают корректную последовательность).
// - parse, вход не похож на URI (поля не строки и т. п.): выбрано — null.
'use strict';
const { URI } = require('vscode-uri');

const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 − 1

const RANGES = [
  [0x0000, 0x001f], [0x007f, 0x00a0], [0x00ad, 0x00ad], [0x034f, 0x034f],
  [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x115f, 0x1160], [0x1680, 0x1680],
  [0x17b4, 0x17b5], [0x180e, 0x180e], [0x2000, 0x200b], [0x200e, 0x200f],
  [0x2028, 0x202f], [0x205f, 0x206f], [0x27e6, 0x27e6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xfdd0, 0xfdef], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff0, 0xfffb], [0xfffe, 0xffff], [0x110bd, 0x110bd], [0x110cd, 0x110cd],
  [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe00ff],
  [0xe01f0, 0xe0fff],
];

function isListed(cp) {
  if (cp >= 0x10000 && (cp & 0xfffe) === 0xfffe) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function cpEscape(cp) {
  return '⟦U+' + hex(cp, 4) + '⟧';
}

function isCont(b) {
  return b >= 0x80 && b <= 0xbf;
}

// Шаги 1–2: байты -> строка с экранированиями.
function escapeBytes(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let cp = -1;
    let len = 0;
    if (b0 < 0x80) {
      cp = b0; len = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 < n && isCont(bytes[i + 1])) {
        cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f); len = 2;
      }
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 < n) {
        const b1 = bytes[i + 1], b2 = bytes[i + 2];
        const lo = b0 === 0xe0 ? 0xa0 : 0x80;
        const hi = b0 === 0xed ? 0x9f : 0xbf;
        if (b1 >= lo && b1 <= hi && isCont(b2)) {
          cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f); len = 3;
        }
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 < n) {
        const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3];
        const lo = b0 === 0xf0 ? 0x90 : 0x80;
        const hi = b0 === 0xf4 ? 0x8f : 0xbf;
        if (b1 >= lo && b1 <= hi && isCont(b2) && isCont(b3)) {
          cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
          len = 4;
        }
      }
    }
    if (len === 0) {
      out += '⟦' + hex(b0, 2) + '⟧';
      i += 1;
      continue;
    }
    out += isListed(cp) ? cpEscape(cp) : String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

function makeLabel(name, index) {
  let s = escapeBytes(name);                       // шаги 1–2
  let dir = false;
  if (s.endsWith('/')) { s = s.slice(0, -1); dir = true; } // шаг 3
  const segs = s.split('/').map((seg) => {         // шаг 4
    if (seg === '') return '⟦⟧';
    if (seg === '.') return '⟦.⟧';
    if (seg === '..') return '⟦..⟧';
    return seg;
  });
  if (dir) segs[segs.length - 1] += cpEscape(0x2f); // шаг 5
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧'); // шаг 6
  let path = '/' + segs.join('/');                 // шаг 7
  const c = path.charCodeAt(1);
  if (path.length >= 3 && c >= 0x41 && c <= 0x5a && path[2] === ':') { // шаг 8
    path = '/' + cpEscape(c) + path.slice(2);
  }
  return path;
}

function archiveString(archive) {
  const p = archive.toString();
  if (typeof p !== 'string' || p === '' || p.includes('&') || p.includes('=')) {
    throw new Error('archive URI has no valid string form');
  }
  if (URI.parse(p).toString() !== p) {
    throw new Error('archive URI string form is not stable');
  }
  return p;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new TypeError('name must be Uint8Array');
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError('index out of range');
  }
  const p = archiveString(archive);
  const e = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
  let query = 'archive=' + p + '&entry=' + e;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: 'zip-document',
    authority: 'v1',
    path: makeLabel(name, index),
    query,
    fragment: '',
  });
}

function decodeEntry(e) {
  if (!/^[A-Za-z0-9_-]*$/.test(e) || e.length % 4 === 1) return null;
  const buf = Buffer.from(e, 'base64url');
  if (buf.toString('base64url') !== e) return null;
  return new Uint8Array(buf);
}

function parse(uri) {
  try {
    if (!uri || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    if (![scheme, authority, path, query, fragment].every((x) => typeof x === 'string')) return null;
    if (scheme !== 'zip-document' || authority !== 'v1' || fragment !== '') return null;
    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const n = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(n) || n.length > 16) return null;
      index = Number(n);
      if (!Number.isSafeInteger(index) || index > MAX_INDEX) return null;
    }
    if (p === '') return null;
    const name = decodeEntry(e);
    if (name === null) return null;
    const archive = URI.parse(p);
    const canon = build(archive, name, index);
    if (canon.scheme !== scheme || canon.authority !== authority || canon.path !== path ||
        canon.query !== query || canon.fragment !== fragment) {
      return null;
    }
    return { archive, name, index };
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
