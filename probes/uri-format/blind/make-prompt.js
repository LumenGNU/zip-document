// Builds PROMPT.md: the task for an independent implementation plus the normative part of
// docs/URI.txt (sections 1-3). Sections 4-8 are left out on purpose: the spec claims that the
// contract alone is enough for two implementations to agree, and this is how it is tested.
// Run: node make-prompt.js
const fs = require('fs');
const path = require('path');

const spec = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'URI.txt'), 'utf8');
const end = spec.indexOf('\n# 4. ');
if (end < 0) throw new Error('section 4 not found in docs/URI.txt');
let part = spec.slice(0, end).trimEnd() + '\n';
// The pointer to our own implementation must not reach the implementer.
const ref = /\nРеализация для сверки[\s\S]*?\n\n/;
if (!ref.test(part)) throw new Error('reference-implementation paragraph not found');
part = part.replace(ref, '\n');

const task = fs.readFileSync(path.join(__dirname, 'task.md'), 'utf8');
fs.writeFileSync(path.join(__dirname, 'PROMPT.md'), task.trimEnd() + '\n\n```text\n' + part + '```\n');
console.log('PROMPT.md: ' + part.split('\n').length + ' lines of the spec');
