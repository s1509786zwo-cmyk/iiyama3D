import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const check = (doc, label) => {
  const m = doc.getRoot().listMaterials().find(m => m.getName() === 'material_1');
  console.log(`${label}: material_1 baseColor=${m.getBaseColorFactor().map(n=>n.toFixed(2))} tex=${m.getBaseColorTexture() ? 'yes' : 'no'} materials=${doc.getRoot().listMaterials().length}`);
};
for (const [label, fn] of [
  ['none', async () => {}],
  ['dedup', (d) => d.transform(dedup())],
  ['prune', (d) => d.transform(prune())],
  ['reorder', (d) => d.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }))],
]) {
  const doc = await io.read('google_drive/abandoned_classroom.glb');
  await fn(doc);
  check(doc, label);
}
