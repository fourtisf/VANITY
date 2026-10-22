// Builds dist/vanity.html: the whole site in one file (no server needed, Your GPU and Your CPU only).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteConfig, renderPage } from '../site.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFile(path.join(root, p), 'utf8');
let html = await read('public/index.html');
for (const src of ['engine/pattern.js', 'engine/gpu-engine.js']) {
  const tag = `<script src="${src}"></script>`;
  if (!html.includes(tag)) throw new Error('missing ' + tag);
  const code = await read(src);
  html = html.replace(tag, () => `<script>\n${code}\n</script>`);
}
// Fonts become data URIs, site details take their defaults, and the legal links go (that page needs the server).
for (const f of ['fredoka', 'nunito', 'jetbrains-mono']) {
  const font = await readFile(path.join(root, 'public', 'fonts', f + '.woff2'));
  html = html.replace(`url(fonts/${f}.woff2)`, () => `url(data:font/woff2;base64,${font.toString('base64')})`);
}
html = renderPage(html, siteConfig({}))
  .replace(/\s*<div><h4>Legal<\/h4>.*?<\/div>/, '')
  .replace(/\s*<p class="small legal">.*?<\/p>/, '');
const wgsl = await read('engine/vanity.wgsl');
html = html.replace('<script type="text/plain" id="workerSrc">', () => `<script type="text/plain" id="wgsl">\n${wgsl}\n</script>\n<script type="text/plain" id="workerSrc">`);
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', 'vanity.html'), html);
console.log('wrote dist/vanity.html', (html.length / 1024).toFixed(0) + ' KB');
