// НЕОДНОЗНАЧНОСТИ:
// - нет

'use strict';

const { URI } = require('vscode-uri');

const SCHEME = 'zip-document';
const AUTHORITY = 'v1';
const MAX_INDEX = Number.MAX_SAFE_INTEGER;

const ESCAPED_CODE_POINT_RANGES = [
    [0x0000, 0x001f],
    [0x007f, 0x00a0],
    [0x00ad, 0x00ad],
    [0x034f, 0x034f],
    [0x0600, 0x0605],
    [0x061c, 0x061c],
    [0x06dd, 0x06dd],
    [0x070f, 0x070f],
    [0x0890, 0x0891],
    [0x08e2, 0x08e2],
    [0x115f, 0x1160],
    [0x1680, 0x1680],
    [0x17b4, 0x17b5],
    [0x180e, 0x180e],
    [0x2000, 0x200b],
    [0x200e, 0x200f],
    [0x2028, 0x202f],
    [0x205f, 0x206f],
    [0x27e6, 0x27e6],
    [0x3000, 0x3000],
    [0x3164, 0x3164],
    [0xfdd0, 0xfdef],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff0, 0xfffb],
    [0xfffe, 0xffff],
    [0x110bd, 0x110bd],
    [0x110cd, 0x110cd],
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe00ff],
    [0xe01f0, 0xe0fff],
];

/**
 * Return true when the code point belongs to the frozen escaping table.
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
function mustEscapeCodePoint(codePoint) {
    if (codePoint >= 0x10000 && codePoint <= 0x10ffff &&
        ((codePoint & 0xffff) === 0xfffe || (codePoint & 0xffff) === 0xffff)) {
        return true;
    }

    return ESCAPED_CODE_POINT_RANGES.some(
        ([first, last]) => codePoint >= first && codePoint <= last,
    );
}

/**
 * Format a code point as U+XXXX, with at least four uppercase hex digits.
 *
 * @param {number} codePoint
 * @returns {string}
 */
function escapeCodePoint(codePoint) {
    return `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}

/**
 * Decode one RFC 3629 UTF-8 scalar value at the given offset.
 * Invalid input returns null; the caller then escapes only the current byte.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{ codePoint: number, length: number } | null}
 */
function decodeUtf8At(bytes, offset) {
    const first = bytes[offset];
    const isContinuation = (value) => value >= 0x80 && value <= 0xbf;

    if (first <= 0x7f) {
        return { codePoint: first, length: 1 };
    }

    if (first >= 0xc2 && first <= 0xdf) {
        const second = bytes[offset + 1];
        if (second !== undefined && isContinuation(second)) {
            return {
                codePoint: ((first & 0x1f) << 6) | (second & 0x3f),
                length: 2,
            };
        }
        return null;
    }

    if (first >= 0xe0 && first <= 0xef) {
        const second = bytes[offset + 1];
        const third = bytes[offset + 2];
        const validSecond = second !== undefined && (
            (first === 0xe0 && second >= 0xa0 && second <= 0xbf) ||
            (first === 0xed && second >= 0x80 && second <= 0x9f) ||
            (first !== 0xe0 && first !== 0xed && isContinuation(second))
        );

        if (validSecond && third !== undefined && isContinuation(third)) {
            return {
                codePoint: ((first & 0x0f) << 12) |
                    ((second & 0x3f) << 6) |
                    (third & 0x3f),
                length: 3,
            };
        }
        return null;
    }

    if (first >= 0xf0 && first <= 0xf4) {
        const second = bytes[offset + 1];
        const third = bytes[offset + 2];
        const fourth = bytes[offset + 3];
        const validSecond = second !== undefined && (
            (first === 0xf0 && second >= 0x90 && second <= 0xbf) ||
            (first === 0xf4 && second >= 0x80 && second <= 0x8f) ||
            (first !== 0xf0 && first !== 0xf4 && isContinuation(second))
        );

        if (validSecond && third !== undefined && isContinuation(third) &&
            fourth !== undefined && isContinuation(fourth)) {
            return {
                codePoint: ((first & 0x07) << 18) |
                    ((second & 0x3f) << 12) |
                    ((third & 0x3f) << 6) |
                    (fourth & 0x3f),
                length: 4,
            };
        }
    }

    return null;
}

/**
 * Convert entry-name bytes and duplicate index into the canonical URI path.
 *
 * @param {Uint8Array} name
 * @param {number} index
 * @returns {string}
 */
function makeLabel(name, index) {
    let text = '';

    for (let offset = 0; offset < name.length;) {
        const decoded = decodeUtf8At(name, offset);

        if (decoded === null) {
            text += `⟦${name[offset].toString(16).toUpperCase().padStart(2, '0')}⟧`;
            offset += 1;
            continue;
        }

        const { codePoint, length } = decoded;
        text += mustEscapeCodePoint(codePoint)
            ? escapeCodePoint(codePoint)
            : String.fromCodePoint(codePoint);
        offset += length;
    }

    const isDirectory = text.endsWith('/');
    if (isDirectory) {
        text = text.slice(0, -1);
    }

    const segments = text.split('/').map((segment) => {
        if (segment === '') return '⟦⟧';
        if (segment === '.') return '⟦.⟧';
        if (segment === '..') return '⟦..⟧';
        return segment;
    });

    if (isDirectory) {
        segments[segments.length - 1] += '⟦U+002F⟧';
    }

    if (index >= 1) {
        segments.splice(segments.length - 1, 0, `⟦#${index}⟧`);
    }

    let path = `/${segments.join('/')}`;
    path = path.replace(/^\/([A-Z]):/, (_match, letter) =>
        `/${escapeCodePoint(letter.charCodeAt(0))}:`,
    );

    return path;
}

