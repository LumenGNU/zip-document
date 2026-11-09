// НЕОДНОЗНАЧНОСТИ:
// - 3.2 шаг 8: применяется ли замена "X:" только если path начинается с "/X:" (X заглавная A–Z), и только к первому символу после "/"; выбрано: да, только префикс path === "/X:"..., X → "⟦U+00XX⟧", остальное без изменений; для "C:x" получается "/⟦U+0043⟧:x"
// - 3.3 P: «совпадает со своим toString(Uri.parse(P))» — какой режим Uri.parse (strict?); выбрано: URI.parse(P) (без strict) и сравнение с toString() результата; результат по тексту не зависит от режима
// - 3.4/3.5: при извлечении тройки из query значения берутся «как есть»; для index — Number(N) и проверка целочисленности/диапазона; выбрано: index должен быть точной десятичной записью без ведущих нулей, 1 ≤ n ≤ 2^53−1

const { URI } = require('vscode-uri');

const SPECIAL_RANGES = [
    [0x0000, 0x001F], [0x007F, 0x00A0], [0x00AD, 0x00AD], [0x034F, 0x034F],
    [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
    [0x0890, 0x0891], [0x08E2, 0x08E2], [0x115F, 0x1160], [0x1680, 0x1680],
    [0x17B4, 0x17B5], [0x180E, 0x180E], [0x2000, 0x200B], [0x200E, 0x200F],
    [0x2028, 0x202F], [0x205F, 0x206F], [0x27E6, 0x27E6], [0x3000, 0x3000],
    [0x3164, 0x3164], [0xFDD0, 0xFDEF], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
    [0xFFF0, 0xFFFB], [0xFFFE, 0xFFFF], [0x110BD, 0x110BD], [0x110CD, 0x110CD],
    [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A],
    [0xE0000, 0xE00FF], [0xE01F0, 0xE0FFF]
];

function isSpecialCodePoint(cp) {
    for (const [lo, hi] of SPECIAL_RANGES) {
        if (cp >= lo && cp <= hi) return true;
    }
    // nFFFE–nFFFF в плоскостях 1–16
    if (cp >= 0x10000 && cp <= 0x10FFFF) {
        const low = cp & 0xFFFF;
        if (low === 0xFFFE || low === 0xFFFF) return true;
    }
    return false;
}

function toHex4(cp) {
    let s = cp.toString(16).toUpperCase();
    while (s.length < 4) s = '0' + s;
    return s;
}

function byteToHex(b) {
    return b.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Decode name bytes to a sequence of "display units": either a string (one code point
 * or the special form) according to steps 1–2 of 3.2.
 * Returns an array of strings (each is either a single character or an already-escaped form).
 */
function bytesToUnits(name) {
    const units = [];
    let i = 0;
    const len = name.length;

    while (i < len) {
        const b0 = name[i];

        // ASCII single-byte
        if (b0 <= 0x7F) {
            const cp = b0;
            if (isSpecialCodePoint(cp)) {
                units.push('⟦U+' + toHex4(cp) + '⟧');
            } else {
                units.push(String.fromCodePoint(cp));
            }
            i += 1;
            continue;
        }

        // Multi-byte UTF-8
        let need = 0;
        let minCp = 0;
        let cp = 0;

        if ((b0 & 0xE0) === 0xC0) { // 2 bytes
            need = 1;
            minCp = 0x80;
            cp = b0 & 0x1F;
        } else if ((b0 & 0xF0) === 0xE0) { // 3 bytes
            need = 2;
            minCp = 0x800;
            cp = b0 & 0x0F;
        } else if ((b0 & 0xF8) === 0xF0) { // 4 bytes
            need = 3;
            minCp = 0x10000;
            cp = b0 & 0x07;
        } else {
            // invalid lead
            units.push('⟦' + byteToHex(b0) + '⟧');
            i += 1;
            continue;
        }

        if (i + need >= len) {
            // truncated
            units.push('⟦' + byteToHex(b0) + '⟧');
            i += 1;
            continue;
        }

        let ok = true;
        for (let k = 1; k <= need; k++) {
            const bk = name[i + k];
            if ((bk & 0xC0) !== 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (bk & 0x3F);
        }

        if (!ok || cp < minCp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
            // overlong, surrogate, or out of range → escape lead only and continue
            units.push('⟦' + byteToHex(b0) + '⟧');
            i += 1;
            continue;
        }

        // valid sequence
        if (isSpecialCodePoint(cp)) {
            units.push('⟦U+' + toHex4(cp) + '⟧');
        } else {
            units.push(String.fromCodePoint(cp));
        }
        i += 1 + need;
    }

    return units;
}

/**
 * Build the path (метка) from name bytes and index according to 3.2.
 */
function buildPath(name, index) {
    // 1–2: units
    const units = bytesToUnits(name);

    // Join units into a string (still with possible trailing "/")
    let s = units.join('');

    // 3: strip one trailing "/"
    let isDir = false;
    if (s.endsWith('/')) {
        isDir = true;
        s = s.slice(0, -1);
    }

    // 4: split by "/"
    // Note: empty name → s === "" → segments = [""]
    const segments = s.split('/');

    // replace exact "", ".", ".."
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg === '') segments[i] = '⟦⟧';
        else if (seg === '.') segments[i] = '⟦.⟧';
        else if (seg === '..') segments[i] = '⟦..⟧';
    }

    // 5: if was directory, append ⟦U+002F⟧ to the last segment
    if (isDir) {
        if (segments.length === 0) {
            // should not happen
            segments.push('⟦U+002F⟧');
        } else {
            segments[segments.length - 1] += '⟦U+002F⟧';
        }
    }

    // 6: if index ≥ 1 insert ⟦#index⟧ before the last segment
    if (index >= 1) {
        const idxSeg = '⟦#' + String(index) + '⟧';
        if (segments.length === 0) {
            segments.push(idxSeg);
        } else {
            segments.splice(segments.length - 1, 0, idxSeg);
        }
    }

    // 7: path = "/" + join
    let path = '/' + segments.join('/');

    // 8: if starts with "/X:" where X is A–Z, replace X with ⟦U+00XX⟧
    // (the ":" stays; it is not a segment separator here)
    if (path.length >= 3 && path[0] === '/' && path[2] === ':') {
        const ch = path[1];
        if (ch >= 'A' && ch <= 'Z') {
            const escaped = '⟦U+' + toHex4(ch.codePointAt(0)) + '⟧';
            path = '/' + escaped + path.slice(2);
        }
    }

    return path;
}

function encodeBase64Url(bytes) {
    // Node Buffer base64url is unpadded
    return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(str) {
    // Accept only canonical base64url (no padding, only -_ alphabet)
    if (!/^[A-Za-z0-9\-_]*$/.test(str)) {
        return null;
    }
    try {
        const buf = Buffer.from(str, 'base64url');
        // Round-trip check for canonicity (no padding, correct alphabet already checked)
        if (buf.toString('base64url') !== str) {
            return null;
        }
        return new Uint8Array(buf);
    } catch {
        return null;
    }
}

function isValidArchiveString(P) {
    if (typeof P !== 'string' || P.length === 0) return false;
    if (P.includes('&') || P.includes('=')) return false;
    try {
        const reparsed = URI.parse(P);
        return reparsed.toString() === P;
    } catch {
        return false;
    }
}

function build(archive, name, index) {
    if (!(archive instanceof URI) && !(archive && typeof archive.scheme === 'string')) {
        throw new Error('invalid archive');
    }
    if (!(name instanceof Uint8Array) && !Buffer.isBuffer(name)) {
        throw new Error('invalid name');
    }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > Number.MAX_SAFE_INTEGER) {
        throw new Error('invalid index');
    }

    const P = archive.toString();
    if (!isValidArchiveString(P)) {
        throw new Error('archive URI not representable');
    }

    const E = encodeBase64Url(name);
    let query;
    if (index === 0) {
        query = 'archive=' + P + '&entry=' + E;
    } else {
        query = 'archive=' + P + '&entry=' + E + '&index=' + String(index);
    }

    const path = buildPath(name, index);

    return URI.from({
        scheme: 'zip-document',
        authority: 'v1',
        path,
        query,
        fragment: ''
    });
}

function parse(uri) {
    try {
        if (!uri || typeof uri.scheme !== 'string') return null;
        if (uri.scheme !== 'zip-document') return null;
        if (uri.authority !== 'v1') return null;
        if (uri.fragment !== '') return null;

        const q = uri.query;
        if (typeof q !== 'string') return null;

        // Split exactly by "&" into 2 or 3 parts with required prefixes
        const parts = q.split('&');
        if (parts.length !== 2 && parts.length !== 3) return null;

        if (!parts[0].startsWith('archive=')) return null;
        if (!parts[1].startsWith('entry=')) return null;

        const P = parts[0].slice('archive='.length);
        const E = parts[1].slice('entry='.length);

        let index = 0;
        if (parts.length === 3) {
            if (!parts[2].startsWith('index=')) return null;
            const Nstr = parts[2].slice('index='.length);
            // must be decimal without leading zeros, 1 .. 2^53-1
            if (!/^[1-9][0-9]*$/.test(Nstr)) return null;
            const n = Number(Nstr);
            if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) return null;
            // exact decimal representation (no scientific etc., already guaranteed by regex)
            if (String(n) !== Nstr) return null;
            index = n;
        }

        if (!isValidArchiveString(P)) return null;

        const nameBytes = decodeBase64Url(E);
        if (nameBytes === null) return null;

        // Reconstruct expected path and compare strictly
        const expectedPath = buildPath(nameBytes, index);
        if (uri.path !== expectedPath) return null;

        // Also the whole URI must equal the one we would build
        const rebuilt = build(URI.parse(P), nameBytes, index);
        if (uri.scheme !== rebuilt.scheme ||
            uri.authority !== rebuilt.authority ||
            uri.path !== rebuilt.path ||
            uri.query !== rebuilt.query ||
            uri.fragment !== rebuilt.fragment) {
            return null;
        }

        return {
            archive: URI.parse(P),
            name: nameBytes,
            index
        };
    } catch {
        return null;
    }
}

module.exports = { build, parse };