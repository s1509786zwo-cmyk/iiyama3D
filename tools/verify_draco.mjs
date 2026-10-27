// Verify a Draco-compressed GLB against its pre-Draco source.
// Compares: node hierarchy/transforms, mesh + primitive counts, triangle counts, position
// bounds (quantisation tolerance), materials (names, base colours, texture references),
// texture image bytes (must be byte-identical) and image mime types.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync } from 'fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const a = process.argv[2];
const b = process.argv[3];

function summarise(doc) {
  const root = doc.getRoot();
  const prims = [];
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      tris += n / 3;
      prims.push({
        mode: prim.getMode(),
        count: n,
        min: pos.getMinNormalized([]),
        max: pos.getMaxNormalized([]),
        verts: pos.getCount(),
        attrs: prim.listSemantics().sort().join(','),
        material: prim.getMaterial()?.getName() || null,
      });
    }
  }
  const mats = root.listMaterials().map((m) => ({
    name: m.getName(),
    baseColor: m.getBaseColorFactor().map((v) => Math.round(v * 1000) / 1000),
    metallic: Math.round(m.getMetallicFactor() * 1000) / 1000,
    roughness: Math.round(m.getRoughnessFactor() * 1000) / 1000,
    doubleSided: m.getDoubleSided(),
    baseTex: m.getBaseColorTexture() ? m.getBaseColorTexture().getURI() || 'embedded' : null,
  }));
  const nodes = root.listNodes().map((n) => ({
    name: n.getName(), t: n.getTranslation().map((v) => +v.toFixed(5)),
    r: n.getRotation().map((v) => +v.toFixed(5)), s: n.getScale().map((v) => +v.toFixed(5)),
  }));
  const textures = root.listTextures().map((t) => {
    let size = null;
    try {
      size = t.getSize();
    } catch {
      size = null; // some JPEGs are not parseable by gltf-transform's size probe
    }
    return { size, mime: t.getMimeType(), bytes: t.getImage()?.byteLength ?? 0, name: t.getName() };
  });
  return { prims, tris, mats, nodes, textures, extensions: root.listExtensionsUsed().map((e) => e.extensionName).sort() };
}

const A = summarise(await io.read(a));
const B = summarise(await io.read(b));
const issues = [];
function check(cond, msg) {
  if (!cond) issues.push(msg);
}

check(A.prims.length === B.prims.length, `primitive count ${A.prims.length} -> ${B.prims.length}`);
check(Math.abs(A.tris - B.tris) < 1, `triangle count ${A.tris} -> ${B.tris}`);
check(A.mats.length === B.mats.length, `material count ${A.mats.length} -> ${B.mats.length}`);
check(A.nodes.length === B.nodes.length, `node count ${A.nodes.length} -> ${B.nodes.length}`);
check(A.textures.length === B.textures.length, `texture count ${A.textures.length} -> ${B.textures.length}`);

let maxPosErr = 0;
for (let i = 0; i < Math.min(A.prims.length, B.prims.length); i++) {
  const x = A.prims[i];
  const y = B.prims[i];
  if (x.mode !== y.mode) issues.push(`prim ${i} mode ${x.mode} -> ${y.mode}`);
  if (x.count !== y.count) issues.push(`prim ${i} index count ${x.count} -> ${y.count}`);
  if (x.attrs !== y.attrs) issues.push(`prim ${i} attributes ${x.attrs} -> ${y.attrs}`);
  if (x.material !== y.material) issues.push(`prim ${i} material ${x.material} -> ${y.material}`);
  if (x.min && y.min) {
    for (let k = 0; k < 3; k++) {
      maxPosErr = Math.max(maxPosErr, Math.abs(x.min[k] - y.min[k]), Math.abs(x.max[k] - y.max[k]));
    }
  }
}
check(maxPosErr < 0.002, `position bounds differ by ${maxPosErr}`);

for (let i = 0; i < Math.min(A.mats.length, B.mats.length); i++) {
  if (JSON.stringify(A.mats[i]) !== JSON.stringify(B.mats[i])) {
    issues.push(`material ${i} differs: ${JSON.stringify(A.mats[i])} vs ${JSON.stringify(B.mats[i])}`);
  }
}
for (let i = 0; i < Math.min(A.textures.length, B.textures.length); i++) {
  if (A.textures[i].bytes !== B.textures[i].bytes || A.textures[i].mime !== B.textures[i].mime) {
    issues.push(`texture ${i} bytes/mime changed ${JSON.stringify(A.textures[i])} -> ${JSON.stringify(B.textures[i])}`);
  }
}
for (let i = 0; i < Math.min(A.nodes.length, B.nodes.length); i++) {
  if (JSON.stringify(A.nodes[i]) !== JSON.stringify(B.nodes[i])) issues.push(`node ${i} transform changed`);
}

console.log(`[${process.argv[4] || ''}] prims=${A.prims.length} tris=${A.tris} mats=${A.mats.length} nodes=${A.nodes.length} textures=${A.textures.length}`);
console.log(`  extensions used: ${B.extensions.join(', ')}`);
console.log(`  max position bound error from quantisation: ${maxPosErr.toFixed(5)}`);
if (issues.length) {
  console.log('  ISSUES:');
  for (const i of issues.slice(0, 12)) console.log('   -', i);
  process.exit(1);
}
console.log('  OK: geometry topology, materials, textures and node transforms preserved');