/**
 * Serialize and validate an archive URI for use in the query component.
 *
 * @param {object} archive
 * @returns {string}
 */
function getArchiveString(archive) {
    const value = archive.toString();

    if (value.length === 0 || value.includes('&') || value.includes('=')) {
        throw new Error('Archive URI cannot be represented in this format');
    }

    if (URI.parse(value).toString() !== value) {
        throw new Error('Archive URI is not in canonical string form');
    }

    return value;
}

/**
 * Compare all URI components using strict string equality.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function sameComponents(left, right) {
    return left.scheme === right.scheme &&
        left.authority === right.authority &&
        left.path === right.path &&
        left.query === right.query &&
        left.fragment === right.fragment;
}

/**
 * Build the canonical URI of an archive entry.
 *
 * @param {object} archive Archive URI.
 * @param {Uint8Array} name Raw entry-name bytes.
 * @param {number} index Duplicate index.
 * @returns {import('vscode-uri').URI}
 */
function buildUri(archive, name, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
        throw new Error('Invalid entry index');
    }

    const archiveString = getArchiveString(archive);
    const entry = Buffer.from(name).toString('base64url');
    const query = index === 0
        ? `archive=${archiveString}&entry=${entry}`
        : `archive=${archiveString}&entry=${entry}&index=${index}`;

    return URI.from({
        scheme: SCHEME,
        authority: AUTHORITY,
        path: makeLabel(name, index),
        query,
        fragment: '',
    });
}

/**
 * Decode a canonical, unpadded Base64URL value.
 *
 * @param {string} value
 * @returns {Buffer | null}
 */
function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
        return null;
    }

    const bytes = Buffer.from(value, 'base64url');
    return bytes.toString('base64url') === value ? bytes : null;
}

/**
 * Parse a canonical positive decimal safe integer.
 *
 * @param {string} value
 * @returns {number | null}
 */
function decodeIndex(value) {
    if (!/^[1-9][0-9]*$/.test(value)) {
        return null;
    }

    const index = Number(value);
    if (!Number.isSafeInteger(index) || index > MAX_INDEX || String(index) !== value) {
        return null;
    }

    return index;
}

module.exports = {
    /**
     * Build the canonical URI of an archive entry.
     *
     * @param {object} archive Archive URI.
     * @param {Uint8Array} name Raw entry-name bytes.
     * @param {number} index Duplicate index, from 0 through Number.MAX_SAFE_INTEGER.
     * @returns {import('vscode-uri').URI}
     */
    build(archive, name, index) {
        return buildUri(archive, name, index);
    },

    /**
     * Parse a canonical archive-entry URI. Invalid or non-canonical URIs return null.
     *
     * @param {import('vscode-uri').URI} uri
     * @returns {{ archive: import('vscode-uri').URI, name: Buffer, index: number } | null}
     */
    parse(uri) {
        try {
            if (uri === null || typeof uri !== 'object' || typeof uri.query !== 'string') {
                return null;
            }

            const parts = uri.query.split('&');
            if (parts.length !== 2 && parts.length !== 3) {
                return null;
            }
            if (!parts[0].startsWith('archive=') || !parts[1].startsWith('entry=')) {
                return null;
            }
            if (parts.length === 3 && !parts[2].startsWith('index=')) {
                return null;
            }

            const archiveString = parts[0].slice('archive='.length);
            if (archiveString.length === 0 || archiveString.includes('&') || archiveString.includes('=')) {
                return null;
            }

            const archive = URI.parse(archiveString);
            if (archive.toString() !== archiveString) {
                return null;
            }

            const name = decodeBase64Url(parts[1].slice('entry='.length));
            if (name === null) {
                return null;
            }

            let index = 0;
            if (parts.length === 3) {
                index = decodeIndex(parts[2].slice('index='.length));
                if (index === null) {
                    return null;
                }
            }

            const canonical = buildUri(archive, name, index);
            return sameComponents(uri, canonical)
                ? { archive, name, index }
                : null;
        } catch {
            return null;
        }
    },
};