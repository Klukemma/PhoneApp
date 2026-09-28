// Stage the Albion app as the web root a native build wraps.
//
// Capacitor copies whatever `webDir` points at into the APK wholesale, and the
// source folder carries things that have no business shipping to a phone: the
// tests, and tools/ with its 90 MB of cached game dumps. So the native build
// gets a staged copy, exactly as the Pages deploy already stages one.
//
// The same script runs locally and in CI, so what you test is what ships.

import { cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../albion/', import.meta.url);
const OUT = new URL('../_app/', import.meta.url);
const SKIP = new Set(['tests', 'tools', 'README.md']);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const name of await readdir(SRC)) {
  if (SKIP.has(name)) continue;
  await cp(new URL(name, SRC), new URL(name, OUT), { recursive: true });
}

/* The one thing a native build must not carry: a service worker. Inside the
 * APK every asset is already on the device, so a cache-first worker adds a
 * second stale copy of the app and a second thing to invalidate - and the
 * whole point of shipping an APK is that the shell is the APK. The web build
 * is untouched; only this staged copy loses it. */
const shell = new URL('index.html', OUT);
const { readFile, writeFile } = await import('node:fs/promises');
let html = await readFile(shell, 'utf8');
html = html.replace(
  /<script>\s*window\.addEventListener\('beforeinstallprompt'[\s\S]*?<\/script>\s*/,
  '',
);
await writeFile(shell, html);
await rm(new URL('sw.js', OUT), { force: true });

let bytes = 0;
const walk = async (dir) => {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p); else bytes += s.size;
  }
};
await walk(fileURLToPath(OUT));
console.log(`staged _app/ (${(bytes / 1048576).toFixed(1)} MB)`);
