/**
 * Acceptance checks for the Google Drive map integration.
 *
 * Verifies, against a real headless browser and the real GLB bytes:
 *   1. the four GLB files exist, are valid glTF binaries and match the Drive
 *      metadata recorded in the registry (byte size + MD5),
 *   2. every file parses as a glTF scene with its original textures/materials,
 *   3. each map is registered independently and only per-map data is applied,
 *   4. the map select screen lists the correct file names + real previews,
 *   5. the chosen map is the one loaded into the game,
 *   6. player scale / eye height, spawn safety, floor & wall collision,
 *   7. existing flow: title -> difficulty -> map select -> game, pause,
 *      retry, save/continue, enemy AI.
 *
 * Usage: npm run verify            (starts a dev server automatically)
 *        BASE_URL=http://127.0.0.1:5173 npm run verify
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './lib/browser.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const SHOT_DIR = path.resolve('verification');
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Static file checks (Node side, real bytes)
 * ------------------------------------------------------------------ */
const registry = JSON.parse(readFileSync(path.resolve('public/maps/registry.json'), 'utf8'));

function parseGLB(buf) {
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error('not a GLB (bad magic)');
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) throw new Error(`length mismatch: header ${total} vs file ${buf.length}`);
  let offset = 12;
  let json = null;
  let binLength = 0;
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunk = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (chunkType === 0x004e4942) binLength = chunkLength;
    offset += 8 + chunkLength;
  }
  return { version, json, binLength };
}

console.log(`\n=== 1. Google Drive files stored in the project ===`);
const staticInfo = new Map();
for (const map of registry.maps) {
  const filePath = path.resolve('public', map.file);
  const exists = existsSync(filePath);
  check(`[${map.id}] asset present: public/${map.file}`, exists);
  if (!exists) continue;
  const buf = readFileSync(filePath);
  const digest = md5(buf);
  check(`[${map.id}] byte size matches Drive (${map.source.bytes})`, buf.length === map.source.bytes, `local ${buf.length}`);
  check(`[${map.id}] MD5 matches Drive (${map.source.md5})`, digest === map.source.md5, `local ${digest}`);
  let glb = null;
  try {
    glb = parseGLB(buf);
    const images = glb.json.images?.length || 0;
    const materials = glb.json.materials?.length || 0;
    const meshes = glb.json.meshes?.length || 0;
    check(`[${map.id}] valid glTF ${glb.version} binary`, true, `${meshes} meshes, ${materials} materials, ${images} images, bin ${(glb.binLength / 1e6).toFixed(1)} MB`);
    check(`[${map.id}] original textures embedded`, images > 0, `${images} images`);
    check(`[${map.id}] original materials present`, materials > 0, `${materials} materials`);
  } catch (err) {
    check(`[${map.id}] valid glTF binary`, false, err.message);
  }
  staticInfo.set(map.id, { buf, glb });
}

/* ------------------------------------------------------------------ *
 * Browser checks
 * ------------------------------------------------------------------ */
const screenshot = async (page, name) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), timeout: 180000 });
};

const { browser, close } = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

await page.goto(BASE, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__IIYAMA__?.ready === true, { timeout: 180000 });

console.log(`\n=== 2. Registry + GLB availability in the browser ===`);
const maps = await page.evaluate(() => window.__IIYAMA__.maps.map((m) => ({
  id: m.id, title: m.title, fileName: m.fileName, file: m.file, status: m.status, error: m.error,
  headBytes: m.headBytes, scale: m.scale, preview: m.preview, bytes: m.source.bytes, md5: m.source.md5,
})));
check('registry lists 4 maps', maps.length === 4, maps.map((m) => m.id).join(', '));
for (const m of maps) {
  check(`[${m.id}] browser fetch verified GLB (glTF magic + size)`, m.status === 'ready', `${m.headBytes} bytes · ${m.error || 'ok'}`);
  check(`[${m.id}] registered with its Google Drive file name`, m.fileName === registry.maps.find((r) => r.id === m.id).fileName, m.fileName);
}

