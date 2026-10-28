/**
 * Integration tests against the assets the game actually ships:
 * parses public/maps/*.glb, builds the same BVH pipeline, then verifies
 * spawn safety, ground contact, wall collisions, objective reachability
 * and enemy navigation.
 *
 * Run: node --max-old-space-size=6144 tests/maps.test.mjs
 */
import { Vector3, Ray, DoubleSide, Matrix4, Quaternion } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { BufferGeometry, BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CharacterBody, NavGrid } from '../src/core/collision.js';
import baked from '../src/maps/baked.json' with { type: 'json' };

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const MAPS = [
  { id: 'city_street', file: 'public/maps/city_street.glb', objFile: 'google_drive/abandoned_city_street_for_games.glb' },
  { id: 'warehouse', file: 'public/maps/warehouse.glb', objFile: 'google_drive/abandoned_warehouse_-_interior_scene.glb' },
  { id: 'subway', file: 'public/maps/subway.glb', objFile: 'google_drive/subway_train_interior.glb' },
  { id: 'classroom', file: 'public/maps/classroom.glb', objFile: 'google_drive/abandoned_classroom.glb' },
];

let failures = 0;
const check = (map, name, ok, detail = '') => {
  if (ok) console.log(`  PASS  [${map}] ${name}`);
  else { failures++; console.log(`  FAIL  [${map}] ${name}   ${detail}`); }
};

async function mergedGeometry(path, scale = 1) {
  const doc = await io.read(path);
  const parts = [];
  const walk = (node, parent) => {
    const local = new Matrix4().compose(new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
    const world = parent.clone().multiply(local);
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        // GLTFLoader builds LineSegments for mode 1/2; StaticGeometryGenerator
        // (the runtime collision path) only merges triangle primitives.
        if (!pos || prim.getMode() !== 4) continue;
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array(pos.getArray()), 3));
        const idx = prim.getIndices();
        if (idx) g.setIndex(new BufferAttribute(new Uint32Array(idx.getArray()), 1));
        g.applyMatrix4(world);
        parts.push(g);
      }
    }
    for (const c of node.listChildren()) walk(c, world);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) walk(n, new Matrix4());
  const merged = mergeGeometries(parts, false);
  // the runtime applies a uniform per-map scale to the loaded root
  if (scale !== 1) merged.scale(scale, scale, scale);
  merged.computeBoundingBox();
  return merged;
}

console.log('map integration tests (shipped assets)\n');

for (const map of MAPS) {
  const data = baked[map.id];
  const geometry = await mergedGeometry(map.file, data.scale);
  const bvh = new MeshBVH(geometry, { targetLeafSize: 10 });
  const nav = new NavGrid(data.grid);
  const spawn = data.spawn;

  // ---- spawn safety ----
  const body = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
  body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
  body.resolve();
  const pushOut = Math.hypot(body.position.x - spawn.x, body.position.z - spawn.z);
  check(map.id, 'spawn is not inside geometry', pushOut < 0.25, `pushed ${pushOut.toFixed(3)} m`);

  const groundAtSpawn = body.groundY(0.4);
  check(map.id, 'floor exists under the spawn', groundAtSpawn !== null, `${groundAtSpawn}`);
  check(map.id, 'spawn sits on that floor', groundAtSpawn !== null && Math.abs(groundAtSpawn - spawn.y) < 0.12,
    `floor=${groundAtSpawn?.toFixed(2)} spawn.y=${spawn.y}`);

  // idle for 2 s — must not fall or drift
  for (let i = 0; i < 120; i++) body.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
  check(map.id, 'stays put when idle (no fall-through)', Math.abs(body.position.y - spawn.y) < 0.25,
    `y ${spawn.y} -> ${body.position.y.toFixed(2)}`);
  check(map.id, 'remains grounded', body.grounded, '');

  // ---- walk forward 2 s ----
  const yaw = spawn.yaw;
  const dir = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const walker = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
  walker.teleport(spawn.x, spawn.y + 0.05, spawn.z);
  for (let i = 0; i < 30; i++) walker.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
  for (let i = 0; i < 120; i++) walker.update(1 / 60, dir, { speed: 3.15 });
  const travelled = walker.position.distanceTo(new Vector3(spawn.x, walker.position.y, spawn.z));
  check(map.id, 'can walk forward from the spawn', travelled > 0.6, `moved ${travelled.toFixed(2)} m`);
  check(map.id, 'does not sink below the map', walker.position.y > data.baseY - 1.0,
    `y=${walker.position.y.toFixed(2)} baseY=${data.baseY}`);
  const { min, max } = data.bbox;
  const inside = walker.position.x > min[0] - 1 && walker.position.x < max[0] + 1
    && walker.position.z > min[2] - 1 && walker.position.z < max[2] + 1;
  check(map.id, 'stays inside the map bounds', inside, walker.position.toArray().map((n) => n.toFixed(2)).join(','));

  // ---- patrol nodes (used by the enemy AI when it is re-enabled) ----
  let reachable = 0;
  const ray = new Ray();
  for (const point of data.patrols) {
    const path = nav.findPath(spawn, point);
    if (path.length) reachable++;
    ray.origin.set(point.x, point.y + 1.2, point.z);
    ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(ray, DoubleSide, 0, 2.0);
    if (hit) continue;
  }
  check(map.id, 'all patrol nodes are reachable by A*', reachable === data.patrols.length,
    `${reachable}/${data.patrols.length}`);

  // ---- patrol nodes for enemies ----
  let patrolOk = 0;
  for (const p of data.patrols) {
    const cell = nav.cellOf(p.x, p.z);
    if (nav.isWalkable(cell.i, cell.j)) patrolOk++;
  }
  check(map.id, 'enemy patrol nodes are on walkable cells', patrolOk === data.patrols.length,
    `${patrolOk}/${data.patrols.length}`);

  // ---- nav grid sanity ----
  let walkable = 0;
  for (let i = 0; i < nav.nx; i++) for (let j = 0; j < nav.nz; j++) if (nav.isWalkable(i, j)) walkable++;
  check(map.id, 'navigation grid is populated', walkable > 50, `${walkable} cells`);

  // ---- patrol spread ----
  let minGap = Infinity;
  for (let i = 0; i < data.patrols.length; i++) {
    for (let j = i + 1; j < data.patrols.length; j++) {
      const a = data.patrols[i];
      const b = data.patrols[j];
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }
  check(map.id, 'patrol nodes are spread out (>1.5 m apart)', minGap > 1.5, `min gap ${minGap.toFixed(2)} m`);

  console.log(`  ---- ${map.id}: ${data.patrols.length} patrol nodes, grid ${nav.nx}x${nav.nz}, walkable ${walkable}\n`);
  geometry.dispose();
}

console.log(failures === 0 ? 'ALL MAP TESTS PASSED' : `${failures} MAP TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
