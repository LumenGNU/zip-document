// Benchmark of the blind implementations. Not a ranking: conformance is pass/fail (run.js and the
// consensus below), the rest is a table of properties that do not change the result. Speed is
// measured by ../speed/perf.js, one process per implementation: in one process it is noise.
//
// Consensus: arbitrary spoiled URIs, each given to every implementation; any minority is a
// divergence. ../uri.js votes like the others and is not the expected answer here.
//
// Usage:  node bench.js [impls/<name>.js ...]   (default: every file in impls/)
//         SEED=<n> (default 1)  N=<spoiled URIs per seed> (default 6000)
const fs = require('fs'), path = require('path');
const { URI } = require('vscode-uri'); // ../node_modules, the same 3.0.8 as run.js
const F = require('../uri.js');

const SEED = Number(process.env.SEED || 1), N = Number(process.env.N || 6000);

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const enc = s => Buffer.from(s, 'utf8');
const call = f => { try { return { v: f() }; } catch { return { e: true }; } };
const norm = r => r === null ? 'null'
  : r && r.archive && typeof r.archive.toString === 'function'
    ? `${r.archive.toString()} | ${Buffer.from(r.name).toString('hex') || '(empty)'} | ${r.index}`
    : 'invalid result';

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, 'impls')).filter(f => f.endsWith('.js')).sort().map(f => path.join('impls', f));
const impls = files.map(f => ({
  name: path.basename(f, '.js'),
  m: require(path.resolve(f)),
  src: fs.readFileSync(f, 'utf8'),
}));

// Lines of code without comments and blank lines.
const sloc = s => s.split('\n').filter(l => l.trim() && !/^\s*\/\//.test(l)).length;

const archive = URI.parse('file:///home/u/release.zip');

// Milliseconds per build of a 64 KiB name: shows quadratic work, if any.
function big(m) {
  const b = enc('ab/'.repeat(22000));
  const s = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) m.build(archive, b, 0);
  return Number(process.hrtime.bigint() - s) / 5e6;
}

// Spoiled URIs: canonical URIs of awkward names, then 1-3 random edits of their components.
const ALPHABET = ['a', 'Z', '0', '/', '.', '%', '%41', '%2F', '&', '=', '?', '#', '+', '-', '_', ':', ' ',
  '⟦', '⟧', '⟦#1⟧', 'é', 'é', '​', '\u{1f600}', 'file://', 'C:', '..'];
function spoiled(seed, n) {
  const rnd = mulberry32(seed), pick = a => a[Math.floor(rnd() * a.length)], out = [];
  const bases = [];
  for (const name of ['a', 'a/', '', 'C:x', '..', '⟦', 'd\\a/b']) for (const index of [0, 1, 12]) bases.push(F.build(URI, archive, enc(name), index));
  for (let i = 0; i < n; i++) {
    const b = pick(bases);
    const c = { scheme: b.scheme, authority: b.authority, path: b.path, query: b.query, fragment: '' };
    for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
      const key = pick(['path', 'query', 'query', 'query', 'authority', 'fragment']);
      const s = Array.from(c[key]), j = Math.floor(rnd() * (s.length + 1)), op = rnd();
      if (op < 0.4 && s.length) s.splice(Math.min(j, s.length - 1), 1, pick(ALPHABET));
      else if (op < 0.75) s.splice(j, 0, pick(ALPHABET));
      else s.splice(j, 1);
      c[key] = s.join('');
    }
    let u;
    try { u = URI.from(c); } catch { continue; }
    out.push(u);
    if (rnd() < 0.3) out.push(URI.parse(u.toString()));
  }
  return out;
}
function consensus(uris) {
  const minority = new Map(impls.map(i => [i.name, 0]));
  let split = 0, accepted = 0;
  const examples = [];
  for (const u of uris) {
    const votes = new Map();
    for (const i of impls) {
      const g = call(() => i.m.parse(u));
      const k = g.e ? 'threw' : norm(g.v);
      if (!votes.has(k)) votes.set(k, []);
      votes.get(k).push(i.name);
    }
    if (votes.size === 1) { if (!votes.has('null')) accepted++; continue; }
    split++;
    const sorted = [...votes].sort((a, b) => b[1].length - a[1].length);
    for (const [, who] of sorted.slice(1)) for (const w of who) minority.set(w, minority.get(w) + 1);
    if (examples.length < 5) examples.push({ uri: u.toString(), votes: sorted });
  }
  return { total: uris.length, accepted, split, minority, examples };
}

// Outside the task's contract: the checker never passes these, a provider might.
const OUTSIDE = {
  'build without index gives index 0': m => {
    const r = call(() => m.build(archive, enc('a'), undefined));
    return !r.e && r.v.toString() === m.build(archive, enc('a'), 0).toString();
  },
  'build reads a Buffer slice by its offset': m => {
    const slice = Buffer.from('xxREADME.mdyy').subarray(2, 11);
    const r = call(() => m.build(archive, slice, 0));
    return !r.e && r.v.toString() === m.build(archive, Uint8Array.from(enc('README.md')), 0).toString();
  },
  'build refuses index 1.5, -1, 2^53, NaN, "1"': m =>
    [1.5, -1, 2 ** 53, NaN, '1'].every(i => call(() => m.build(archive, enc('a'), i)).e),
  'parse of null, undefined, a string, {}, 42 gives null': m =>
    [null, undefined, 'zip-document://v1/a', {}, 42].every(x => { const r = call(() => m.parse(x)); return !r.e && r.v === null; }),
  'parse of an object whose getter throws gives null': m => {
    const r = call(() => m.parse({ get scheme() { throw new Error('getter'); } }));
    return !r.e && r.v === null;
  },
  'two parse results do not share the name': m => {
    const u = m.build(archive, enc('abc'), 0);
    const a = m.parse(u), b = m.parse(u);
    a.name[0] = 0;
    return b.name[0] === 0x61;
  },
};

const uris = [...spoiled(SEED, N), ...spoiled(SEED + 1, N)];
const fz = consensus(uris);
console.log(`consensus: seeds ${SEED}, ${SEED + 1}; ${fz.total} spoiled URIs, ${impls.length} implementations; ` +
  `accepted by all ${fz.accepted}, divergent ${fz.split}`);
for (const ex of fz.examples) {
  console.log(`  uri ${JSON.stringify(ex.uri)}`);
  for (const [k, who] of ex.votes) console.log(`    ${who.length}: ${k}${who.length < 4 ? ' (' + who.join(', ') + ')' : ''}`);
}

const outside = Object.keys(OUTSIDE);
const rows = impls.map(i => ({ name: i.name, sloc: sloc(i.src), big: big(i.m),
  outside: outside.map(k => call(() => OUTSIDE[k](i.m)).v === true ? '+' : '-').join('') }));
const w = Math.max(...rows.map(r => r.name.length));
console.log('\n' + ['impl'.padEnd(w), 'sloc', '64KiB ms', 'minority', 'outside'].join('  '));
for (const r of rows.sort((a, b) => a.sloc - b.sloc)) {
  console.log([r.name.padEnd(w), String(r.sloc).padStart(4), r.big.toFixed(1).padStart(8),
    String(fz.minority.get(r.name)).padStart(8), r.outside].join('  '));
}
console.log('\noutside, by position:\n' + outside.map((k, j) => `  ${j + 1}. ${k}`).join('\n'));
process.exit(fz.split ? 1 : 0);
