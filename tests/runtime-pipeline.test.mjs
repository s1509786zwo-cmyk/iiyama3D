/**
 * Exercises the exact runtime loading path with three.js' GLTFLoader:
 *   GLB bytes -> GLTFLoader.parse (EXT_meshopt_compression + EXT_texture_webp)
 *   -> scaled scene graph -> StaticGeometryGenerator -> BVH -> CharacterBody
 *
 * Image decoding is stubbed (Node has no ImageBitmap); everything else is real.
 * Run: node --max-old-space-size=6144 tests/runtime-pipeline.test.mjs
 */
import fs from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildCollision, CharacterBody, NavGrid } from '../src/core/collision.js';
import baked from '../src/maps/baked.json' with { type: 'json' };

// --- minimal browser stubs so GLTFLoader can decode embedded images ---
let decodeCount = 0;
globalThis.createImageBitmap = async (blob) => {
  decodeCount++;
  return { width: 8, height: 8, close() {} };
};
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

console.log('runtime GLTFLoader pipeline tests\n');

for (const [id, file] of MAPS) {
  const data = baked[id];
  const buffer = fs.readFileSync(file);
  const before = decodeCount;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  let gltf;
  let loadError = null;
  try {
    gltf = await new Promise((resolve, reject) => {
      loader.parse(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        '',
        resolve,
        reject,
      );
    });
  } catch (error) {
    loadError = error;
  }
  check(id, 'GLTFLoader.parse succeeds (meshopt + webp extensions)', !loadError, String(loadError?.message || loadError));
  if (loadError) continue;

  const root = gltf.scene;
  root.scale.setScalar(data.scale);
  root.updateMatrixWorld(true);

  let meshes = 0;
  let materials = new Set();
  let triangles = 0;
  root.traverse((child) => {
    if (!child.isMesh) return;
    meshes++;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => m && materials.add(m.uuid));
    const geo = child.geometry;
    triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  });
  check(id, 'scene graph contains meshes', meshes > 0, `${meshes} meshes`);
  check(id, 'materials were created', materials.size > 0, `${materials.size} materials`);
  check(id, 'triangle count is preserved', Math.round(triangles) > 1000, `${Math.round(triangles)} triangles`);

  // texture decode path (stubbed bitmap)
  check(id, 'embedded textures were decoded', decodeCount > before, `${decodeCount - before} decoded`);
  let matsWithMap = 0;
  root.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => { if (m?.map) matsWithMap++; });
  });
  check(id, 'materials keep their base colour textures', matsWithMap > 0, `${matsWithMap} textured materials`);

  // runtime collision path
  const { bvh } = buildCollision(root);
  check(id, 'collision BVH built from the loaded scene', !!bvh);

  const body = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
  const spawn = data.spawn;
  body.teleport(spawn.x, spawn.y + 0.1, spawn.z);
  for (let i = 0; i < 90; i++) body.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
  check(id, 'player stands on the spawn floor', body.grounded && Math.abs(body.position.y - spawn.y) < 0.2,
    `y=${body.position.y.toFixed(2)} spawn.y=${spawn.y}`);

  // enemy navigation uses the same BVH + baked grid
  const nav = new NavGrid(data.grid);
  const target = data.objectives[0];
  const path = nav.findPath(body.position, target);
  check(id, 'enemy path to first objective exists', path.length > 0, `${path.length} waypoints`);

  if (path.length) {
    const enemy = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
    const start = data.patrols[0];
    enemy.teleport(start.x, start.y + 0.1, start.z);
    const enemyPath = nav.findPath(enemy.position, target);
    let reached = 0;
    for (let step = 0; step < 600 && enemyPath.length; step++) {
      const node = enemyPath[Math.min(reached, enemyPath.length - 1)];
      const dx = node.x - enemy.position.x;
      const dz = node.z - enemy.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.45) { reached++; if (reached >= enemyPath.length) break; continue; }
      enemy.update(1 / 60, new Vector3(dx / d, 0, dz / d), { speed: 1.9 });
    }
    check(id, 'enemy walks its path without falling through', enemy.position.y > data.baseY - 1,
      `y=${enemy.position.y.toFixed(2)} nodes=${reached}/${enemyPath.length}`);
  }

  console.log(`  ---- ${id}: ${Math.round(triangles)} tris, ${meshes} meshes, ${materials.size} materials\n`);
}

console.log(failures === 0 ? 'ALL RUNTIME PIPELINE TESTS PASSED' : `${failures} RUNTIME TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
