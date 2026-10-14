// Builds a solo (you vs the AI) version of the game as ONE html file that runs with no
// server: open it in a browser, or host it anywhere. three.js loads from jsDelivr.
//
//   npm run build:web
//   -> dist/street-rules-solo.html   full page, open it directly
//   -> dist/artifact.html            same page without <html>/<head>/<body>, for hosts that add them
//
// The standalone page uses its own name so it can't be mistaken for the official Roblox game.

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);
const NAME = 'Street Rules';
const threeVersion = JSON.parse(await fs.readFile(at('node_modules/three/package.json'), 'utf8')).version;
const CDN = `https://cdn.jsdelivr.net/npm/three@${threeVersion}`;

const result = await build({
  entryPoints: [at('web/main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: 'es2020',
  external: ['three', 'three/addons/*'],
  plugins: [{
    name: 'node-crypto-shim',
    setup(b) {
      b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: at('web/crypto-shim.js') }));
    },
  }],
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await fs.readFile(at('public/style.css'), 'utf8');
let html = await fs.readFile(at('public/index.html'), 'utf8');

const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`build-web: expected to find ${from}`);
  html = html.split(from).join(to);
};
swap('<title>Illegal Soccer 3v3</title>', `<title>${NAME} 3v3</title>`);
swap('aria-label="Illegal Soccer home"', `aria-label="${NAME} home"`);
swap('ILLEGAL<span>SOCCER</span>', 'STREET<span>RULES</span>');
swap('<p class="tagline">3v3 street soccer. No referee. No rules. Slide tackles strongly encouraged.</p>',
  '<p class="tagline">3v3 street soccer. No referee. No rules. Slide tackles strongly encouraged.</p>\n'
  + '        <p class="muted small">An unofficial fan game inspired by Illegal Soccer on Roblox.</p>');
swap('./vendor/three/build/three.module.min.js', `${CDN}/build/three.module.min.js`);
swap('./vendor/three/examples/jsm/', `${CDN}/examples/jsm/`);
swap('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
swap('<script type="module" src="app.js"></script>', `<script type="module">\n${js}\n</script>`);
const flags = `<script>window.GAME_BRAND = ${JSON.stringify(NAME)}; document.body.classList.add('offline');</script>`;
swap('<body>', `<body>\n  ${flags}`);

await fs.mkdir(at('dist'), { recursive: true });
await fs.writeFile(at('dist/street-rules-solo.html'), html);

// Fragment version: title first, then styles, the import map, and the body's contents.
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
const importMap = html.match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
await fs.writeFile(at('dist/artifact.html'), `${title}\n${style}\n${importMap}\n${body}`);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`Built dist/street-rules-solo.html (${kb(html)}) and dist/artifact.html, three.js ${threeVersion} from jsDelivr`);
