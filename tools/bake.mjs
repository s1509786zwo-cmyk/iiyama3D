// Bake per-map navigation grid, spawn point, objective points from real geometry.
import { loadMerged } from './lib/geom.mjs';
import { MeshBVH } from 'three-mesh-bvh';
import { Ray, Vector3, DoubleSide, BackSide } from 'three';
import fs from 'node:fs';

/**
 * Unit calibration for the street map.
 *
 * Measured with tools/city-scale.mjs: the model tops out at 5.51 units and its
 * facade storeys are ~2.55 units apart. At 1 unit = 1 m that makes the tallest
 * building 5.5 m, i.e. a 1.75 m player is 38 % of the skyline — which reads as a
 * giant in a toy street (this is what the user reported).
 *
 * At 1.75 the skyline becomes ~9.6 m (three storeys), storeys 4.5 m and the
 * open street ~11 m wide, so a 1.75 m player is 18 % of the skyline — a normal
 * adult in a city street. Only this map is rescaled; the other three already
 * measure correctly (see tools/anthropometrics.mjs).
 */
const CITY_SCALE = process.env.CITY_SCALE ? Number(process.env.CITY_SCALE) : 1.75;
const MAPS = [
  { id: 'city_street', file: 'abandoned_city_street_for_games.glb', scale: CITY_SCALE },
  { id: 'warehouse', file: 'abandoned_warehouse_-_interior_scene.glb', scale: 1.0 },
  { id: 'subway', file: 'subway_train_interior.glb', scale: 0.01 },
  { id: 'classroom', file: 'abandoned_classroom.glb', scale: 0.0254 },
];

const OUT_FILES = {
  city_street: 'city_street.glb',
  warehouse: 'warehouse.glb',
  subway: 'subway.glb',
  classroom: 'classroom.glb',
};

const CELL = 0.35;
const PLAYER_R = 0.24;
const PLAYER_H = 1.75;
const STEP = 0.45;

