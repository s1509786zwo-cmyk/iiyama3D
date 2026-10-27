// Static wiring checks for the browser bundle:
//   * every element id used by the JS exists in index.html
//   * every module specifier resolves (relative file on disk, or via the import map)
//   * every asset path in the manifest exists on disk
//   * no duplicate element ids, no missing script/css references
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/iiyama3D';
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const dupIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
check('index.html has unique element ids', new Set(dupIds).size === dupIds.length,
  `${dupIds.length} ids`);

const importMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
const imports = importMap.imports;
check('import map declares three', !!imports.three);
check('import map declares three/addons/', !!imports['three/addons/']);
check('import map declares three-mesh-bvh', !!imports['three-mesh-bvh']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(ROOT, 'src'));
const usedIds = new Set();
const bareSpecifiers = new Set();
let importCount = 0;

for (const file of srcFiles) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) usedIds.add(m[1]);
  for (const m of code.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) usedIds.add(m[1]);
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1];
    importCount++;
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), spec);
      check(`import resolves: ${path.relative(ROOT, resolved)}`, existsSync(resolved));
    } else {
      bareSpecifiers.add(spec);
    }
  }
}

const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
check(`all ${usedIds.size} element ids referenced by the JS exist in index.html`, missingIds.length === 0,
  missingIds.join(', '));

for (const spec of bareSpecifiers) {
  const prefix = Object.keys(imports).find((k) => k.endsWith('/') && spec.startsWith(k));
  const target = prefix ? imports[prefix] + spec.slice(prefix.length) : imports[spec];
  check(`bare specifier mapped: ${spec}`, !!target, target || 'not in import map');
  if (target) check(`  -> file exists: ${target}`, existsSync(path.join(ROOT, target)));
}

check('stylesheet linked', existsSync(path.join(ROOT, html.match(/href="([^"]+\.css)"/)[1].replace(/^\//, ''))));
const entry = html.match(/<script type="module" src="([^"]+)"/)[1];
check('module entry exists', existsSync(path.join(ROOT, entry.replace(/^\//, ''))), entry);

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/maps/manifest.json'), 'utf8'));
for (const m of manifest.maps) {
  for (const key of ['model', 'collision', 'nav', 'preview', 'previewHero']) {
    const p = path.join(ROOT, m[key].replace(/^\//, ''));
    check(`manifest ${m.id}.${key} exists`, existsSync(p), m[key]);
  }
  const nav = JSON.parse(readFileSync(path.join(ROOT, m.nav.replace(/^\//, '')), 'utf8'));
  check(`manifest ${m.id} nav grid dimensions`, nav.nx > 0 && nav.nz > 0, `${nav.nx}x${nav.nz}`);
  check(`manifest ${m.id} spawn is the world origin`, m.spawn.position.every((v) => v === 0));
}

// player metrics must be identical for every map
const first = JSON.stringify(manifest.maps[0].player);
check('player size unified across maps', manifest.maps.every((m) => JSON.stringify(m.player) === first), first);
check('player height ~1.7-1.8 m', manifest.maps[0].player.height >= 1.7 && manifest.maps[0].player.height <= 1.8);
check('eye height ~1.6-1.7 m', manifest.maps[0].player.eyeHeight >= 1.6 && manifest.maps[0].player.eyeHeight <= 1.7);

console.log(`\n${importCount} imports scanned, ${srcFiles.length} source files`);
console.log(failures ? `\n${failures} FAILURES` : '\nALL WIRING CHECKS PASSED');
process.exit(failures ? 1 : 0);
