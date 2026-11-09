// НЕОДНОЗНАЧНОСТИ:
// - 3.2, шаги 4–5: дописывание "⟦U+002F⟧" к последнему сегменту (признак каталога) — к сегменту до шага 4 или после него (для имени "/" это "⟦U+002F⟧" или "⟦⟧⟦U+002F⟧"); выбрано: после шага 4, как записано порядком шагов (для "/" — "⟦⟧⟦U+002F⟧")

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const OPEN = '⟦';
const CLOSE = '⟧';

// Замороженная таблица шага 2 (3.2) как список диапазонов [от, до] включительно.
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

function inTable(cp) {
  for (const [a, b] of TABLE) {
    if (cp >= a && cp <= b) return true;
  }
  // nFFFE–nFFFF в плоскостях 1–16
  return cp >= 0x10000 && cp <= 0x10FFFF && (cp & 0xFFFE) === 0xFFFE;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function isCont(b, j, lo = 0x80, hi = 0xBF) {
  return j < b.length && b[j] >= lo && b[j] <= hi;
}

// Строгое чтение одного символа UTF-8 (RFC 3629) с позиции i: [cp, длина] или null.
function decodeAt(b, i) {
  const c = b[i];
  if (c < 0x80) return [c, 1];
  if (c >= 0xC2 && c <= 0xDF) {
    return isCont(b, i + 1) ? [((c & 0x1F) << 6) | (b[i + 1] & 0x3F), 2] : null;
  }
  if (c >= 0xE0 && c <= 0xEF) {
    const lo = c === 0xE0 ? 0xA0 : 0x80;
    const hi = c === 0xED ? 0x9F : 0xBF;
    if (!isCont(b, i + 1, lo, hi) || !isCont(b, i + 2)) return null;
    return [((c & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F), 3];
  }
  if (c >= 0xF0 && c <= 0xF4) {
    const lo = c === 0xF0 ? 0x90 : 0x80;
    const hi = c === 0xF4 ? 0x8F : 0xBF;
    if (!isCont(b, i + 1, lo, hi) || !isCont(b, i + 2) || !isCont(b, i + 3)) return null;
    return [
      ((c & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) | ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F),
      4,
    ];
  }
  return null;
}

// Метка (path) из (имя, index), 3.2.
function label(name, index) {
  let text = '';
  let i = 0;
  while (i < name.length) {
    const d = decodeAt(name, i);
    if (d === null) {
      text += OPEN + hex(name[i], 2) + CLOSE;
      i += 1;
    } else {
      const cp = d[0];
      text += inTable(cp) ? OPEN + 'U+' + hex(cp, 4) + CLOSE : String.fromCodePoint(cp);
      i += d[1];
    }
  }

  let dir = false;
  if (text.endsWith('/')) {
    dir = true;
    text = text.slice(0, -1);
  }

  const segs = text.split('/').map((s) => {
    if (s === '') return OPEN + CLOSE;
    if (s === '.') return OPEN + '.' + CLOSE;
    if (s === '..') return OPEN + '..' + CLOSE;
    return s;
  });

  if (dir) segs[segs.length - 1] += OPEN + 'U+002F' + CLOSE;

  if (index >= 1) segs.splice(segs.length - 1, 0, OPEN + '#' + String(index) + CLOSE);

  let path = '/' + segs.join('/');

  if (/^\/[A-Z]:/.test(path)) {
    path = '/' + OPEN + 'U+' + hex(path.charCodeAt(1), 4) + CLOSE + path.slice(2);
  }
  return path;
}

// P (строка из query) допустима, если непуста, без "&" и "=" и совпадает со своим
// toString(Uri.parse(P)) (3.3); иначе бросает исключение.
function checkArchiveString(P) {
  if (P === '' || P.includes('&') || P.includes('=')) throw new Error('archive');
  if (URI.parse(P).toString() !== P) throw new Error('archive');
  return P;
}

function archiveString(archive) {
  return checkArchiveString(archive.toString());
}

function makeUri(P, name, index) {
  const E = Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString('base64url');
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

module.exports = {
  build(archive, name, index) {
    const P = archiveString(archive);
    return makeUri(P, name, index);
  },

  parse(uri) {
    try {
      if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') {
        return null;
      }
      if (typeof uri.query !== 'string' || typeof uri.path !== 'string') return null;

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
        const n = Number(N);
        if (!Number.isSafeInteger(n)) return null;
        index = n;
      }

      if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
      const name = Buffer.from(E, 'base64url');
      if (name.toString('base64url') !== E) return null;

      const archiveStr = checkArchiveString(P);
      const archive = URI.parse(archiveStr);

      const expected = makeUri(archiveStr, name, index);
      if (expected.path !== uri.path || expected.query !== uri.query) return null;

      return { archive, name, index };
    } catch (e) {
      return null;
    }
  },
};
