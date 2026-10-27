// Analyze GLB: world-space bounding box, triangles, textures, and floor statistics.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Vector3, Quaternion, Box3 } from 'three';
import path from 'node:path';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function composeLocal(node) {
  const m = new Matrix4();
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const q = new Quaternion(r[0], r[1], r[2], r[3]);
  m.compose(new Vector3(t[0], t[1], t[2]), q, new Vector3(s[0], s[1], s[2]));
  return m;
}

for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const box = new Box3();
  let tris = 0, verts = 0, prims = 0;
  const meshBoxes = [];
  const v = new Vector3();
  const walk = (node, parentM, depth) => {
    const world = parentM.clone().multiply(composeLocal(node));
    if (node.getMesh()) {
      const mb = new Box3();
      for (const prim of node.getMesh().listPrimitives()) {
        prims++;
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const arr = pos.getArray();
        verts += pos.getCount();
        const idx = prim.getIndices();
        tris += idx ? idx.getCount() / 3 : pos.getCount() / 3;
        for (let i = 0; i < arr.length; i += 3) {
          v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(world);
          mb.expandByPoint(v); box.expandByPoint(v);
        }
      }
      meshBoxes.push({ name: node.getName(), box: mb, depth });
    }
    for (const c of node.listChildren()) walk(c, world, depth + 1);
  };
  const scene = root.listScenes()[0];
  for (const n of scene.listChildren()) walk(n, new Matrix4(), 0);

  const size = box.getSize(new Vector3());
  console.log('='.repeat(72));
  console.log(path.basename(file));
  console.log('  bbox min', box.min.toArray().map(n => +n.toFixed(2)).join(', '));
  console.log('  bbox max', box.max.toArray().map(n => +n.toFixed(2)).join(', '));
  console.log('  size (x,y,z) m:', size.toArray().map(n => +n.toFixed(2)).join(', '));
  console.log(`  triangles=${Math.round(tris)} vertices=${verts} primitives=${prims} nodes=${root.listNodes().length}`);
  console.log('  images:', root.listTextures().map(t => `${t.getMimeType()} ${t.getSize()? t.getSize().join('x'):'?'} ${(t.getImage()?.byteLength/1024).toFixed(0)}KB`).join(' | '));
  console.log('  materials:', root.listMaterials().map(m => m.getName()).join(', '));
  // sample floor heights: y-histogram of triangle area is skipped; show top-level mesh boxes
  meshBoxes.slice(0, 12).forEach(m => {
    const s = m.box.getSize(new Vector3());
    console.log(`    - ${m.name} size=${s.toArray().map(n=>n.toFixed(1)).join('/')} ymin=${m.box.min.y.toFixed(2)} ymax=${m.box.max.y.toFixed(2)}`);
  });
}
