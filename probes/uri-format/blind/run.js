// Differential check of independent implementations (written from PROMPT.md) against the
// implementation for cross-checking, ../uri.js. A divergence is not a verdict on who is wrong:
// it is a place where two readings of docs/URI.txt section 3 differ, to be looked at by a human.
//
// Usage:  node run.js impls/<name>.js [impls/<other>.js ...]
//         SEED=<n> (default 1)  N=<random triples> (default 3000)  SHOW=<examples per category>
const path = require('path');
const { URI } = require('vscode-uri'); // ../node_modules, the same 3.0.8 as check.js
const F = require('../uri.js');

const SEED = Number(process.env.SEED || 1), N = Number(process.env.N || 3000);
const SHOW = Number(process.env.SHOW || 3);

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enc = s => Array.from(Buffer.from(s, 'utf8'));
const hex = b => Buffer.from(b).toString('hex').replace(/(..)(?!$)/g, '$1 ') || '(empty)';
const show = s => JSON.stringify(s).replace(/[^\x20-\x7e]/gu, c => '\\u{' + c.codePointAt(0).toString(16) + '}');

// Pieces of names: everything the label rules care about, valid and broken UTF-8.
const PIECES = [
  'a', 'b', 'README.md', 'x.txt', '/', '/', '/', '.', '..', '%41', '&', '=', '#', '?', '+', '\\',
  'C:', 'c:', 'Z:', ' ', '\t', '\n', '\u0000', '\u007f', '\u0085', '\u00a0', '\u00ad', '\u034f',
  '\u061c', '\u180e', '\u200b', '\u200c', '\u200d', '\u202e', '\u2066', '\u2028', '\u2060', '\u3000',
  '\u3164', '\ufe0f', '\ufeff', '\ufffd', '\ufffe', '\u2400', '\u27e6', '\u27e7', '\u27e6U+0041\u27e7',
  '\u27e684\u27e7', '\u27e6#1\u27e7', '\u00e9', 'e\u0301', '\u212b', '\u4e2d\u6587', '\u{1f468}\u200d\u{1f469}',
  '\u{e0001}', '\u{e0100}', '\u{1fffe}', '\u{10ffff}', '\u{1d173}', '\u{13430}',
].map(enc).concat([
  [0x84], [0xff], [0x80], [0xc3], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf0, 0x9f],
  [0xf4, 0x90, 0x80, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80],
]);

const ARCHIVES = [
  URI.parse('file:///home/u/release.zip'),
  URI.file('/home/u/a&b=c#d%41 \u00e9.zip'),
  URI.parse('file:///c%3A/x.zip'),
  URI.parse('vscode-remote://ssh-remote%2Bhost/home/u/x.zip'),
  URI.parse('untitled:Untitled-1'),
  F.build(URI, URI.parse('file:///home/u/release.zip'), enc('lib/x.jar'), 1),
];

function randomTriple(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const bytes = [];
  const k = Math.floor(rnd() * 7);
  for (let i = 0; i < k; i++) {
    if (rnd() < 0.08) for (let j = Math.floor(rnd() * 4); j > 0; j--) bytes.push(Math.floor(rnd() * 256));
    else bytes.push(...pick(PIECES));
  }
  const r = rnd();
  const index = r < 0.7 ? 0 : r < 0.95 ? 1 + Math.floor(rnd() * 3) : pick([7, 10, 99, 2 ** 53 - 1]);
  return { archive: pick(ARCHIVES), bytes: Uint8Array.from(bytes), index };
}

