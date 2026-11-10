// Does VS Code deliver object URIs of docs/URI.txt (entries and the root) to the provider exactly
// as built?
//
// A provider for scheme `zip-document` accepts only canonical URIs (uri.js `parse`) and records
// every call. Each case URI is built with vscode.Uri and sent through workspace.fs,
// openTextDocument and vscode.open — both as the Uri object and as Uri.parse(toString()),
// the string form that history, links and other extensions pass around. Every URI the provider
// receives must parse, and be the one that was sent. Also: is a scheme taken twice an error?
//
// Results: out.txt. Runs inside VS Code via run.js (Linux without a desktop: xvfb-run -a node run.js).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const F = require('./uri');

const enc = s => new TextEncoder().encode(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms} ms`); })]);
const show = s => Array.from(s).map(ch => { const c = ch.codePointAt(0); return c > 0x20 && c < 0x7f ? ch : `\\u{${c.toString(16)}}`; }).join('');

let calls = [];
const accept = (op, uri) => {
  const r = F.parse(vscode.Uri, uri);
  calls.push({ op, uri: uri.toString(), ok: !!r });
  if (!r) throw vscode.FileSystemError.FileNotFound(uri);
  return r;
};
const provider = {
  onDidChangeFile: new vscode.EventEmitter().event,
  watch(uri) { calls.push({ op: 'watch', uri: uri.toString(), ok: !!F.parse(vscode.Uri, uri) }); return new vscode.Disposable(() => {}); },
  stat(uri) { accept('stat', uri); return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 2 }; },
  readFile(uri) { accept('readFile', uri); return enc('ok'); },
  readDirectory() { throw vscode.FileSystemError.FileNotFound(); },
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  writeFile() { throw vscode.FileSystemError.NoPermissions(); },
  delete() { throw vscode.FileSystemError.NoPermissions(); },
  rename() { throw vscode.FileSystemError.NoPermissions(); },
};

const ARCHIVE = vscode.Uri.file('/tmp/probe/release.zip');
const CASES = [
  ['обычное', enc('src/main.ts')],
  ['дубликат, index 1', enc('src/main.ts'), 1],
  ['пустое имя', enc('')],
  ['.', enc('.')],
  ['a/..', enc('a/..')],
  ['./a//b', enc('./a//b.txt')],
  ['../../x', enc('../../x.txt')],
  ['ведущий /', enc('/etc/passwd')],
  ['буква диска C:', enc('C:/x.txt')],
  ['каталог a/b/', enc('a/b/')],
  ['%41 ? # & = +', enc('d/%41?#&=+.txt')],
  ['NUL, перевод строки', enc('a\u0000b\nc.txt')],
  ['кириллица', enc('папка/файл.txt')],
  ['NFD', enc('e\u0301.txt')],
  ['CP437 (не UTF-8)', new Uint8Array([0x84, 0x2e, 0x74, 0x78, 0x74])],
  ['произвольные байты', new Uint8Array([0xff, 0xfe, 0x2f, 0x00, 0x80])],
  ['архив с & = # в имени', enc('a.txt'), 0, vscode.Uri.file('/tmp/probe/a&b=c#d.zip')],
  ['вложенный архив', enc('META-INF/MANIFEST.MF'), 0, 'nested'],
  // name null: the root (the central directory) of the archive
  ['корень', null],
  ['корень архива с & = # в имени', null, 0, vscode.Uri.file('/tmp/probe/a&b=c#d.zip')],
  ['корень вложенного архива', null, 0, 'nested'],
];

const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);

exports.run = async function () {
  const L = [`VS Code ${vscode.version}, ${process.platform}. Схема ${F.SCHEME}, isCaseSensitive true.`, ''];

  // Scheme taken twice.
  const first = vscode.workspace.registerFileSystemProvider('probe-taken', provider, { isReadonly: true });
  try { vscode.workspace.registerFileSystemProvider('probe-taken', provider, { isReadonly: true }); L.push('повторная регистрация схемы: без ошибки'); }
  catch (e) { L.push(`повторная регистрация схемы: исключение «${e.message}»`); }
  first.dispose();
  L.push('');

  const reg = vscode.workspace.registerFileSystemProvider(F.SCHEME, provider, { isReadonly: true, isCaseSensitive: true });
  let bad = 0;
  for (const [label, bytes, index = 0, arch = ARCHIVE] of CASES) {
    const archive = arch === 'nested' ? F.build(vscode.Uri, ARCHIVE, enc('lib/x.jar'), 1) : arch;
    const u = bytes === null ? F.buildRoot(vscode.Uri, archive) : F.build(vscode.Uri, archive, bytes, index);
    const sent = u.toString();
    L.push(`## ${label}`, `  ${sent}`, `  path ${JSON.stringify(show(u.path))}`);
    for (const [form, uri] of [['Uri', u], ['строка', vscode.Uri.parse(sent)]]) {
      const res = {};
      calls = [];
      try { await timeout(vscode.workspace.fs.readFile(uri), 8000); res.fs = 'ok'; } catch (e) { res.fs = 'ОШИБКА ' + e.message; }
      try {
        const doc = await timeout(Promise.resolve(vscode.workspace.openTextDocument(uri)), 8000);
        res.doc = doc.uri.toString() === sent ? 'ok' : 'ДРУГОЙ URI ' + doc.uri.toString();
      } catch (e) { res.doc = 'ОШИБКА ' + e.message; }
      try {
        await timeout(Promise.resolve(vscode.commands.executeCommand('vscode.open', uri)), 8000);
        await sleep(300);
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const tu = tab && tab.input && tab.input.uri;
        res.open = tu && tu.toString() === sent ? `ok, вкладка ${JSON.stringify(show(tab.label))}` : `ДРУГОЙ URI ${tu}`;
        res.tabs = allTabs().length;
      } catch (e) { res.open = 'ОШИБКА ' + e.message; }
      await sleep(150);
      const wrong = calls.filter(c => !c.ok || c.uri !== sent);
      const fine = res.fs === 'ok' && res.doc === 'ok' && String(res.open).startsWith('ok') && !wrong.length;
      if (!fine) bad++;
      L.push(`  ${form.padEnd(6)} fs: ${res.fs}; doc: ${res.doc}; open: ${res.open}; вызовов провайдера ${calls.length}, ` +
        (wrong.length ? `НЕ ТОТ URI: ${wrong.map(c => `${c.op} ${c.uri}`).join(' | ')}` : 'все с отправленным URI'));
    }
    // Both forms are one resource: one tab for the pair.
    L.push(`  вкладок после обеих форм: ${allTabs().length}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    L.push('');
  }
  reg.dispose();
  L.push(bad ? `ИТОГ: расхождений ${bad}` : 'ИТОГ: все URI дошли до провайдера без изменений и приняты');
  fs.writeFileSync(path.join(__dirname, 'out.txt'), L.join('\n') + '\n');
};
