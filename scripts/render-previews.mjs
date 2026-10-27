/**
 * Renders the map-select thumbnails from the real GLB files and writes them to
 * public/maps/previews/<map id>.webp.
 *
 * Usage: npm run previews        (expects `npm run dev` to be running)
 *        BASE_URL=http://127.0.0.1:5173 npm run previews
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, waitForApp } from './lib/browser.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT_DIR = path.resolve('public/maps/previews');

const { browser, close } = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await waitForApp(page);
mkdirSync(OUT_DIR, { recursive: true });

const maps = await page.evaluate(() => window.__IIYAMA__.maps.map((m) => ({ id: m.id, fileName: m.fileName, file: m.file, preview: m.preview })));
for (const map of maps) {
  const result = await page.evaluate(async (mapId) => {
    const g = window.__IIYAMA__;
    const m = g.maps.find((x) => x.id === mapId);
    m.previewUrl = null;
    const url = await g.previews.generate(m, { refresh: true });
    const blob = await (await fetch(url)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { b64: btoa(bin), type: blob.type, size: blob.size };
  }, map.id);

  const outName = `${map.id}.webp`;
  writeFileSync(path.join(OUT_DIR, outName), Buffer.from(result.b64, 'base64'));
  console.log(`[preview] ${map.fileName} -> public/maps/previews/${outName} (${(result.size / 1024).toFixed(0)} KB, ${result.type})`);
}

await close();