const out = {};
for (const map of MAPS) {
  const src = fs.existsSync('google_drive/' + map.file) ? 'google_drive/' + map.file : 'public/maps/' + OUT_FILES[map.id];
  const geo = await loadMerged(src, map.scale);
  const bvh = new MeshBVH(geo, { maxLeafSize: 10 });
  const box = geo.boundingBox;
  const size = box.getSize(new Vector3());
  const nx = Math.max(1, Math.round(size.x / CELL));
  const nz = Math.max(1, Math.round(size.z / CELL));
  const ox = (box.min.x + box.max.x) / 2 - (nx * CELL) / 2;
  const oz = (box.min.z + box.max.z) / 2 - (nz * CELL) / 2;
  const top = box.max.y + 0.6;
  const downRay = new Ray(new Vector3(), new Vector3(0, -1, 0));
  const upRay = new Ray(new Vector3(), new Vector3(0, 1, 0));
  const tmp = {};
  let baseY = box.min.y;

  // find the base ground level: modal lowest up-facing surface sampled from below
  {
    const hist = new Map();
    const N = 48;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = box.min.x + (size.x * i) / N, z = box.min.z + (size.z * j) / N;
      upRay.origin.set(x, box.min.y - 1, z); upRay.direction.set(0, 1, 0);
      const h = bvh.raycastFirst(upRay, DoubleSide, 0, 1000);
      if (!h) continue;
      const key = Math.round(h.point.y * 10);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    let bestK = null, bestC = 0;
    for (const [k, c] of hist) if (c > bestC) { bestC = c; bestK = k; }
    baseY = bestK / 10;
  }
  const floorAt = (x, z) => {
    downRay.origin.set(x, baseY + 1.55, z); downRay.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(downRay, DoubleSide, 0, 1.9);
    if (!hit) return null;
    const y = hit.point.y;
    if (y > baseY + 1.2 || y < baseY - 0.4) return null;
    return y;
  };
  const clearAt = (x, y, z) => {
    for (const h of [0.9, 1.5]) {
      tmp.point = null;
      if (bvh.closestPointToPoint(new Vector3(x, y + h, z), tmp, 0, PLAYER_R - 0.01)) return false;
    }
    upRay.origin.set(x, y + 0.45, z); upRay.direction.set(0, 1, 0);
    if (bvh.raycastFirst(upRay, DoubleSide, 0, PLAYER_H - 0.35)) return false;
    return true;
  };

  // strict body clearance used for spawn / objective / patrol points
  const strictClear = (x, y, z) => {
    for (const h of [0.5, 1.0, 1.5]) {
      tmp.point = null;
      if (bvh.closestPointToPoint(new Vector3(x, y + h, z), tmp, 0, PLAYER_R + 0.03)) return false;
    }
    upRay.origin.set(x, y + 0.45, z); upRay.direction.set(0, 1, 0);
    if (bvh.raycastFirst(upRay, DoubleSide, 0, PLAYER_H - 0.35)) return false;
    return true;
  };

  const heights = new Float32Array(nx * nz).fill(NaN);
  const cellX = new Float32Array(nx * nz), cellZ = new Float32Array(nx * nz);
  const walk = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = ox + (i + 0.5) * CELL, z = oz + (j + 0.5) * CELL;
    const y = floorAt(x, z);
    if (y === null) continue;
    const k = j * nx + i;
    heights[k] = y; cellX[k] = x; cellZ[k] = z;
    if (clearAt(x, y, z)) walk[k] = 1;
  }
  // connectivity
  const comp = new Int32Array(nx * nz).fill(-1);
  const compSizes = [];
  for (let s = 0; s < nx * nz; s++) {
    if (!walk[s] || comp[s] >= 0) continue;
    const id = compSizes.length; compSizes.push(0);
    const q = [s]; comp[s] = id; let n = 0;
    while (q.length) {
      const cur = q.pop(); n++;
      const ci = cur % nx, cj = (cur - ci) / nx;
      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const k = nj * nx + ni;
        if (!walk[k] || comp[k] >= 0) continue;
        if (Math.abs(heights[k] - heights[cur]) > STEP) continue;
        comp[k] = id; q.push(k);
      }
    }
    compSizes[id] = n;
  }
  let bestComp = 0;
  compSizes.forEach((n, i) => { if (n > (compSizes[bestComp] || 0)) bestComp = i; });
  const members = [];
  for (let k = 0; k < nx * nz; k++) if (comp[k] === bestComp) members.push(k);

  // clearance BFS distance (in cells) inside the main component
  const dist = new Int32Array(nx * nz).fill(-1);
  const q = [];
  for (let k = 0; k < nx * nz; k++) if (comp[k] !== bestComp) { dist[k] = 0; q.push(k); }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++]; const ci = cur % nx, cj = (cur - ci) / nx;
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const k = nj * nx + ni;
      if (dist[k] !== -1) continue;
      dist[k] = dist[cur] + 1; q.push(k);
    }
  }

  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const strictCells = members.filter((k) => strictClear(cellX[k], heights[k], cellZ[k]));
  const levelCells = strictCells.filter((k) => Math.abs(heights[k] - baseY) < 0.18);
  const open = levelCells.filter((k) => dist[k] >= 2);
  const openPool = open.length > 8 ? open : levelCells.length ? levelCells : (strictCells.length ? strictCells : members);
  const pool = openPool;
  let spawnK = pool[0], spawnScore = -Infinity;
  for (const k of pool) {
    const score = Math.min(dist[k], 7) - 0.22 * Math.hypot(cellX[k] - cx, cellZ[k] - cz);
    if (score > spawnScore) { spawnScore = score; spawnK = k; }
  }

  // facing direction: most open horizontal direction from the spawn
  const flatRay = new Ray(new Vector3(), new Vector3(0, 0, -1));
  let bestDir = 0, bestLen = -1;
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    flatRay.origin.set(cellX[spawnK], heights[spawnK] + 1.2, cellZ[spawnK]);
    flatRay.direction.set(dx, 0, dz);
    const hit = bvh.raycastFirst(flatRay, DoubleSide, 0, 8);
    const len = hit ? hit.distance : 8;
    if (len > bestLen) { bestLen = len; bestDir = ang; }
  }
  // camera yaw such that forward = (-sin(yaw), 0, -cos(yaw))
  const yaw = Math.atan2(-Math.sin(bestDir), -Math.cos(bestDir));

  const farthest = (count, minDist, startK) => {
    const chosen = [];
    const cand = pool.slice();
    if (startK !== undefined) chosen.push(startK);
    while (chosen.length < count + (startK !== undefined ? 1 : 0)) {
      let best = null, bestD = -1;
      for (const k of cand) {
        if (chosen.includes(k)) continue;
        let d = Infinity;
        for (const c of chosen) d = Math.min(d, Math.hypot(cellX[k] - cellX[c], cellZ[k] - cellZ[c]));
        if (d > bestD) { bestD = d; best = k; }
      }
      if (best === null || bestD < minDist) break;
      chosen.push(best);
    }
    return startK !== undefined ? chosen.slice(1) : chosen;
  };

  const objectives = farthest(5, 2.5, spawnK).map((k) => ({ x: +cellX[k].toFixed(2), y: +heights[k].toFixed(2), z: +cellZ[k].toFixed(2) }));
  const patrols = farthest(8, 3.0, undefined).map((k) => ({ x: +cellX[k].toFixed(2), y: +heights[k].toFixed(2), z: +cellZ[k].toFixed(2) }));

  // serialize walkable grid as base64 bitmask + compact heights
  const bits = new Uint8Array(Math.ceil((nx * nz) / 8));
  for (let k = 0; k < nx * nz; k++) if (comp[k] === bestComp) bits[k >> 3] |= 1 << (k & 7);
  const hq = new Int16Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) hq[k] = Number.isFinite(heights[k]) ? Math.round(heights[k] * 100) : -32768;

  out[map.id] = {
    scale: map.scale,
    baseY: +baseY.toFixed(2),
    bbox: { min: box.min.toArray().map((n) => +n.toFixed(3)), max: box.max.toArray().map((n) => +n.toFixed(3)) },
    spawn: { x: +cellX[spawnK].toFixed(2), y: +heights[spawnK].toFixed(2), z: +cellZ[spawnK].toFixed(2), yaw: +yaw.toFixed(3), openDistance: +bestLen.toFixed(2) },
    objectives, patrols,
    grid: { cell: CELL, nx, nz, originX: +ox.toFixed(3), originZ: +oz.toFixed(3), walkable: Buffer.from(bits).toString('base64'), heights: Buffer.from(hq.buffer).toString('base64') },
  };
  console.log(`${map.id}: yaw=${yaw.toFixed(2)} open=${bestLen.toFixed(1)}m objectives=${objectives.map(o=>`(${o.x},${o.z})`).join(' ')}`);
  console.log(`${map.id}: baseY=${baseY.toFixed(2)} grid ${nx}x${nz} walkable=${members.length}/${nx * nz} (components ${compSizes.length}, largest ${members.length}) spawn=(${out[map.id].spawn.x}, ${out[map.id].spawn.y}, ${out[map.id].spawn.z}) objectives=${objectives.length} patrols=${patrols.length}`);
  geo.dispose();
}
fs.writeFileSync('tools/baked-maps.json', JSON.stringify(out));
console.log('wrote tools/baked-maps.json', (fs.statSync('tools/baked-maps.json').size / 1024).toFixed(0) + 'KB');
