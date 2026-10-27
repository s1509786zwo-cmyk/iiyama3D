/**
 * Material-level measurement: bounding boxes (in metres, at the applied scale)
 * of semantically named parts (doors, windows, chairs, lamps) so the unit system
 * of every model can be confirmed against real-world sizes:
 *   door 1.9-2.2 m tall, window sill 0.8-1.0 m, roll-up door 2.4-3.2 m.
 *
 * Run: node --max-old-space-size=6144 tools/part-audit.mjs
 */
import { Vector3, Matrix4, Quaternion, Box3 } from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import baked from '../src/maps/baked.json' with { type: 'json' };

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const MAPS = [
  ['warehouse', 'public/maps/warehouse.glb', /door|fenetre|window|chaise|lampe|palette|poutre|colonne/i],
  ['subway', 'public/maps/subway.glb', /door|bench|seat|bar|roof|window|glass/i],
  ['classroom', 'public/maps/classroom.glb', /door|window|desk|chair|board/i],
  ['city_street', 'public/maps/city_street.glb', /door|window|car|sign/i],
];

const v = new Vector3();

for (const [id, file, pattern] of MAPS) {
  const data = baked[id];
  const scale = data.scale;
  const baseY = data.baseY;
  const doc = await io.read(file);
  const groups = new Map();

  const walk = (node, parent, path) => {
    const m = new Matrix4().compose(
      new Vector3(...node.getTranslation()),
      new Quaternion(...node.getRotation()),
      new Vector3(...node.getScale()));
    const world = parent.clone().multiply(m);
    const label = node.getName() || '';
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const material = prim.getMaterial()?.getName() || '';
        const key = label || material;
        if (!pattern.test(key) && !pattern.test(material)) continue;
        const box = groups.get(key) || new Box3();
        const arr = pos.getArray();
        for (let i = 0; i < arr.length; i += 3) {
          v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(world).multiplyScalar(scale);
          box.expandByPoint(v);
        }
        groups.set(key, box);
      }
    }
    for (const child of node.listChildren()) walk(child, world, path);
  };
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, new Matrix4(), '');

  console.log('='.repeat(72));
  console.log(`${id} (scale x${scale}, floor y=${baseY})`);
  const rows = [...groups.entries()].map(([name, box]) => {
    const size = box.getSize(new Vector3());
    return { name, w: size.x, h: size.y, d: size.z, bottom: box.min.y - baseY, top: box.max.y - baseY };
  }).sort((a, b) => b.h * b.w - a.h * a.w);
  for (const r of rows.slice(0, 14)) {
    console.log(`  ${r.name.slice(0, 46).padEnd(46)} h=${r.h.toFixed(2)}m w=${r.w.toFixed(2)} d=${r.d.toFixed(2)}  bottom=${r.bottom.toFixed(2)} top=${r.top.toFixed(2)}`);
  }
  if (!rows.length) console.log('  (no semantically named parts)');
}
