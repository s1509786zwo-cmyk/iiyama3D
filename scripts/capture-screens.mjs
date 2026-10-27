/**
 * Captures the UI screens (title, difficulty, map select, gameplay) into
 * verification/ for review. Expects `npm run dev` to be running.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, waitForApp } from './lib/browser.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT = process.env.OUT_DIR || path.resolve('verification');
mkdirSync(OUT, { recursive: true });

const { browser, close } = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(240000);
await page.goto(BASE, { waitUntil: 'load', timeout: 180000 });
await waitForApp(page);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'screen-title.png') });

// title -> map select -> difficulty (the order the player sees)
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('to-mapselect'));
await page.waitForFunction(() => [...document.querySelectorAll('#map-grid img')].every((i) => i.complete && i.naturalWidth > 50), { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'screen-mapselect.png') });

await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('to-difficulty'));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'screen-difficulty.png') });

for (const id of ['city_street', 'warehouse', 'subway', 'classroom']) {
  await page.evaluate(async (mapId) => { await window.__IIYAMA__.startRun(mapId, 'normal'); }, id);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `game-${id}.png`) });
  await page.evaluate(() => { window.__IIYAMA__.app.pause(); });
  await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('to-title'));
  await page.waitForTimeout(200);
}
await close();
console.log(`screens captured in ${OUT}`);
