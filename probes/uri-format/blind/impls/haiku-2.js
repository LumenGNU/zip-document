// НЕОДНОЗНАЧНОСТИ:
// - 1 (интерфейс, отказ генератора): текст говорит «отказывает», без способа; выбрано: build бросает Error при любом отказе (P пустой или не равен своему toString(Uri.parse(P)), index не safe-integer или < 0, не число)
// - 2 (интерфейс, parse): «исключений не бросает» и «любой другой -> null» без уточнения, что считать неканоничным входом; выбрано: любое исключение внутри parse и любой не-URI вход -> null
// - 3 (3.3, P): «P не содержит & и =» и «совпадает со своим toString(Uri.parse(P))»; не сказано, что делать с пустым P отдельно от правила round-trip; выбрано: пустой P отказ, иначе строгое равенство строк P === Uri.parse(P).toString()
// - 4 (3.2 шаг 1, некорректный UTF-8): «чтение продолжается со следующего байта»; неясно, сколько байт съедает неполная последовательность; выбрано: при неуспехе декодирования с позиции i экранируется только байт i, чтение продолжается с i+1 (продолжающие байты повторно проверяются как начало)
// - 5 (3.2 шаг 1, границы UTF-8): RFC 3629 перечислен словами; выбрано: таблица допустимых вторых байт (E0: A0–BF, ED: 80–9F, F0: 90–BF, F4: 80–8F), остальные продолжающие 80–BF
// - 6 (3.2 шаг 2, таблица): «nFFFE–nFFFF в плоскостях 1–16» понято как 1FFFE–1FFFF … 10FFFE–10FFFF; таблица взята буквально, без сверки с Unicode 17.0; ASCII-пробел U+0020 и U+007F–U+00A0 вошли по буквальным диапазонам
// - 7 (3.2 шаг 3, признак каталога): «один завершающий "/"» — проверяется по символу, уже прошедшему шаги 1–2 (U+002F не экранируется, поэтому эквивалентно проверке по байтам)
// - 8 (3.2 шаги 4–6, порядок): шаг 5 дописывает ⟦U+002F⟧ к последнему сегменту, шаг 6 вставляет ⟦#N⟧ перед последним сегментом; выбрано: буквальный порядок (сначала дописывание, потом вставка), так что ⟦#N⟧ стоит перед сегментом с признаком каталога
// - 9 (3.2 шаг 8, «/X:»): не сказано, проверяется ли префикс после шага 6 или до; выбрано: после шага 7 (path начинается с "/" и первого сегмента), то есть при index ≥ 1 замена не происходит
// - 10 (3.2 шаг 8, форма буквы): «на свою форму ⟦U+XXXX⟧» — выбрано: ⟦U+0041⟧–⟦U+005A⟧ с четырьмя цифрами
// - 11 (3.4, парсинг query): «делится по "&" на 2 или 3 части» и значения «как есть»; не сказано, что делать, если "=" встречается в значении; выбрано: делим только по "&", значения срезаются по префиксу, лишний "=" делает P неканоничным (round-trip)
// - 12 (3.4, сравнение канонического URI): «покомпонентно строгим равенством» и «из какой-либо тройки»; выбрано: parse восстанавливает тройку, строит URI через build и сравнивает scheme, authority, path, query, fragment строго (fragment обязан быть "", иначе отказ)
// - 13 (3.3, N): «от 1 до 2^53 − 1» и «десятичное без ведущих нулей»; выбрано: регэксп /^[1-9][0-9]*$/ и сравнение BigInt ≤ 2^53 − 1
// - 14 (3.3/3.4, E): «строгим» base64url без паддинга; неясно, допустима ли непустая строка длины по модулю 4 == 1; выбрано: символы A–Z a–z 0–9 - _, затем обязательное совпадение Buffer.from(E,'base64url').toString('base64url') === E (отсюда длина 1 mod 4 и ненулевые хвостовые биты отказываются)
// - 15 (3.5, имя в parse): тип возвращаемого name не уточнён; выбрано: обычный Uint8Array (копия, не Buffer)
// - 16 (3.4, провайдер): требование «isCaseSensitive: true» касается регистрации схемы в VS Code, а не функций этого модуля; не реализуется здесь
// - 17 (3.1, scheme/authority): сравнение строгое; нормализация регистра scheme, которую мог бы сделать vscode-uri при parse, выбранным поведением не учитывается; выбрано: uri.scheme и uri.authority сравниваются как есть

'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 9007199254740991; // 2^53 - 1

