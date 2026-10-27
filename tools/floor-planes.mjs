// Detect floor/ceiling planes and vertical structure to derive real-world scale.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Vector3, Quaternion } from 'three';
import path from 'node:path';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function localM(node) {
  const m = new Matrix4();
  m.compose(new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
  return m;
}

for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const up = new Map(), down = new Map(), wallH = new Map();
  const add = (map, key, area) => map.set(key, (map.get(key) || 0) + area);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3(), n = new Vector3();
  const walk = (node, parent) => {
    const world = parent.clone().multiply(localM(node));
    if (node.getMesh()) for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); const idx = prim.getIndices();
      if (!pos) continue;
      const arr = pos.getArray(); const ind = idx ? idx.getArray() : null;
      const count = ind ? ind.length : pos.getCount();
      for (let i = 0; i < count; i += 3) {
        const i0 = ind ? ind[i] : i, i1 = ind ? ind[i + 1] : i + 1, i2 = ind ? ind[i + 2] : i + 2;
        a.fromArray(arr, i0 * 3).applyMatrix4(world);
        b.fromArray(arr, i1 * 3).applyMatrix4(world);
        c.fromArray(arr, i2 * 3).applyMatrix4(world);
        ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
        const area = n.length() / 2; if (area < 1e-9) continue;
        n.normalize();
        const ny = n.y;
        if (Math.abs(ny) > 0.95) {
          const y = (a.y + b.y + c.y) / 3;
          add(ny > 0 ? up : down, Math.round(y * 20) / 20, area);
        } else if (Math.abs(ny) < 0.3) {
          // vertical surface: bucket by top height to find wall tops / door headers
          add(wallH, Math.round((Math.max(a.y, b.y, c.y)) * 10) / 10, area);
        }
      }
    }
    for (const ch of node.listChildren()) walk(ch, world);
  };
  const scene = root.listScenes()[0];
  for (const n of scene.listChildren()) walk(n, new Matrix4());
  const top = (m, k = 12) => [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, k).map(([y, ar]) => `${y}:${ar.toFixed(0)}`);
  console.log('='.repeat(72));
  console.log(path.basename(file));
  console.log('  UP-facing planes   (y:area)', top(up).join('  '));
  console.log('  DOWN-facing planes (y:area)', top(down).join('  '));
  console.log('  vertical surf tops (y:area)', top(wallH, 10).join('  '));
}