// Ways to spoil a canonical URI. The expected answer is never assumed: it is what ../uri.js says.
const parts = c => c.query.split('&');
const withQuery = (c, q) => ({ query: q.join('&') });
const setParam = (c, key, value) => {
  const q = parts(c).filter(p => !p.startsWith(key + '='));
  if (value !== null) q.push(key + '=' + value);
  const order = ['pkg', 'entry', 'index'];
  q.sort((a, b) => order.indexOf(a.split('=')[0]) - order.indexOf(b.split('=')[0]));
  return { query: q.join('&') };
};
const entryOf = c => (parts(c).find(p => p.startsWith('entry=')) || 'entry=').slice(6);
const MUTATIONS = {
  'authority V1': () => ({ authority: 'V1' }),
  'authority v2': () => ({ authority: 'v2' }),
  'authority empty': () => ({ authority: '' }),
  'fragment': () => ({ fragment: 'L10' }),
  'scheme zip': () => ({ scheme: 'zip' }),
  'path /x': () => ({ path: '/x' }),
  'path + /': c => ({ path: c.path + '/' }),
  'path /. prefix': c => ({ path: '/.' + c.path }),
  'path // inside': c => ({ path: c.path.replace('/', '//') }),
  'path upper case': c => ({ path: c.path.toUpperCase() }),
  'path lower case': c => ({ path: c.path.toLowerCase() }),
  'path NFC': c => ({ path: c.path.normalize('NFC') }),
  'path NFD': c => ({ path: c.path.normalize('NFD') }),
  'path escape brackets as [ ]': c => ({ path: c.path.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']') }),
  'path of index+1': (c, t) => ({ path: F.labelPath(t.bytes, t.index + 1) }),
  'path without index segment': (c, t) => ({ path: F.labelPath(t.bytes, 0) }),
  'params reversed': c => withQuery(c, parts(c).reverse()),
  'param extra': c => withQuery(c, [...parts(c), 'x=1']),
  'param entry twice': c => withQuery(c, [...parts(c), 'entry=' + entryOf(c)]),
  'param entry dropped': c => setParam(c, 'entry', null),
  'entry + "="': c => setParam(c, 'entry', entryOf(c) + '='),
  'entry + "=="': c => setParam(c, 'entry', entryOf(c) + '=='),
  'entry last char +1': c => { const e = entryOf(c); return e ? setParam(c, 'entry', e.slice(0, -1) + String.fromCharCode(e.charCodeAt(e.length - 1) + 1)) : { query: c.query + '&' }; },
  'entry base64 alphabet': c => setParam(c, 'entry', entryOf(c).replace(/-/g, '+').replace(/_/g, '/')),
  'entry %-encoded': c => setParam(c, 'entry', entryOf(c).replace(/^./, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())),
  'entry with space': c => setParam(c, 'entry', entryOf(c).replace(/^(.)/, '$1 ')),
  'index=0': c => setParam(c, 'index', '0'),
  'index=01': (c, t) => setParam(c, 'index', '0' + (t.index || 1)),
  'index=1e1': c => setParam(c, 'index', '1e1'),
  'index=-1': c => setParam(c, 'index', '-1'),
  'index=': c => setParam(c, 'index', ''),
  'index=+1': c => setParam(c, 'index', '+1'),
  'index=2^53': c => setParam(c, 'index', '9007199254740992'),
  'index dropped': c => setParam(c, 'index', null),
  'pkg empty': c => setParam(c, 'pkg', ''),
  'pkg without scheme': c => setParam(c, 'pkg', 'home/u/release.zip'),
  'pkg upper-case scheme': c => setParam(c, 'pkg', parts(c)[0].slice(4).replace(/^[a-z-]+/, s => s.toUpperCase())),
  'pkg toString(true)': (c, t) => setParam(c, 'pkg', t.archive.toString(true)),
  'pkg with C:': c => setParam(c, 'pkg', 'file:///C:/x.zip'),
  'pkg + "#"': c => setParam(c, 'pkg', parts(c)[0].slice(4) + '#'),
};
const ALPHABET = ['a', 'A', 'z', '0', '9', '/', '.', '%', '&', '=', '?', '#', '+', '-', '_', ':', ' ',
  '\u27e6', '\u27e7', '\u00e9', '\u200b', '\u{1f600}'];
function randomEdit(rnd, c) {
  const key = ['path', 'query', 'query', 'authority'][Math.floor(rnd() * 4)];
  const s = Array.from(c[key]);
  const i = Math.floor(rnd() * (s.length + 1));
  const ch = ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  const op = rnd();
  if (op < 0.4 && s.length) s.splice(Math.min(i, s.length - 1), 1, ch);
  else if (op < 0.7 || !s.length) s.splice(i, 0, ch);
  else s.splice(Math.min(i, s.length - 1), 1);
  return { [key]: s.join('') };
}

