// Downloads VS Code (stable) into .vscode-test/ and runs probe.js inside it.
// Linux without a desktop session: xvfb-run -a node run.js
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const dir = __dirname;
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      cachePath: path.join(dir, '.vscode-test'),
      extensionDevelopmentPath: dir,
      extensionTestsPath: path.join(dir, 'probe.js'),
      launchArgs: [
        '--disable-extensions',
        '--user-data-dir', path.join(dir, '.vscode-test', 'user-data'),
      ],
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