// 3.2, шаг 2: замороженный список символов, которые экранируются как ⟦U+XXXX⟧.
const ESCAPE_RANGES = [
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
for (let plane = 1; plane <= 16; plane++) {
  ESCAPE_RANGES.push([plane * 0x10000 + 0xFFFE, plane * 0x10000 + 0xFFFF]);
}

function isEscaped(cp) {
  for (const [lo, hi] of ESCAPE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// 3.2, шаг 1: одно шаговое декодирование UTF-8 (RFC 3629) с позиции i.
// Возвращает { cp, len } или null, если с позиции i нет корректной последовательности.
function decodeStep(b, i) {
  const b0 = b[i];
  if (b0 < 0x80) return { cp: b0, len: 1 };

  let len;
  let second = [0x80, 0xBF];
  if (b0 >= 0xC2 && b0 <= 0xDF) {
    len = 2;
  } else if (b0 >= 0xE0 && b0 <= 0xEF) {
    len = 3;
    if (b0 === 0xE0) second = [0xA0, 0xBF];
    else if (b0 === 0xED) second = [0x80, 0x9F];
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    len = 4;
    if (b0 === 0xF0) second = [0x90, 0xBF];
    else if (b0 === 0xF4) second = [0x80, 0x8F];
  } else {
    return null;
  }

  if (i + len > b.length) return null;
  let cp = b0 & (len === 2 ? 0x1F : len === 3 ? 0x0F : 0x07);
  for (let k = 1; k < len; k++) {
    const bk = b[i + k];
    const [lo, hi] = k === 1 ? second : [0x80, 0xBF];
    if (bk < lo || bk > hi) return null;
    cp = (cp << 6) | (bk & 0x3F);
  }
  return { cp, len };
}

// 3.2, метка из (имя, index).
function buildLabel(name, index) {
  const pieces = [];
  let i = 0;
  while (i < name.length) {
    const step = decodeStep(name, i);
    if (step === null) {
      pieces.push(`⟦${hex(name[i], 2)}⟧`);
      i += 1;
    } else {
      if (isEscaped(step.cp)) pieces.push(`⟦U+${hex(step.cp, 4)}⟧`);
      else pieces.push(String.fromCodePoint(step.cp));
      i += step.len;
    }
  }

  // Шаг 3: один завершающий "/" снимается и запоминается.
  let trailingSlash = false;
  if (pieces.length > 0 && pieces[pieces.length - 1] === '/') {
    pieces.pop();
    trailingSlash = true;
  }

  // Шаг 4: деление по "/", сегменты "", ".", ".." экранируются.
  const segs = pieces.join('').split('/').map((s) => {
    if (s === '') return '⟦⟧';
    if (s === '.') return '⟦.⟧';
    if (s === '..') return '⟦..⟧';
    return s;
  });

  // Шаг 5: признак записи каталога.
  if (trailingSlash) segs[segs.length - 1] += '⟦U+002F⟧';

  // Шаг 6: номер дубликата перед последним сегментом.
  if (index >= 1) segs.splice(segs.length - 1, 0, `⟦#${index}⟧`);

  // Шаг 7.
  let path = '/' + segs.join('/');

  // Шаг 8: буква диска "X:" в начале пути.
  if (/^\/[A-Z]:/.test(path)) {
    const code = path.charCodeAt(1);
    path = `/⟦U+00${hex(code, 2)}⟧:` + path.slice(3);
  }
  return path;
}

// 3.3, query из (P, E, index).
function buildQuery(P, E, index) {
  return index === 0
    ? `archive=${P}&entry=${E}`
    : `archive=${P}&entry=${E}&index=${index}`;
}

// Проверка и разбор архива P (строка toString()). Возвращает URI или null.
function checkArchive(P) {
  if (P === '') return null;
  const archive = URI.parse(P);
  if (archive.toString() !== P) return null;
  return archive;
}

function build(archive, name, index) {
  const P = archive.toString();
  if (!checkArchive(P)) {
    throw new Error('zip-document: archive URI is not canonical (no URI for this entry)');
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('zip-document: index must be an integer in [0, 2^53 - 1]');
  }
  const E = Buffer.from(name).toString('base64url');
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: buildLabel(name, index),
    query: buildQuery(P, E, index),
    fragment: '',
  });
}

function parseStrict(uri) {
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
    if (BigInt(N) > BigInt(MAX_INDEX)) return null;
    index = Number(N);
  }

  if (!/^[A-Za-z0-9_-]*$/.test(E)) return null;
  const name = Buffer.from(E, 'base64url');
  if (name.toString('base64url') !== E) return null;

  const archive = checkArchive(P);
  if (!archive) return null;

  const expected = build(archive, new Uint8Array(name), index);
  if (
    expected.scheme !== uri.scheme ||
    expected.authority !== uri.authority ||
    expected.path !== uri.path ||
    expected.query !== uri.query ||
    expected.fragment !== uri.fragment
  ) {
    return null;
  }
  return { archive, name: new Uint8Array(name), index };
}

function parse(uri) {
  try {
    return parseStrict(uri);
  } catch (_) {
    return null;
  }
}

module.exports = { build, parse };
