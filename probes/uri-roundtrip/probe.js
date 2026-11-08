// What does VS Code do with a URI of our scheme on its way to the FileSystemProvider?
//
// A logging provider for scheme `zip` (isCaseSensitive: true, isReadonly: true, as planned
// for the extension) records every URI it is called with. Each case URI is sent through:
//   fs    — workspace.fs.stat + readFile
//   doc   — workspace.openTextDocument
//   open  — commands.executeCommand('vscode.open') (what the custom editor will use)
// and the URI that arrives is compared with the one sent. Pairs check whether VS Code
// treats two different URIs as one resource (same TextDocument / same tab).
//
// Results: out.json (raw) and out.txt (readable). Runs inside VS Code via run.js.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ARCHIVE = 'file:///tmp/probe/x.zip';

// Every char outside printable ASCII as \u{hex}, so NFC/NFD, NUL, surrogates are visible.
const show = s => Array.from(s).map(ch => {
  const c = ch.codePointAt(0);
  if (ch === '\\') return '\\\\';
  return c > 0x20 && c < 0x7f ? ch : `\\u{${c.toString(16)}}`;
}).join('');

const str = u => { try { return u.toString(); } catch (e) { return `toString() бросает: ${e.message}`; } };
const desc = u => u && { scheme: u.scheme, authority: u.authority, path: u.path, query: u.query, fragment: u.fragment, str: str(u) };
const diff = (sent, got) => {
  if (!got) return 'нет URI';
  const d = ['scheme', 'authority', 'path', 'query', 'fragment'].filter(k => sent[k] !== got[k]);
  return d.length ? 'ИЗМЕНЁН: ' + d.map(k => `${k} ${JSON.stringify(show(sent[k]))} → ${JSON.stringify(show(got[k]))}`).join('; ') : 'без изменений';
};

