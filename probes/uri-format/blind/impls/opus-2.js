// НЕОДНОЗНАЧНОСТИ:
// - 3.4 «генератор отказывает»: форма отказа не задана; выбрано: build бросает Error (на неверные
//   типы аргументов, index не целое / < 0 / > 2^53 − 1).
// - 3.3 P: сказано, что P не содержит "&", "=" и совпадает с toString(Uri.parse(P)), но не сказано,
//   что делать генератору, если для данного объекта URI архива это вдруг не так; выбрано: build
//   проверяет оба условия и при нарушении отказывает (иначе построенный URI не принял бы провайдер).
// - 3.5 «архив — Uri.parse(P)»: строгий или нестрогий режим parse не указан; выбрано: URI.parse(P)
//   по умолчанию (strict = false). На результат не влияет: P обязан совпасть с toString(parse(P)).
// - 3.4 проверка каноничности: выбрано буквальное определение — извлечь тройку из query, построить
//   по ней URI через build и сравнить все пять компонентов строгим равенством; E декодируется как
//   base64url и обязан перекодироваться в ту же строку, N — /^[1-9][0-9]*$/ и <= 2^53 − 1.
// - 3.2 шаг 1: «любой другой байт» понят побайтно: если с текущего байта не начинается корректная
//   последовательность, экранируется только он, следующие байты разбираются заново (а не «максимальная
//   часть» по Unicode). Например, E0 80 → "⟦E0⟧⟦80⟧", усечённая E2 9F → "⟦E2⟧⟦9F⟧".
// - 3.2 шаг 8: проверяется итоговый path после шагов 1–7 (с учётом вставленного "⟦#N⟧"), только
//   заглавные A–Z; строчная буква диска ("/c:") остаётся как есть.
// - parse: вход не объект URI (строка, null, объект без нужных полей) — возвращается null.

'use strict';
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 9007199254740991; // 2^53 - 1

// Таблица символов шага 2 (замороженная).
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

function isListed(cp) {
  if (cp >= 0x10000 && (cp & 0xFFFE) === 0xFFFE) return true; // nFFFE–nFFFF, плоскости 1–16
  for (const [a, b] of RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function uEsc(cp) {
  return '⟦U+' + hex(cp, 4) + '⟧';
}

// Корректная последовательность UTF-8 (RFC 3629) с позиции i: [cp, длина] или null.
function readUtf8(b, i) {
  const n = b.length;
  const b0 = b[i];
  if (b0 <= 0x7F) return [b0, 1];
  const cont = (k, lo = 0x80, hi = 0xBF) => i + k < n && b[i + k] >= lo && b[i + k] <= hi;
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    if (cont(1)) return [((b0 & 0x1F) << 6) | (b[i + 1] & 0x3F), 2];
    return null;
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
    if (cont(1, lo, hi) && cont(2)) {
      return [((b0 & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F), 3];
    }
    return null;
  }
  if (b0 >= 0xF0 && b0 <= 0xF4) {
    let lo = 0x80, hi = 0xBF;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
    if (cont(1, lo, hi) && cont(2) && cont(3)) {
      return [((b0 & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F), 4];
    }
    return null;
  }
  return null;
}

function label(name, index) {
  // Шаги 1–2: последовательность токенов; '/' из имени — отдельный токен-символ.
  let s = '';
  // Строим строку, где разделителем служит сам '/', — экранирования не содержат '/'.
  let i = 0;
  while (i < name.length) {
    const r = readUtf8(name, i);
    if (r === null) {
      s += '⟦' + hex(name[i], 2) + '⟧';
      i += 1;
      continue;
    }
    const cp = r[0];
    s += isListed(cp) ? uEsc(cp) : String.fromCodePoint(cp);
    i += r[1];
  }
  // Шаг 3.
  let dir = false;
  if (s.endsWith('/')) {
    s = s.slice(0, -1);
    dir = true;
  }
  // Шаг 4.
  const segs = s.split('/').map((seg) => {
    if (seg === '') return '⟦⟧';
    if (seg === '.') return '⟦.⟧';
    if (seg === '..') return '⟦..⟧';
    return seg;
  });
  // Шаг 5.
  if (dir) segs[segs.length - 1] += uEsc(0x2F);
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (path.length >= 3 && path[2] === ':') {
    const c = path.charCodeAt(1);
    if (c >= 0x41 && c <= 0x5A) path = '/' + uEsc(c) + path.slice(2);
  }
  return path;
}

function toBuffer(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

function archiveString(archive) {
  if (!URI.isUri(archive)) throw new Error('archive: not a URI');
  const a = archive instanceof URI ? archive : URI.from(archive);
  const P = a.toString();
  if (typeof P !== 'string' || P.includes('&') || P.includes('=')) {
    throw new Error('archive: toString() contains "&" or "="');
  }
  if (URI.parse(P).toString() !== P) {
    throw new Error('archive: toString() is not stable under parse');
  }
  return P;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new Error('name: Uint8Array expected');
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('index: integer in 0..2^53-1 expected');
  }
  const P = archiveString(archive);
  const E = toBuffer(name).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
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
    if (uri === null || typeof uri !== 'object') return null;
    const { scheme, authority, path, query, fragment } = uri;
    if (![scheme, authority, path, query, fragment].every((x) => typeof x === 'string')) return null;
    if (scheme !== SCHEME || authority !== AUTHORITY || fragment !== '') return null;

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
      if (BigInt(N) > BigInt(MAX_INDEX)) return null;
      index = Number(N);
    }

    if (P === '' || P.includes('=')) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E) || E.length % 4 === 1) return null;
    const buf = Buffer.from(E, 'base64url');
    if (buf.toString('base64url') !== E) return null;
    const name = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    const archive = URI.parse(P);
    const built = build(archive, name, index);
    if (built.scheme !== scheme || built.authority !== authority || built.path !== path ||
        built.query !== query || built.fragment !== fragment) {
      return null;
    }
    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = { build, parse };
