// НЕОДНОЗНАЧНОСТИ:
// - 3.2 шаг 1: чтение UTF-8 при неполной или неверной последовательности; выбрано: последовательность берётся целиком, только если она валидна по RFC 3629 (с учётом ограничений второго байта E0/ED/F0/F4); иначе экранируется только текущий байт, чтение продолжается со следующего
// - 3.2 таблица: "nFFFE–nFFFF в плоскостях 1–16"; выбрано: диапазоны 1FFFE–1FFFF … 10FFFE–10FFFF (плейн 0 покрыт записью FFFE–FFFF)
// - 3.3/3.4 генератор: archive, у которого toString() не совпадает с toString(Uri.parse(toString())), и тройка не даёт канонического URI; текст не говорит, что делает генератор; выбрано: build бросает Error
// - 3.3 генератор: index не целое, отрицательное или больше 2^53 − 1 (для него «URI нет», но метод build не описан на этот случай); выбрано: build бросает RangeError
// - 3.4 провайдер, проверка P: критерий «P совпадает со своим toString()» понят как: P непуст и Uri.parse(P).toString() === P
// - 3.4 провайдер, проверка E: критерий «не в канонической форме» понят как: только символы base64url-алфавита и повторное кодирование декодированных байт даёт E побайтно (отсекает "QR", "QQ==", "+/8" и т.п.)
// - 3.4 провайдер, проверка пути: текст даёт свойства метки, но не говорит, как сверять путь с тройкой; выбрано: тройка из query восстанавливается, URI перестраивается по 3.1–3.3 и сравнивается с принятым по всем компонентам строгим равенством (обратный разбор метки по 3.5 не используется)
// - 3.4 провайдер, index: "index=" с числом, начинающимся с нуля или равным 0 — отвергается по форме; значение "0" при наличии параметра считается неканоническим
// - 3.1 authority / fragment: проверка для принимаемого URI без учёта регистра схемы; выбрано: строгое сравнение строк всех компонентов
'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MAX_INDEX_BIG = BigInt(MAX_INDEX);

const L = '⟦'; // ⟦
const R = '⟧'; // ⟧

// Замороженная таблица шага 2 (раздел 3.2): диапазоны включительно.
const ESCAPE_RANGES = [
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
for (let plane = 1; plane <= 16; plane++) {
  ESCAPE_RANGES.push([(plane << 16) | 0xFFFE, (plane << 16) | 0xFFFF]);
}

function needsEscape(cp) {
  for (const [a, b] of ESCAPE_RANGES) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

// Читает одну корректную UTF-8 последовательность в позиции i (RFC 3629) или возвращает null.
function readUtf8(bytes, i) {
  const b0 = bytes[i];
  if (b0 < 0x80) return { cp: b0, len: 1 };
  let n;
  let cp;
  let lo = 0x80;
  let hi = 0xBF;
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    n = 1;
    cp = b0 & 0x1F;
  } else if (b0 >= 0xE0 && b0 <= 0xEF) {
    n = 2;
    cp = b0 & 0x0F;
    if (b0 === 0xE0) lo = 0xA0;
    if (b0 === 0xED) hi = 0x9F;
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    n = 3;
    cp = b0 & 0x07;
    if (b0 === 0xF0) lo = 0x90;
    if (b0 === 0xF4) hi = 0x8F;
  } else {
    return null;
  }
  for (let k = 1; k <= n; k++) {
    const b = bytes[i + k];
    if (b === undefined) return null;
    const [rl, rh] = k === 1 ? [lo, hi] : [0x80, 0xBF];
    if (b < rl || b > rh) return null;
    cp = (cp << 6) | (b & 0x3F);
  }
  return { cp, len: n + 1 };
}

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function hexU(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

// Шаги 1–2 раздела 3.2: байты имени -> строка с экранированиями.
function labelChars(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const r = readUtf8(bytes, i);
    if (r === null) {
      out += L + hex2(bytes[i]) + R;
      i += 1;
      continue;
    }
    out += needsEscape(r.cp)
      ? L + 'U+' + hexU(r.cp) + R
      : String.fromCodePoint(r.cp);
    i += r.len;
  }
  return out;
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError('index must be an integer in [0, 2^53 - 1]');
  }
  const P = archive.toString();
  if (P === '' || URI.parse(P).toString() !== P) {
    throw new Error('archive URI is not canonical');
  }

  // Шаги 1–3.
  let s = labelChars(name);
  let trailing = false;
  if (s.endsWith('/')) {
    trailing = true;
    s = s.slice(0, -1);
  }

  // Шаг 4.
  const segs = s.split('/').map((seg) => {
    if (seg === '') return L + R;
    if (seg === '.') return L + '.' + R;
    if (seg === '..') return L + '..' + R;
    return seg;
  });

  // Шаг 5.
  if (trailing) {
    segs[segs.length - 1] += L + 'U+002F' + R;
  }

  // Шаг 6.
  if (index >= 1) {
    segs.splice(segs.length - 1, 0, L + '#' + index + R);
  }

  // Шаг 7.
  let path = '/' + segs.join('/');

  // Шаг 8.
  if (/^\/[A-Z]:/.test(path)) {
    path = '/' + L + 'U+' + hexU(path.charCodeAt(1)) + R + path.slice(2);
  }

  // Раздел 3.3.
  const E = Buffer.from(name).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) {
    query += '&index=' + index;
  }

  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path,
    query,
    fragment: '',
  });
}

function parse(uri) {
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

    if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
    const bytes = Buffer.from(E, 'base64url');
    if (bytes.toString('base64url') !== E) return null;

    let index = 0;
    if (parts.length === 3) {
      if (!parts[2].startsWith('index=')) return null;
      const N = parts[2].slice('index='.length);
      if (!/^[1-9][0-9]*$/.test(N)) return null;
      if (BigInt(N) > MAX_INDEX_BIG) return null;
      index = Number(N);
    }

    if (P === '') return null;
    const archive = URI.parse(P);
    if (archive.toString() !== P) return null;
    const name = Uint8Array.from(bytes);

    // Каноничность: URI, перестроенный из тройки, должен совпасть покомпонентно.
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
