import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const path = p => new URL(`../public${p}`, import.meta.url);
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const pngSize = p => { const b = readFileSync(path(p)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('favicon.ico bundles the 16, 32 and 48 px images as PNGs', () => {
  assert.ok(existsSync(path('/favicon.ico')), 'favicon.ico exists');
  const ico = readFileSync(path('/favicon.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], 'ICO header: reserved 0, type 1');
  const count = ico.readUInt16LE(4);
  assert.equal(count, 3);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a', `image ${i} is a PNG`);
    assert.ok(offset + size <= ico.length, `image ${i} lies inside the file`);
    sizes.push(ico.readUInt8(entry) || 256);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
});

test('the sized favicon PNGs the user supplied have the sizes their names claim', () => {
  for (const size of [16, 32, 48]) assert.deepEqual(pngSize(`/favicon-${size}x${size}.png`), [size, size]);
});

test('every page head points at the new favicon files, not the old inline "R" SVG', () => {
  const layout = read('../src/layouts/Layout.astro');
  assert.match(layout, /<link rel="icon" href="\/favicon\.ico" sizes="any" \/>/);
  for (const size of [16, 32, 48]) {
    assert.match(layout, new RegExp(`<link rel="icon" type="image/png" sizes="${size}x${size}" href="/favicon-${size}x${size}\\.png" />`));
  }
  assert.doesNotMatch(layout, /data:image\/svg\+xml/);
  assert.match(layout, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
});

test('manifest and service worker only reference icon files that exist', () => {
  const manifest = JSON.parse(read('../public/manifest.json'));
  for (const icon of manifest.icons) assert.ok(existsSync(path(icon.src)), icon.src);
  const worker = read('../public/sw.js');
  const used = [...worker.matchAll(/'(\/icons\/[^']+)'/g)].map(m => m[1]);
  assert.ok(used.length >= 2, 'notification icon and badge are set');
  for (const src of used) assert.ok(existsSync(path(src)), src);
});

test('the notification badge is a transparent white silhouette, not the opaque logo tile', () => {
  const worker = read('../public/sw.js');
  assert.match(worker, /badge: '\/icons\/badge-96\.png'/);
  assert.match(worker, /icon: '\/icons\/icon-192\.png'/);
  const png = readFileSync(path('/icons/badge-96.png'));
  assert.deepEqual(pngSize('/icons/badge-96.png'), [96, 96]);
  assert.equal(png[25], 6, 'colour type 6 = RGBA, so it can carry transparency');
});

test('the in-app logo tiles use the real logo image instead of the red "R" square', () => {
  for (const file of ['../src/pages/index.astro', '../src/pages/login.astro']) {
    const html = read(file);
    assert.doesNotMatch(html, /bg-ric-red[^"]*"[^>]*>R<\/div>/, `${file} still has the red R tile`);
    assert.match(html, /<img src="\/icons\/icon-192\.png" alt="RIC"/, file);
  }
});
