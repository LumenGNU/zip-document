// НЕОДНОЗНАЧНОСТИ: нет

"use strict";

const { URI } = require("vscode-uri");

const MAX_INDEX = 9007199254740991; // 2^53 − 1

const L = "⟦"; // ⟦
const R = "⟧"; // ⟧

// ---------------------------------------------------------------------------
// 3.2, шаг 2: замороженная таблица символов.
// ---------------------------------------------------------------------------

const TABLE = [
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

function inTable(cp) {
    for (let k = 0; k < TABLE.length; k++) {
        if (cp >= TABLE[k][0] && cp <= TABLE[k][1]) {
            return true;
        }
    }
    // nFFFE–nFFFF в плоскостях 1–16.
    const plane = Math.floor(cp / 0x10000);
    if (plane >= 1 && plane <= 16) {
        const rest = cp % 0x10000;
        if (rest === 0xfffe || rest === 0xffff) {
            return true;
        }
    }
    return false;
}

function hexByte(b) {
    let h = b.toString(16).toUpperCase();
    if (h.length < 2) {
        h = "0" + h;
    }
    return h;
}

function hexCp(cp) {
    let h = cp.toString(16).toUpperCase();
    while (h.length < 4) {
        h = "0" + h;
    }
    return h;
}

// ---------------------------------------------------------------------------
// 3.2, шаг 1: корректная последовательность UTF-8 (RFC 3629: без избыточных
// форм, без суррогатов, не выше U+10FFFF). [кодовая точка, длина] или null.
// ---------------------------------------------------------------------------

function utf8At(b, i) {
    const n = b.length;
    const b0 = b[i];
    if (b0 < 0x80) {
        return [b0, 1];
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
        if (i + 1 < n && b[i + 1] >= 0x80 && b[i + 1] <= 0xbf) {
            return [((b0 & 0x1f) << 6) | (b[i + 1] & 0x3f), 2];
        }
        return null;
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
        let lo = 0x80;
        let hi = 0xbf;
        if (b0 === 0xe0) {
            lo = 0xa0; // без избыточных форм
        } else if (b0 === 0xed) {
            hi = 0x9f; // без суррогатов
        }
        if (i + 2 >= n || b[i + 1] < lo || b[i + 1] > hi) {
            return null;
        }
        if (b[i + 2] < 0x80 || b[i + 2] > 0xbf) {
            return null;
        }
        return [((b0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f), 3];
    }
    if (b0 >= 0xf0 && b0 <= 0xf4) {
        let lo = 0x80;
        let hi = 0xbf;
        if (b0 === 0xf0) {
            lo = 0x90; // без избыточных форм
        } else if (b0 === 0xf4) {
            hi = 0x8f; // не выше U+10FFFF
        }
        if (i + 3 >= n || b[i + 1] < lo || b[i + 1] > hi) {
            return null;
        }
        if (b[i + 2] < 0x80 || b[i + 2] > 0xbf) {
            return null;
        }
        if (b[i + 3] < 0x80 || b[i + 3] > 0xbf) {
            return null;
        }
        return [
            ((b0 & 0x07) << 18) |
            ((b[i + 1] & 0x3f) << 12) |
            ((b[i + 2] & 0x3f) << 6) |
            (b[i + 3] & 0x3f),
            4,
        ];
    }
    return null; // 0x80–0xBF (одиночное продолжение), 0xC0, 0xC1, 0xF5–0xFF
}

// ---------------------------------------------------------------------------
// 3.2: метка (path) из (имя, index).
// ---------------------------------------------------------------------------

function label(name, index) {
    // Шаги 1–2: байты читаются слева направо; корректная последовательность
    // UTF-8 — её символ (из таблицы — ⟦U+XXXX⟧, иначе как есть), любой другой
    // байт — ⟦HH⟧, чтение продолжается со следующего байта.
    let s = "";
    const n = name.length;
    let i = 0;
    while (i < n) {
        const d = utf8At(name, i);
        if (d === null) {
            s += L + hexByte(name[i]) + R;
            i += 1;
        } else {
            const cp = d[0];
            s += inTable(cp) ? L + "U+" + hexCp(cp) + R : String.fromCodePoint(cp);
            i += d[1];
        }
    }

    // Шаг 3: один завершающий "/" снимается и запоминается.
    let dir = false;
    if (s.length > 0 && s.charCodeAt(s.length - 1) === 0x2f) {
        s = s.slice(0, -1);
        dir = true;
    }

    // Шаг 4: деление по "/"; сегменты "", ".", ".." заменяются, ничего
    // не отбрасывается и не разрешается.
    const segs = s.split("/");
    for (let k = 0; k < segs.length; k++) {
        if (segs[k] === "") {
            segs[k] = L + R;
        } else if (segs[k] === ".") {
            segs[k] = L + "." + R;
        } else if (segs[k] === "..") {
            segs[k] = L + ".." + R;
        }
    }

    // Шаг 5: признак записи каталога дописывается к последнему сегменту.
    if (dir) {
        segs[segs.length - 1] += L + "U+002F" + R;
    }

    // Шаг 6: номер дубликата вставляется перед последним сегментом.
    if (index >= 1) {
        segs.splice(segs.length - 1, 0, L + "#" + index + R);
    }

    // Шаг 7.
    let path = "/" + segs.join("/");

    // Шаг 8: path (с сегментом номера) начинается с "/X:",
    // X — заглавная латинская буква — X заменяется на ⟦U+XXXX⟧.
    if (
        path.length >= 3 &&
        path.charCodeAt(0) === 0x2f &&
        path.charCodeAt(2) === 0x3a &&
        path.charCodeAt(1) >= 0x41 &&
        path.charCodeAt(1) <= 0x5a
    ) {
        path = "/" + L + "U+" + hexCp(path.charCodeAt(1)) + R + path.slice(2);
    }

    return path;
}

// ---------------------------------------------------------------------------
// 3.3: E — имя в base64url (RFC 4648 §5) без паддинга.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeName(bytes) {
    let out = "";
    const n = bytes.length;
    let i = 0;
    while (i < n) {
        const b0 = bytes[i];
        out += B64[b0 >> 2];
        if (i + 1 >= n) {
            out += B64[(b0 & 0x03) << 4];
            break;
        }
        const b1 = bytes[i + 1];
        out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
        if (i + 2 >= n) {
            out += B64[(b1 & 0x0f) << 2];
            break;
        }
        const b2 = bytes[i + 2];
        out += B64[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out += B64[b2 & 0x3f];
        i += 3;
    }
    return out;
}

const B64VAL = [];
for (let k = 0; k < 128; k++) {
    B64VAL[k] = -1;
}
for (let k = 0; k < 64; k++) {
    B64VAL[B64.charCodeAt(k)] = k;
}

// Строгое декодирование: только алфавит base64url, длина не даёт остатка 1
// по модулю 4. Неканонические строки отсекаются потом сравнением query с
// перекодированным (3.4).
function decodeName(str) {
    if (str.length % 4 === 1) {
        return null;
    }
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        const v = c < 128 ? B64VAL[c] : -1;
        if (v < 0) {
            return null;
        }
        acc = ((acc << 6) | v) & 0x1fff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// 3.3–3.4: генератор. Строит только канонические URI; для тройки, у которой
// URI нет, отказывает (бросает исключение).
// ---------------------------------------------------------------------------

function build(archive, name, index) {
    if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > MAX_INDEX
    ) {
        throw new Error("zip-document: triple has no URI (index)");
    }

    // P — toString() URI архива. URI записи есть, только если P непуст,
    // не содержит "&" и "=" и совпадает со своим toString(Uri.parse(P)).
    const P = archive.toString();
    if (P === "" || P.indexOf("&") !== -1 || P.indexOf("=") !== -1) {
        throw new Error("zip-document: triple has no URI (archive string)");
    }
    let reparsed;
    try {
        reparsed = URI.parse(P);
    } catch (e) {
        throw new Error("zip-document: triple has no URI (archive string)");
    }
    if (reparsed.toString() !== P) {
        throw new Error("zip-document: triple has no URI (archive string)");
    }

    const E = encodeName(name);
    const query =
        "archive=" + P + "&entry=" + E + (index >= 1 ? "&index=" + index : "");

    return URI.from({
        scheme: "zip-document",
        authority: "v1",
        path: label(name, index),
        query: query,
        fragment: "",
    });
}

// ---------------------------------------------------------------------------
// 3.4–3.5: провайдер. Канонический URI -> тройка, любой другой -> null.
// Исключений не бросает.
// ---------------------------------------------------------------------------

function hasPrefix(s, prefix) {
    if (s.length < prefix.length) {
        return false;
    }
    for (let k = 0; k < prefix.length; k++) {
        if (s.charCodeAt(k) !== prefix.charCodeAt(k)) {
            return false;
        }
    }
    return true;
}

function parse(uri) {
    try {
        if (!uri || typeof uri !== "object") {
            return null;
        }
        const scheme = uri.scheme;
        const authority = uri.authority;
        const path = uri.path;
        const query = uri.query;
        const fragment = uri.fragment;
        if (scheme !== "zip-document" || authority !== "v1" || fragment !== "") {
            return null;
        }
        if (typeof path !== "string" || typeof query !== "string") {
            return null;
        }

        // Тройка, если она есть, извлекается из query однозначно: деление по "&"
        // на 2 или 3 части с префиксами по порядку; значения как есть, без
        // процентного декодирования и без правил форм.
        const parts = query.split("&");
        let P;
        let E;
        let N = null;
        if (parts.length === 2) {
            if (!hasPrefix(parts[0], "archive=") || !hasPrefix(parts[1], "entry=")) {
                return null;
            }
            P = parts[0].slice(8);
            E = parts[1].slice(6);
        } else if (parts.length === 3) {
            if (
                !hasPrefix(parts[0], "archive=") ||
                !hasPrefix(parts[1], "entry=") ||
                !hasPrefix(parts[2], "index=")
            ) {
                return null;
            }
            P = parts[0].slice(8);
            E = parts[1].slice(6);
            N = parts[2].slice(6);
            if (!/^[0-9]+$/.test(N)) {
                return null;
            }
        } else {
            return null;
        }

        const name = decodeName(E);
        if (name === null) {
            return null;
        }
        const index = N === null ? 0 : Number(N);

        const archive = URI.parse(P);
        const canonical = build(archive, name, index);

        // Каноничность: покомпонентное строгое равенство строк (3.4).
        if (
            canonical.scheme !== scheme ||
            canonical.authority !== authority ||
            canonical.path !== path ||
            (canonical.query || "") !== query ||
            (canonical.fragment || "") !== fragment
        ) {
            return null;
        }
        return { archive: archive, name: name, index: index };
    } catch (e) {
        return null;
    }
}

module.exports = { build: build, parse: parse };