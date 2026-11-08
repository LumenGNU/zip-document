// How does VS Code show the path of an entry URI (docs/URI.txt) to a human?
//
// The path is a label only: tab title, tab description (same-name tabs), hover, breadcrumbs,
// window title. The extension API gives `tab.label` only, so this probe reads the rendered
// workbench DOM through the Chrome DevTools Protocol (run.js starts VS Code with
// --remote-debugging-port) and takes a screenshot of the title area for each case.
// Question: is Unicode in the path shown as is — not percent-encoded, not NFC/NFD/NFKC-normalized?
//
// Results: out-ui.txt, out-ui/*.png. Run: PROBE=ui-probe.js xvfb-run -a -s "-screen 0 1600x900x24" node run.js

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const F = require('./uri');

const PORT = Number(process.env.CDP_PORT || 9339);
const OUT = path.join(__dirname, 'out-ui');
const enc = s => new TextEncoder().encode(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cps = s => Array.from(s).map(ch => { const c = ch.codePointAt(0); return c > 0x20 && c < 0x7f ? ch : `\\u{${c.toString(16)}}`; }).join('');

const provider = {
  onDidChangeFile: new vscode.EventEmitter().event,
  watch: () => new vscode.Disposable(() => {}),
  stat: uri => { if (!F.parse(vscode.Uri, uri)) throw vscode.FileSystemError.FileNotFound(uri); return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 2 }; },
  readFile: uri => { if (!F.parse(vscode.Uri, uri)) throw vscode.FileSystemError.FileNotFound(uri); return enc('ok'); },
  readDirectory: () => { throw vscode.FileSystemError.FileNotFound(); },
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  writeFile() { throw vscode.FileSystemError.NoPermissions(); },
  delete() { throw vscode.FileSystemError.NoPermissions(); },
  rename() { throw vscode.FileSystemError.NoPermissions(); },
};

async function connect() {
  if (typeof WebSocket === 'undefined') throw new Error('no global WebSocket in the extension host');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === 'page' && /workbench/.test(t.url));
  if (!page) throw new Error('workbench page not found: ' + JSON.stringify(list.map(t => t.url)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws: ' + (e.message || e.type))); });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// Everything a human sees of the active editor's resource.
const READ_DOM = `(() => {
  const t = s => s ? s.textContent : null;
  const tabs = [...document.querySelectorAll('.part.editor .tabs-container .tab')].map(e => ({
    active: e.classList.contains('active'),
    name: t(e.querySelector('.label-name')),
    description: t(e.querySelector('.label-description')),
    aria: e.getAttribute('aria-label'),
  }));
  const crumbs = [...document.querySelectorAll('.part.editor .breadcrumbs-control .monaco-breadcrumb-item')].map(e => e.textContent);
  const titlebar = t(document.querySelector('.part.titlebar .window-title'));
  return { tabs, crumbs, windowTitle: document.title, titlebar };
})()`;

async function hoverActiveTab(c) {
  const r = await c.evaluate(`(() => { const e = document.querySelector('.part.editor .tabs-container .tab.active'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) return null;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await sleep(1800);
  const text = await c.evaluate(`(() => { const h = [...document.querySelectorAll('.workbench-hover, .monaco-hover')].filter(e => e.offsetParent !== null); return h.length ? h.map(e => e.textContent).join(' | ') : null; })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 600 });
  await sleep(300);
  return text;
}

async function shot(c, file) {
  const bottom = await c.evaluate(`(() => { const e = document.querySelector('.part.editor .title'); return e ? Math.ceil(e.getBoundingClientRect().bottom) : 120; })()`);
  const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1100, height: bottom + 4, scale: 1 } });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
}

