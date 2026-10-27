import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const PAIRS = [
  ['warehouse','google_drive/abandoned_warehouse_-_interior_scene.glb','public/maps/warehouse.glb'],
  ['classroom','google_drive/abandoned_classroom.glb','public/maps/classroom.glb'],
];
const usedMaterials = (doc) => {
  const set = new Map();
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    const key = m ? `${m.getName()}|${m.getBaseColorFactor().map(n=>n.toFixed(3))}|${m.getMetallicFactor().toFixed(2)}|${m.getRoughnessFactor().toFixed(2)}|tex:${!!m.getBaseColorTexture()}` : 'NONE';
    set.set(key, (set.get(key) || 0) + 1);
  }
  return set;
};
for (const [id, a, b] of PAIRS) {
  const A = usedMaterials(await io.read(a)), B = usedMaterials(await io.read(b));
  console.log('='.repeat(70)); console.log(id);
  const all = new Set([...A.keys(), ...B.keys()]);
  const diffs = [...all].filter(k => (A.get(k)||0) !== (B.get(k)||0));
  console.log('  distinct used-material signatures:', A.size, '->', B.size, ' differing:', diffs.length);
  for (const k of diffs.slice(0, 8)) console.log(`   "${k}"  origPrims=${A.get(k)||0} newPrims=${B.get(k)||0}`);
  // primitives without material
  const noMatA = [...A.keys()].filter(k=>k==='NONE'); const noMatB=[...B.keys()].filter(k=>k==='NONE');
  console.log('  prims without material:', (A.get('NONE')||0), '->', (B.get('NONE')||0));
  const primsA = [...A.values()].reduce((x,y)=>x+y,0), primsB=[...B.values()].reduce((x,y)=>x+y,0);
  console.log('  primitives:', primsA, '->', primsB);
}
