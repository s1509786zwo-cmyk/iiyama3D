import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
let orig = 0, best = 0;
for (const tex of doc.getRoot().listTextures()) {
  if (tex.getMimeType() !== 'image/png') continue;
  const buf = Buffer.from(tex.getImage());
  orig += buf.length;
  const p = await sharp(buf).png({ compressionLevel: 9, effort: 10, palette: true, quality: 100, dither: 0 }).toBuffer();
  const a = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  const same = a.data.equals(b.data);
  best += p.length;
  console.log(`${a.info.width}x${a.info.height} ${(buf.length/1e6).toFixed(2)} -> ${(p.length/1e6).toFixed(2)} identical=${same}`);
}
console.log(`PNG total ${(orig/1e6).toFixed(1)} -> ${(best/1e6).toFixed(1)} (${(100*best/orig).toFixed(0)}%)`);
