// Fast variant of ../uri.js behind the interface of blind/PROMPT.md, so that blind/run.js and
// blind/bench.js check it as they check the blind implementations.
// Same result (run.js, bench.js), different work — see perf.js for the numbers:
// - the table of step 2 as a 64 KiB lookup for the BMP instead of a scan of the ranges;
// - UTF-8 checked in one pass, clean runs decoded natively (Buffer utf8Slice) instead of
//   one String.fromCodePoint per character, no array per character;
// - "", "." and ".." segments found on bytes; steps 3-8 without split/map/join when there are none;
// - P checked once per archive object (WeakMap); parse remembers the last P;
// - parse compares query and path with what they must be instead of building a URI.
const { URI } = require('vscode-uri');
const { SHOWN_AS_ESCAPE } = require('../uri.js');

const O = '⟦', C = '⟧';
const BMP = new Uint8Array(0x10000);
const ASTRAL = [];
for (const [a, b] of SHOWN_AS_ESCAPE) {
  if (a > 0xFFFF) { ASTRAL.push(a, b); continue; }
  BMP.fill(1, a, b + 1);
}
const escaped = cp => {
  if (cp < 0x10000) return BMP[cp] === 1;
  for (let k = 0; k < ASTRAL.length; k += 2) if (cp >= ASTRAL[k] && cp <= ASTRAL[k + 1]) return true;
  return false;
};
const HEX = '0123456789ABCDEF';
const hex2 = x => HEX[x >> 4] + HEX[x & 15];
const uplus = cp => O + 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') + C;

// Length of the well-formed UTF-8 sequence at i (RFC 3629), 0 if none; code point in CP.
let CP = 0;
function seq(b, i, n) {
  const x = b[i];
  if (x < 0x80) { CP = x; return 1; }
  if (x < 0xC2) return 0;
  if (x < 0xE0) {
    if (i + 1 >= n) return 0;
    const y = b[i + 1];
    if ((y & 0xC0) !== 0x80) return 0;
    CP = ((x & 0x1F) << 6) | (y & 0x3F); return 2;
  }
  if (x < 0xF0) {
    if (i + 2 >= n) return 0;
    const y = b[i + 1], z = b[i + 2];
    if (y < (x === 0xE0 ? 0xA0 : 0x80) || y > (x === 0xED ? 0x9F : 0xBF) || (z & 0xC0) !== 0x80) return 0;
    CP = ((x & 0x0F) << 12) | ((y & 0x3F) << 6) | (z & 0x3F); return 3;
  }
  if (x < 0xF5) {
    if (i + 3 >= n) return 0;
    const y = b[i + 1], z = b[i + 2], w = b[i + 3];
    if (y < (x === 0xF0 ? 0x90 : 0x80) || y > (x === 0xF4 ? 0x8F : 0xBF) || (z & 0xC0) !== 0x80 || (w & 0xC0) !== 0x80) return 0;
    CP = ((x & 0x07) << 18) | ((y & 0x3F) << 12) | ((z & 0x3F) << 6) | (w & 0x3F); return 4;
  }
  return 0;
}

// Steps 1-2. Clean runs are decoded in one native call.
function renderName(buf) {
  const n = buf.length;
  let s = '', run = 0, i = 0;
  while (i < n) {
    const x = buf[i];
    if (x >= 0x20 && x < 0x7F) { i++; continue; } // printable ASCII: never escaped
    const len = seq(buf, i, n);
    if (len && !escaped(CP)) { i += len; continue; }
    if (i > run) s += buf.utf8Slice(run, i);
    s += len ? uplus(CP) : O + hex2(x) + C;
    i += len || 1;
    run = i;
  }
  return run === 0 ? buf.utf8Slice(0, n) : s + buf.utf8Slice(run, n);
}

