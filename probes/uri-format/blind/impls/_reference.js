// ../../uri.js behind the interface of PROMPT.md: the harness compared with itself must show
// no differences. Not for the implementers.
const { URI } = require('vscode-uri');
const F = require('../../uri.js');

module.exports = {
  build: (archive, name, index) => F.build(URI, archive, name, index),
  parse(uri) {
    const r = F.parse(URI, uri);
    return r && { archive: r.archive, name: r.bytes, index: r.index };
  },
};
