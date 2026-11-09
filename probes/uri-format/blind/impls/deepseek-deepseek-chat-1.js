// НЕОДНОЗНАЧНОСТИ:
// - нет

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = 9007199254740991; // 2^53 - 1

function escapeByte(b) {
    return '⟦' + b.toString(16).toUpperCase().padStart(2, '0') + '⟧';
}

function escapeCodePoint(cp) {
    let h = cp.toString(16).toUpperCase();
    if (h.length < 4) h = h.padStart(4, '0');
    return '⟦U+' + h + '⟧';
}

function isForbiddenCodePoint(cp) {
    if (cp <= 0x001F) return true;
    if (cp >= 0x007F && cp <= 0x00A0) return true;
    if (cp === 0x00AD) return true;
    if (cp === 0x034F) return true;
    if (cp >= 0x0600 && cp <= 0x0605) return true;
    if (cp === 0x061C) return true;
    if (cp === 0x06DD) return true;
    if (cp === 0x070F) return true;
    if (cp >= 0x0890 && cp <= 0x0891) return true;
    if (cp === 0x08E2) return true;
    if (cp >= 0x115F && cp <= 0x1160) return true;
    if (cp === 0x1680) return true;
    if (cp >= 0x17B4 && cp <= 0x17B5) return true;
    if (cp === 0x180E) return true;
    if (cp >= 0x2000 && cp <= 0x200B) return true;
    if (cp >= 0x200E && cp <= 0x200F) return true;
    if (cp >= 0x2028 && cp <= 0x202F) return true;
    if (cp >= 0x205F && cp <= 0x206F) return true;
    if (cp === 0x27E6) return true;
    if (cp === 0x3000) return true;
    if (cp === 0x3164) return true;
    if (cp >= 0xFDD0 && cp <= 0xFDEF) return true;
    if (cp === 0xFEFF) return true;
    if (cp === 0xFFA0) return true;
    if (cp >= 0xFFF0 && cp <= 0xFFFB) return true;
    if (cp >= 0xFFFE && cp <= 0xFFFF) return true;
    if (cp === 0x110BD) return true;
    if (cp === 0x110CD) return true;
    if (cp >= 0x13430 && cp <= 0x1343F) return true;
    if (cp >= 0x1BCA0 && cp <= 0x1BCA3) return true;
    if (cp >= 0x1D173 && cp <= 0x1D17A) return true;
    if (cp >= 0xE0000 && cp <= 0xE00FF) return true;
    if (cp >= 0xE01F0 && cp <= 0xE0FFF) return true;
    if (cp >= 0x1FFFE && cp <= 0x10FFFF && (cp & 0xFFFF) >= 0xFFFE) return true;
    return false;
}

