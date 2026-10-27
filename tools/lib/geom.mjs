// Headless GLB geometry extraction (no textures/DOM) -> merged world-space BufferGeometry.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BufferGeometry, BufferAttribute, Matrix4, Vector3, Quaternion } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

function localM(node) {
  const m = new Matrix4();
  m.compose(new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
  return m;
}

export async function loadMerged(file, scale = 1) {
  const doc = await io.read(file);
  const out = [];
  const walk = (node, parent) => {
    const world = parent.clone().multiply(localM(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos || prim.getMode() !== 4 /* TRIANGLES */) continue;
        const idx = prim.getIndices();
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array(pos.getArray()), 3));
        if (idx) g.setIndex(new BufferAttribute(new Uint32Array(idx.getArray()), 1));
        g.applyMatrix4(world);
        if (scale !== 1) g.scale(scale, scale, scale);
        out.push(g);
      }
    }
    for (const c of node.listChildren()) walk(c, world);
  };
  const scene = doc.getRoot().listScenes()[0];
  for (const n of scene.listChildren()) walk(n, new Matrix4());
  const merged = mergeGeometries(out, false);
  out.forEach((g) => g.dispose());
  if (!merged) throw new Error('no geometry: ' + file);
  merged.computeBoundingBox();
  return merged;
}
