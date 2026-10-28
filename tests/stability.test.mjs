/**
 * Stability / comfort tests — the "the train car shakes and makes me sick" bug.
 *
 * Reproduces real gameplay movement (CharacterBody + the ledge guard + the
 * session's safety net, at the exact runtime eye height and walking speed) and
 * asserts the camera cannot fall, teleport or oscillate in any map.
 *
 * Run: node --max-old-space-size=6144 tests/stability.test.mjs
 */
import fs from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildCollision, CharacterBody } from '../src/core/collision.js';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED, SPRINT_SPEED } from '../src/game/view.js';
import baked from '../src/maps/baked.json' with { type: 'json' };

globalThis.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
globalThis.self = globalThis;
await MeshoptDecoder.ready;

const MAPS = {
  city_street: 'public/maps/city_street.glb',
  warehouse: 'public/maps/warehouse.glb',
  subway: 'public/maps/subway.glb',
  classroom: 'public/maps/classroom.glb',
};

let failures = 0;
const check = (map, name, ok, detail = '') => {
  if (ok) console.log(`  PASS  [${map}] ${name}`);
  else { failures++; console.log(`  FAIL  [${map}] ${name}   ${detail}`); }
};

/** walk in `dirs` for `seconds`, mirroring GameSession.update + safety net */
function simulate({ bvh, spawn, dirs, seconds, speed }) {
  const body = new CharacterBody({ bvh, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
  body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
  body.resolve();
  const dt = 1 / 60;
  const frames = Math.round(seconds * 60);
  const camY = [];
  let safe = { x: body.position.x, y: body.position.y, z: body.position.z };
  let airborne = 0;
  let snaps = 0;
  let groundedFrames = 0;
  let minY = Infinity;

  for (let f = 0; f < frames; f++) {
    const dir = dirs[Math.floor(f / Math.max(1, Math.floor(frames / dirs.length))) % dirs.length];
    body.update(dt, f < 20 ? new Vector3() : dir, { speed, accel: 15, ledgeGuard: true });
    const p = body.position;
    if (body.grounded) {
      safe = { x: p.x, y: p.y, z: p.z };
      airborne = 0;
      groundedFrames++;
    } else {
      airborne++;
      if (airborne > 6 && p.y < safe.y - 0.7) {
        body.teleport(safe.x, safe.y + 0.01, safe.z);
        body.velocity.set(0, 0, 0);
        body.resolve();
        airborne = 0;
        snaps++;
      }
    }
    camY.push(body.position.y + EYE_HEIGHT);
    minY = Math.min(minY, body.position.y);
  }

  const walking = camY.slice(20);
  const span = Math.max(...walking) - Math.min(...walking);
  const deltas = [];
  for (let i = 1; i < walking.length; i++) deltas.push(Math.abs(walking[i] - walking[i - 1]));
  deltas.sort((a, b) => a - b);
  return {
    span,
    p95: deltas[Math.floor(deltas.length * 0.95)] ?? 0,
    groundedRatio: groundedFrames / frames,
    snaps,
    minY,
    body,
  };
}

console.log('stability / comfort tests\n');

for (const [id, file] of Object.entries(MAPS)) {
  const data = baked[id];
  const buffer = fs.readFileSync(file);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((res, rej) => {
    loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', res, rej);
  });
  gltf.scene.scale.setScalar(data.scale);
  gltf.scene.updateMatrixWorld(true);
  const { bvh } = buildCollision(gltf.scene);

  const yaw = data.spawn.yaw;
  const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const back = forward.clone().negate();
  const left = new Vector3(-forward.z, 0, forward.x);
  const right = left.clone().negate();

  // 1) straight ahead for 8 s — this is what broke the subway car
  const ahead = simulate({ bvh, spawn: data.spawn, dirs: [forward], seconds: 8, speed: WALK_SPEED });
  check(id, 'walking forward never leaves the floor', ahead.groundedRatio === 1,
    `grounded ${(ahead.groundedRatio * 100).toFixed(1)}%, lowest feet y=${ahead.minY.toFixed(2)}`);
  check(id, 'camera does not fall into the void', ahead.minY > data.baseY - 1.0,
    `lowest feet y=${ahead.minY.toFixed(2)} (floor ${data.baseY})`);
  check(id, 'no safety-net teleports on a straight walk', ahead.snaps === 0, `${ahead.snaps} snaps`);
  check(id, 'camera height is smooth (p95 frame delta < 25 mm)', ahead.p95 < 0.025,
    `p95 ${(ahead.p95 * 1000).toFixed(2)} mm`);

  // 2) wander in four directions at sprint speed for 12 s
  const wander = simulate({ bvh, spawn: data.spawn, dirs: [forward, right, back, left], seconds: 12, speed: SPRINT_SPEED });
  check(id, 'sprinting in all directions stays grounded', wander.groundedRatio >= 0.98,
    `${(wander.groundedRatio * 100).toFixed(1)}% grounded`);
  check(id, 'sprinting never falls out of the map', wander.minY > data.baseY - 1.0,
    `lowest feet y=${wander.minY.toFixed(2)}`);
  check(id, 'sprinting camera is smooth (p95 frame delta < 40 mm)', wander.p95 < 0.04,
    `p95 ${(wander.p95 * 1000).toFixed(2)} mm`);
  check(id, 'no repeated snap-back loop while sprinting', wander.snaps <= 2, `${wander.snaps} snaps`);

  console.log(`  ---- ${id}: fwd span ${(ahead.span * 1000).toFixed(0)} mm, sprint span ${(wander.span * 1000).toFixed(0)} mm\n`);
}

console.log(failures === 0 ? 'ALL STABILITY TESTS PASSED' : `\n${failures} STABILITY TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