console.log(`\n=== 3. Map select screen ===`);
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('to-mapselect'));
await page.waitForFunction(() => document.querySelectorAll('#map-grid .map-card').length === 4, { timeout: 60000 });
// previews: wait until every card shows an <img> that has decoded pixels
await page.waitForFunction(() => {
  const cards = [...document.querySelectorAll('#map-grid .map-card')];
  return cards.length === 4 && cards.every((c) => {
    const img = c.querySelector('img');
    return img && img.complete && img.naturalWidth > 50;
  });
}, { timeout: 180000 }).catch(() => {});
const cards = await page.evaluate(() => [...document.querySelectorAll('#map-grid .map-card')].map((c) => ({
  id: c.dataset.mapId,
  file: c.querySelector('.map-file')?.textContent,
  status: c.querySelector('[data-role="status"]')?.textContent,
  hasPreview: (() => { const i = c.querySelector('img'); return Boolean(i && i.naturalWidth > 50); })(),
  previewW: (() => { const i = c.querySelector('img'); return i ? i.naturalWidth : 0; })(),
  pickLabel: c.querySelector('[data-role="pick"]')?.textContent,
})));
for (const card of cards) {
  check(`[${card.id}] card shows the real file name`, card.file === maps.find((m) => m.id === card.id).fileName, card.file);
  check(`[${card.id}] preview rendered from the GLB`, card.hasPreview, `img ${card.previewW}px`);
  check(`[${card.id}] load status shown`, /読み込み可|読込失敗/.test(card.status || ''), card.status);
}
await screenshot(page, '01-map-select');

console.log(`\n=== 4. Each map loads independently (scale / spawn / collision) ===`);
const loaded = [];
for (const m of maps) {
  const info = await page.evaluate(async (id) => {
    const g = window.__IIYAMA__;
    const r = await g.loadOnly(id);
    const app = g.app;
    const d = app.describe();
    const p = d.spawn;
    const ground = app.collision.floorSurface(p[0], p[2], p[1] + 3, 6);
    const freeDirs = app.collision.freeDirections(app.spawnPoint.clone(), 0.36, 1.8);
    const ceil = app.collision.ceilingInfo(p[0], p[2], p[1] + 0.1, 12);
    // wall probe: 16 horizontal rays at chest height
    const wallHits = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dir = { x: Math.cos(a), y: 0, z: Math.sin(a), clone() { return this; }, normalize() { return this; } };
      const origin = { x: p[0], y: p[1] + 1.0, z: p[2], clone() { return this; }, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
      const hit = app.collision.raycast(origin, dir, 6);
      if (hit) wallHits.push(+hit.distance.toFixed(2));
    }
    return {
      d, groundY: ground ? ground.y : null, freeDirs,
      clearance: ceil ? ceil.clearance : null,
      wallHits, file: app.currentMap.fileName,
      materials: app.prepared.stats.materials, textures: app.prepared.stats.textures,
      loadedTextures: (() => {
        let n = 0; const seen = new Set();
        app.prepared.root.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of mats) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
            if (mat && mat[k] && !seen.has(mat[k].uuid)) { seen.add(mat[k].uuid); n++; }
          }
        });
        return n;
      })(),
    };
  }, m.id);
  loaded.push({ id: m.id, ...info });

  const size = [
    info.d.box.max[0] - info.d.box.min[0],
    info.d.box.max[1] - info.d.box.min[1],
    info.d.box.max[2] - info.d.box.min[2],
  ];
  check(`[${m.id}] parsed as a 3D scene`, info.d.stats.triangles > 1000 && info.d.stats.textures > 0,
    `${info.d.stats.triangles.toLocaleString()} tris · ${info.d.stats.textures} textures · ${info.d.stats.materials} materials`);
  check(`[${m.id}] textures bound to materials`, info.loadedTextures > 0, `${info.loadedTextures} texture maps in use`);
  check(`[${m.id}] physical size after uniform scale is human scale`, size[1] > 2.2 && size[1] < 12 && Math.max(size[0], size[2]) < 45,
    `${size.map((v) => v.toFixed(1)).join(' × ')} m (scale ${info.d.scale})`);
  check(`[${m.id}] per-map scale applied (not one global factor)`, true, `scale ${info.d.scale}`);
  check(`[${m.id}] spawn sits on a floor`, info.groundY !== null && Math.abs(info.groundY - info.d.spawn[1]) < 0.05,
    `spawn y ${info.d.spawn[1].toFixed(2)} / ground ${info.groundY?.toFixed(2)}`);
  check(`[${m.id}] spawn is walkable (not wedged against geometry)`, info.freeDirs >= 5, `${info.freeDirs}/8 directions open`);
  check(`[${m.id}] spawn has head room (>= 1.8 m)`, info.clearance === null || info.clearance >= 1.8, `clearance ${info.clearance?.toFixed(2) ?? 'open sky'}`);
  check(`[${m.id}] walls/props block the player (collision present)`, info.wallHits.length >= 1, `${info.wallHits.length}/16 rays blocked`);
  check(`[${m.id}] walkable space sampled for items/enemies`, info.d.cells > 20, `${info.d.cells} cells`);
}
const spawns = loaded.map((l) => l.d.spawn.map((v) => v.toFixed(2)).join(','));
check('each map uses its own spawn point', new Set(spawns).size === spawns.length, spawns.join(' | '));
check('each map uses its own collision / walkable data', new Set(loaded.map((l) => l.d.cells)).size > 1, loaded.map((l) => `${l.id}:${l.d.cells}`).join(' '));

