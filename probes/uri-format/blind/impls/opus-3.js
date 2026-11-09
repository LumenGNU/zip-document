// НЕОДНОЗНАЧНОСТИ:
// - 3.3, P: «P не содержит "&" и "=" … и совпадает со своим toString(Uri.parse(P))» можно прочесть
//   как утверждение о toString() или как условие существования URI; выбрано: условие — генератор
//   отказывает, если archive.toString() пуст, содержит "&" или "=", или не равен
//   toString(Uri.parse(P)); провайдер принимает только P, равный toString(Uri.parse(P)).
// - 3.4, «генератор … отказывает»: способ отказа не задан; выбрано: build бросает Error (также при
//   index не целом/отрицательном/больше 2^53 − 1 и при name не Uint8Array).
// - 3.4/3.5, канонический E: «base64url без паддинга» не говорит явно о ненулевых хвостовых битах;
//   выбрано: E каноничен, только если повторное кодирование декодированных байт даёт ровно E
//   (поэтому "QR" отвергается, как в списке примеров).
// - 3.4, проверка каноничности: выбрано — извлечь тройку из query (архив = Uri.parse(P)), построить
//   по ней URI заново и сравнить все пять полей строгим равенством.
// - parse: что считать URI на входе, не уточнено; выбрано: любой объект со строковыми полями
//   scheme/authority/path/query/fragment, иначе null; name возвращается как Uint8Array (не Buffer).
// - 3.2 шаг 8: проверяется только заглавная буква A–Z, как написано; "/c:" остаётся как есть.

'use strict';
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 − 1

const RANGES = [
  [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F],
  [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
  [0x0890, 0x0891], [0x08E2, 0x08E2], [0x115F, 0x1160], [0x1680, 0x1680],
  [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B], [0x200E, 0x200F],
  [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
  [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD],
  [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE00FF],
  [0xE01F0, 0xE0FFF],
];

function isListed(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFF) >= 0xFFFE) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

const cpEsc = (cp) => '⟦U+' + hex(cp, 4) + '⟧';

// Шаг 1: строгое чтение UTF-8 (RFC 3629). Возвращает длину корректной последовательности
// и её код, либо null.
function readUtf8(b, i) {
  const b0 = b[i];
  const cont = (k, lo = 0x80, hi = 0xBF) => i + k < b.length && b[i + k] >= lo && b[i + k] <= hi;
  if (b0 < 0x80) return [1, b0];
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    if (cont(1)) return [2, ((b0 & 0x1F) << 6) | (b[i + 1] & 0x3F)];
    return null;
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
    if (cont(1, lo, hi) && cont(2)) {
      return [3, ((b0 & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F)];
    }
    return null;
  }
  if (b0 >= 0xF0 && b0 <= 0xF4) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
    if (cont(1, lo, hi) && cont(2) && cont(3)) {
      return [4, ((b0 & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F)];
    }
    return null;
  }
  return null;
}

function label(name, index) {
  // Шаги 1–2: токены — строки; литеральный "/" остаётся отдельным токеном "/".
  const toks = [];
  for (let i = 0; i < name.length;) {
    const r = readUtf8(name, i);
    if (r === null) {
      toks.push('⟦' + hex(name[i], 2) + '⟧');
      i += 1;
    } else {
      const cp = r[1];
      toks.push(isListed(cp) ? cpEsc(cp) : String.fromCodePoint(cp));
      i += r[0];
    }
  }
  // Шаг 3.
  let dir = false;
  if (toks.length > 0 && toks[toks.length - 1] === '/') {
    toks.pop();
    dir = true;
  }
  // Шаг 4.
  const segs = [''];
  for (const t of toks) {
    if (t === '/') segs.push('');
    else segs[segs.length - 1] += t;
  }
  for (let k = 0; k < segs.length; k++) {
    if (segs[k] === '') segs[k] = '⟦⟧';
    else if (segs[k] === '.') segs[k] = '⟦.⟧';
    else if (segs[k] === '..') segs[k] = '⟦..⟧';
  }
  // Шаг 5.
  if (dir) segs[segs.length - 1] += cpEsc(0x2F);
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (path.length >= 3 && path[2] === ':' && path[1] >= 'A' && path[1] <= 'Z') {
    path = '/' + cpEsc(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

function archiveString(archive) {
  const p = archive.toString();
  if (typeof p !== 'string' || p === '') return null;
  if (p.includes('&') || p.includes('=')) return null;
  if (URI.parse(p).toString() !== p) return null;
  return p;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new Error('name must be Uint8Array');
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('no URI for this index');
  }
  const p = archiveString(archive);
  if (p === null) throw new Error('no URI for this archive');
  const e = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
  let query = 'archive=' + p + '&entry=' + e;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({ scheme: SCHEME, authority: AUTHORITY, path: label(name, index), query, fragment: '' });
}

function decodeEntry(e) {
  if (!/^[A-Za-z0-9_-]*$/.test(e) || e.length % 4 === 1) return null;
  const buf = Buffer.from(e, 'base64url');
  if (buf.toString('base64url') !== e) return null;
  return new Uint8Array(buf);
}

function parse(uri) {
  try {
    if (uri === null || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    if ([scheme, authority, path, query, fragment].some((s) => typeof s !== 'string')) return null;
    if (scheme !== SCHEME || authority !== AUTHORITY || fragment !== '') return null;
    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      const n = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(n)) return null;
      index = Number(n);
      if (!Number.isSafeInteger(index) || String(index) !== n) return null;
    }
    const name = decodeEntry(e);
    if (name === null) return null;
    if (p === '') return null;
    const archive = URI.parse(p);
    let canon;
    try {
      canon = build(archive, name, index);
    } catch {
      return null;
    }
    if (canon.scheme !== scheme || canon.authority !== authority || canon.path !== path ||
        canon.query !== query || canon.fragment !== fragment) return null;
    return { archive, name, index };
  } catch {
    return null;
  }
}

module.exports = { build, parse };
