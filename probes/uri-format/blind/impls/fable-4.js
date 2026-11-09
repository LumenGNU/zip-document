// НЕОДНОЗНАЧНОСТИ:
// - 3.3/3.4 «генератор отказывает»: способ отказа не задан; выбрано: build бросает Error
//   (также при index не целом, < 0 или > 2^53 − 1 и при name не Uint8Array).
// - 3.2 шаг 1: «корректная последовательность» понята по таблице корректных UTF-8 (Unicode
//   Table 3-7: E0 A0–BF, ED 80–9F, F0 90–BF, F4 80–8F); при любой ошибке экранируется только
//   первый байт, чтение продолжается со следующего (не «максимальная подчасть»).
// - 3.2 шаги 3–8: применяются к строке, уже содержащей экранирования шагов 1–2 (в них нет "/",
//   так что порядок на результат не влияет).
// - 3.2 шаг 8: проверяется готовый path целиком; заменяется только сама буква X на "⟦U+00XX⟧".
// - 3.4 провайдер/parse: каноничность проверяется так — извлечь тройку из query по правилам 3.4,
//   проверить P (непуст, без "&" и "=", P === URI.parse(P).toString()), E (только
//   [A-Za-z0-9_-], повторное кодирование декодированных байтов даёт ровно E), N (^[1-9][0-9]*$,
//   ≤ 2^53 − 1), затем построить URI заново и сравнить все пять компонентов строгим равенством.
// - parse возвращает name как обычный Uint8Array (не Buffer), archive — URI.parse(P).
const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 2 ** 53 - 1;

// Список шага 2 (3.2), замороженная таблица.
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

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function cpEscape(cp) {
  return '⟦U+' + cp.toString(16).toUpperCase().padStart(4, '0') + '⟧';
}

// Пытается прочитать корректную последовательность UTF-8 с позиции i.
// Возвращает [codePoint, length] или null.
function decodeAt(b, i) {
  const n = b.length;
  const b0 = b[i];
  const cont = (x, lo = 0x80, hi = 0xbf) => x !== undefined && x >= lo && x <= hi;
  if (b0 <= 0x7f) return [b0, 1];
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    if (i + 1 < n && cont(b[i + 1])) return [((b0 & 0x1f) << 6) | (b[i + 1] & 0x3f), 2];
    return null;
  }
  if (b0 >= 0xe0 && b0 <= 0xef) {
    let lo = 0x80, hi = 0xbf;
    if (b0 === 0xe0) lo = 0xa0;
    if (b0 === 0xed) hi = 0x9f;
    if (i + 2 < n && cont(b[i + 1], lo, hi) && cont(b[i + 2])) {
      return [((b0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f), 3];
    }
    return null;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    let lo = 0x80, hi = 0xbf;
    if (b0 === 0xf0) lo = 0x90;
    if (b0 === 0xf4) hi = 0x8f;
    if (i + 3 < n && cont(b[i + 1], lo, hi) && cont(b[i + 2]) && cont(b[i + 3])) {
      return [((b0 & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f), 4];
    }
    return null;
  }
  return null;
}

function makeLabel(name, index) {
  // Шаги 1–2.
  let s = '';
  let i = 0;
  while (i < name.length) {
    const r = decodeAt(name, i);
    if (r === null) {
      s += '⟦' + hex2(name[i]) + '⟧';
      i += 1;
      continue;
    }
    const [cp, len] = r;
    s += isListed(cp) ? cpEscape(cp) : String.fromCodePoint(cp);
    i += len;
  }
  // Шаг 3.
  let dir = false;
  if (s.endsWith('/')) {
    dir = true;
    s = s.slice(0, -1);
  }
  // Шаг 4.
  const segs = s.split('/').map((seg) =>
    seg === '' ? '⟦⟧' : seg === '.' ? '⟦.⟧' : seg === '..' ? '⟦..⟧' : seg);
  // Шаг 5.
  if (dir) segs[segs.length - 1] += '⟦U+002F⟧';
  // Шаг 6.
  if (index >= 1) segs.splice(segs.length - 1, 0, '⟦#' + String(index) + '⟧');
  // Шаг 7.
  let path = '/' + segs.join('/');
  // Шаг 8.
  if (/^\/[A-Z]:/.test(path)) {
    path = '/' + cpEscape(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

function b64urlEncode(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

function archiveStringOk(p) {
  return typeof p === 'string' && p !== '' && !p.includes('&') && !p.includes('=') &&
    URI.parse(p).toString() === p;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new Error('name must be Uint8Array');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('no URI for this index');
  }
  const p = archive.toString();
  if (!archiveStringOk(p)) throw new Error('no URI for this archive');
  const e = b64urlEncode(name);
  let query = 'archive=' + p + '&entry=' + e;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: makeLabel(name, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') {
      return null;
    }
    const q = uri.query;
    if (typeof q !== 'string' || typeof uri.path !== 'string') return null;
    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
    if (parts.length === 3 && !parts[2].startsWith('index=')) return null;
    const p = parts[0].slice('archive='.length);
    const e = parts[1].slice('entry='.length);
    let index = 0;
    if (parts.length === 3) {
      const nStr = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(nStr)) return null;
      if (nStr.length > 16) return null;
      index = Number(nStr);
      if (!Number.isSafeInteger(index) || index > MAX_INDEX) return null;
    }
    if (!archiveStringOk(p)) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(e)) return null;
    const buf = Buffer.from(e, 'base64url');
    if (buf.toString('base64url') !== e) return null;
    const name = new Uint8Array(buf);
    const archive = URI.parse(p);
    const canon = build(archive, name, index);
    if (canon.scheme !== uri.scheme || canon.authority !== uri.authority ||
        canon.path !== uri.path || canon.query !== uri.query || canon.fragment !== uri.fragment) {
      return null;
    }
    return { archive, name, index };
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
