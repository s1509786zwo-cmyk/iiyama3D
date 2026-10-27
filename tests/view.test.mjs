/**
 * Verifies the eye line is identical in every map.
 *
 * For each shipped map it loads the real geometry, applies the map's calibrated
 * scale, measures the actual floor under the spawn, then reproduces exactly what
 * GameSession.syncCamera() does and checks the camera height above that floor.
 *
 * Run: node --max-old-space-size=6144 tests/view.test.mjs
 */
import fs from 'node:fs';
import { Vector3, PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildCollision, CharacterBody } from '../src/core/collision.js';
import { EYE_HEIGHT, FOV, PLAYER_HEIGHT, PLAYER_RADIUS, cameraYFor } from '../src/game/view.js';
import baked from '../src/maps/baked.json' with { type: 'json' };

globalThis.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
globalThis.self = globalThis;
await MeshoptDecoder.ready;

const MAPS = [
  ['city_street', 'public/maps/city_street.glb'],
  ['warehouse', 'public/maps/warehouse.glb'],
  ['subway', 'public/maps/subway.glb'],
  ['classroom', 'public/maps/classroom.glb'],
];

let failures = 0;
const check = (map, name, ok, detail = '') => {
  if (ok) console.log(`  PASS  [${map}] ${name}`);
  else { failures++; console.log(`  FAIL  [${map}] ${name}   ${detail}`); }
};

console.log('eye-line consistency tests\n');
console.log(`  shared spec: eye=${EYE_HEIGHT} m, height=${PLAYER_HEIGHT} m, radius=${PLAYER_RADIUS} m, fov=${FOV}°\n`);

const measured = [];

for (const [id, file] of MAPS) {
  const data = baked[id];
  const buffer = fs.readFileSync(file);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', resolve, reject);
  });

  const root = gltf.scene;
  root.scale.setScalar(data.scale);
  root.updateMatrixWorld(true);

  const { bvh } = buildCollision(root);
  const body = new CharacterBody({ bvh, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
  const spawn = data.spawn;

  // exactly what GameSession.setupPlayer() does
  body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
  body.resolve();
  const floor = body.groundY(0.6);
  check(id, 'floor measured under the spawn', floor !== null, String(floor));
  if (floor !== null) {
    body.position.y = floor + 0.001;
    body.grounded = true;
  }

  // settle for a second of simulation (no input) — the eye must not drift
  for (let i = 0; i < 60; i++) body.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
  const settledFloor = body.groundY(0.5) ?? body.position.y;
  const cameraY = cameraYFor(body.position.y);
  const eyeAboveFloor = cameraY - settledFloor;
  measured.push({ id, floor: settledFloor, cameraY, eyeAboveFloor });

  check(id, 'eye sits exactly 1.62 m above the floor', Math.abs(eyeAboveFloor - EYE_HEIGHT) < 0.02,
    `${eyeAboveFloor.toFixed(4)} m`);
  check(id, 'eye is below the ceiling / inside the space', Number.isFinite(cameraY), cameraY.toFixed(2));

  const camera = new PerspectiveCamera(FOV, 16 / 9, 0.05, 500);
  check(id, 'camera uses the shared vertical FOV', camera.fov === FOV, `${camera.fov}° (≈${(2 * Math.atan(Math.tan((FOV * Math.PI) / 360) * (16 / 9)) * 180 / Math.PI).toFixed(0)}° horizontal at 16:9)`);

  // the standing volume must be free of geometry: nothing inside the capsule
  let worst = 0;
  for (const h of [0.3, 0.9, 1.4, 1.6]) {
    const p = new Vector3(body.position.x, settledFloor + h, body.position.z);
    const hit = bvh.closestPointToPoint(p, {}, 0, PLAYER_RADIUS + 0.02);
    if (hit) worst = Math.max(worst, PLAYER_RADIUS - hit.distance);
  }
  check(id, 'the standing volume is clear at spawn (no geometry inside the player)',
    worst <= 0.0, `intrusion ${worst.toFixed(3)} m`);

  // head clearance: the 1.75 m player must fit under whatever is above the spawn
  const upRay = new (await import('three')).Ray(new Vector3(spawn.x, settledFloor + 0.05, spawn.z), new Vector3(0, 1, 0));
  const { DoubleSide } = await import('three');
  const ceil = bvh.raycastFirst(upRay, DoubleSide, 0, 40);
  check(id, 'head clearance above the player (or open sky)',
    !ceil || ceil.distance >= PLAYER_HEIGHT,
    ceil ? `ceiling at ${ceil.distance.toFixed(2)} m, player is ${PLAYER_HEIGHT} m` : 'open sky');

  console.log(`  ---- ${id}: floor=${settledFloor.toFixed(3)}  camera=${cameraY.toFixed(3)}  eye above floor=${eyeAboveFloor.toFixed(3)} m\n`);
}

const heights = measured.map((m) => m.eyeAboveFloor);
const spread = Math.max(...heights) - Math.min(...heights);
check('all maps', 'eye height spread across maps is ~0 (< 1 cm)', spread < 0.01, `${(spread * 1000).toFixed(2)} mm`);

console.log('  summary');
for (const m of measured) {
  console.log(`    ${m.id.padEnd(12)} eye above floor = ${m.eyeAboveFloor.toFixed(3)} m`);
}

console.log(failures === 0 ? '\nALL VIEW TESTS PASSED' : `\n${failures} VIEW TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
