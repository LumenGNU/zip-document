// Builds PROMPT.md: the task for an independent implementation plus the normative part of
// docs/URI.txt (sections 1-3). Sections 4-8 are left out on purpose: the spec claims that the
// contract alone is enough for two implementations to agree, and this is how it is tested.
// Run: node make-prompt.js
//      node make-prompt.js --no-examples  -> PROMPT-no-examples.md: the same without the examples
//      of section 3 (3.7, the list of non-canonical forms in 3.4, the examples in steps 1 and 8),
//      to see where the text rests on rules and where on examples.
const fs = require('fs');
const path = require('path');

const noExamples = process.argv.includes('--no-examples');

const spec = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'URI.txt'), 'utf8');
const end = spec.indexOf('\n4. Гарантии');
if (end < 0) throw new Error('section 4 not found in docs/URI.txt');
let part = spec.slice(0, end).trimEnd() + '\n';
// The pointer to our own implementation must not reach the implementer.
const ref = /\nРеализация для сверки[\s\S]*?\n\n/;
if (!ref.test(part)) throw new Error('reference-implementation paragraph not found');
part = part.replace(ref, '\n');

if (noExamples) {
  // Each cut must match exactly once: a silent miss would leave an example in the prompt.
  const cut = (what, re, by) => {
    const n = (part.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
    if (n !== 1) throw new Error(`${what}: ${n} matches, expected 1`);
    part = part.replace(re, by);
  };
  cut('3.7', /\n3\.7 Примеры\n[\s\S]*$/, '\n');
  cut('3.4 list', /\nИз определения следует, что не каноничны, например:\n[\s\S]*?\n\n/, '\n');
  cut('step 1 example', /по\n   одному байту: E2 82 41 → "⟦E2⟧⟦82⟧A"\./, 'по\n   одному байту.');
  cut('step 8 examples', /на свою форму "⟦U\+XXXX⟧": "C:\/x"[\s\S]*?\(префикс, а не сегмент "C:"\)\./,
    'на свою форму "⟦U+XXXX⟧".');
  part = part.trimEnd() + '\n';
}

const task = fs.readFileSync(path.join(__dirname, 'task.md'), 'utf8');
const out = noExamples ? 'PROMPT-no-examples.md' : 'PROMPT.md';
fs.writeFileSync(path.join(__dirname, out), task.trimEnd() + '\n\n```text\n' + part + '```\n');
console.log(out + ': ' + part.split('\n').length + ' lines of the spec');
