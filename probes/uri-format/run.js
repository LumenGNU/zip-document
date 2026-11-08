// Runs a probe inside VS Code 1.145.2: vscode-probe.js, or PROBE=ui-probe.js (that one also gets
// --remote-debugging-port to read the rendered workbench). The VS Code download is shared with
// ../uri-roundtrip/.vscode-test. Linux without a desktop session: xvfb-run -a node run.js
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const dir = __dirname;
  const probe = process.env.PROBE || 'vscode-probe.js';
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || '1.145.2',
      cachePath: path.join(dir, '..', 'uri-roundtrip', '.vscode-test'),
      extensionDevelopmentPath: dir,
      extensionTestsPath: path.join(dir, probe),
      launchArgs: ['--disable-extensions', '--user-data-dir', path.join(dir, '.vscode-test', 'user-data'),
        ...(probe === 'ui-probe.js' ? [`--remote-debugging-port=${process.env.CDP_PORT || 9339}`] : [])],
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
