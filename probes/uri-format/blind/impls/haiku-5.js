// НЕОДНОЗНАЧНОСТИ:
// - 3.4, генератор: форма отказа не задана ("отказывает"); выбрано: build бросает Error
// - интерфейс build: вход вне области (index не безопасное целое >= 0, name не Uint8Array, archive без toString) не описан; выбрано: бросает Error
// - 3.4, P архива: "совпадает со своим toString(Uri.parse(P))" не сказано, что делать, если Uri.parse бросает; выбрано: отказ; пустой P тоже отказ
// - 3.2, шаг 1: как продолжать после оборванной последовательности не сказано явно; выбрано: жадное чтение с каждой позиции, неудача -> один байт "⟦HH⟧", чтение со следующего байта
// - 3.2, шаг 8: "/X:" — не сказано, нужно ли что-то после двоеточия и применяется ли к сегменту номера; выбрано: регэксп /^\/([A-Z]):/ по итоговому path, однократно; сегмент "⟦#N⟧" не совпадает
// - 3.4, parse: "значения берутся как есть" и "строгое равенство" покомпонентно; выбрано: E — /^[A-Za-z0-9_-]*$/ и повторное кодирование совпадает; N — /^[1-9][0-9]*$/ и <= 2^53-1 (BigInt); затем пересборка тройки и сравнение всех пяти полей строкой
// - 3.4, parse: поведение при "index=" вместе с двумя частями и при лишних "&" не сказано явно; выбрано: 2 или 3 части строго, иначе null
// - 3.5/интерфейс parse: тип имени в результате не задан (байты); выбрано: Uint8Array (копия, не Buffer); index — число, для отсутствующего index — 0
// - 3.2, таблица: "nFFFE–nFFFF в плоскостях 1–16" — плоскость 0 покрыта FFFE–FFFF; выбрано: пары для n=1..16 добавлены отдельно

'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 9007199254740991; // 2^53 - 1

const ESCAPED_RANGES = [
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
for (let n = 1; n <= 16; n++) {
  ESCAPED_RANGES.push([n * 0x10000 + 0xFFFE, n * 0x10000 + 0xFFFF]);
}

function isEscapedCp(cp) {
  for (const [lo, hi] of ESCAPED_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function uhex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

// Шаг 1–2 метки: байты -> строка символов с экранированием.
function labelChars(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  const cont = (k, lo = 0x80, hi = 0xBF) =>
    i + k < n && bytes[i + k] >= lo && bytes[i + k] <= hi;
  while (i < n) {
    const b = bytes[i];
    let len = 0;
    let cp = 0;
    if (b < 0x80) {
      len = 1;
      cp = b;
    } else if (b >= 0xC2 && b <= 0xDF) {
      if (cont(1)) {
        len = 2;
        cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
      }
    } else if (b >= 0xE0 && b <= 0xEF) {
      const lo = b === 0xE0 ? 0xA0 : 0x80;
      const hi = b === 0xED ? 0x9F : 0xBF;
      if (cont(1, lo, hi) && cont(2)) {
        len = 3;
        cp = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
      }
    } else if (b >= 0xF0 && b <= 0xF4) {
      const lo = b === 0xF0 ? 0x90 : 0x80;
      const hi = b === 0xF4 ? 0x8F : 0xBF;
      if (cont(1, lo, hi) && cont(2) && cont(3)) {
        len = 4;
        cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) |
          ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      }
    }
    if (len === 0) {
      out += '⟦' + hex2(b) + '⟧';
      i += 1;
    } else {
      out += isEscapedCp(cp) ? '⟦U+' + uhex(cp) + '⟧' : String.fromCodePoint(cp);
      i += len;
    }
  }
  return out;
}

// Шаги 1–8 метки.
function encodeLabel(bytes, index) {
  let s = labelChars(bytes);
  let dir = false;
  if (s.endsWith('/')) {
    dir = true;
    s = s.slice(0, -1);
  }
  const segs = s.split('/').map((seg) => {
    if (seg === '') return '⟦⟧';
    if (seg === '.') return '⟦.⟧';
    if (seg === '..') return '⟦..⟧';
    return seg;
  });
  if (dir) {
    segs[segs.length - 1] += '⟦U+002F⟧';
  }
  if (index >= 1) {
    segs.splice(segs.length - 1, 0, '⟦#' + index + '⟧');
  }
  const path = '/' + segs.join('/');
  return path.replace(/^\/([A-Z]):/, (m, x) => '/⟦U+' + uhex(x.charCodeAt(0)) + '⟧:');
}

function checkArchive(archive) {
  const P = archive.toString();
  if (P === '' || P.includes('&') || P.includes('=')) {
    throw new Error('archive URI cannot be used in a zip-document URI');
  }
  if (URI.parse(P).toString() !== P) {
    throw new Error('archive URI is not in toString() canonical form');
  }
  return P;
}

function buildRaw(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('index must be an integer in [0, 2^53-1]');
  }
  if (!(name instanceof Uint8Array)) {
    throw new TypeError('name must be Uint8Array');
  }
  const P = checkArchive(archive);
  const path = encodeLabel(name, index);
  const E = Buffer.from(name).toString('base64url');
  const query = 'archive=' + P + '&entry=' + E + (index >= 1 ? '&index=' + index : '');
  return URI.from({ scheme: SCHEME, authority: AUTHORITY, path, query, fragment: '' });
}

module.exports = {
  // archive — URI архива (объект URI); name — байты имени записи (Uint8Array);
  // index — целое число >= 0. Возвращает канонический URI записи (объект URI).
  build(archive, name, index) {
    return buildRaw(archive, name, index);
  },

  // uri — URI, который получил провайдер (объект URI, любой схемы и вида).
  // Канонический URI записи -> { archive: URI, name: Uint8Array, index: number };
  // любой другой -> null. Исключений не бросает.
  parse(uri) {
    try {
      if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') {
        return null;
      }
      const q = uri.query;
      if (typeof q !== 'string') return null;
      const parts = q.split('&');
      if (parts.length !== 2 && parts.length !== 3) return null;
      if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;
      if (parts.length === 3 && !parts[2].startsWith('index=')) return null;

      const P = parts[0].slice('archive='.length);
      const E = parts[1].slice('entry='.length);
      let index = 0;
      if (parts.length === 3) {
        const N = parts[2].slice('index='.length);
        if (!/^[1-9][0-9]*$/.test(N)) return null;
        if (BigInt(N) > BigInt(MAX_INDEX)) return null;
        index = Number(N);
      }
      if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
      const nameBuf = Buffer.from(E, 'base64url');
      if (nameBuf.toString('base64url') !== E) return null;
      if (P === '') return null;

      const archive = URI.parse(P);
      const name = new Uint8Array(nameBuf);
      const expected = buildRaw(archive, name, index);
      if (
        expected.scheme !== uri.scheme ||
        expected.authority !== uri.authority ||
        expected.path !== uri.path ||
        expected.query !== uri.query ||
        expected.fragment !== uri.fragment
      ) {
        return null;
      }
      return { archive, name, index };
    } catch (e) {
      return null;
    }
  },
};
