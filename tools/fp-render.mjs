/**
 * Software first-person render (BVH raycast, flat shading) from each map's spawn,
 * at the exact runtime eye height, with a 1.75 m human silhouette drawn 2.5 m
 * ahead as a scale reference (red).
 *
 * Run: node --max-old-space-size=6144 tools/fp-render.mjs [eyeHeight] [fovDeg] [tag]
 * Output: tools/renders/<map>-<tag>.png
 */
import { Vector3, Ray, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { loadMerged } from './lib/geom.mjs';
import sharp from 'sharp';
import fs from 'node:fs';
import baked from '../src/maps/baked.json' with { type: 'json' };

const EYE = Number(process.argv[2] || 1.62);
const FOV = Number(process.argv[3] || 74); // vertical degrees, matches the game
const TAG = process.argv[4] || 'ref';
const W = 560;
const H = 315;
const REF_DIST = 2.6;      // metres in front of the eye
const REF_H = 1.75;        // player height
const REF_W = 0.46;        // shoulder width
const REF_D = 0.24;        // body depth

const MAPS = [
  ['city_street', 'public/maps/city_street.glb'],
  ['warehouse', 'public/maps/warehouse.glb'],
  ['subway', 'public/maps/subway.glb'],
  ['classroom', 'public/maps/classroom.glb'],
];

fs.mkdirSync('tools/renders', { recursive: true });

/** ray vs axis-aligned box (slab method); returns entry distance or null */
function rayBox(origin, dir, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    let t1 = (min[axis] - o) / d;
    let t2 = (max[axis] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

for (const [id, file] of MAPS) {
  const data = baked[id];
  const geo = await loadMerged(file, data.scale);
  const bvh = new MeshBVH(geo, { targetLeafSize: 10 });
  const spawn = data.spawn;
  const eye = new Vector3(spawn.x, spawn.y + EYE, spawn.z);
  const yaw = spawn.yaw;
  const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const up = new Vector3(0, 1, 0);
  const tanHalf = Math.tan((FOV * Math.PI) / 360);
  const out = Buffer.alloc(W * H * 3);
  const ray = new Ray(new Vector3(), new Vector3());
  const dir = new Vector3();

  // reference silhouette: standing on the same floor, REF_DIST ahead
  const refCenter = eye.clone().addScaledVector(forward, REF_DIST);
  const refMin = {
    x: refCenter.x - REF_W / 2,
    y: spawn.y,
    z: refCenter.z - REF_D / 2,
  };
  const refMax = { x: refCenter.x + REF_W / 2, y: spawn.y + REF_H, z: refCenter.z + REF_D / 2 };
  // orient the box with the camera's yaw by testing in camera-local space instead
  const toLocal = (p) => {
    const v = p.clone().sub(eye);
    return { x: v.dot(right), y: v.y, z: -v.dot(forward) };
  };

  const lightDir = new Vector3(0.4, 0.8, 0.35).normalize();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ndcX = ((x + 0.5) / W) * 2 - 1;
      const ndcY = 1 - ((y + 0.5) / H) * 2;
      dir.copy(forward)
        .addScaledVector(right, ndcX * tanHalf * (W / H))
        .addScaledVector(up, ndcY * tanHalf)
        .normalize();
      ray.origin.copy(eye);
      ray.direction.copy(dir);

      // human reference in camera-local coordinates (box faces the camera)
      const localO = { x: 0, y: 0, z: 0 };
      const localD = { x: dir.dot(right), y: dir.y, z: dir.dot(forward) };
      const localMin = { x: -REF_W / 2, y: spawn.y - eye.y, z: REF_DIST - REF_D / 2 };
      const localMax = { x: REF_W / 2, y: spawn.y + REF_H - eye.y, z: REF_DIST + REF_D / 2 };
      const refT = rayBox(localO, localD, localMin, localMax);

      const hit = bvh.raycastFirst(ray, DoubleSide, 0.02, 120);
      let r; let g; let b;
      if (refT !== null && (!hit || refT < hit.distance)) {
        r = 226; g = 92; b = 76; // human reference
      } else if (!hit) {
        r = 16; g = 22; b = 28;
      } else {
        const normal = hit.face?.normal ?? up;
        const shade = Math.max(0.12, Math.abs(normal.dot(lightDir)));
        const fog = Math.min(1, Math.max(0, (hit.distance - 3) / 30));
        const base = shade * (1 - fog * 0.85) * 235 + 14;
        r = Math.min(255, base * 0.96);
        g = Math.min(255, base * 0.98);
        b = Math.min(255, base);
      }
      const i = (y * W + x) * 3;
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
  }

  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  fs.writeFileSync(`tools/renders/${id}-${TAG}.png`, png);

  // quantitative: how high is the ceiling relative to the 1.75 m reference?
  const upRay = new Ray(new Vector3(refCenter.x, spawn.y + 0.05, refCenter.z), up);
  const ceil = bvh.raycastFirst(upRay, DoubleSide, 0, 40);
  const fwd = new Ray(new Vector3(spawn.x, spawn.y + EYE, spawn.z), forward);
  const ahead = bvh.raycastFirst(fwd, DoubleSide, 0, 60);
  console.log(`${id}: fov=${FOV} eye=${EYE}  headroom@ref=${ceil ? (ceil.distance).toFixed(2) + ' m' : 'open sky'}  obstruction ahead=${ahead ? ahead.distance.toFixed(2) + ' m' : '>60 m'}`);
  geo.dispose();
}
