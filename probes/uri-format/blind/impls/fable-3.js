// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4 (генератор): условие «P совпадает со своим toString(Uri.parse(P))» сформулировано как
//   свойство P, а не как явное условие отказа; неясно, должен ли генератор сам его проверять, если
//   у переданного объекта URI toString() не идемпотентна; выбрано: генератор проверяет, что P
//   непуст, не содержит "&" и "=" и P === URI.parse(P).toString(), иначе отказывает (бросает Error).
// - 3.4 (генератор): форма отказа не задана; выбрано: исключение Error (также для index не целого,
//   < 0 или > 2^53 − 1 и для name не Uint8Array).
// - 3.4 (провайдер): «каноничен, если равен URI, построенному из какой-либо тройки» — архив тройки
//   при проверке берётся как Uri.parse(P) (3.5); выбрано: URI каноничен, если P непуст, без "&"/"=",
//   P === URI.parse(P).toString(), E — каноничный base64url без паддинга (повторное кодирование
//   декодированных байт даёт ровно E), N по 3.3, а path строго равен метке, построенной по 3.2 из
//   (декодированное имя, index); scheme/authority/fragment — строгое равенство строк.
// - 3.2 шаг 4: сравнение сегмента с "", ".", ".." — по строке после шагов 1–2 (экранированный байт
//   или символ не равен "."); выбрано так, по смыслу это то же, что сравнение исходных символов.
// - parse: вход «любого вида» — объект без строковых полей scheme/authority/path/query/fragment
//   считается неканоническим (null), а не ошибкой.

'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 2 ** 53 - 1;

// Список шага 2 (замороженный).
const RANGES = [
  [0x0000, 0x001f], [0x007f, 0x00a0], [0x00ad, 0x00ad], [0x034f, 0x034f],
  [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x115f, 0x1160], [0x1680, 0x1680],
  [0x17b4, 0x17b5], [0x180e, 0x180e], [0x2000, 0x200b], [0x200e, 0x200f],
  [0x2028, 0x202f], [0x205f, 0x206f], [0x27e6, 0x27e6], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xfdd0, 0xfdef], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff0, 0xfffb], [0xfffe, 0xffff], [0x110bd, 0x110bd], [0x110cd, 0x110cd],
  [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe00ff], [0xe01f0, 0xe0fff],
];

function inList(cp) {
  if (cp >= 0x10000 && (cp & 0xfffe) === 0xfffe) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function escCp(cp) {
  return '⟦U+' + hex(cp, 4) + '⟧';
}

// Шаг 1: байты -> токены { cp } или { byte }.
function decodeUtf8(bytes) {
  const out = [];
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b0 = bytes[i];
    let len = 0, cp = 0, min = 0;
    if (b0 < 0x80) { out.push({ cp: b0 }); i++; continue; }
    else if (b0 >= 0xc2 && b0 <= 0xdf) { len = 2; cp = b0 & 0x1f; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { len = 3; cp = b0 & 0x0f; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { len = 4; cp = b0 & 0x07; min = 0x10000; }
    let ok = len > 0 && i + len <= n;
    if (ok) {
      for (let k = 1; k < len; k++) {
        const b = bytes[i + k];
        if ((b & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (b & 0x3f);
      }
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (ok) { out.push({ cp }); i += len; }
    else { out.push({ byte: b0 }); i++; }
  }
  return out;
}

function label(name, index) {
  const toks = decodeUtf8(name);
  // Шаг 3: снять один завершающий "/".
  let dir = false;
  if (toks.length > 0 && toks[toks.length - 1].cp === 0x2f) { toks.pop(); dir = true; }
  // Шаги 2 и 4: отрисовка и деление по "/".
  const segs = [];
  let cur = '';
  for (const t of toks) {
    if (t.byte !== undefined) { cur += '⟦' + hex(t.byte, 2) + '⟧'; continue; }
    const cp = t.cp;
    if (cp === 0x2f) { segs.push(cur); cur = ''; continue; }
    cur += inList(cp) ? escCp(cp) : String.fromCodePoint(cp);
  }
  segs.push(cur);
  for (let k = 0; k < segs.length; k++) {
    if (segs[k] === '') segs[k] = '⟦⟧';
    else if (segs[k] === '.') segs[k] = '⟦.⟧';
    else if (segs[k] === '..') segs[k] = '⟦..⟧';
  }
  // Шаг 5.
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + index + '⟧');
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (path.length >= 3 && path[1] >= 'A' && path[1] <= 'Z' && path[2] === ':') {
    path = '/' + escCp(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

function b64urlEncode(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

function validP(P) {
  if (typeof P !== 'string' || P === '') return false;
  if (P.includes('&') || P.includes('=')) return false;
  return URI.parse(P).toString() === P;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new Error('name must be Uint8Array');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('no URI for this index');
  }
  if (!archive || typeof archive.toString !== 'function') throw new Error('bad archive');
  const P = archive.toString();
  if (!validP(P)) throw new Error('no URI for this archive');
  let query = 'archive=' + P + '&entry=' + b64urlEncode(name);
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: label(name, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    if ([scheme, authority, path, query, fragment].some((s) => typeof s !== 'string')) return null;
    if (scheme !== SCHEME || authority !== AUTHORITY || fragment !== '') return null;

    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=')) return null;
    if (!parts[1].startsWith('entry=')) return null;
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

    if (!validP(P)) return null;

    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const buf = Buffer.from(E, 'base64url');
    if (buf.toString('base64url') !== E) return null;
    const name = new Uint8Array(buf.length);
    name.set(buf);

    if (path !== label(name, index)) return null;

    return { archive: URI.parse(P), name, index };
  } catch {
    return null;
  }
}

module.exports = { build, parse };
