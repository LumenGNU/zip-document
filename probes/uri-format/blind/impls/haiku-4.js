// НЕОДНОЗНАЧНОСТИ:
// - 3.4 генератор: «отказывает» не определено как именно; выбрано: build бросает Error
// - 3.3 P: «совпадает со своим toString(Uri.parse(P))» не уточняет режим разбора и случай исключения при разборе P; выбрано: URI.parse по умолчанию (не strict), исключение = отказ
// - 3.3 P: правило «не содержит & и =» применено к P целиком, в том числе к «=» внутри значения; выбрано: любой «=» в P — отказ
// - 3.2 шаг 1: порядок экранирования оборванной последовательности описан примером (E2 82 41); выбрано: экранируется один первый байт, чтение продолжается со следующего, для каждого последующего байта проверка заново
// - 3.2 шаг 1: границы диапазонов второго байта (E0, ED, F0, F4) выведены из RFC 3629, в тексте не перечислены; выбрано: стандартные границы RFC 3629
// - 3.2 шаг 8: «начинается с "/X:"» не уточнено, относится ли к первому сегменту или к строке path целиком, в том числе после вставки сегмента ⟦#N⟧; выбрано: строковое сравнение итогового path (при index ≥ 1 замена не происходит)
// - 3.2 шаг 2: символ «⟧» (U+27E7) не входит в список и не экранируется, хотя он закрывает экранирование; выбрано: остаётся как есть, как сказано в тексте
// - 3.4 провайдер: что считать совпадением fragment, если поле отсутствует (undefined) вместо пустой строки; выбрано: отличие от пустой строки — неканонический URI
// - 3.2 шаг 2: «nFFFE–nFFFF в плоскостях 1–16» — плоскость 0 покрыта диапазоном FFFE–FFFF; выбрано: добавлены 1FFFE–1FFFF … 10FFFE–10FFFF
// - 3.4: проверка канонической формы путём пересборки из тройки; выбрано: сравнение scheme, authority, path, query, fragment с результатом build(тройка)

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const OPEN = '⟦';
const CLOSE = '⟧';

// Список символов шага 2 (замороженный, из 3.2).
const ESC_RANGES = [
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
const ESC_SET = new Set();
for (const [a, b] of ESC_RANGES) {
  for (let c = a; c <= b; c++) ESC_SET.add(c);
}
for (let plane = 1; plane <= 16; plane++) {
  ESC_SET.add(plane * 0x10000 + 0xFFFE);
  ESC_SET.add(plane * 0x10000 + 0xFFFF);
}

function esc(inner) {
  return OPEN + inner + CLOSE;
}

function uHex(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function byteHex(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

// Один символ UTF-8 по RFC 3629 начиная с позиции i; null, если последовательность некорректна или оборвана.
function decodeAt(bytes, i) {
  const b0 = bytes[i];
  if (b0 < 0x80) return { cp: b0, len: 1 };
  let need;
  let lo = 0x80;
  let hi = 0xBF;
  let cp;
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    need = 1;
    cp = b0 & 0x1F;
  } else if (b0 >= 0xE0 && b0 <= 0xEF) {
    need = 2;
    cp = b0 & 0x0F;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    need = 3;
    cp = b0 & 0x07;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
  } else {
    return null;
  }
  for (let k = 1; k <= need; k++) {
    const b = bytes[i + k];
    if (b === undefined) return null;
    const min = k === 1 ? lo : 0x80;
    const max = k === 1 ? hi : 0xBF;
    if (b < min || b > max) return null;
    cp = (cp << 6) | (b & 0x3F);
  }
  return { cp, len: need + 1 };
}

// Метка (path) из имени и index, шаги 1–8 из 3.2.
function makePath(nameBytes, index) {
  let s = '';
  let i = 0;
  while (i < nameBytes.length) {
    const d = decodeAt(nameBytes, i);
    if (!d) {
      s += esc(byteHex(nameBytes[i]));
      i += 1;
      continue;
    }
    s += ESC_SET.has(d.cp) ? esc(uHex(d.cp)) : String.fromCodePoint(d.cp);
    i += d.len;
  }

  let dirFlag = false;
  if (s.endsWith('/')) {
    dirFlag = true;
    s = s.slice(0, -1);
  }

  const segs = s.split('/').map((seg) => {
    if (seg === '') return esc('');
    if (seg === '.') return esc('.');
    if (seg === '..') return esc('..');
    return seg;
  });
  if (dirFlag) segs[segs.length - 1] += esc(uHex(0x2F));
  if (index >= 1) segs.splice(segs.length - 1, 0, esc('#' + String(index)));

  let path = '/' + segs.join('/');
  path = path.replace(/^\/([A-Z]):/, (m, x) => '/' + esc(uHex(x.charCodeAt(0))) + ':');
  return path;
}

// P пригоден для query: непуст, без & и =, и совпадает со своим toString(Uri.parse(P)).
function isValidArchive(P) {
  if (typeof P !== 'string' || P.length === 0) return false;
  if (P.includes('&') || P.includes('=')) return false;
  try {
    return URI.parse(P).toString() === P;
  } catch {
    return false;
  }
}

function build(archive, name, index) {
  const P = archive.toString();
  if (!isValidArchive(P)) throw new Error('archive URI has no canonical form for query');
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index out of range');

  const bytes = Buffer.from(name.buffer, name.byteOffset, name.byteLength);
  const E = bytes.toString('base64url');

  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);

  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: makePath(name, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (!uri || typeof uri !== 'object') return null;
    if (uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string') return null;

    const parts = q.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) return null;

    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      index = Number(N);
      if (!Number.isSafeInteger(index)) return null;
    }

    const P = parts[0].slice('archive='.length);
    const E = parts[1].slice('entry='.length);
    if (!isValidArchive(P)) return null;
    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;

    const nameBuf = Buffer.from(E, 'base64url');
    if (nameBuf.toString('base64url') !== E) return null;
    const name = new Uint8Array(nameBuf);

    const archive = URI.parse(P);
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

module.exports = {
  build,
  parse,
};
