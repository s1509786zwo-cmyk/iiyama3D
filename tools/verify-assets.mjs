// Rigorous comparison of original vs optimized assets:
//  - world-space triangle multiset hash (shape preservation)
//  - texture multiset (dimensions + decoded pixel hash)
//  - material list + pbr factors
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { Matrix4, Vector3, Quaternion } from 'three';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const PAIRS = [
  ['city_street', 'google_drive/abandoned_city_street_for_games.glb', 'public/maps/city_street.glb'],
  ['warehouse', 'google_drive/abandoned_warehouse_-_interior_scene.glb', 'public/maps/warehouse.glb'],
  ['subway', 'google_drive/subway_train_interior.glb', 'public/maps/subway.glb'],
  ['classroom', 'google_drive/abandoned_classroom.glb', 'public/maps/classroom.glb'],
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 20);

function worldTriangles(doc) {
  const tris = [];
  const v = new Vector3();
  const walk = (node, parent) => {
    const m = new Matrix4().compose(
      new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
    const world = parent.clone().multiply(m);
    if (node.getMesh()) for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const arr = pos.getArray(); const idx = prim.getIndices(); const ind = idx ? idx.getArray() : null;
      const n = ind ? ind.length : pos.getCount();
      for (let i = 0; i < n; i += 3) {
        const ids = ind ? [ind[i], ind[i+1], ind[i+2]] : [i, i+1, i+2];
        const f = [];
        for (const id of ids) { v.set(arr[id*3], arr[id*3+1], arr[id*3+2]).applyMatrix4(world); f.push(v.x, v.y, v.z); }
        // canonical: sort the three vertices to be winding-agnostic, then quantize to 1e-4
        const verts = [f.slice(0,3), f.slice(3,6), f.slice(6,9)].map(a => a.map(x => Math.round(x * 1e4) / 1e4));
        verts.sort((a, b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
        tris.push(verts.flat().join(','));
      }
    }
    for (const c of node.listChildren()) walk(c, world);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n, new Matrix4());
  tris.sort();
  return { count: tris.length, hash: sha(Buffer.from(tris.join(';'))) };
}

async function textures(doc) {
  const out = [];
  for (const t of doc.getRoot().listTextures()) {
    const { data, info } = await sharp(Buffer.from(t.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    out.push({ key: `${info.width}x${info.height}:${sha(data)}`, w: info.width, h: info.height, bytes: t.getImage().byteLength, mime: t.getMimeType() });
  }
  return out;
}

for (const [id, a, b] of PAIRS) {
  const docA = await io.read(a), docB = await io.read(b);
  const gA = worldTriangles(docA), gB = worldTriangles(docB);
  const tA = await textures(docA), tB = await textures(docB);
  const setA = new Map(); tA.forEach(t => setA.set(t.key, (setA.get(t.key) || 0) + 1));
  const setB = new Map(); tB.forEach(t => setB.set(t.key, (setB.get(t.key) || 0) + 1));
  const onlyA = [...setA.keys()].filter(k => !setB.has(k));
  const onlyB = [...setB.keys()].filter(k => !setA.has(k));
  const mA = docA.getRoot().listMaterials().map(m => `${m.getName()}:${m.getBaseColorFactor().map(n=>n.toFixed(3))}`).sort();
  const mB = docB.getRoot().listMaterials().map(m => `${m.getName()}:${m.getBaseColorFactor().map(n=>n.toFixed(3))}`).sort();
  console.log('='.repeat(70));
  console.log(id);
  console.log(`  triangles: ${gA.count} -> ${gB.count}  shapeIdentical=${gA.hash === gB.hash}`);
  console.log(`  textures: ${tA.length} -> ${tB.length}  onlyOriginal=${onlyA.length} onlyOptimized=${onlyB.length}`);
  if (onlyA.length) console.log('    removed textures:', onlyA.map(k => { const t = tA.find(x => x.key === k); return `${t.w}x${t.h}/${t.mime}/${(t.bytes/1024).toFixed(0)}KB`; }).join(', '));
  if (onlyB.length) console.log('    new textures  :', onlyB.map(k => { const t = tB.find(x => x.key === k); return `${t.w}x${t.h}/${t.mime}/${(t.bytes/1024).toFixed(0)}KB`; }).join(', '));
  console.log(`  materials: ${mA.length} -> ${mB.length}  namesAndColorsIdentical=${JSON.stringify(mA) === JSON.stringify(mB)}`);
  const extA = docA.getRoot().listExtensionsUsed().map(e => e.extensionName).sort();
  const extB = docB.getRoot().listExtensionsUsed().map(e => e.extensionName).sort();
  console.log(`  extensions: [${extA}] -> [${extB}]`);
}
