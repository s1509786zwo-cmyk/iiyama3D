import fs from 'node:fs';
import validator from 'gltf-validator';
const files = process.argv.slice(2);
for (const f of files) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  const report = await validator.validateBytes(bytes, { maxIssues: 15, ignoredIssues: ['UNSUPPORTED_EXTENSION'] });
  const issues = report.issues;
  const info = report.info || {};
  console.log(`${f}`);
  console.log(`  version=${info.version} tris=${info.totalTriangleCount} drawCalls=${info.drawCallCount} materials=${info.materialCount} textures=${info.textureCount} anim=${info.animationCount}`);
  console.log(`  errors=${issues.numErrors} warnings=${issues.numWarnings} infos=${issues.numInfos} hints=${issues.numHints}`);
  for (const m of issues.messages.slice(0, 8)) console.log(`   - [${m.severity}] ${m.code}: ${m.message} ${m.pointer || ''}`);
}
