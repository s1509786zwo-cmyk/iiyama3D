import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const dump = (doc, label) => {
  for (const m of doc.getRoot().listMaterials()) {
    const bc = m.getBaseColorTexture();
    if (!m.getName().includes('material_1') && !m.getName().includes('edge')) continue;
    console.log(`${label}  ${m.getName()}  baseColor=${m.getBaseColorFactor().map(n=>n.toFixed(2))} tex=${bc ? bc.getImage().byteLength + 'B ' + bc.getMimeType() : 'none'} metallic=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()} alpha=${m.getAlphaMode()}`);
  }
  const root = doc.getRoot();
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    if (m && (m.getName().includes('material_1') || m.getName().includes('edge'))) {
      const idx = root.listMeshes().indexOf(mesh);
      console.log(`   prim in mesh#${idx} (${mesh.getName()}) mat=${m.getName()} verts=${p.getAttribute('POSITION')?.getCount()}`);
    }
  }
};
dump(await io.read('google_drive/abandoned_classroom.glb'), 'ORIG');
console.log('---');
dump(await io.read('public/maps/classroom.glb'), 'NEW ');
