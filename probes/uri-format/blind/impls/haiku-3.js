// НЕОДНОЗНАЧНОСТИ:
// - 3.2, шаг 8: "/X:" проверяется как буквальный префикс готового пути, уже с сегментом номера (при index >= 1 и имени из одного сегмента "C:" он оказывается после "⟦#N⟧", и замены нет); после ":" может идти что угодно, в том числе не "/"; выбрано: буквальная проверка префикса, как написано
// - 3.2, шаг 1: "корректная последовательность" проверяется для полной последовательности, начинающейся с данного байта (не максимальный подпериод); при неудаче экранируется только этот байт, чтение продолжается со следующего; выбрано: так
// - 3.2, шаг 1 и 3: снятие завершающего "/" делается по байтам до декодирования; эквивалентно декодированию с последующим снятием (0x2F не бывает продолжением UTF-8); выбрано: до декодирования
// - 3.2, таблица: использована таблица из текста как есть (замороженный список), а не переустановленный по Unicode 17.0 набор; выбрано: таблица
// - 3.3, P: "P не содержит & и =" и "совпадает со своим toString(Uri.parse(P))" — проверяются в build (отказ = исключение) и в parse (отказ = null); пустой P отказ; выбрано: все три условия
// - 3.3/3.4, отказ генератора: "отказывает" не определён как механизм; выбрано: исключение (TypeError для неверных типов, RangeError для index вне 0..2^53-1, Error для P, для которого URI нет)
// - 3.4, parse: "Uri.parse(P)" понимается как Uri.parse с параметрами по умолчанию (strict = false), из которых выбран VS Code-вариант vscode-uri; выбрано: по умолчанию
// - 3.4, каноничность: проверка выполнена сравнением полей scheme, authority, path, query, fragment с URI, перестроенным из извлечённой тройки (E — проверкой "декодировал и закодировал обратно побайтно"); выбрано: так, эквивалентно тексту
// - 3.4, parse: index в query принимается только как /^[1-9][0-9]*$/ и не больше 2^53 − 1; "index=" вне этого — не URI записи; выбрано: так
// - 3.5, обратимость по метке: декодирование метки в (имя, index) не нужно интерфейсу (parse использует тройку из query), не реализовано; выбрано: не реализовано
// - 3.1, fragment: в parse требуется fragment === '' (пустая строка); undefined у неканоничного URI трактуется как не равный ''; выбрано: строгое равенство ''
// - 3.6/3.1: сравнение path/query в parse — строгое, по полям (не по toString); выбрано: по полям

'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER; // 2^53 - 1

// Замороженная таблица шага 2 (3.2), включительно.
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

