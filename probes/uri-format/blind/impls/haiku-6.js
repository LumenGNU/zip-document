// НЕОДНОЗНАЧНОСТИ:
// - 3.2, шаг 8: «готовый path начинается с "/X:"» — буквальный префикс пути (имя "C:x" даёт "/⟦U+0043⟧:x")
//   или только первый сегмент, равный "X:" (тогда "C:x" остаётся "/C:x"); выбрано: буквальный префикс
'use strict';

const { URI } = require('vscode-uri');

const MAX_INDEX = 2n ** 53n - 1n;

// Таблица шага 2 (3.2), диапазоны включительно.
const TABLE = [
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

function needsEscape(cp) {
  for (const [a, b] of TABLE) {
    if (cp >= a && cp <= b) return true;
  }
  // nFFFE–nFFFF в плоскостях 1–16 (плоскость 0 покрыта таблицей).
  return (cp & 0xFFFE) === 0xFFFE;
}

function uHex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

function byteHex(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

// Читает одну корректную UTF-8 последовательность (RFC 3629) начиная с i.
// Возвращает { cp, len } или null.
function decodeOne(bytes, i) {
  const b0 = bytes[i];
  if (b0 < 0x80) return { cp: b0, len: 1 };
  let len, cp, lo = 0x80, hi = 0xBF;
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    len = 2; cp = b0 & 0x1F;
  } else if (b0 >= 0xE0 && b0 <= 0xEF) {
    len = 3; cp = b0 & 0x0F;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F; // суррогаты
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    len = 4; cp = b0 & 0x07;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F; // не выше U+10FFFF
  } else {
    return null;
  }
  if (i + len > bytes.length) return null;
  for (let k = 1; k < len; k++) {
    const b = bytes[i + k];
    const min = k === 1 ? lo : 0x80;
    const max = k === 1 ? hi : 0xBF;
    if (b < min || b > max) return null;
    cp = (cp << 6) | (b & 0x3F);
  }
  return { cp, len };
}

// Метка (path) из (имя, index), шаги 1–8 (3.2).
function makePath(name, index) {
  // Шаги 1–2: побайтно слева направо.
  let s = '';
  let i = 0;
  while (i < name.length) {
    const d = decodeOne(name, i);
    if (d === null) {
      s += '⟦' + byteHex(name[i]) + '⟧';
      i += 1;
    } else {
      s += needsEscape(d.cp)
        ? '⟦U+' + uHex(d.cp) + '⟧'
        : String.fromCodePoint(d.cp);
      i += d.len;
    }
  }
  // Шаг 3: один завершающий "/" снимается.
  let trailing = false;
  if (s.endsWith('/')) {
    trailing = true;
    s = s.slice(0, -1);
  }
  // Шаг 4: деление по "/", служебные сегменты.
  const segs = s.split('/').map((x) => {
    if (x === '') return '⟦⟧';
    if (x === '.') return '⟦.⟧';
    if (x === '..') return '⟦..⟧';
    return x;
  });
  // Шаг 5.
  if (trailing) segs[segs.length - 1] += '⟦U+002F⟧';
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (/^\/[A-Z]:/.test(path)) {
    const cp = path.charCodeAt(1);
    path = '/⟦U+' + uHex(cp) + '⟧' + path.slice(2);
  }
  return path;
}

// P — toString() архива; если P не годится в query (3.3), возвращает null.
function archiveString(archive) {
  let P;
  try {
    P = archive.toString();
  } catch {
    return null;
  }
  if (typeof P !== 'string' || P === '' || P.includes('&') || P.includes('=')) return null;
  let again;
  try {
    again = URI.parse(P).toString();
  } catch {
    return null;
  }
  return again === P ? P : null;
}

function build(archive, name, index) {
  const P = archiveString(archive);
  if (P === null) throw new Error('у тройки нет URI: архив');
  if (!(name instanceof Uint8Array)) throw new Error('имя: нужны байты');
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index вне диапазона');

  const E = Buffer.from(name).toString('base64url');
  const query = 'archive=' + P + '&entry=' + E + (index >= 1 ? '&index=' + String(index) : '');
  const path = makePath(name, index);
  return URI.from({ scheme: 'zip-document', authority: 'v1', path, query, fragment: '' });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') {
      return null;
    }
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
      const big = BigInt(N);
      if (big > MAX_INDEX) return null;
      index = Number(big);
    }

    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const name = new Uint8Array(Buffer.from(E, 'base64url'));
    if (Buffer.from(name).toString('base64url') !== E) return null;

    const archive = URI.parse(P);
    // Каноничность: URI должен совпасть покомпонентно с URI, построенным из извлечённой тройки.
    const canon = build(archive, name, index);
    if (
      canon.scheme !== uri.scheme ||
      canon.authority !== uri.authority ||
      canon.path !== uri.path ||
      canon.query !== uri.query ||
      canon.fragment !== uri.fragment
    ) {
      return null;
    }
    return { archive, name, index };
  } catch {
    return null;
  }
}

module.exports = { build, parse };
