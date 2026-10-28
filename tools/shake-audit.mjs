/**
 * Reproduces the in-game camera motion numerically to find screen shake.
 *
 * Runs the real CharacterBody + GameSession camera formula on the subway map,
 * walking forward for a few seconds, and records per-frame camera height and
 * horizontal speed so any oscillation (vibration) can be measured.
 *
 * Run: node --max-old-space-size=6144 tools/shake-audit.mjs [mapId]
 */
import fs from 'node:fs';
import { Vector3, Ray, DoubleSide } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildCollision, CharacterBody } from '../src/core/collision.js';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED } from '../src/game/view.js';
import baked from '../src/maps/baked.json' with { type: 'json' };

globalThis.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
globalThis.self = globalThis;
await MeshoptDecoder.ready;

const id = process.argv[2] || 'subway';
const FILES = {
  city_street: 'public/maps/city_street.glb',
  warehouse: 'public/maps/warehouse.glb',
  subway: 'public/maps/subway.glb',
  classroom: 'public/maps/classroom.glb',
};

const data = baked[id];
const buffer = fs.readFileSync(FILES[id]);
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await new Promise((res, rej) => {
  loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', res, rej);
});
const root = gltf.scene;
root.scale.setScalar(data.scale);
root.updateMatrixWorld(true);
const { bvh } = buildCollision(root);

const body = new CharacterBody({ bvh, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
const spawn = data.spawn;
body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
body.resolve();
const yaw = spawn.yaw;
const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));

const dt = 1 / 60;
const samples = [];
let safe = { x: body.position.x, y: body.position.y, z: body.position.z };
let airborne = 0;
let snaps = 0;
const startY = new Vector3(spawn.x, 0, spawn.z);
for (let frame = 0; frame < 600; frame++) {
  // settle for the first 30 frames, then walk for 6 s
  const wish = frame > 30 ? forward : new Vector3();
  // exactly the call GameSession makes, including the ledge guard
  body.update(dt, wish, { speed: WALK_SPEED, accel: 15, ledgeGuard: true });

  // GameSession's safety net (see src/game/session.js)
  const p = body.position;
  if (body.grounded) {
    safe = { x: p.x, y: p.y, z: p.z };
    airborne = 0;
  } else {
    airborne += 1;
    if (airborne > 6 && p.y < safe.y - 0.7) {
      body.teleport(safe.x, safe.y + 0.01, safe.z);
      body.velocity.set(0, 0, 0);
      body.resolve();
      airborne = 0;
      snaps += 1;
    }
  }

  const camY = body.position.y + EYE_HEIGHT;
  samples.push({
    frame,
    camY,
    x: body.position.x,
    z: body.position.z,
    grounded: body.grounded,
    vy: body.velocity.y,
  });
}

const walking = samples.slice(60);
const ys = walking.map((s) => s.camY);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);
const span = maxY - minY;

// frame-to-frame vertical deltas: this is what the eye actually feels
const deltas = [];
for (let i = 1; i < walking.length; i++) deltas.push(walking[i].camY - walking[i - 1].camY);
const absDeltas = deltas.map((d) => Math.abs(d));
absDeltas.sort((a, b) => a - b);
const signChanges = deltas.reduce((n, d, i) => (i > 0 && Math.sign(d) !== Math.sign(deltas[i - 1]) && Math.abs(d) > 1e-6 ? n + 1 : n), 0);

// horizontal jitter: deviation from a straight line
const hs = [];
for (const s of walking) {
  const dx = s.x - startY.x;
  const dz = s.z - startY.z;
  const along = dx * forward.x + dz * forward.z;
  const lateral = Math.abs(dx * -forward.z + dz * forward.x);
  hs.push({ along, lateral });
}
const maxLateral = Math.max(...hs.map((h) => h.lateral));
const groundedRatio = walking.filter((s) => s.grounded).length / walking.length;

console.log(`shake audit: ${id}`);
console.log(`  camera Y span over 6 s of walking : ${(span * 1000).toFixed(1)} mm  (min ${minY.toFixed(4)} max ${maxY.toFixed(4)})`);
console.log(`  per-frame |ΔY| median             : ${(absDeltas[Math.floor(absDeltas.length / 2)] * 1000).toFixed(2)} mm`);
console.log(`  per-frame |ΔY| p95                : ${(absDeltas[Math.floor(absDeltas.length * 0.95)] * 1000).toFixed(2)} mm`);
console.log(`  vertical direction reversals      : ${signChanges} over ${walking.length} frames (${(signChanges / (walking.length / 60)).toFixed(1)}/s)`);
console.log(`  max lateral deviation from path   : ${(maxLateral * 1000).toFixed(1)} mm`);
console.log(`  grounded frames                   : ${(groundedRatio * 100).toFixed(1)}%`);
const worst = [...walking].sort((a, b) => Math.abs(b.vy) - Math.abs(a.vy)).slice(0, 5);
console.log(`  worst |vy| samples                : ${worst.map((s) => s.vy.toFixed(3)).join(', ')}`);
console.log(`  safety-net snaps                  : ${snaps}`);