function needsUEscape(cp) {
  for (const [lo, hi] of ESCAPE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function uEscape(cp) {
  return '⟦U+' + hex(cp, 4) + '⟧';
}

function byteEscape(b) {
  return '⟦' + hex(b, 2) + '⟧';
}

// Читает одну корректную UTF-8 последовательность, начинающуюся в i.
// Возвращает { cp, n } или null.
function readUtf8(bytes, i) {
  const b = bytes[i];
  if (b < 0x80) return { cp: b, n: 1 };
  let n;
  let cp;
  let lo = 0x80;
  let hi = 0xBF;
  if (b >= 0xC2 && b <= 0xDF) {
    n = 2;
    cp = b & 0x1F;
  } else if (b >= 0xE0 && b <= 0xEF) {
    n = 3;
    cp = b & 0x0F;
    if (b === 0xE0) lo = 0xA0;
    if (b === 0xED) hi = 0x9F; // без суррогатов
  } else if (b >= 0xF0 && b <= 0xF4) {
    n = 4;
    cp = b & 0x07;
    if (b === 0xF0) lo = 0x90;
    if (b === 0xF4) hi = 0x8F; // не выше U+10FFFF
  } else {
    return null;
  }
  if (i + n > bytes.length) return null;
  for (let k = 1; k < n; k++) {
    const c = bytes[i + k];
    const a = k === 1 ? lo : 0x80;
    const z = k === 1 ? hi : 0xBF;
    if (c < a || c > z) return null;
    cp = (cp << 6) | (c & 0x3F);
  }
  return { cp, n };
}

// Шаги 1–2 метки: байты имени -> строка с экранированиями.
function decodeName(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const r = readUtf8(bytes, i);
    if (r === null) {
      out += byteEscape(bytes[i]);
      i += 1;
      continue;
    }
    out += needsUEscape(r.cp) ? uEscape(r.cp) : String.fromCodePoint(r.cp);
    i += r.n;
  }
  return out;
}

// Метка (path) из (имя, index), шаги 1–8 из 3.2.
function labelOf(name, index) {
  let body = name;
  let trailingSlash = false;
  if (body.length > 0 && body[body.length - 1] === 0x2F) {
    trailingSlash = true;
    body = body.subarray(0, body.length - 1);
  }
  const text = decodeName(body);
  const segments = text.split('/').map((s) => {
    if (s === '') return '⟦⟧';
    if (s === '.') return '⟦.⟧';
    if (s === '..') return '⟦..⟧';
    return s;
  });
  if (trailingSlash) {
    segments[segments.length - 1] += uEscape(0x2F);
  }
  if (index >= 1) {
    segments.splice(segments.length - 1, 0, '⟦#' + String(index) + '⟧');
  }
  let path = '/' + segments.join('/');
  // шаг 8: буква диска A–Z
  if (path.length >= 3 && path[1] >= 'A' && path[1] <= 'Z' && path[2] === ':') {
    path = '/' + uEscape(path.charCodeAt(1)) + path.slice(2);
  }
  return path;
}

// P: строка toString() архива, пригодная для query.
function archiveString(archive) {
  if (archive === null || typeof archive !== 'object' || typeof archive.toString !== 'function') {
    throw new TypeError('archive must be a URI');
  }
  const P = archive.toString();
  if (P === '') throw new Error('archive URI is empty');
  if (P.includes('&') || P.includes('=')) throw new Error('archive URI contains & or =');
  if (URI.parse(P).toString() !== P) throw new Error('archive URI is not toString()-stable');
  return P;
}

function build(archive, name, index) {
  if (!(name instanceof Uint8Array)) throw new TypeError('name must be Uint8Array');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError('index must be an integer in 0..2^53-1');
  }
  const P = archiveString(archive);
  const E = Buffer.from(name).toString('base64url');
  let query = 'archive=' + P + '&entry=' + E;
  if (index >= 1) query += '&index=' + String(index);
  return URI.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: labelOf(name, index),
    query,
    fragment: '',
  });
}

function parse(uri) {
  try {
    if (uri === null || typeof uri !== 'object') return null;
    if (uri.scheme !== SCHEME || uri.authority !== AUTHORITY || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string') return null;

    const parts = q.split('&');
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
      if (big > BigInt(MAX_INDEX)) return null;
      index = Number(big);
    }

    // E — каноническая base64url без паддинга: декодировать и закодировать обратно.
    const decoded = Buffer.from(E, 'base64url');
    if (decoded.toString('base64url') !== E) return null;
    const name = new Uint8Array(decoded);

    // archive = Uri.parse(P); P должен совпадать со своим toString() (проверяет build).
    const archive = URI.parse(P);
    const rebuilt = build(archive, name, index);
    if (rebuilt.scheme !== uri.scheme) return null;
    if (rebuilt.authority !== uri.authority) return null;
    if (rebuilt.path !== uri.path) return null;
    if (rebuilt.query !== uri.query) return null;
    if (rebuilt.fragment !== uri.fragment) return null;

    return { archive, name, index };
  } catch (e) {
    return null;
  }
}

module.exports = {
  build,
  parse,
};
