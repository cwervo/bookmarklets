#!/usr/bin/env node
// Builds docs/met-library/ from source.js. No dependencies required; if the
// `terser` package is resolvable (e.g. `npm i -g terser` + NODE_PATH) the
// self-contained bookmarklet is minified, otherwise it ships un-minified.
//
//   node met-library/build.js
'use strict';
const fs = require('fs');
const path = require('path');

const here = __dirname;
const outDir = path.join(here, '..', 'docs', 'met-library');
const PAGES_BASE = 'https://cwervo.github.io/bookmarklets/met-library/';

const source = fs.readFileSync(path.join(here, 'source.js'), 'utf8');
const template = fs.readFileSync(path.join(here, 'docs.template.html'), 'utf8');

// Strip the ==Bookmarklet== metadata block; keep the explanatory comment.
const body = source.replace(/^\/\/ ==Bookmarklet==[\s\S]*?\/\/ ==\/Bookmarklet==\r?\n/, '');

const loader = `(function(){if(location.hostname!=='library.metmuseum.org'){location.href='https://library.metmuseum.org/';return}var s=document.createElement('script');s.src='${PAGES_BASE}app.js?'+Date.now();document.documentElement.appendChild(s)})()`;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function minify(code) {
  try {
    const terser = require('terser');
    const result = await terser.minify(code, { compress: { passes: 2, negate_iife: false }, mangle: true, format: { comments: false } });
    if (result.code) return { code: result.code, minified: true };
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  return { code, minified: false };
}

(async () => {
  const { code: compact, minified } = await minify(body);
  const full = 'javascript:' + encodeURIComponent(compact);
  const loaderUrl = 'javascript:' + encodeURIComponent(loader);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'app.js'), body);
  fs.writeFileSync(path.join(outDir, 'shortcut.js'), body);
  fs.writeFileSync(path.join(outDir, 'bookmarklet.txt'), full + '\n');
  fs.writeFileSync(path.join(outDir, 'loader.txt'), loaderUrl + '\n');

  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  const html = template
    .replace(/__BOOKMARKLET_FULL__/g, escapeHtml(full))
    .replace(/__BOOKMARKLET_LOADER__/g, escapeHtml(loaderUrl))
    .replace(/__SHORTCUT_SCRIPT__/g, escapeHtml(body))
    .replace(/__APP_URL__/g, PAGES_BASE + 'app.js')
    .replace(/__FULL_SIZE__/g, kb(full.length) + (minified ? '' : ', unminified'))
    .replace(/__BUILT__/g, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  console.log(`built ${outDir}`);
  console.log(`  app.js / shortcut.js: ${kb(body.length)}`);
  console.log(`  bookmarklet: ${kb(full.length)} (${minified ? 'minified with terser' : 'terser not found, unminified'})`);
  console.log(`  loader: ${loaderUrl.length} chars`);
})().catch((e) => { console.error(e); process.exit(1); });
