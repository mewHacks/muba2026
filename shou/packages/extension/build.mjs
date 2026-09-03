// Bundles the extension into dist/, which is the folder you point
// chrome://extensions at.
//
// Four separate bundles rather than one: a content script, a service
// worker and two pages are four different execution contexts, and
// Chrome loads each by filename from the manifest. Shared modules
// (shared.ts, redact.ts) are duplicated into each bundle — a few KB, and
// the alternative is a shared chunk that a service worker cannot import
// the same way a page can.

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'dist');
const watch = process.argv.includes('--watch');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const options = {
  entryPoints: [
    join(HERE, 'src/content.ts'),
    join(HERE, 'src/background.ts'),
    join(HERE, 'src/popup.ts'),
    join(HERE, 'src/options.ts'),
  ],
  bundle: true,
  // A service worker and a content script are both ES-module capable in
  // MV3 ("type": "module" in the manifest), so no IIFE wrapper needed.
  format: 'esm',
  target: 'chrome114',
  outdir: OUT,
  logLevel: 'info',
};

async function copyStatic() {
  await cp(join(HERE, 'manifest.json'), join(OUT, 'manifest.json'));
  for (const page of ['popup.html', 'options.html']) {
    await cp(join(HERE, 'src', page), join(OUT, page));
  }
  await cp(join(HERE, 'icons'), join(OUT, 'icons'), { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log(`watching — load unpacked from ${OUT}`);
} else {
  await build(options);
  await copyStatic();
  console.log(`built ${(await readdir(OUT)).join(', ')}`);
  console.log(`\nLoad it: chrome://extensions -> Developer mode -> Load unpacked -> ${OUT}`);
}
