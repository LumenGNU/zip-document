// Checks the claims of docs/URI.txt on the implementation for cross-checking (uri.js) with
// vscode-uri 3.0.8 — the same URI code VS Code uses. Plain Node: `node check.js`.
// What only VS Code itself can show (normalizePath, tabs) — vscode-probe.js.

const assert = require('assert');
const { URI, Utils } = require('vscode-uri');
const F = require('./uri');

const enc = s => new TextEncoder().encode(s);
const ARCHIVE = URI.file('/home/u/release.zip');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// --- the label: escapes, decoding, injectivity
const O = '\u27e6', C = '\u27e7';
const E = s => O + s + C;

// Inverse of labelPath, written independently: path -> { bytes, index }. If it always gives
// back what the label was built from, two different entries can never share a label.
function unlabel(path) {
  assert.strictEqual(path[0], '/');
  const out = []; let index = 0;
  for (let i = 1; i < path.length;) {
    const ch = String.fromCodePoint(path.codePointAt(i));
    if (ch !== O) { out.push(...enc(ch)); i += ch.length; continue; }
    const j = path.indexOf(C, i);
    if (j < 0) throw new Error('unclosed escape in ' + path);
    const c = path.slice(i + 1, j); i = j + 1;
    if (c === '' || c === '.' || c === '..') out.push(...enc(c));
    else if (/^#[1-9][0-9]*$/.test(c)) { index = Number(c.slice(1)); assert.strictEqual(path[i], '/'); i++; }
    else if (/^U\+[0-9A-F]{4,6}$/.test(c)) out.push(...enc(String.fromCodePoint(parseInt(c.slice(2), 16))));
    else if (/^[0-9A-F]{2}$/.test(c)) out.push(parseInt(c, 16));
    else throw new Error('bad escape ' + c + ' in ' + path);
  }
  return { bytes: Uint8Array.from(out), index };
}
const sameBytes = (x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;
// Everything outside escapes is shown as is: no code point of the escape list may remain.
// The escape list, derived independently from the runtime's Unicode tables by the rule of
// docs/URI.txt 3.2. The table is frozen at Unicode 17.0, so it is compared only on a runtime with
// exactly that version; any other version would confirm nothing about 17.0.
const UNICODE = '17.0';
const KEPT = c => c === 0x20 || c === 0x200c || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) ||
  (c >= 0xe0100 && c <= 0xe01ef) || (c >= 0x180b && c <= 0x180d) || c === 0x180f;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u;
const derived = c => c === 0x27e6 || (!KEPT(c) && HIDDEN.test(String.fromCodePoint(c)));
if (process.versions.unicode !== UNICODE) {
  console.log(`SKIPPED: frozen escape list vs Unicode properties — runtime has Unicode ${process.versions.unicode}, the list is ${UNICODE}`);
} else { const diff = [];
  for (let c = 0; c <= 0x10ffff; c++) if (!(c >= 0xd800 && c <= 0xdfff) && derived(c) !== F.shownAsEscape(c)) diff.push(c.toString(16));
  ok(diff.length === 0, 'frozen escape list = Unicode ' + UNICODE + ' properties; differ: ' + diff.slice(0, 20).join(' ')); }
// Everything outside escapes is shown as is: no code point to be escaped may remain.
const visible = path => ![...path.replace(/⟦[^⟧]*⟧/g, '')].some(ch => derived(ch.codePointAt(0)));

// UTF-8 decoding: well-formed sequences decoded, everything else escaped byte by byte
const B = (...x) => Uint8Array.from(x);
const DECODE = [
  [B(0xc3, 0xa4), '\u00e4'], [B(0x84), E('84')], [B(0xf0, 0x9f, 0x98, 0x80), '\u{1f600}'],
  [B(0xed, 0xa0, 0x80), E('ED') + E('A0') + E('80')],          // encoded surrogate
  [B(0xc0, 0x80), E('C0') + E('80')], [B(0xe0, 0x80, 0x80), E('E0') + E('80') + E('80')], // overlong
  [B(0xf4, 0x90, 0x80, 0x80), E('F4') + E('90') + E('80') + E('80')],  // above U+10FFFF
  [B(0xe2, 0x82, 0x41), E('E2') + E('82') + 'A'],                     // truncated, then ASCII
  [B(0xef, 0xbb, 0xbf, 0x61), E('U+FEFF') + 'a'],                     // BOM: decoded, then escaped
];
for (const [bytes, want] of DECODE) ok(F.renderName(bytes) === want, 'decode ' + Buffer.from(bytes).toString('hex') + ' -> ' + F.renderName(bytes));

const LABELS = [
  ['a/b.txt', '/a/b.txt'], ['', '/' + E('')], ['.', '/' + E('.')], ['..', '/' + E('..')],
  ['/', '/' + E('') + E('U+002F')], ['a/..', '/a/' + E('..')], ['./a//b', '/' + E('.') + '/a/' + E('') + '/b'],
  ['/etc/passwd', '/' + E('') + '/etc/passwd'], ['a/c/../b.txt', '/a/c/' + E('..') + '/b.txt'],
  ['a/b/', '/a/b' + E('U+002F')], ['a/b//', '/a/b/' + E('') + E('U+002F')], ['.../a', '/.../a'], ['a/.b/..c', '/a/.b/..c'],
  ['C:/x.txt', '/' + E('U+0043') + ':/x.txt'], ['c:/x.txt', '/c:/x.txt'], ['a/C:/b', '/a/C:/b'],
  ['a\\b', '/a\\b'], ['%41?#&=', '/%41?#&='], ['\u0416:/a', '/\u0416:/a'],
  ['a\u0000b\tc\nd\u007f', '/a' + E('U+0000') + 'b' + E('U+0009') + 'c' + E('U+000A') + 'd' + E('U+007F')],
  ['x\u0085y\u00a0z\u00ad', '/x' + E('U+0085') + 'y' + E('U+00A0') + 'z' + E('U+00AD')],
  ['invoice\u202etxt.exe', '/invoice' + E('U+202E') + 'txt.exe'],
  ['a\u200bb\u200ec\u200fd\u061ce\u2028f\u3000g', '/a' + E('U+200B') + 'b' + E('U+200E') + 'c' + E('U+200F') + 'd' + E('U+061C') + 'e' + E('U+2028') + 'f' + E('U+3000') + 'g'],
  [O + '84' + C, '/' + E('U+27E6') + '84' + C],
  ['\u2400\ufffd', '/\u2400\ufffd'],
  // kept: ZWJ, ZWNJ, variation selectors
  ['\u{1f468}\u200d\u{1f469}\u200c\u2764\ufe0f\u{e0100}\u180b', '/\u{1f468}\u200d\u{1f469}\u200c\u2764\ufe0f\u{e0100}\u180b'],
  ['\u{e0001}\ufdd0\u{1fffe}', '/' + E('U+E0001') + E('U+FDD0') + E('U+1FFFE')],
];
for (const [name, want] of LABELS) {
  const p = F.labelPath(enc(name));
  ok(p === want, 'label ' + JSON.stringify(name) + ' -> ' + p + ', want ' + want);
}
const INDEXED = [['a/README.md', 1, '/a/' + E('#1') + '/README.md'], ['README.md', 2, '/' + E('#2') + '/README.md'],
  ['a/b/', 1, '/a/' + E('#1') + '/b' + E('U+002F')], ['C:', 1, '/' + E('#1') + '/C:']];
for (const [name, i, want] of INDEXED) ok(F.labelPath(enc(name), i) === want, 'label ' + name + ' #' + i + ' -> ' + F.labelPath(enc(name), i));

// Pairs that look alike or used to share a label: different labels now
const PAIRS = [
  [B(0xc3, 0xa4), B(0x84)], [enc('a\u0000b'), enc('a\u2400b')], [enc('x\u0085'), enc('x\ufffd')],
  [enc('..'), enc('\ufffd..')], [enc('a/b/'), enc('a/b')], [enc('C:/x'), enc('c:/x')], [enc('a b'), enc('a\u00a0b')],
  [enc('ab'), enc('a\u200bb')], [enc(O + '84' + C), B(0x84)], [enc('a/./b'), enc('a/b')], [enc('a/c/../b'), enc('a/c/b')],
  [enc('/a'), enc('a')], [enc('a//b'), enc('a/b')], [enc('x'), enc('\ufeffx')],
];
for (const [x, y] of PAIRS) ok(F.labelPath(x) !== F.labelPath(y), 'labels must differ: ' + F.labelPath(x));
ok(F.labelPath(enc('a/b'), 0) !== F.labelPath(enc('a/b'), 1), 'duplicates: labels must differ');

// The root label (3.2) and the entries closest to it: no entry gets it, with any index
ok(F.ROOT_PATH === '/' + E('U+002F'), 'root label is /' + E('U+002F'));
for (const name of [enc('/'), enc(''), enc('a/'), enc(E('U+002F')), enc('U+002F'), enc('//'), enc('∕'), B(0x2f, 0x84)])
  for (const i of [0, 1, 2]) ok(F.labelPath(name, i) !== F.ROOT_PATH, 'an entry has the root label: ' + JSON.stringify(Buffer.from(name).toString('latin1')) + ' #' + i);
ok(F.labelPath(enc(E('U+002F'))) === '/' + E('U+27E6') + 'U+002F' + C, 'name "' + E('U+002F') + '": its escape is escaped');

// --- label path: invariant under VS Code's normalizePath and parse∘toString
const vsNormalize = p => { // what UriIdentityService does to a path (probes/uri-roundtrip)
  const out = [];
  for (const s of p.split('/').slice(1)) {
    if (s === '' || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  return '/' + out.join('/');
};

// --- random names, archives (incl. nested), indices: round trip through the string form
// mulberry32. Not `seed % k` of an LCG: its low bits repeat with a short period, and the first
// version of this check ran 381 distinct cases out of 20 000. SEED=<n> node check.js - another run.
const SEED = Number(process.env.SEED ?? 42) >>> 0;
let state = SEED;
const rnd = k => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * k);
};
const PIECES = ['a', 'B', '/', '/', '.', '..', '', '%', '%2F', '&', '=', '#', '?', '+', ' ', '\\', 'C:', 'c:', '\u00e9',
  'e\u0301', '\u00e4', '\u0000', '\n', '\u007f', '\u0085', '\u00a0', '\u00ad', '\u200b', '\u202e', '\u2066', '\u2028',
  '\u200d', '\u200f', '\ufe0f', '\ufeff', '\ufffd', '\u2400', O, C, O + '84' + C, O + '#1' + C, 'U+0043',
  O + 'U+002F' + C, 'U+002F', '\u{1f600}', '\u0416', '~', '-', '_'];
const randomName = () => {
  if (rnd(4) === 0) return Uint8Array.from({ length: rnd(12) }, () => rnd(256)); // arbitrary bytes
  let s = ''; for (let k = rnd(8); k > 0; k--) s += PIECES[rnd(PIECES.length)];
  return enc(s);
};
const utf8fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ARCHIVES = [ARCHIVE, URI.parse('file:///C:/x.zip'), URI.file('/tmp/a&b=c#d?e%.zip'),
  URI.parse('vscode-remote://ssh-remote%2Bhost/x.zip'), URI.parse('http://u:p@h:8/x.zip?q=1&r=2#f')];
const seen = new Map(), labels = new Map(), roots = new Map();
const N = 20000;
const before = n;
for (let t = 0; t < N; t++) {
  let archive = ARCHIVES[rnd(ARCHIVES.length)];
  for (let d = rnd(4); d > 0; d--) archive = F.build(URI, archive, randomName(), rnd(3));
  const bytes = randomName(), index = rnd(3);
  const u = F.build(URI, archive, bytes, index);
  const s = u.toString();
  const back = URI.parse(s);
  ok(F.same(back, u), 'string round trip ' + s);
  ok(back.toString() === s, 'toString is a fixed point ' + s);
  ok(vsNormalize(u.path) === u.path && !u.path.endsWith('/') && !/^\/[A-Z]:/.test(u.path), 'path is a fixed point of VS Code ' + u.path);
  ok(visible(u.path), 'nothing invisible or acting outside escapes ' + JSON.stringify(u.path));
  { // nothing dropped, nothing added: one path segment per name segment (+1 for the index)
    const plain = Buffer.from(bytes).toString('latin1');
    const want = (plain.endsWith('/') ? plain.slice(0, -1) : plain).split('/').length + (index > 0 ? 1 : 0);
    ok(u.path.slice(1).split('/').length === want, 'one segment per name segment ' + u.path); }
  { const r = unlabel(u.path);
    ok(sameBytes(r.bytes, bytes) && r.index === index, 'label gives back name and index ' + u.path); }
  { let valid = true; try { utf8fatal.decode(bytes); } catch { valid = false; }
    ok(valid === !/\u27e6[0-9A-F]{2}\u27e7/.test(F.renderName(bytes)), 'byte escapes exactly when not UTF-8 ' + Buffer.from(bytes).toString('hex')); }
  const r = F.parse(URI, back);
  ok(r && r.kind === 'entry' && r.archive.toString() === archive.toString() && sameBytes(r.bytes, bytes) && r.index === index, 'parse ' + s);
  // injectivity: one string per (archive, bytes, index); one label per (bytes, index); the root
  // label belongs to no entry
  const key = Buffer.from(bytes).toString('hex') + '\u0000' + index;
  ok((!seen.has(s) || seen.get(s) === archive.toString() + key) && !roots.has(s), 'two objects share ' + s);
  seen.set(s, archive.toString() + key);
  ok(!labels.has(u.path) || labels.get(u.path) === key, 'two entries share the label ' + u.path);
  labels.set(u.path, key);
  ok(u.path !== F.ROOT_PATH, 'an entry has the root label ' + s);
  // the root of the same archive: same properties, and the archive comes back
  const root = F.buildRoot(URI, archive), rs = root.toString(), rback = URI.parse(rs);
  ok(F.same(rback, root) && rback.toString() === rs, 'root: string round trip, toString is a fixed point ' + rs);
  ok(vsNormalize(root.path) === root.path, 'root: path is a fixed point of VS Code');
  const rr = F.parse(URI, rback);
  ok(rr && rr.kind === 'root' && rr.archive.toString() === archive.toString() && !('bytes' in rr), 'root: parse ' + rs);
  ok((!roots.has(rs) || roots.get(rs) === archive.toString()) && !seen.has(rs), 'two objects share ' + rs);
  roots.set(rs, archive.toString());
}
const randomChecks = n - before;
// Guard against the generator degenerating again (the space of cases is far larger than N).
ok(seen.size > 0.95 * N, `only ${seen.size} distinct cases out of ${N}`);

// --- non-canonical forms are rejected
const Q = `archive=${ARCHIVE.toString()}`;
const u = (query, extra = {}) => URI.from({ scheme: F.SCHEME, authority: F.AUTHORITY, path: '/A', fragment: '', query, ...extra });
ok(F.parse(URI, u(`${Q}&entry=QQ`)), 'canonical: entry "A"');
ok(F.parse(URI, u(`${Q}&entry=QQ&index=1`, { path: '/' + E('#1') + '/A' })), 'canonical: index 1');
ok(F.parse(URI, F.build(URI, ARCHIVE, new Uint8Array(0))).bytes.length === 0, 'empty name: entry=');
ok(F.parse(URI, u(Q, { path: F.ROOT_PATH }))?.kind === 'root', 'canonical: root');
ok(F.buildRoot(URI, ARCHIVE).toString() === 'zip-document://v1/%E2%9F%A6U%2B002F%E2%9F%A7?archive%3Dfile%3A%2F%2F%2Fhome%2Fu%2Frelease.zip',
  'root: string of example 3.7');
const REJECT = {
  'entry=QR (lenient decoder → "A")': u(`${Q}&entry=QR`),
  'entry=QQ== (padding)': u(`${Q}&entry=QQ==`),
  'entry=Q Q': u(`${Q}&entry=Q Q`),
  'entry=QQ!': u(`${Q}&entry=QQ!`),
  'entry base64 not base64url': F.build(URI, ARCHIVE, new Uint8Array([0xfb, 0xff])).with({ query: `${Q}&entry=+/8` }),
  'index=0': u(`${Q}&entry=QQ&index=0`),
  'index=01': u(`${Q}&entry=QQ&index=01`),
  'index=': u(`${Q}&entry=QQ&index=`),
  'index=1e1': u(`${Q}&entry=QQ&index=1e1`),
  'index=-1': u(`${Q}&entry=QQ&index=-1`),
  'index too big': u(`${Q}&entry=QQ&index=99999999999999999999`),
  'order': u(`entry=QQ&${Q}`),
  'extra parameter': u(`${Q}&entry=QQ&x=1`),
  'repeated parameter': u(`${Q}&entry=QQ&entry=QQ`),
  'entry label without entry': u(Q),
  'root: path "/"': u(Q, { path: '/' }),
  'root: path of entry "/"': u(Q, { path: '/' + E('') + E('U+002F') }),
  'root: path of empty name': u(Q, { path: '/' + E('') }),
  'root: index without entry': u(`${Q}&index=1`, { path: F.ROOT_PATH }),
  'root label with entry "/"': u(`${Q}&entry=Lw`, { path: F.ROOT_PATH }),
  'root label with empty entry': u(`${Q}&entry=`, { path: F.ROOT_PATH }),
  'root: trailing "&"': u(`${Q}&`, { path: F.ROOT_PATH }),
  'root: other parameter': u('entry=QQ', { path: F.ROOT_PATH }),
  'root: archive not canonical': u('archive=file:///C:/x.zip', { path: F.ROOT_PATH }),
  'root: archive empty': u('archive=', { path: F.ROOT_PATH }),
  'root: empty query': u('', { path: F.ROOT_PATH }),
  'root: authority upper case': u(Q, { path: F.ROOT_PATH, authority: 'V1' }),
  'root: fragment': u(Q, { path: F.ROOT_PATH, fragment: 'L10' }),
  'archive not canonical (C: instead of c%3A)': u(`archive=file:///C:/x.zip&entry=QQ`),
  'archive empty': u(`archive=&entry=QQ`),
  'path differs from label': u(`${Q}&entry=QQ`, { path: '/B' }),
  'path not normalized': u(`${Q}&entry=QQ`, { path: '/./A' }),
  'authority upper case': u(`${Q}&entry=QQ`, { authority: 'V1' }),
  'other format version': u(`${Q}&entry=QQ`, { authority: 'v2' }),
  'fragment': u(`${Q}&entry=QQ`, { fragment: 'L10' }),
  'relative link resolved against an entry (joinPath)': Utils.joinPath(u(`${Q}&entry=YS9SRUFETUUubWQ`, { path: '/a/README.md' }), '..', 'img.png'),
};
for (const [label, uri] of Object.entries(REJECT)) ok(F.parse(URI, uri) === null, `must reject: ${label}`);

// --- why the format does what it does: facts about the tools
ok(['QQ', 'QR', 'QQ==', 'Q Q', 'QQ!'].every(s => Buffer.from(s, 'base64url').toString() === 'A'), 'Node base64url decoder is lenient');
ok(URI.parse('zip-document://v1/C:/a').toString() === 'zip-document://v1/c%3A/a', 'toString lower-cases /X:');
{ const amp = F.build(URI, URI.file('/tmp/a&b.zip'), enc('A'));
  ok(URI.parse(amp.toString(true)).query !== amp.query && F.parse(URI, URI.parse(amp.toString(true))) === null, 'toString(true) does not round-trip'); }
ok(!/[&=]/.test(URI.from({ scheme: 'x', authority: 'a&b=c@h&=:1', path: '/p&=q', query: 'q=1&r=2', fragment: 'f&=g' }).toString()), 'toString() encodes & and = in every component except the port');
ok(URI.from({ scheme: 'x', authority: 'h:1&2=3', path: '/p' }).toString() === 'x://h:1&2=3/p', 'toString() leaves the port as is: & and = pass through');
ok(URI.parse(URI.from({ scheme: 'x', authority: 'h:%41', path: '/p' }).toString()).authority === 'h:A', 'toString() of an odd port is not a fixed point');
for (const port of ['1&2', '1=2', '%41']) {
  const archive = URI.from({ scheme: 'http', authority: 'h:' + port, path: '/x.zip' });
  let threw = false, rootThrew = false;
  try { F.build(URI, archive, enc('a'), 0); } catch { threw = true; }
  try { F.buildRoot(URI, archive); } catch { rootThrew = true; }
  ok(threw && rootThrew, `generator refuses an archive whose P is not canonical (port ${port}), for entries and the root`);
}
// Random archive URIs with hostile components: P breaks only through a non-digit port, and the
// generator either builds a URI the provider accepts or refuses — never a URI it then rejects.
{
  const PIECES = ['a', 'A', '/', '//', '.', '..', '%', '%41', '&', '=', '?', '#', ':', '@', '[', ']', ' ', '+',
    'C:', '\\', 'ä', '‮', '~', '\u0000', '😀'];
  let st = 1;
  const r = () => (st = (st * 1103515245 + 12345) % 2147483648) / 2147483648;
  const str = k => Array.from({ length: Math.floor(r() * k) }, () => PIECES[Math.floor(r() * PIECES.length)]).join('');
  const SCHEMES = ['file', 'http', 'zip-document', 'vscode-remote', 'untitled'];
  let total = 0, broken = 0, notPort = 0, refused = 0, wrong = 0;
  for (let i = 0; i < 50000; i++) {
    let u;
    try {
      u = URI.from({ scheme: SCHEMES[Math.floor(r() * SCHEMES.length)], authority: r() < 0.5 ? '' : str(4),
        path: (r() < 0.8 ? '/' : '') + str(6), query: r() < 0.5 ? '' : str(4), fragment: r() < 0.7 ? '' : str(3) });
    } catch { continue; }
    total++;
    const p = u.toString();
    let back = null;
    try { back = URI.parse(p, true).toString(); } catch {}
    if (p === '' || /[&=]/.test(p) || back !== p) {
      broken++;
      const host = u.authority.replace(/^.*@/, ''), c = host.lastIndexOf(':');
      if (c < 0 || /^[0-9]*$/.test(host.slice(c + 1))) notPort++;
    }
    let root = null;
    try { root = F.buildRoot(URI, u); } catch {}
    let e = null;
    try { e = F.build(URI, u, enc('a/b'), 1); } catch { refused++; if (root) wrong++; continue; }
    if (!root) { wrong++; continue; }
    const t = F.parse(URI, e), t2 = F.parse(URI, URI.parse(e.toString()));
    const r1 = F.parse(URI, root), r2 = F.parse(URI, URI.parse(root.toString()));
    if (!t || !t2 || t.archive.toString() !== p) wrong++;
    if (r1?.kind !== 'root' || r2?.kind !== 'root' || r1.archive.toString() !== p) wrong++;
  }
  ok(notPort === 0, `P breaks only through the port (${broken} of ${total} random archive URIs)`);
  ok(wrong === 0 && refused === broken, `generator refuses exactly those ${refused}, for entries and the root alike, and builds accepted URIs for the rest`);
  console.log(`random archive URIs: ${total}, P not canonical: ${broken} (${(100 * broken / total).toFixed(1)}%), all through the port`);
}
// The mode of Uri.parse(P) is left open by 3.3: strict and lenient give the same verdict on P.
{
  const verdict = (p, strict) => { try { return URI.parse(p, strict).toString() === p; } catch { return false; } };
  const fixed = ['', 'abc', '/abc', 'a b:x', 'x:', 'x:p', 'x://h/p', 'x:/%41', 'file:x', 'A:p', '-x:p', 'x://h:%41/p'];
  const ALPHA = 'ab:/?#%@ +-.A1\\';
  let st = 7;
  const r = () => (st = (st * 1103515245 + 12345) % 2147483648) / 2147483648;
  const random = Array.from({ length: 100000 }, () => Array.from({ length: Math.floor(r() * 9) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join(''));
  const differ = [...fixed, ...random].filter(p => verdict(p, true) !== verdict(p, false));
  ok(differ.length === 0, `strict and lenient Uri.parse agree on whether P is canonical (${fixed.length + random.length} strings)`);
}

// --- size: nesting depth → string length
const lengths = [];
let a = ARCHIVE;
for (let d = 1; d <= 5; d++) { a = F.build(URI, a, enc('inner/archive.zip')); lengths.push(a.toString().length); }

console.log(`seed ${SEED}: ${N} random cases, ${seen.size} distinct, ${randomChecks / N} properties each (${randomChecks} checks); ` +
  `${n - randomChecks} targeted checks. All passed.`);
console.log('example:', F.build(URI, ARCHIVE, enc('src/main.ts')).toString());
console.log('example, root:', F.buildRoot(URI, ARCHIVE).toString());
console.log('example, nested:', F.build(URI, F.build(URI, ARCHIVE, enc('lib/x.jar')), enc('META-INF/MANIFEST.MF'), 1).toString());
console.log('string length for nesting depth 1..5 (name inner/archive.zip):', lengths.join(', '));
