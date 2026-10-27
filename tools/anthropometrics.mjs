/**
 * Anthropometric audit: measures, per map, at the currently applied uniform scale:
 *   - headroom above every walkable nav cell (ceiling height)
 *   - heights of horizontal surfaces that the player would read as tables/seats
 *   - wall-top / lintel heights around the walkable area
 * Used to verify that the player (1.75 m) is proportionate in every map.
 *
 * Run: node --max-old-space-size=6144 tools/anthropometrics.mjs
 */
import { Vector3, Ray, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { loadMerged } from './lib/geom.mjs';
import baked from '../src/maps/baked.json' with { type: 'json' };

const MAPS = [
  { id: 'city_street', file: 'public/maps/city_street.glb' },
  { id: 'warehouse', file: 'public/maps/warehouse.glb' },
  { id: 'subway', file: 'public/maps/subway.glb' },
  { id: 'classroom', file: 'public/maps/classroom.glb' },
];

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

const decode = (b64) => {
  const bin = Buffer.from(b64, 'base64');
  return { walk: bin };
};

function walkableCells(data) {
  const bits = Buffer.from(data.grid.walkable, 'base64');
  const raw = Buffer.from(data.grid.heights, 'base64');
  const heights = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const { nx, nz, cell, originX, originZ } = data.grid;
  const out = [];
  for (let k = 0; k < nx * nz; k++) {
    if ((bits[k >> 3] & (1 << (k & 7))) === 0) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    out.push({
      x: originX + (i + 0.5) * cell,
      z: originZ + (j + 0.5) * cell,
      y: heights[k] === -32768 ? null : heights[k] / 100,
    });
  }
  return out;
}

for (const map of MAPS) {
  const data = baked[map.id];
  const geo = await loadMerged(map.file, data.scale);
  const bvh = new MeshBVH(geo, { targetLeafSize: 10 });
  const cells = walkableCells(data).filter((c) => c.y !== null);

  const down = new Ray(new Vector3(), new Vector3(0, -1, 0));
  const up = new Ray(new Vector3(), new Vector3(0, 1, 0));
  const headrooms = [];
  const surfaces = [];

  for (const c of cells) {
    // real floor under the cell
    down.origin.set(c.x, c.y + 1.2, c.z);
    down.direction.set(0, -1, 0);
    const floorHit = bvh.raycastFirst(down, DoubleSide, 0, 1.6);
    const floorY = floorHit ? floorHit.point.y : c.y;

    up.origin.set(c.x, floorY + 0.02, c.z);
    up.direction.set(0, 1, 0);
    const ceil = bvh.raycastFirst(up, DoubleSide, 0, 30);
    if (ceil) headrooms.push(ceil.distance);

    // low horizontal surfaces nearby = tables / seats / ledges
    for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.8, 0.8], [-0.8, -0.8]]) {
      down.origin.set(c.x + dx, floorY + 1.1, c.z + dz);
      const hit = bvh.raycastFirst(down, DoubleSide, 0, 1.1);
      if (!hit) continue;
      const h = hit.point.y - floorY;
      if (h > 0.06 && h < 1.15) surfaces.push(h);
    }
  }

  const spawn = data.spawn;
  up.origin.set(spawn.x, spawn.y + 0.05, spawn.z);
  up.direction.set(0, 1, 0);
  const spawnCeil = bvh.raycastFirst(up, DoubleSide, 0, 30);
  const spawnHead = spawnCeil ? spawnCeil.distance : null;

  console.log('='.repeat(72));
  console.log(`${map.id}  (scale x${data.scale})  walkable cells=${cells.length}`);
  console.log(`  headroom  p10=${pct(headrooms, 10)?.toFixed(2)}  median=${pct(headrooms, 50)?.toFixed(2)}  p90=${pct(headrooms, 90)?.toFixed(2)} m   (n=${headrooms.length})`);
  console.log(`  headroom above spawn: ${spawnHead === null ? 'open sky / none' : spawnHead.toFixed(2) + ' m'}`);
  if (surfaces.length) {
    const bands = [[0.3, 0.55, 'seat / low ledge'], [0.6, 0.85, 'table / desk'], [0.85, 1.15, 'bar / high shelf']];
    for (const [lo, hi, label] of bands) {
      const n = surfaces.filter((h) => h >= lo && h < hi).length;
      console.log(`  ${label.padEnd(18)} ${lo}-${hi} m: ${n} hits (${((n / surfaces.length) * 100).toFixed(0)}%)`);
    }
  }
  geo.dispose();
}
