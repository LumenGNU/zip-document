// Speed of the implementations on a large archive. Each implementation runs in its own process
// (in one process they share the JIT state of vscode-uri and the numbers move by a factor of 5).
// Time per entry: build of every entry of the archive, then parse of every URI built; median of
// RUNS passes. The URIs are kept, as a provider would keep them, so GC is part of the cost.
//
// Usage:  node perf.js [<impl>.js ...]   (default: fast.js and ../blind/impls/_reference.js, which is
//         ../uri.js behind the same interface; the blind ones: node perf.js ../blind/impls/*.js)
//         ENTRIES=<n> (default 100000)  RUNS=<n> (default 7)
const path = require('path'), { execFileSync } = require('child_process');

const ENTRIES = Number(process.env.ENTRIES || 100000), RUNS = Number(process.env.RUNS || 7);

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Names like those of a source tree or node_modules: mostly ASCII, some non-ASCII words,
// 10% directory records, rare escaped characters and broken UTF-8. Average about 35 bytes.
function archiveNames(n) {
  const rnd = mulberry32(42), pick = a => a[Math.floor(rnd() * a.length)];
  const words = ['src', 'lib', 'test', 'node_modules', 'dist', 'main', 'java', 'com', 'example', 'util', 'index',
    'core', 'api', 'v2', 'assets', 'images', 'docs', 'README', 'package', 'internal', 'impl', 'Component',
    'helpers', 'build', 'резюме', 'документы', '中文', 'テスト', 'café', 'naïve'];
  const ext = ['.js', '.ts', '.json', '.md', '.java', '.class', '.png', '.txt', '.d.ts', ''];
  const out = [];
  for (let i = 0; i < n; i++) {
    const segs = [];
    for (let d = 1 + Math.floor(rnd() * 7); d > 0; d--) segs.push(pick(words) + (rnd() < 0.3 ? '-' + Math.floor(rnd() * 1000) : ''));
    let s = segs.join('/') + (rnd() < 0.1 ? '/' : pick(ext));
    if (rnd() < 0.003) s += '​';
    let b = Buffer.from(s, 'utf8');
    if (rnd() < 0.002) b = Buffer.concat([b, Buffer.from([0xff])]);
    out.push(new Uint8Array(b));
  }
  return out;
}

function child(file) {
  const { URI } = require('vscode-uri');
  const impl = require(path.resolve(file));
  const names = archiveNames(ENTRIES);
  const archive = URI.file('/home/u/projects/big-release-2026.11.zip');
  const time = f => { const s = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - s) / ENTRIES; };
  const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  let uris;
  const b = [], p = [];
  for (let run = 0; run < RUNS; run++) {
    b.push(time(() => { uris = new Array(ENTRIES); for (let i = 0; i < ENTRIES; i++) uris[i] = impl.build(archive, names[i], i % 50 === 0 ? 1 : 0); }));
    p.push(time(() => { for (let i = 0; i < ENTRIES; i++) if (!impl.parse(uris[i])) throw new Error('canonical URI rejected'); }));
  }
  process.stdout.write(JSON.stringify({ build: median(b), parse: median(p), spread: Math.max(...b) / Math.min(...b) }));
}

if (process.argv[2] === '--child') child(process.argv[3]);
else {
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : [path.join(__dirname, 'fast.js'), path.join(__dirname, '../blind/impls/_reference.js')];
  const rows = [];
  for (const f of files) {
    try {
      rows.push({ name: path.basename(f, '.js'), ...JSON.parse(execFileSync(process.execPath, [__filename, '--child', f], { encoding: 'utf8' })) });
    } catch (e) { rows.push({ name: path.basename(f, '.js'), error: String(e.stderr || e.message).split('\n').find(l => /Error/.test(l)) || 'failed' }); }
  }
  const w = Math.max(...rows.map(r => r.name.length));
  console.log(`${ENTRIES} entries, median of ${RUNS}; microseconds per entry`);
  console.log(['impl'.padEnd(w), '  build', '  parse', 'spread'].join('  '));
  for (const r of rows.sort((a, b) => (a.build ?? Infinity) - (b.build ?? Infinity))) {
    if (r.error) { console.log(`${r.name.padEnd(w)}  ${r.error}`); continue; }
    console.log([r.name.padEnd(w), (r.build / 1000).toFixed(2).padStart(7), (r.parse / 1000).toFixed(2).padStart(7),
      ('×' + r.spread.toFixed(2)).padStart(6)].join('  '));
  }
}