function decodeNameToLabelString(bytes) {
    let out = '';
    let i = 0;
    const len = bytes.length;

    while (i < len) {
        const b = bytes[i];
        let cp = -1;
        let size = 0;

        if (b <= 0x7F) {
            cp = b;
            size = 1;
        } else if (b >= 0xC2 && b <= 0xDF) {
            if (i + 1 < len) {
                const b1 = bytes[i + 1];
                if (b1 >= 0x80 && b1 <= 0xBF) {
                    cp = ((b & 0x1F) << 6) | (b1 & 0x3F);
                    size = 2;
                }
            }
        } else if (b >= 0xE0 && b <= 0xEF) {
            if (i + 2 < len) {
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                let valid = b2 >= 0x80 && b2 <= 0xBF;

                if (valid) {
                    if (b === 0xE0) valid = b1 >= 0xA0 && b1 <= 0xBF;
                    else if (b === 0xED) valid = b1 >= 0x80 && b1 <= 0x9F;
                    else valid = b1 >= 0x80 && b1 <= 0xBF;
                }

                if (valid) {
                    cp = ((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
                    size = 3;
                }
            }
        } else if (b >= 0xF0 && b <= 0xF4) {
            if (i + 3 < len) {
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                const b3 = bytes[i + 3];
                let valid = b2 >= 0x80 && b2 <= 0xBF && b3 >= 0x80 && b3 <= 0xBF;

                if (valid) {
                    if (b === 0xF0) valid = b1 >= 0x90 && b1 <= 0xBF;
                    else if (b === 0xF4) valid = b1 >= 0x80 && b1 <= 0x8F;
                    else valid = b1 >= 0x80 && b1 <= 0xBF;
                }

                if (valid) {
                    cp = ((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
                    size = 4;
                }
            }
        }

        if (size === 0) {
            out += escapeByte(b);
            i++;
        } else {
            if (isForbiddenCodePoint(cp)) out += escapeCodePoint(cp);
            else out += String.fromCodePoint(cp);
            i += size;
        }
    }

    return out;
}

function makeLabel(name, index) {
    let s = decodeNameToLabelString(name);
    let hadTrailingSlash = false;

    if (s.endsWith('/')) {
        hadTrailingSlash = true;
        s = s.slice(0, -1);
    }

    const segments = s.split('/').map(seg => {
        if (seg === '') return '⟦⟧';
        if (seg === '.') return '⟦.⟧';
        if (seg === '..') return '⟦..⟧';
        return seg;
    });

    if (hadTrailingSlash) {
        segments[segments.length - 1] += '⟦U+002F⟧';
    }

    if (index >= 1) {
        segments.splice(segments.length - 1, 0, '⟦#' + index + '⟧');
    }

    let path = '/' + segments.join('/');

    if (
        path.length >= 3 &&
        path[0] === '/' &&
        path[1] >= 'A' && path[1] <= 'Z' &&
        path[2] === ':'
    ) {
        path = '/' + escapeCodePoint(path.charCodeAt(1)) + path.slice(2);
    }

    return path;
}

function makeQuery(P, E, index) {
    if (index === 0) return `archive=${P}&entry=${E}`;
    return `archive=${P}&entry=${E}&index=${index}`;
}

function parseArchiveP(P) {
    if (
        typeof P !== 'string' ||
        P.length === 0 ||
        P.includes('&') ||
        P.includes('=')
    ) {
        return null;
    }

    try {
        const archive = URI.parse(P);
        if (archive.toString() !== P) return null;
        return archive;
    } catch {
        return null;
    }
}

function decodeEntry(E) {
    if (typeof E !== 'string' || !/^[A-Za-z0-9_-]*$/.test(E)) return null;

    try {
        const buf = Buffer.from(E, 'base64url');
        if (buf.toString('base64url') !== E) return null;
        return buf;
    } catch {
        return null;
    }
}

function parseQuery(query) {
    if (typeof query !== 'string') return null;

    const parts = query.split('&');
    if (parts.length !== 2 && parts.length !== 3) return null;

    if (!parts[0].startsWith('archive=')) return null;
    if (!parts[1].startsWith('entry=')) return null;

    const P = parts[0].slice('archive='.length);
    const E = parts[1].slice('entry='.length);

    let index = 0;

    if (parts.length === 3) {
        if (!parts[2].startsWith('index=')) return null;

        const N = parts[2].slice('index='.length);
        if (!/^(?:[1-9][0-9]*)$/.test(N)) return null;

        let big;
        try {
            big = BigInt(N);
        } catch {
            return null;
        }

        if (big < 1n || big > 9007199254740991n) return null;
        index = Number(big);
    }

    return { P, E, index };
}

function build(archive, name, index) {
    if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > MAX_INDEX
    ) {
        throw new Error('invalid index');
    }

    let P;
    try {
        P = archive.toString();
    } catch {
        throw new Error('invalid archive URI');
    }

    if (
        typeof P !== 'string' ||
        P.length === 0 ||
        P.includes('&') ||
        P.includes('=')
    ) {
        throw new Error('invalid archive URI');
    }

    try {
        if (URI.parse(P).toString() !== P) {
            throw new Error('invalid archive URI');
        }
    } catch {
        throw new Error('invalid archive URI');
    }

    const bytes = Buffer.from(name);
    const E = bytes.toString('base64url');
    const path = makeLabel(bytes, index);
    const query = makeQuery(P, E, index);

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
        if (!uri || typeof uri !== 'object') return null;

        if (
            uri.scheme !== SCHEME ||
            uri.authority !== AUTHORITY ||
            uri.fragment !== ''
        ) {
            return null;
        }

        if (typeof uri.path !== 'string' || typeof uri.query !== 'string') {
            return null;
        }

        const q = parseQuery(uri.query);
        if (!q) return null;

        const archive = parseArchiveP(q.P);
        if (!archive) return null;

        const name = decodeEntry(q.E);
        if (!name) return null;

        if (uri.query !== makeQuery(q.P, q.E, q.index)) return null;
        if (uri.path !== makeLabel(name, q.index)) return null;

        return {
            archive,
            name,
            index: q.index,
        };
    } catch {
        return null;
    }
}

module.exports = {
    build,
    parse,
};