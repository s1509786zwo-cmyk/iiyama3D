/**
 * Detailed scale audit for the street map: measures the geometry that gives a
 * human the strongest size cues and reports them for several candidate scales
 * so the map's unit factor can be chosen from data instead of guesswork.
 *
 * Cues measured (all converted to metres with the candidate scale):
 *   - street width between facades
 *   - vertical facade openings (doors / windows): width, height, sill height
 *   - step risers
 *   - storey spacing on the facades
 *
 * Run: node --max-old-space-size=6144 tools/city-scale.mjs
 */
import { Vector3, Matrix4, Quaternion, Ray, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read('public/maps/city_street.glb');

const a = new Vector3(), b = new Vector3(), c = new Vector3();
const ab = new Vector3(), ac = new Vector3(), n = new Vector3();
const tris = []; // {cx,cy,cz, area, nx,ny,nz}

const walk = (node, parent) => {
  const m = new Matrix4().compose(
    new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
  const world = parent.clone().multiply(m);
  const mesh = node.getMesh();
  if (mesh) for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    if (!pos) continue;
    const arr = pos.getArray();
    const ind = idx ? idx.getArray() : null;
    const count = ind ? ind.length : pos.getCount();
    for (let i = 0; i < count; i += 3) {
      const i0 = ind ? ind[i] : i;
      const i1 = ind ? ind[i + 1] : i + 1;
      const i2 = ind ? ind[i + 2] : i + 2;
      a.fromArray(arr, i0 * 3).applyMatrix4(world);
      b.fromArray(arr, i1 * 3).applyMatrix4(world);
      c.fromArray(arr, i2 * 3).applyMatrix4(world);
      ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
      const area = n.length() / 2;
      if (area < 1e-7) continue;
      n.normalize();
      tris.push({
        cx: (a.x + b.x + c.x) / 3, cy: (a.y + b.y + c.y) / 3, cz: (a.z + b.z + c.z) / 3,
        area, nx: n.x, ny: n.y, nz: n.z, minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y),
      });
    }
  }
  for (const child of node.listChildren()) walk(child, world);
};
for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, new Matrix4());

const baseY = -0.10;
const bboxY = { min: Infinity, max: -Infinity };
for (const t of tris) { bboxY.min = Math.min(bboxY.min, t.minY); bboxY.max = Math.max(bboxY.max, t.maxY); }

// ---- street width: horizontal distance across the walkable corridor at y=0.9 ----
const bvh = await (async () => {
  const { MeshBVH: B } = await import('three-mesh-bvh');
  const { BufferGeometry, BufferAttribute } = await import('three');
  const g = new BufferGeometry();
  const positions = [];
  const walk2 = (node, parent) => {
    const m = new Matrix4().compose(
      new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
    const world = parent.clone().multiply(m);
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      const arr = pos.getArray();
      const ind = idx ? idx.getArray() : null;
      const cnt = ind ? ind.length : pos.getCount();
      for (let i = 0; i < cnt; i++) {
        const id = ind ? ind[i] : i;
        const v = new Vector3(arr[id * 3], arr[id * 3 + 1], arr[id * 3 + 2]).applyMatrix4(world);
        positions.push(v.x, v.y, v.z);
      }
    }
    for (const child of node.listChildren()) walk2(child, world);
  };
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk2(node, new Matrix4());
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.computeBoundingBox();
  return new B(g);
})();

const ray = new Ray(new Vector3(), new Vector3());
const widths = [];
for (let z = -16; z <= 9; z += 0.5) {
  const hits = [];
  for (const dir of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0)]) {
    ray.origin.set(0, baseY + 0.9, z);
    ray.direction.copy(dir);
    const h = bvh.raycastFirst(ray, DoubleSide, 0, 40);
    if (h) hits.push(h.distance);
  }
  if (hits.length === 2) widths.push(hits[0] + hits[1]);
}
widths.sort((p, q) => p - q);
const streetWidth = widths.length ? widths[Math.floor(widths.length / 2)] : null;

// ---- vertical facade openings: cluster near-vertical quads by plane ----
const verticals = tris.filter((t) => Math.abs(t.ny) < 0.25 && t.area > 0.02);
const openingHeights = [];
for (const t of verticals) {
  const h = t.maxY - t.minY;
  const sill = t.minY - baseY;
  if (h > 0.4 && h < 6 && sill < 4) openingHeights.push({ h, sill, area: t.area });
}
openingHeights.sort((p, q) => p.h - q.h);

// ---- step risers: up-facing quads with small height above a lower surface ----
const ups = tris.filter((t) => t.ny > 0.9 && t.area > 0.01);
const stepHeights = ups
  .map((t) => t.cy - baseY)
  .filter((h) => h > 0.05 && h < 1.2)
  .sort((p, q) => p - q);

// ---- storey spacing: distinct facade top heights ----
const facadeTops = [...new Set(tris.filter((t) => Math.abs(t.ny) < 0.25).map((t) => Math.round((t.maxY - baseY) * 10) / 10))]
  .filter((h) => h > 0.6)
  .sort((p, q) => p - q);

const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);

console.log('city_street raw measurements (model units)');
console.log(`  model bbox height            : ${(bboxY.max - bboxY.min).toFixed(2)} units above floor`);
console.log(`  street width (median)        : ${streetWidth?.toFixed(2)} units`);
console.log(`  vertical quad heights        : p10=${q(openingHeights.map((o) => o.h), 10)?.toFixed(2)}  median=${q(openingHeights.map((o) => o.h), 50)?.toFixed(2)}  p90=${q(openingHeights.map((o) => o.h), 90)?.toFixed(2)}`);
console.log(`  vertical quad sill heights   : p10=${q(openingHeights.map((o) => o.sill), 10)?.toFixed(2)}  median=${q(openingHeights.map((o) => o.sill), 50)?.toFixed(2)}`);
console.log(`  up-facing heights (steps)    : p10=${q(stepHeights, 10)?.toFixed(2)}  median=${q(stepHeights, 50)?.toFixed(2)}  p90=${q(stepHeights, 90)?.toFixed(2)}`);
console.log(`  facade top heights           : ${facadeTops.slice(0, 12).join(', ')}`);
console.log('');

// ---- what each candidate scale implies in metres ----
console.log('candidate scale  street  storey  door-ish quad  step riser  eye/building  verdict');
for (const scale of [1.0, 1.2, 1.4, 1.6, 1.8, 2.0]) {
  const sw = streetWidth * scale;
  const storey = 2.55 * scale;
  const quad = q(openingHeights.map((o) => o.h), 50) * scale;
  const riser = q(stepHeights, 50) * scale;
  const tallest = (bboxY.max - baseY) * scale;
  const eyeRatio = 1.62 / tallest;
  const verdict = sw < 4 ? 'narrow' : sw > 14 ? 'wide' : 'ok';
  console.log(`  x${scale.toFixed(1)}            ${sw.toFixed(1)}m   ${storey.toFixed(1)}m   ${quad.toFixed(2)}m       ${riser.toFixed(2)}m      ${(eyeRatio * 100).toFixed(0)}%        ${verdict}`);
}