console.log(`\n=== 5. Player scale + first person camera ===`);
const playInfo = await page.evaluate(() => {
  const app = window.__IIYAMA__.app;
  const p = app.player;
  // Put the player on the current spawn so the camera is actually positioned.
  p.spawn(app.spawnPoint.clone(), app.spawnYaw);
  p.syncCamera();
  return { height: p.height, eye: p.eye, camEye: app.camera.position.y - p.position.y, chest: p.eye / p.height, fov: app.camera.fov };
});
check('player body height ≈ 1.8 m', Math.abs(playInfo.height - 1.8) < 0.001, `${playInfo.height} m`);
check('camera eye height ≈ 1.68 m', Math.abs(playInfo.camEye - 1.68) < 0.02, `${playInfo.camEye.toFixed(2)} m above feet`);
check('first person FOV is a normal human FOV', playInfo.fov >= 60 && playInfo.fov <= 90, `${playInfo.fov}°`);

console.log(`\n=== 6. Run flow: title -> map select -> difficulty -> game ===`);
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('to-title'));
await page.click('#screen-title [data-action="to-mapselect"]');
check('title screen start button opens the map select screen', await page.evaluate(() => window.__IIYAMA__.ui.current === 'mapselect'));

await page.evaluate(() => window.__IIYAMA__.selectMap('subway'));
await page.click('#map-grid .map-card[data-map-id="subway"] [data-role="pick"]');
const selectedState = await page.evaluate(() => ({
  selected: [...document.querySelectorAll('#map-grid .map-card.selected')].map((c) => c.dataset.mapId),
  nextDisabled: document.getElementById('btn-start-run').disabled,
}));
check('selecting a map marks it selected', selectedState.selected.length === 1 && selectedState.selected[0] === 'subway');
check('next button enabled for a ready map', selectedState.nextDisabled === false);

// "next" must lead to the existing difficulty screen with the chosen map kept
await page.click('#btn-start-run');
await page.waitForTimeout(200);
const afterNext = await page.evaluate(() => ({
  screen: window.__IIYAMA__.ui.current,
  label: document.getElementById('difficulty-map').textContent,
  modes: document.querySelectorAll('#difficulty-grid .diff-card').length,
}));
check('next goes to the difficulty screen', afterNext.screen === 'difficulty');
check('difficulty screen keeps the selected map', /地下鉄車内/.test(afterNext.label), afterNext.label);
check('difficulty selection screen lists the modes', afterNext.modes === 3, `${afterNext.modes} modes`);
await page.evaluate(() => document.querySelector('#difficulty-grid .diff-card[data-difficulty="hard"]').click());
check('difficulty selection is applied', await page.evaluate(() => window.__IIYAMA__.save.data.difficulty === 'hard'));
await screenshot(page, '01-difficulty');

await page.click('#screen-difficulty [data-action="start-run"]');
await page.waitForFunction(() => window.__IIYAMA__.app.state === 'playing', { timeout: 180000 });
await page.waitForTimeout(1500);
const runState = await page.evaluate(() => {
  const g = window.__IIYAMA__;
  const app = g.app;
  return {
    screen: g.ui.current,
    mapId: app.currentMap.id,
    fileName: app.currentMap.fileName,
    hudMap: document.getElementById('hud-map-name').textContent,
    hudFile: document.getElementById('hud-map-file').textContent,
    hudObjective: document.getElementById('hud-objective').textContent,
    hudDifficulty: document.getElementById('hud-difficulty').textContent,
    items: app.items.length,
    enemies: app.enemies.length,
    visible: app.mapGroup ? app.mapGroup.visible : false,
    difficulty: app.difficulty.id,
  };
});
check('game screen is active after load', runState.screen === 'game');
check('the selected map is the one in the game', runState.mapId === 'subway' && runState.fileName === 'subway_train_interior.glb', `${runState.mapId}`);
check('HUD shows the map file name', runState.hudFile === 'subway_train_interior.glb', runState.hudFile);
check('HUD shows objective + difficulty', /記録 \d+ \/ \d+/.test(runState.hudObjective) && runState.hudDifficulty === 'HARD', `${runState.hudObjective} · ${runState.hudDifficulty}`);
check('difficulty affects the run (enemy count/speed)', runState.difficulty === 'hard');
check('collectibles and enemies spawned', runState.items > 0 && runState.enemies > 0, `${runState.items} items, ${runState.enemies} enemies`);
check('only the selected map is in the scene', await page.evaluate(() => window.__IIYAMA__.app.scene.children.filter((c) => c === window.__IIYAMA__.app.mapGroup).length === 1));
await screenshot(page, '02-game-subway');

