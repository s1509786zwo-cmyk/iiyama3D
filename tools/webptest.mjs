import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
let orig = 0, webp = 0;
for (const tex of doc.getRoot().listTextures()) {
  const buf = Buffer.from(tex.getImage());
  orig += buf.length;
  const out = await sharp(buf).webp({ lossless: true, effort: 5 }).toBuffer();
  // verify pixel equality
  const a = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const same = a.data.equals(b.data) && a.info.width === b.info.width;
  webp += out.length;
  console.log(`${tex.getMimeType()} ${a.info.width}x${a.info.height} ${buf.length} -> ${out.length} (${(100*out.length/buf.length).toFixed(1)}%) identical=${same}`);
}
console.log(`TOTAL ${(orig/1e6).toFixed(1)}MB -> ${(webp/1e6).toFixed(1)}MB (${(100*webp/orig).toFixed(1)}%)`);