const ARCHIVE = vscode.Uri.file('/tmp/probe/release.zip');
// [label, name (string → UTF-8 bytes, or bytes), what NFC / NFKC would turn the last segment into]
const CASES = [
  ['кириллица', 'папка/файл.txt'],
  ['NFC é', 'café.txt'],
  ['NFD e+◌́', 'café.txt'],
  ['лигатура ﬁ (NFKC → fi)', 'ﬁle.txt'],
  ['полноширинные ＡＢＣ (NFKC → ABC)', 'ＡＢＣ.txt'],
  ['верхний индекс ² (NFKC → 2)', 'x².txt'],
  ['полуширинная катакана (NFKC → полноширинная)', 'ｶﾀｶﾅ.txt'],
  ['римская Ⅻ (NFKC → XII)', 'Ⅻ.txt'],
  ['㎏ (NFKC → kg)', '㎏.txt'],
  ['знак ангстрема U+212B (NFC → Å U+00C5)', 'Å.txt'],
  ['знак ома U+2126 (NFC → Ω U+03A9)', 'Ω.txt'],
  ['чамо хангыля (NFC → 가)', '가.txt'],
  ['китайский', '中文/文件.txt'],
  ['эмодзи с ZWJ', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}.txt'],
  ['иврит (RTL)', 'שלום.txt'],
  ['RLO U+202E', 'invoice\u202etxt.exe'],
  ['пробел нулевой ширины', 'a\u200bb.txt'],
  ['BOM в начале', '\ufeffbom.txt'],
  ['таб и перевод строки', 'a\tb\nc.txt'],
  ['NUL', 'a\u0000b.txt'],
  ['NEL U+0085 и DEL', 'a\u0085b\u007fc.txt'],
  ['изоляция LRI…PDI', 'a\u2066b\u2069.txt'],
  ['много диакритик', 'ź̂̃̄̅.txt'],
  ['CP437 0x84 → ä', new Uint8Array([0x84, 0x2e, 0x74, 0x78, 0x74])],
  ['глубокий путь для крошек', 'один/два/три/ﬁle.txt'],
  ['пустое имя', ''],
];
// Opened together: what tells same-name tabs apart.
const GROUPS = [
  ['одноимённые из разных каталогов', [['a/README.md'], ['b/README.md']]],
  ['дубликаты (index 0 и 1)', [['a/README.md', 0], ['a/README.md', 1]]],
  ['NFC и NFD одного имени', [['d/café.txt'], ['d/café.txt']]],
  ['одно имя, записанное по-разному, и настоящий a/c/b.txt', [['a/b.txt'], ['a/./b.txt'], ['a//b.txt'], ['./a/b.txt'], ['/a/b.txt'], ['a/c/../b.txt'], ['a/c/b.txt']]],
  ['запись каталога и файл с тем же именем', [['a/b/'], ['a/b']]],
  ['похожие имена: пробел и NBSP, ZWSP, NUL и знак U+2400', [['d/a b.txt'], ['d/a\u00a0b.txt'], ['d/ab.txt'], ['d/a\u200bb.txt'], ['d/a\u0000b.txt'], ['d/a␀b.txt']]],
  ['ä в UTF-8 и байт 0x84', [[new Uint8Array([0x64, 0x2f, 0xc3, 0xa4, 0x2e, 0x74, 0x78, 0x74])], [new Uint8Array([0x64, 0x2f, 0x84, 0x2e, 0x74, 0x78, 0x74])]]],
];

exports.run = async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const L = [`VS Code ${vscode.version}, ${process.platform}. Что видит человек: DOM workbench через CDP.`, ''];
  const reg = vscode.workspace.registerFileSystemProvider(F.SCHEME, provider, { isReadonly: true, isCaseSensitive: true });
  let c;
  try { c = await connect(); } catch (e) { L.push('CDP: ' + e.message); fs.writeFileSync(path.join(__dirname, 'out-ui.txt'), L.join('\n') + '\n'); reg.dispose(); return; }
  await c.send('Page.enable');
  const toBytes = n => typeof n === 'string' ? enc(n) : n;
  const verdict = (got, want) => got === null ? 'НЕТ' : got === want ? 'как есть' : `ИНАЧЕ ${JSON.stringify(cps(got))}`;

  let k = 0, bad = 0;
  for (const [label, name] of CASES) {
    k++;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const u = F.build(vscode.Uri, ARCHIVE, toBytes(name));
    const segs = u.path.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    await vscode.commands.executeCommand('vscode.open', u);
    await sleep(900);
    const d = await c.evaluate(READ_DOM);
    const tab = d.tabs.find(t => t.active) || {};
    const hover = await hoverActiveTab(c);
    const file = `${String(k).padStart(2, '0')}.png`;
    await shot(c, file);
    const nameOk = tab.name === last;
    const crumbsOk = segs.every(s => d.crumbs.includes(s));
    if (!nameOk) bad++;
    L.push(`## ${k}. ${label}   [${file}]`,
      `  path          ${JSON.stringify(cps(u.path))}`,
      `  NFC / NFKC    ${last.normalize('NFC') === last ? 'не меняет' : 'меняет → ' + JSON.stringify(cps(last.normalize('NFC')))} / ${last.normalize('NFKC') === last ? 'не меняет' : 'меняет → ' + JSON.stringify(cps(last.normalize('NFKC')))}`,
      `  вкладка       ${verdict(tab.name ?? null, last)}`,
      `  описание      ${JSON.stringify(tab.description && cps(tab.description))}`,
      `  aria-label    ${JSON.stringify(tab.aria && cps(tab.aria))}`,
      `  подсказка     ${JSON.stringify(hover && cps(hover))}`,
      `  крошки        ${JSON.stringify(d.crumbs.map(cps))}  ${crumbsOk ? '(все сегменты path как есть)' : '(НЕ все сегменты path как есть)'}`,
      `  окно          ${JSON.stringify(cps(d.windowTitle))}`,
      '');
  }

  for (const [label, items] of GROUPS) {
    k++;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [name, index = 0] of items) {
      await vscode.commands.executeCommand('vscode.open', F.build(vscode.Uri, ARCHIVE, toBytes(name), index), { preview: false });
      await sleep(600);
    }
    await sleep(500);
    const d = await c.evaluate(READ_DOM);
    const file = `${String(k).padStart(2, '0')}.png`;
    await shot(c, file);
    L.push(`## ${k}. ${label}   [${file}]`);
    for (const t of d.tabs) L.push(`  вкладка ${JSON.stringify(cps(t.name || ''))}  описание ${JSON.stringify(t.description && cps(t.description))}`);
    L.push('');
  }

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  c.close();
  reg.dispose();
  L.push(bad ? `ИТОГ: заголовок вкладки не равен последнему сегменту path в ${bad} случаях` : 'ИТОГ: заголовок вкладки во всех случаях — последний сегмент path, символ в символ');
  fs.writeFileSync(path.join(__dirname, 'out-ui.txt'), L.join('\n') + '\n');
};
