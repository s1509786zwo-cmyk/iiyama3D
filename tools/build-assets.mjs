// Build runtime map assets: lossless texture re-encode (WebP, pixel-identical) +
// lossless meshopt geometry compression. No polygon reduction, no resolution change.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, reorder, metalRough } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import crypto from 'node:crypto';

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const MAPS = [
  { id: 'city_street', file: 'abandoned_city_street_for_games.glb', out: 'city_street.glb', metalRough: false },
  { id: 'warehouse', file: 'abandoned_warehouse_-_interior_scene.glb', out: 'warehouse.glb', metalRough: true },
  { id: 'subway', file: 'subway_train_interior.glb', out: 'subway.glb', metalRough: false },
  { id: 'classroom', file: 'abandoned_classroom.glb', out: 'classroom.glb', metalRough: false },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// ---- helpers: exact geometry fingerprint (order-insensitive) ----
function geometryFingerprint(doc) {
  const parts = [];
  const walk = (node, parent) => {
    // local matrix
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
    const key = [t.map(n=>n.toFixed(6)), r.map(n=>n.toFixed(6)), s.map(n=>n.toFixed(6))].join('|');
    if (node.getMesh()) {
      for (const prim of node.getMesh().listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const arr = pos.getArray();
        const sorted = Array.from(arr).sort((a, b) => a - b);
        parts.push(`${key}#${pos.getCount()}#${prim.getIndices()?.getCount() ?? -1}#${sha(Buffer.from(new Float64Array(sorted).buffer))}`);
      }
    }
    for (const c of node.listChildren()) walk(c, node);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n, null);
  return parts.sort();
}

async function textureFingerprint(doc) {
  const out = [];
  for (const tex of doc.getRoot().listTextures()) {
    const buf = Buffer.from(tex.getImage());
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    out.push(`${info.width}x${info.height}:${sha(data)}`);
  }
  return out.sort();
}

// ---- patch JSON chunk: declare EXT_texture_webp for webp-backed textures ----
function patchWebp(glbBuffer) {
  const magic = glbBuffer.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a glb');
  const jsonLen = glbBuffer.readUInt32LE(12);
  const jsonStr = glbBuffer.subarray(20, 20 + jsonLen).toString('utf8');
  const json = JSON.parse(jsonStr);
  const rest = glbBuffer.subarray(20 + jsonLen); // remaining chunks, untouched
  const webpImages = new Set();
  (json.images || []).forEach((img, i) => { if (img.mimeType === 'image/webp') webpImages.add(i); });
  let patched = 0;
  for (const tex of json.textures || []) {
    if (tex.source !== undefined && webpImages.has(tex.source)) {
      // texture.source is optional in glTF 2.0 — the webp source lives in the
      // extension, so drop the invalid webp fallback from `source`.
      tex.extensions = { ...(tex.extensions || {}), EXT_texture_webp: { source: tex.source } };
      delete tex.source;
      patched++;
    }
  }
  if (patched) {
    json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []), 'EXT_texture_webp']));
    json.extensionsRequired = Array.from(new Set([...(json.extensionsRequired || []), 'EXT_texture_webp']));
  }
  // The meshopt writer stores NORMAL as normalized BYTE (octahedral filter),
  // which is only valid glTF when KHR_mesh_quantization is declared.
  const quantized = (json.meshes || []).some((mesh) => (mesh.primitives || []).some((prim) => {
    const attrs = prim.attributes || {};
    return Object.values(attrs).some((idx) => {
      const acc = json.accessors[idx];
      return acc && acc.normalized === true;
    });
  }));
  if (quantized) {
    json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []), 'KHR_mesh_quantization']));
    json.extensionsRequired = Array.from(new Set([...(json.extensionsRequired || []), 'KHR_mesh_quantization']));
  }
  let newJson = Buffer.from(JSON.stringify(json), 'utf8');
  while (newJson.length % 4 !== 0) newJson = Buffer.concat([newJson, Buffer.from(' ')]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + newJson.length + rest.length, 8);
  head.writeUInt32LE(newJson.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return { buffer: Buffer.concat([head, newJson, rest]), patchedTextures: patched };
}

const report = [];
for (const map of MAPS) {
  const srcPath = 'google_drive/' + map.file;
  const srcBytes = fs.statSync(srcPath).size;
  const doc = await io.read(srcPath);

  const beforeGeo = geometryFingerprint(doc);
  const beforeTex = await textureFingerprint(doc);
  const beforeStats = {
    nodes: doc.getRoot().listNodes().length,
    meshes: doc.getRoot().listMeshes().length,
    prims: doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0),
    tris: doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3, 0), 0),
    materials: doc.getRoot().listMaterials().length,
    textures: doc.getRoot().listTextures().length,
  };

  if (map.metalRough) await doc.transform(metalRough());

  // lossless texture re-encode to WebP only when pixels are identical and smaller
  let texGain = 0, texKept = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const orig = Buffer.from(tex.getImage());
    const mime = tex.getMimeType();
    if (mime !== 'image/png') { texKept++; continue; }
    const webp = await sharp(orig).webp({ lossless: true, effort: 6, smartSubsample: true }).toBuffer();
    const a = await sharp(orig).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const identical = a.data.equals(b.data) && a.info.width === b.info.width && a.info.height === b.info.height;
    if (identical && webp.length < orig.length) {
      texGain += orig.length - webp.length;
      tex.setImage(new Uint8Array(webp)).setMimeType('image/webp');
    } else texKept++;
  }

  await doc.transform(dedup(), reorder({ encoder: MeshoptEncoder, target: 'size' }));
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });

  // verify geometry is bit-identical before writing
  const afterGeo = geometryFingerprint(doc);
  const sameGeo = JSON.stringify(beforeGeo) === JSON.stringify(afterGeo);

  const glb = await io.writeBinary(doc);
  const { buffer, patchedTextures } = patchWebp(Buffer.from(glb));
  const outPath = 'public/maps/' + map.out;
  fs.writeFileSync(outPath, buffer);

  // re-read the written file to confirm it parses and matches
  const doc2 = await io.read(outPath);
  const geo2 = geometryFingerprint(doc2);
  const tex2 = await textureFingerprint(doc2);
  const reparsed = JSON.stringify(geo2) === JSON.stringify(afterGeo);
  const texSame = JSON.stringify(tex2) === JSON.stringify(beforeTex);

  const entry = {
    id: map.id, file: map.file, out: map.out,
    srcBytes, outBytes: buffer.length, ratio: +(buffer.length / srcBytes).toFixed(3),
    stats: beforeStats,
    geometryBitIdentical: sameGeo, reparseMatches: reparsed, texturesPixelIdentical: texSame,
    textureBytesSaved: texGain, texturesKeptAsIs: texKept, webpTexturesPatched: patchedTextures,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
  report.push(entry);
  console.log(`${map.id}: ${(srcBytes/1e6).toFixed(1)}MB -> ${(buffer.length/1e6).toFixed(1)}MB (${(100*buffer.length/srcBytes).toFixed(1)}%) geoSame=${sameGeo} reparse=${reparsed} texSame=${texSame} webpTex=${patchedTextures}`);
}

fs.writeFileSync('tools/asset-report.json', JSON.stringify(report, null, 2));
console.log('total', (report.reduce((n, r) => n + r.srcBytes, 0) / 1e6).toFixed(1) + 'MB ->', (report.reduce((n, r) => n + r.outBytes, 0) / 1e6).toFixed(1) + 'MB');
