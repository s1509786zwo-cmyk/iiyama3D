// Draco geometry compression pass (glTF Transform).
// Fidelity: 16-bit quantisation for positions/normals/UVs - sub-millimetre for these
// scene sizes, i.e. far below one screen pixel. Textures are untouched by this step.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3d';
import { readdirSync, statSync } from 'fs';
import path from 'path';

const inDir = process.argv[2];
const outDir = process.argv[3];
const quantize = {
  quantizePosition: Number(process.env.Q_POS || 16),
  quantizeNormal: 16,
  quantizeTexcoord: 16,
  quantizeColor: 12,
  quantizeGeneric: 16,
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

for (const f of readdirSync(inDir).filter((f) => f.endsWith('.glb'))) {
  const src = path.join(inDir, f);
  const dst = path.join(outDir, f);
  const before = statSync(src).size;
  const doc = await io.read(src);
  await doc.transform(draco(quantize));
  await io.write(dst, doc);
  const after = statSync(dst).size;
  console.log(`${f}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
}