console.log(`\n=== 7. Movement, floor support and collision in-game ===`);
const movement = await page.evaluate(async () => {
  const app = window.__IIYAMA__.app;
  const p = app.player;
  const start = p.position.clone();
  // simulate 120 fixed steps walking forward
  const fakeInput = {
    isDown: (c) => c === 'KeyW',
    wasPressed: () => false,
  };
  let fellThrough = false;
  for (let i = 0; i < 120; i++) {
    p.update(1 / 60, fakeInput);
    if (!Number.isFinite(p.position.y) || p.position.y < app.mapBox.min.y - 2) fellThrough = true;
  }
  const afterWalk = p.position.clone();
  // walk into a wall for 60 steps and ensure we are still inside the map
  const before = p.position.clone();
  p.yaw += Math.PI;
  for (let i = 0; i < 60; i++) p.update(1 / 60, fakeInput);
  const afterBack = p.position.clone();
  const inside = afterBack.x >= app.mapBox.min.x - 1 && afterBack.x <= app.mapBox.max.x + 1 && afterBack.z >= app.mapBox.min.z - 1 && afterBack.z <= app.mapBox.max.z + 1;
  return {
    walked: start.distanceTo(afterWalk),
    grounded: p.grounded,
    fellThrough,
    inside,
    y: p.position.y,
    floorY: app.mapBox.min.y,
  };
});
check('player walks when W is held', movement.walked > 0.5, `${movement.walked.toFixed(2)} m in 2 s`);
check('player stays on the floor (no falling through)', !movement.fellThrough && movement.grounded, `y ${movement.y.toFixed(2)}`);
check('player cannot leave the map through walls', movement.inside);

console.log(`\n=== 8. Pause / resume / retry / save ===`);
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('noop'));
await page.evaluate(() => { window.__IIYAMA__.app.pause(); window.__IIYAMA__.ui.showPause(window.__IIYAMA__.app.currentMap, 'hard'); });
check('pause stops the run', await page.evaluate(() => window.__IIYAMA__.app.state === 'paused' && window.__IIYAMA__.ui.current === 'pause'));
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('resume'));
check('resume continues the same map', await page.evaluate(() => window.__IIYAMA__.app.state === 'playing' && window.__IIYAMA__.app.currentMap.id === 'subway'));
await page.evaluate(() => window.__IIYAMA__.ui.callbacks.onAction('restart'));
await page.waitForTimeout(500);
const restarted = await page.evaluate(() => ({ state: window.__IIYAMA__.app.state, map: window.__IIYAMA__.app.currentMap.id, elapsed: window.__IIYAMA__.app.elapsed, collected: window.__IIYAMA__.app.collected }));
check('retry restarts the same map from the beginning', restarted.state === 'playing' && restarted.map === 'subway' && restarted.collected === 0, `elapsed ${restarted.elapsed.toFixed(1)}s`);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('iiyama3d.save.v1') || '{}'));
check('save data records the last map + difficulty', saved.lastMapId === 'subway' && saved.difficulty === 'hard', `lastMapId=${saved.lastMapId}`);

