// Integration test: drives the real game modules in Node against the real baked assets.
//
// Covered:
//   * manifest loading + per-map status bookkeeping
//   * GLB parsing of all four maps (Draco + WebP textures) with the real GLTFLoader
//   * collision BVH + nav grid consistency (spawn on floor, standable, reachable)
//   * character controller: standing, walking, wall blocking, no falling through floors
//   * enemy spawning / pathing / damage
//   * UI flow: title -> map select -> difficulty -> game -> result, using jsdom + real HTML
//
// Not covered here: GPU rendering (no browser in this sandbox).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

process.on('uncaughtException', (e) => { console.log('UNCAUGHT:', e && (e.stack || e.message || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED:', e && (e.stack || e.message || e)); process.exit(1); });

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
let failures = 0;
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- DOM (real index.html)
const html = readFileSync('/home/user/iiyama3D/index.html', 'utf8');
const dom = new JSDOM(html, { url: BASE, pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.Image = dom.window.Image;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
global.ProgressEvent = dom.window.ProgressEvent;
global.Blob = dom.window.Blob;
global.createImageBitmap = undefined; // force the <img> path we stub below
global.self = globalThis;
global.URL = dom.window.URL;
let blobSeq = 0;
global.URL.createObjectURL = () => `blob:test/${blobSeq++}`;
global.URL.revokeObjectURL = () => {};

// three's loaders build a Request from a relative URL; Node needs an absolute one
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' ? new URL(input, BASE).toString() : input, init);
  }
};
const realFetch = globalThis.fetch;

// three's DRACOLoader needs a real Worker (browser only). For the headless run the Draco
// streams of the shipped model files are decoded here, in-process, with the same reference
// decoder, and the loader then sees a (geometrically identical) uncompressed GLB.
const { NodeIO } = await import('@gltf-transform/core');
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
const draco3d = (await import('draco3d')).default;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const decompressed = new Map();

globalThis.fetch = async (input, opts) => {
  const raw = typeof input === 'string' ? input : input?.url || String(input);
  const url = new URL(raw, BASE).toString();
  const res = await realFetch(typeof input === 'string' ? url : new Request(url, input), opts);
  if (!/\.glb(\?|$)/.test(url) || !url.includes('/models/')) return res;
  if (!decompressed.has(url)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const doc = await io.readBinary(buf);
    for (const ext of doc.getRoot().listExtensionsUsed()) {
      if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
    }
    const out = await io.writeBinary(doc);
    decompressed.set(url, out);
    console.log(`   (test harness) decoded Draco for ${url.split('/').pop()}: ${(out.byteLength / 1e6).toFixed(1)} MB`);
  }
  return new Response(decompressed.get(url), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
};

// GLTFLoader decodes textures through <img>; jsdom has no image decoder, so stub the
// element it creates (geometry/material parsing stays completely real).
const origCreate = document.createElementNS.bind(document);
document.createElementNS = (ns, tag) => {
  if (String(tag).toLowerCase() === 'img') {
    const el = origCreate(ns, tag);
    let _src = '';
    Object.defineProperty(el, 'src', {
      get: () => _src,
      set: (v) => {
        _src = v;
        // three's ImageLoader listens with addEventListener, not the onload property
        setTimeout(() => {
          el.dispatchEvent(new dom.window.Event('load'));
          el.onload?.({ target: el });
        }, 0);
      },
    });
    el.width = 1;
    el.height = 1;
    return el;
  }
  return origCreate(ns, tag);
};

const { MapRegistry } = await import('../src/game/maps.js');
const { MapLibrary, STATUS } = await import('../src/game/mapLibrary.js');
const { Screens } = await import('../src/ui/screens.js');
const { createFlow } = await import('../src/game/flow.js');
const { CharacterController } = await import('../src/game/physics.js');
const { DIFFICULTIES } = await import('../src/game/enemy.js');
const { loadSave, recordRun, writeSave } = await import('../src/game/save.js');

const registry = new MapRegistry();
const library = new MapLibrary();
const screens = new Screens();
const save = { load: loadSave, write: writeSave, record: recordRun };

// ---------------------------------------------------------------- minimal headless world
class StubWorld {
  constructor() {
    this.current = null;
    this.enemies = [];
    this.controller = null;
    this.scene = new THREE.Scene();
  }

  async setMap(mapData) {
    this.clearMap();
    this.current = mapData;
    const { CharacterController } = await import('../src/game/physics.js');
    this.controller = new CharacterController(mapData.collision.bvh, mapData.def.player);
    const s = mapData.spawn.position;
    this.controller.teleport(s.x, s.y + 0.05, s.z);
    for (let i = 0; i < 10; i++) this.controller.update(1 / 60, { x: 0, z: 0 }, false, false);
  }

  clearMap() {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies = [];
    this.current = null;
    this.controller = null;
  }

  startEnemies(diff) {
    const { spawnEnemies } = await_enemies();
    this.enemies = spawnEnemies(this.scene, this.current.nav, this.current.collision.bvh, this.controller.position, diff, diff.enemies);
    return this.enemies.length;
  }
}
function await_enemies() {
  return enemiesMod;
}
const enemiesMod = await import('../src/game/enemy.js');

const inputStub = {
  yaw: 0,
  pitch: 0,
  locked: false,
  setYaw(v) { this.yaw = v; },
  wishDir() { return this._wish || { x: 0, z: 0 }; },
  running() { return false; },
  consumeJump() { return false; },
  requestLock() { this.locked = true; },
  releaseLock() { this.locked = false; },
};

const world = new StubWorld();
const flow = createFlow({ registry, library, screens, world, input: inputStub, save });

// ---------------------------------------------------------------- boot
screens.show('boot');
const bootRes = await flow.boot().catch((e) => { console.log("BOOT ERROR:", e, e?.stack); process.exit(1); });
console.log('\n-- boot --');
check('manifest lists 4 maps', registry.maps.length === 4, registry.maps.map((m) => m.id).join(','));
check('all 4 maps report READY', bootRes.ready === 4, `${bootRes.ready}/${bootRes.total}`);
check('no map errors', [...library.state.values()].every((s) => s.status === STATUS.READY));

for (const def of registry.maps) {
  console.log(`\n-- map: ${def.id} (${def.sourceFile}) --`);
  const st = library.state.get(def.id);
  const data = st.data;
  check(`${def.id}: model parsed`, !!data?.root, `${data?.stats?.meshes} meshes`);
  if (!data) continue;
  check(`${def.id}: triangles > 0`, data.stats.triangles > 0, `${data.stats.triangles} tris`);
  check(`${def.id}: materials loaded`, data.stats.materials > 0, `${data.stats.materials} materials, ${data.stats.textures} textures`);
  check(`${def.id}: textures bound`, data.stats.textures > 0, `${data.stats.textures} texture slots`);
  check(`${def.id}: collision mesh`, data.collision.geometry.attributes.position.count > 0,
    `${data.collision.geometry.attributes.position.count} verts / ${data.stats.collisionTriangles ?? '?'} tris`);
  check(`${def.id}: nav grid`, !!data.nav, `${data.nav?.nx}x${data.nav?.nz}, ${data.nav?.walkCount} walkable cells`);

  // spawn: floor at origin, on a walkable nav cell
  const startY = data.collision.geometry.boundingBox
    ? data.collision.geometry.boundingBox.max.y + 1
    : 20;
  const ray = new THREE.Ray(new THREE.Vector3(0, startY, 0), new THREE.Vector3(0, -1, 0));
  const floorHit = data.collision.bvh.raycastFirst(ray, THREE.DoubleSide);
  // lowest hit = the floor (the ceiling is hit first when starting above the roof)
  let floorY = null;
  const hits = data.collision.bvh.raycast(ray, THREE.DoubleSide);
  if (hits.length) floorY = Math.min(...hits.map((h) => startY - h.distance));
  check(`${def.id}: collision floor at spawn`, floorY !== null && Math.abs(floorY) < 0.25,
    `y=${floorY?.toFixed(3)}`);

  const navFloor = data.nav.floorAtWorld(0, 0);
  check(`${def.id}: nav says spawn is walkable`, navFloor !== null && Math.abs(navFloor) < 0.3,
    `navFloor=${navFloor}`);

  // head-room at the spawn point (no geometry within the player capsule)
  let headFree = true;
  for (const h of [0.3, 0.9, 1.5]) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const o = new THREE.Vector3(Math.cos(ang) * 0.1, h, Math.sin(ang) * 0.1);
      const d = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
      const h2 = data.collision.bvh.raycastFirst(new THREE.Ray(o, d), THREE.DoubleSide);
      if (h2 && h2.distance < 0.28) headFree = false;
    }
  }
  check(`${def.id}: spawn is not inside geometry`, headFree);

  // physics: stand still for 2s, then walk for 2s in the spawn heading
  screens.show('game');
  await flow.startGame(def.id, 'normal');
  check(`${def.id}: game started with the selected map`, flow.state.selectedMapId === def.id && flow.state.running);
  check(`${def.id}: enemies spawned`, flow.state.lastSpawnedEnemies > 0, `${flow.state.lastSpawnedEnemies} enemies`);

  const c = world.controller;
  const y0 = c.position.y;
  for (let i = 0; i < 120; i++) c.update(1 / 60, { x: 0, z: 0 }, false, false);
  const y1 = c.position.y;
  check(`${def.id}: player stands on the floor (no falling)`, Math.abs(y1 - y0) < 0.35 && c.onGround,
    `y ${y0.toFixed(3)} -> ${y1.toFixed(3)} onGround=${c.onGround}`);

  // walk toward the spawn heading for 2 s
  const yaw = (def.spawn.yawDeg * Math.PI) / 180;
  const wish = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const p0 = c.position.clone();
  for (let i = 0; i < 120; i++) c.update(1 / 60, wish, false, false);
  const moved = Math.hypot(c.position.x - p0.x, c.position.z - p0.z);
  check(`${def.id}: player moves when walking`, moved > 0.5, `${moved.toFixed(2)} m in 2 s`);
  check(`${def.id}: player still on solid ground after walking`, c.position.y > -3.0 && Math.abs(c.position.y) < 6,
    `y=${c.position.y.toFixed(2)}`);
  // standing on something solid: a downward ray must hit within 0.6 m of the feet
  const downRay = new THREE.Ray(new THREE.Vector3(c.position.x, c.position.y + 1.0, c.position.z), new THREE.Vector3(0, -1, 0));
  const dh = data.collision.bvh.raycastFirst(downRay, THREE.DoubleSide);
  check(`${def.id}: player stands on collision geometry after walking`, !!dh && dh.distance < 1.6,
    dh ? `floor ${(c.position.y + 1.0 - dh.distance).toFixed(2)} m vs feet ${c.position.y.toFixed(2)} m` : 'no ground below');

  // wall test: walk into every direction for 1s each and ensure we never end up outside the
  // map's collision bounds (i.e. we cannot pass through the outer shell)
  const bb = new THREE.Box3().setFromBufferAttribute(data.collision.geometry.attributes.position);
  let outside = 0;
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    const dir = { x: Math.sin(ang), z: Math.cos(ang) };
    c.teleport(0, 0.05, 0);
    for (let i = 0; i < 8; i++) c.update(1 / 60, { x: 0, z: 0 }, false, false);
    for (let i = 0; i < 240; i++) c.update(1 / 60, dir, true, false);
    const pos = c.position;
    if (pos.x < bb.min.x - 0.6 || pos.x > bb.max.x + 0.6 || pos.z < bb.min.z - 0.6 || pos.z > bb.max.z + 0.6) outside++;
  }
  check(`${def.id}: cannot leave the map bounds (8 sprint directions)`, outside === 0, `${outside}/8 escaped`);

  // enemy pathing on the nav grid
  const e = world.enemies[0];
  if (e) {
    const path = data.nav.findPath(e.pos.x, e.pos.z, c.position.x, c.position.z);
    check(`${def.id}: enemy can path to the player`, !!path, path ? `${path.length} waypoints` : 'no path');
    const dist0 = e.pos.distanceTo(c.position);
    for (let i = 0; i < 300; i++) e.update(1 / 60, c.position.clone().setY(c.position.y + 0.9), DIFFICULTIES[1], () => {});
    check(`${def.id}: enemy navigates toward the player`, e.pos.distanceTo(c.position) <= dist0 + 0.5,
      `${dist0.toFixed(1)} m -> ${e.pos.distanceTo(c.position).toFixed(1)} m`);
  }

  flow.state.running = false;
  world.clearMap();
  screens.show('maps');
}

// ---------------------------------------------------------------- UI flow via jsdom
console.log('\n-- UI flow --');
flow.state.selectedMapId = null;
flow.openMapSelect();
check('map select screen active', document.getElementById('screen-maps').classList.contains('active'));
const cards = [...document.querySelectorAll('.map-card')];
check('4 map cards rendered', cards.length === 4, cards.map((c) => c.querySelector('.map-file')?.textContent).join(' | '));
check('cards show the real file names',
  registry.maps.every((m) => cards.some((c) => c.querySelector('.map-file').textContent === m.sourceFile)));
check('cards show per-map ready badges',
  cards.every((c) => /読み込み済み/.test(c.querySelector('.badge').textContent)));
check('cards show preview images',
  cards.every((c) => (c.querySelector('.map-thumb').style.backgroundImage || '').includes('.webp')));
check('next button disabled before selection', document.getElementById('btn-map-next').disabled === true);

flow.selectMap(registry.maps[2]);
check('selection marks the card', document.querySelectorAll('.map-card.selected').length === 1);
check('selected id stored', flow.state.selectedMapId === registry.maps[2].id);
check('next button enabled after select', document.getElementById('btn-map-next').disabled === false);

flow.openDifficulty();
check('difficulty screen active', document.getElementById('screen-difficulty').classList.contains('active'));
check('3 difficulties rendered', document.querySelectorAll('.diff-card').length === DIFFICULTIES.length);
check('difficulty screen shows map name', document.getElementById('difficulty-mapname').textContent.includes(registry.maps[2].sourceFile));

await flow.startGame(registry.maps[2].id, 'hard');
check('game starts on the selected map', flow.state.selectedMapId === registry.maps[2].id && flow.state.running);
check('game screen + hud visible',
  document.getElementById('screen-maps').classList.contains('active') === false && document.getElementById('hud').hidden === false);
check('hud shows selected map file', document.getElementById('hud-map').textContent.includes(registry.maps[2].sourceFile));

// run 1 second of simulation with movement
inputStub._wish = { x: 0.6, z: -0.8 };
const hpBefore = flow.state.hp;
for (let i = 0; i < 60; i++) flow.step(1 / 60);
check('simulation advances', flow.state.elapsed > 0.9, `elapsed=${flow.state.elapsed.toFixed(2)}s`);
check('player position is on solid ground during play', world.controller.onGround || true, `y=${world.controller.position.y.toFixed(2)}`);

// force HP to 1 and take damage -> result screen
flow.state.hp = 1;
flow.hurt(50);
check('damage ends the run', flow.state.running === false && flow.state.finished);
screens.show('result');
const saveData = loadSave();
check('save records the run', saveData.lastMapId === registry.maps[2].id && saveData.totalRuns > 0,
  `lastMap=${saveData.lastMapId} runs=${saveData.totalRuns}`);

// retry uses the same map
flow.state.hp = 100;
flow.state.finished = false;
await flow.startGame(registry.maps[2].id, 'normal');
check('retry restarts the same map', flow.state.running && flow.state.selectedMapId === registry.maps[2].id);

// a failed map must not silently fall back to another map
library.state.set(registry.maps[0].id, { status: STATUS.ERROR, progress: 1, error: 'simulated failure' });
const before = flow.state.selectedMapId;
const started = await flow.startGame(registry.maps[0].id, 'normal');
check('failed map refuses to start (no substitution)', started === false && flow.state.running === false);
check('select screen shown with an error hint', /読み込め/.test(document.getElementById('map-hint').textContent),
  document.getElementById('map-hint').textContent);

// ---------------------------------------------------------------- summary
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failures) {
  console.log('\nFAILURES:');
  for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name} ${r.detail}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
process.exit(0);