const components = u => ({ scheme: u.scheme, authority: u.authority, path: u.path, query: u.query, fragment: u.fragment });
const tryFrom = (base, change) => { try { return URI.from({ ...components(base), ...change }); } catch { return null; } };

function normParse(r) {
  if (r === null) return 'null';
  if (!r || typeof r !== 'object' || !r.archive || typeof r.archive.toString !== 'function') return 'invalid result ' + show(String(r));
  let name;
  try { name = hex(Buffer.from(r.name)); } catch { return 'invalid name'; }
  return `archive=${show(r.archive.toString())} name=${name} index=${r.index}`;
}
const refParse = u => { const r = F.parse(URI, u); return r && { archive: r.archive, name: r.bytes, index: r.index }; };

function check(implPath) {
  const impl = require(path.resolve(implPath));
  const rnd = mulberry32(SEED);
  const stats = new Map();
  const note = (cat, ok, example) => {
    if (!stats.has(cat)) stats.set(cat, { total: 0, diff: 0, examples: [] });
    const s = stats.get(cat);
    s.total++;
    if (!ok) { s.diff++; if (s.examples.length < SHOW) s.examples.push(example); }
  };
  const call = f => { try { return { v: f() }; } catch (e) { return { e: String(e && e.message || e) }; } };
  const triple = t => `name ${hex(t.bytes)}, index ${t.index}, archive ${show(t.archive.toString())}`;

  for (let n = 0; n < N; n++) {
    const t = randomTriple(rnd);
    const ref = F.build(URI, t.archive, t.bytes, t.index);
    // build
    const b = call(() => impl.build(t.archive, Uint8Array.from(t.bytes), t.index));
    const got = b.e ? 'threw: ' + b.e : (b.v && typeof b.v.toString === 'function' ? show(b.v.toString()) + ' ' + show(components(b.v)) : 'not a URI');
    const want = show(ref.toString()) + ' ' + show(components(ref));
    note('build', got === want, { input: triple(t), want, got });
    // parse of the canonical URI, as an object and after a trip through its string
    for (const [cat, u] of [['parse canonical', ref], ['parse canonical via string', URI.parse(ref.toString())]]) {
      const w = normParse(refParse(u)), g = call(() => impl.parse(u));
      note(cat, !g.e && normParse(g.v) === w, { input: triple(t) + '; uri ' + show(components(u)), want: w, got: g.e ? 'threw: ' + g.e : normParse(g.v) });
    }
    // parse of spoiled URIs
    const cases = Object.entries(MUTATIONS).map(([cat, m]) => [cat, m(ref, t)]);
    for (let k = 0; k < 4; k++) cases.push(['random edit', randomEdit(rnd, ref)]);
    for (const [cat, change] of cases) {
      const u = tryFrom(ref, change);
      if (!u) continue;
      const w = normParse(refParse(u)), g = call(() => impl.parse(u));
      note('parse: ' + cat, !g.e && normParse(g.v) === w, { input: show(components(u)), want: w, got: g.e ? 'threw: ' + g.e : normParse(g.v) });
    }
  }

  let total = 0, diff = 0;
  const lines = [];
  for (const [cat, s] of stats) {
    total += s.total; diff += s.diff;
    if (!s.diff) continue;
    lines.push(`  ${cat}: ${s.diff} of ${s.total} differ`);
    for (const ex of s.examples) lines.push(`    input ${ex.input}`, `      expected ${ex.want}`, `      got      ${ex.got}`);
  }
  console.log(`${implPath}: seed ${SEED}, ${N} random triples, ${stats.size} categories, ${total} comparisons, ${diff} differ`);
  if (lines.length) console.log(lines.join('\n'));
  return diff;
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node run.js impls/<name>.js ...'); process.exit(2); }
let bad = 0;
for (const f of files) bad += check(f) ? 1 : 0;
process.exit(bad ? 1 : 0);
