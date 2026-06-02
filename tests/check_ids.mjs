// Verify that every '#id' selector in popup.js / options.js refers to an id
// that actually exists in the corresponding HTML file.
import fs from 'fs';

const pairs = [
  ['popup/popup.html', 'popup/popup.js'],
  ['options/options.html', 'options/options.js']
];

let bad = 0;
for (const [htmlPath, jsPath] of pairs) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js   = fs.readFileSync(jsPath, 'utf8');
  const htmlIds = new Set(
    [...html.matchAll(/\bid=["']([\w-]+)["']/g)].map(m => m[1])
  );
  const jsRefs = new Set(
    [...js.matchAll(/["']#([\w-]+)["']/g)].map(m => m[1])
  );
  const missing = [...jsRefs].filter(id => !htmlIds.has(id));
  console.log(`${jsPath}: ${jsRefs.size} #id refs, missing in HTML: ${missing.length ? missing.join(', ') : '(none)'}`);
  bad += missing.length;
}
process.exit(bad ? 1 : 0);
