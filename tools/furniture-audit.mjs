/**
 * Exact furniture-height audit. For every up-facing horizontal surface within
 * human reach of the walkable floor, reports an area-weighted histogram of the
 * height above the floor, so desk / seat / crate / kerb heights can be compared
 * with real-world ergonomics (desk 0.72-0.76 m, seat 0.42-0.46 m, kerb 0.12 m).
 *
 * Run: node --max-old-space-size=6144 tools/furniture-audit.mjs
 */
import { Vector3, Matrix4, Quaternion } from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import baked from '../src/maps/baked.json' with { type: 'json' };

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const MAPS = [
  ['city_street', 'public/maps/city_street.glb'],
  ['warehouse', 'public/maps/warehouse.glb'],
  ['subway', 'public/maps/subway.glb'],
  ['classroom', 'public/maps/classroom.glb'],
];

const a = new Vector3(), b = new Vector3(), c = new Vector3();
const ab = new Vector3(), ac = new Vector3(), n = new Vector3();

for (const [id, file] of MAPS) {
  const data = baked[id];
  const scale = data.scale;
  const baseY = data.baseY;
  const doc = await io.read(file);
  const hist = new Map();
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
        a.fromArray(arr, i0 * 3).applyMatrix4(world).multiplyScalar(scale);
        b.fromArray(arr, i1 * 3).applyMatrix4(world).multiplyScalar(scale);
        c.fromArray(arr, i2 * 3).applyMatrix4(world).multiplyScalar(scale);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const area = n.length() / 2;
        if (area < 1e-6) continue;
        n.normalize();
        if (n.y < 0.9) continue; // up-facing only
        const h = (a.y + b.y + c.y) / 3 - baseY;
        if (h < 0.05 || h > 1.30) continue; // human-reach surfaces only
        const key = Math.round(h * 20) / 20; // 5 cm buckets
        hist.set(key, (hist.get(key) || 0) + area);
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, new Matrix4());

  const total = [...hist.values()].reduce((x, y) => x + y, 0) || 1;
  const top = [...hist.entries()].sort((p, q) => q[1] - p[1]).slice(0, 10);
  console.log('='.repeat(72));
  console.log(`${id} (scale x${scale})  up-facing surface area within 1.3 m: ${total.toFixed(1)} m2`);
  for (const [h, area] of top) {
    console.log(`   height ${h.toFixed(2)} m : ${area.toFixed(2)} m2  (${((area / total) * 100).toFixed(1)}%)`);
  }
}