// Is any segment of bytes [0, end) "", "." or ".."? Checked on bytes: step 2 never produces
// "/" or "." from other bytes, so a rendered segment is "", "." or ".." exactly when its bytes are.
function strangeSegment(buf, end) {
  let start = 0;
  for (let i = 0; i <= end; i++) {
    if (i < end && buf[i] !== 0x2F) continue;
    const len = i - start;
    if (len === 0 || (len <= 2 && buf[start] === 0x2E && (len === 1 || buf[start + 1] === 0x2E))) return true;
    start = i + 1;
  }
  return false;
}
const fixSeg = g => g === '' ? O + C : g === '.' ? O + '.' + C : g === '..' ? O + '..' + C : g;
// Steps 3-8.
function labelPath(buf, index) {
  let name = renderName(buf);
  const dir = buf.length > 0 && buf[buf.length - 1] === 0x2F;
  if (dir) name = name.slice(0, -1);
  const plain = !strangeSegment(buf, dir ? buf.length - 1 : buf.length);
  let path;
  if (plain) {
    const tail = dir ? O + 'U+002F' + C : '';
    if (index > 0) {
      const k = name.lastIndexOf('/') + 1;
      path = '/' + name.slice(0, k) + O + '#' + index + C + '/' + name.slice(k) + tail;
    } else path = '/' + name + tail;
  } else {
    const segs = name.split('/').map(fixSeg);
    if (dir) segs[segs.length - 1] += O + 'U+002F' + C;
    if (index > 0) segs.splice(segs.length - 1, 0, O + '#' + index + C);
    path = '/' + segs.join('/');
  }
  const d = path.charCodeAt(1);
  if (d >= 65 && d <= 90 && path.charCodeAt(2) === 58) path = '/' + uplus(d) + path.slice(2);
  return path;
}

// P of an archive, or null when it has no entry URIs (3.3). Once per archive object.
const P_OF = new WeakMap();
function pOf(archive) {
  let p = P_OF.get(archive);
  if (p !== undefined) return p;
  p = archive.toString();
  let back;
  try { back = URI.parse(p, true).toString(); } catch { back = null; }
  if (p === '' || p.indexOf('&') >= 0 || p.indexOf('=') >= 0 || back !== p) p = null;
  P_OF.set(archive, p);
  return p;
}

const asBuffer = b => Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);

function make(p, buf, index) {
  let query = 'archive=' + p + '&entry=' + buf.base64urlSlice(0, buf.length);
  if (index > 0) query += '&index=' + index;
  return URI.from({ scheme: 'zip-document', authority: 'v1', path: labelPath(buf, index), query, fragment: '' });
}

function build(archive, name, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('index');
  const p = pOf(archive);
  if (p === null) throw new RangeError('archive URI has no entry URI');
  return make(p, asBuffer(name), index);
}

let lastP = null, lastArchive = null;
function parse(uri) {
  try {
    if (!uri || uri.scheme !== 'zip-document' || uri.authority !== 'v1' || uri.fragment !== '') return null;
    const q = uri.query;
    if (typeof q !== 'string' || !q.startsWith('archive=')) return null;
    const a = q.indexOf('&'), e = a < 0 ? -1 : q.indexOf('&', a + 1);
    if (a < 0 || !q.startsWith('entry=', a + 1)) return null;
    const p = q.slice(8, a), E = q.slice(a + 7, e < 0 ? q.length : e);
    let index = 0;
    if (e >= 0) {
      if (!q.startsWith('index=', e + 1)) return null;
      const N = q.slice(e + 7);
      if (!/^[1-9][0-9]{0,15}$/.test(N)) return null;
      index = Number(N);
      if (!Number.isSafeInteger(index)) return null;
    }
    let archive;
    if (p === lastP) archive = lastArchive;
    else { archive = URI.parse(p, true); lastP = p; lastArchive = archive; }
    if (pOf(archive) !== p) return null;
    const buf = Buffer.from(E, 'base64url');
    if (buf.base64urlSlice(0, buf.length) !== E) return null;
    const want = index > 0 ? `archive=${p}&entry=${E}&index=${index}` : `archive=${p}&entry=${E}`;
    if (q !== want || uri.path !== labelPath(buf, index)) return null;
    return { archive, name: new Uint8Array(buf), index };
  } catch {
    return null;
  }
}

module.exports = { build, parse, labelPath, renderName };