let calls = [];
let watchId = 0;
const rec = (op, uri, extra) => calls.push({ op, uri: desc(uri), ...extra });
const provider = {
  onDidChangeFile: new vscode.EventEmitter().event,
  watch(uri, options) {
    const id = ++watchId;
    rec('watch', uri, { id, options });
    return new vscode.Disposable(() => rec('unwatch', uri, { id }));
  },
  stat(uri) {
    rec('stat', uri);
    const dir = uri.authority === '' && (uri.path === '/' || uri.path === '');
    return { type: dir ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: 0, size: 64 };
  },
  readDirectory(uri) { rec('readDirectory', uri); return []; },
  readFile(uri) { rec('readFile', uri); return new TextEncoder().encode(JSON.stringify(desc(uri))); },
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  writeFile() { throw vscode.FileSystemError.NoPermissions(); },
  delete() { throw vscode.FileSystemError.NoPermissions(); },
  rename() { throw vscode.FileSystemError.NoPermissions(); },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms} ms`); })]);
const mk = c => vscode.Uri.from({ scheme: 'zip', authority: c.a ?? '', path: c.p, query: c.q ?? ARCHIVE, fragment: c.f ?? '' });
const closeAll = () => vscode.commands.executeCommand('workbench.action.closeAllEditors');
const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);

async function step(fn) {
  calls = [];
  let result, error;
  try { result = await timeout(fn(), 8000); } catch (e) { error = String(e && e.message || e); }
  await sleep(150);
  return { result, error, calls };
}

// Path cases. `prefix` keeps doc/open from hitting a TextDocument cached by a previous step.
const S = 'x'.repeat(300);
const CASES = [
  ['обычный',                  { p: '/a/b.txt' }],
  ['//  в середине',           { p: '/a//b.txt' }],
  ['//  в конце',              { p: '/a//' }],
  ['/./',                      { p: '/a/./b.txt' }],
  ['/../',                     { p: '/a/../b.txt' }],
  ['/.. в начале',             { p: '/../b.txt' }],
  ['/ в конце',                { p: '/a/b.txt/' }],
  ['. в конце',                { p: '/a/b.txt.' }],
  ['пробел в конце',           { p: '/a/b.txt ' }],
  ['регистр',                  { p: '/A/B.TXT' }],
  ['NFC é',                    { p: '/é.txt' }],
  ['NFD e+◌́',                  { p: '/é.txt' }],
  ['текст %FF',                { p: '/%FF.txt' }],
  ['текст %2F',                { p: '/a%2Fb.txt' }],
  ['? и # в пути',             { p: '/a?b#c.txt' }],
  ['пробел',                   { p: '/a b.txt' }],
  ['\\ в пути',                { p: '/a\\b.txt' }],
  ['NUL',                      { p: '/a\u0000b.txt' }],
  ['U+0001',                   { p: '/a\u0001b.txt' }],
  ['перевод строки',           { p: '/a\nb.txt' }],
  ['одиночный суррогат',       { p: '/\ud800.txt' }],
  ['U+FFFD',                   { p: '/�.txt' }],
  ['длинный сегмент 300',      { p: `/${S}.txt` }],
  ['authority 2',              { a: '2', p: '/a/b.txt' }],
  ['authority AbC',            { a: 'AbC', p: '/a/b.txt' }],
  ['query с & и =',            { p: '/a/b.txt', q: 'file:///tmp/a&b=c.zip' }],
  ['query пустой',             { p: '/a/b.txt', q: '' }],
  ['fragment L10',             { p: '/a/b.txt', f: 'L10' }],
  ['вложенный zip в query',    { p: '/a/b.txt', q: vscode.Uri.from({ scheme: 'zip', authority: '2', path: '/in/x.zip', query: ARCHIVE }).toString() }],
  ['корень /',                 { p: '/', raw: true }],
  ['пустой path',              { p: '', raw: true }],
  ['// в начале, без authority', { p: '//a/b.txt', raw: true }],
  ['12 × .. выше корня',       { p: '/' + '../'.repeat(12) + 'a', raw: true }],
  ['/a/..',                    { p: '/a/..', raw: true }],
  ['/..',                      { p: '/..', raw: true }],
  ['authority, пустой path',   { a: 'm', p: '', raw: true }],
  ['authority, path /',        { a: 'm', p: '/', raw: true }],
];

const PAIRS = [
  ['a/b vs a//b',        { p: '/a/b.txt' }, { p: '/a//b.txt' }],
  ['a/b vs a/./b',       { p: '/a/b.txt' }, { p: '/a/./b.txt' }],
  ['a/b vs x/../a/b',    { p: '/a/b.txt' }, { p: '/x/../a/b.txt' }],
  ['a/b vs a/b/',        { p: '/a/b.txt' }, { p: '/a/b.txt/' }],
  ['a/b vs a/b.',        { p: '/a/b.txt' }, { p: '/a/b.txt.' }],
  ['регистр пути',       { p: '/a/b.txt' }, { p: '/A/B.TXT' }],
  ['NFC vs NFD',         { p: '/é.txt' }, { p: '/é.txt' }],
  ['a/b vs a\\b',        { p: '/a/b.txt' }, { p: '/a\\b.txt' }],
  ['регистр authority',  { a: 'x', p: '/a/b.txt' }, { a: 'X', p: '/a/b.txt' }],
  ['регистр query',      { p: '/a/b.txt', q: 'file:///tmp/x.zip' }, { p: '/a/b.txt', q: 'file:///tmp/X.zip' }],
  ['fragment',           { p: '/a/b.txt' }, { p: '/a/b.txt', f: 'L10' }],
  ['entry=QQ vs entry=QR', { p: '/a/b.txt', q: `pkg=${ARCHIVE}&entry=QQ` }, { p: '/a/b.txt', q: `pkg=${ARCHIVE}&entry=QR` }],
];

// Watchers: one URI open in several editor groups, then closed one by one.
// Every provider call is logged in order with the action that preceded it.
async function watchLifecycle() {
  const log = [];
  const act = async (label, fn) => {
    calls = [];
    try { await timeout(fn(), 8000); } catch (e) { log.push({ label, error: String(e.message || e) }); }
    await sleep(800);
    log.push({ label, tabs: allTabs().length, groups: vscode.window.tabGroups.all.length,
               calls: calls.filter(c => c.op === 'watch' || c.op === 'unwatch').map(c => ({ op: c.op, id: c.id, str: c.uri.str, options: c.options })) });
  };
  const u = mk({ p: '/lifecycle/a/b.txt' });
  const u2 = mk({ p: '/lifecycle/a/b.txt', q: `pkg=${ARCHIVE}&entry=QR` });
  await act('vscode.open(u)', () => vscode.commands.executeCommand('vscode.open', u));
  await act('splitEditor', () => vscode.commands.executeCommand('workbench.action.splitEditor'));
  await act('vscode.open(u, ViewColumn.Three)', () => vscode.commands.executeCommand('vscode.open', u, vscode.ViewColumn.Three));
  await act('vscode.open(u2: тот же path, другой query)', () => vscode.commands.executeCommand('vscode.open', u2, vscode.ViewColumn.Three));
  await act('закрыть активный редактор (u2)', () => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
  await act('закрыть активный редактор (u, группа 3)', () => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
  await act('закрыть активный редактор (u, ещё одна копия)', () => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
  await act('закрыть всё', () => vscode.commands.executeCommand('workbench.action.closeAllEditors'));
  await act('пауза 3 с', () => sleep(3000));
  return log;
}

exports.run = async function () {
  const reg = vscode.workspace.registerFileSystemProvider('zip', provider, { isReadonly: true, isCaseSensitive: true });
  const out = { vscode: vscode.version, platform: process.platform, cases: [], pairs: [] };

  for (const [label, c] of CASES) {
    const r = { label, case: c, steps: {} };
    let u;
    try { u = mk(c); } catch (e) { r.constructError = String(e.message || e); out.cases.push(r); continue; }
    r.sent = desc(u);
    r.steps.fs = await step(async () => {
      const st = await vscode.workspace.fs.stat(u);
      if (st.type === vscode.FileType.File) await vscode.workspace.fs.readFile(u);
      return { type: st.type };
    });
    const variant = pfx => c.raw ? u : mk({ ...c, p: pfx + c.p });
    const ud = variant('/doc'), uo = variant('/open');
    r.sentDoc = desc(ud); r.sentOpen = desc(uo);
    r.steps.doc = await step(async () => desc((await vscode.workspace.openTextDocument(ud)).uri));
    r.steps.open = await step(async () => {
      await vscode.commands.executeCommand('vscode.open', uo);
      await sleep(400);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab && tab.input;
      return { label: tab && tab.label, tab: input && input.uri ? desc(input.uri) : (input ? input.constructor.name : null),
               editor: desc(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri) };
    });
    await closeAll();
    out.cases.push(r);
  }

  let n = 0;
  for (const [label, ca, cb] of PAIRS) {
    n++;
    const ua = mk({ ...ca, p: `/pair${n}${ca.p}` }), ub = mk({ ...cb, p: `/pair${n}${cb.p}` });
    const r = { label, a: desc(ua), b: desc(ub) };
    r.doc = await step(async () => {
      const A = await vscode.workspace.openTextDocument(ua), B = await vscode.workspace.openTextDocument(ub);
      return { same: A === B, a: desc(A.uri), b: desc(B.uri) };
    });
    const ua2 = mk({ ...ca, p: `/pairo${n}${ca.p}` }), ub2 = mk({ ...cb, p: `/pairo${n}${cb.p}` });
    r.open = await step(async () => {
      await vscode.commands.executeCommand('vscode.open', ua2); await sleep(300);
      await vscode.commands.executeCommand('vscode.open', ub2); await sleep(300);
      return { tabs: allTabs().map(t => t.input && t.input.uri ? desc(t.input.uri) : String(t.label)) };
    });
    await closeAll();
    out.pairs.push(r);
  }
  out.watchLifecycle = await watchLifecycle();
  reg.dispose();

  fs.writeFileSync(path.join(__dirname, 'out.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, 'out.txt'), report(out));
};

function report(out) {
  const L = [`VS Code ${out.vscode}, ${out.platform}. Провайдер zip: isCaseSensitive true.`, ''];
  const fmtCalls = (calls, sent) => calls.length
    ? calls.map(c => `      ${c.op.padEnd(13)} ${diff(sent, c.uri)}`).join('\n')
    : '      (провайдер не вызывался)';
  for (const r of out.cases) {
    L.push(`## ${r.label}`);
    if (r.constructError) { L.push(`  Uri.from: ошибка: ${r.constructError}`, ''); continue; }
    L.push(`  отправлен: authority=${JSON.stringify(show(r.sent.authority))} path=${JSON.stringify(show(r.sent.path))} fragment=${JSON.stringify(show(r.sent.fragment))}`);
    for (const [k, sent] of [['fs', r.sent], ['doc', r.sentDoc], ['open', r.sentOpen]]) {
      const s = r.steps[k];
      L.push(`  ${k}:${s.error ? ' ОШИБКА: ' + s.error : ''}`);
      L.push(fmtCalls(s.calls, sent));
      if (k === 'doc' && s.result) L.push(`      document.uri  ${diff(sent, s.result)}`);
      if (k === 'open' && s.result) {
        L.push(`      tab.input.uri ${typeof s.result.tab === 'object' && s.result.tab ? diff(sent, s.result.tab) : String(s.result.tab)}  (label ${JSON.stringify(s.result.label && show(s.result.label))})`);
      }
    }
    L.push('');
  }
  L.push('# Пары: считает ли VS Code два разных URI одним ресурсом', '');
  for (const r of out.pairs) {
    L.push(`## ${r.label}`);
    L.push(`  doc:  ${r.doc.error ? 'ОШИБКА: ' + r.doc.error : (r.doc.result.same ? 'ОДИН TextDocument' : 'разные TextDocument')}`);
    L.push(`  open: ${r.open.error ? 'ОШИБКА: ' + r.open.error : `вкладок: ${r.open.result.tabs.length}`}`);
    L.push('');
  }
  L.push('# watch / unwatch: один URI в нескольких группах', '');
  for (const s of out.watchLifecycle) {
    L.push(`## ${s.label}${s.error ? '  ОШИБКА: ' + s.error : ''}  (вкладок ${s.tabs}, групп ${s.groups})`);
    for (const c of s.calls || []) L.push(`  ${c.op.padEnd(8)} #${c.id} ${c.str}${c.options ? '  ' + JSON.stringify(c.options) : ''}`);
    if (!s.calls || !s.calls.length) L.push('  (нет вызовов watch/unwatch)');
  }
  return L.join('\n');
}