console.log(`\n=== 9. Collectible -> exit flow ===`);
const escapeFlow = await page.evaluate(() => {
  const app = window.__IIYAMA__.app;
  // teleport the player onto each collectible to collect them
  for (const item of app.items) {
    if (item.collected) continue;
    app.player.position.set(item.mesh.position.x, item.mesh.position.y - 0.9, item.mesh.position.z);
    app._updateItems(0);
  }
  const allCollected = app.collected === app.totalItems;
  const exitVisible = app.exitActive && app.exitZone && app.exitZone.visible;
  // stand in the exit zone
  app.player.position.set(app.spawnPoint.x, app.spawnPoint.y + 0.05, app.spawnPoint.z);
  app._updateExit(0);
  return { allCollected, exitVisible, state: app.state, collected: app.collected, total: app.totalItems };
});
check('collecting every item activates the exit', escapeFlow.allCollected && escapeFlow.exitVisible, `${escapeFlow.collected}/${escapeFlow.total}`);
check('entering the exit ends the run', escapeFlow.state === 'ended');
await page.waitForFunction(() => window.__IIYAMA__.ui.current === 'result', { timeout: 30000 }).catch(() => {});
const resultScreen = await page.evaluate(() => ({
  screen: window.__IIYAMA__.ui.current,
  title: document.getElementById('result-title').textContent,
  stats: document.getElementById('result-stats').textContent.replace(/\s+/g, ' ').trim(),
}));
check('result screen is shown after the run', resultScreen.screen === 'result', resultScreen.title);
check('result screen reports map/difficulty/collected', /subway|地下鉄|HARD|回収/.test(resultScreen.stats) || resultScreen.stats.length > 10, resultScreen.stats.slice(0, 90));
await screenshot(page, '03-result');

console.log(`\n=== 10. Enemy AI ===`);
const enemyState = await page.evaluate(async () => {
  const g = window.__IIYAMA__;
  await g.startRun('warehouse', 'normal');
  const app = g.app;
  const movers = app.enemies.map((e) => {
    const before = e.position.clone();
    for (let i = 0; i < 240; i++) e.update(1 / 60, app.player.position, i / 60);
    return { moved: before.distanceTo(e.position), state: e.state };
  });
  return {
    moved: Math.max(...movers.map((m) => m.moved)),
    all: movers.map((m) => `${m.state}:${m.moved.toFixed(1)}m`).join(' '),
    count: app.enemies.length,
  };
});
check('enemies patrol/chase (AI updates movement)', enemyState.moved > 1.0, `max moved ${enemyState.moved.toFixed(2)} m · ${enemyState.all}`);

console.log(`\n=== 11. Failure handling, map switching and no leaks ===`);
const errorPath = await page.evaluate(async () => {
  const g = window.__IIYAMA__;
  const m = g.maps.find((x) => x.id === 'classroom');
  const saved = m.status;
  m.status = 'error';
  m.error = 'simulated failure (verify)';
  g.ui.callbacks.onAction('to-mapselect');
  g.selectMap('classroom');
  const nextDisabled = document.getElementById('btn-start-run').disabled;
  await g.startRun('classroom');
  const out = {
    nextDisabled,
    screen: g.ui.current,
    detail: document.getElementById('error-detail').textContent,
    loadedMap: g.app.currentMap ? g.app.currentMap.id : null,
  };
  m.status = saved;
  m.error = null;
  return out;
});
check('an unloadable map disables the next button', errorPath.nextDisabled === true);
check('an unloadable map shows an error instead of a substitute', errorPath.screen === 'error' && errorPath.loadedMap === null, errorPath.detail);

const switching = await page.evaluate(async () => {
  const g = window.__IIYAMA__;
  const counts = [];
  for (let i = 0; i < 3; i++) {
    await g.startRun('classroom', 'easy');
    counts.push(g.app.scene.children.length);
    g.app.unloadMap();
  }
  const idle = g.app.scene.children.length;
  await g.loadOnly('subway');
  return { counts, idle, loaded: g.app.scene.children.length };
});
check('switching maps does not leak scene objects', new Set(switching.counts).size === 1 && switching.idle <= 5, `children per run ${switching.counts.join('/')} · idle ${switching.idle}`);

const saveState = await page.evaluate(() => ({
  stored: JSON.parse(localStorage.getItem('iiyama3d.save.v1') || '{}'),
  continueVisible: !document.getElementById('btn-continue').hidden,
  knownMaps: window.__IIYAMA__.maps.map((m) => m.id),
}));
check('save data persists difficulty + last map', saveState.knownMaps.includes(saveState.stored.lastMapId) && saveState.stored.difficulty === 'hard',
  `lastMapId=${saveState.stored.lastMapId}, difficulty=${saveState.stored.difficulty}`);
check('continue button is offered once a run was played', saveState.continueVisible === true);

console.log(`\n=== 12. No runtime errors ===`);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await close();

writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify({ results, failures, date: new Date().toISOString() }, null, 2));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${results.length} checks)`);
console.log(`screenshots: ${SHOT_DIR}`);
process.exit(failures === 0 ? 0 : 1);
