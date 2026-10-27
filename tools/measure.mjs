import { loadMerged } from './lib/geom.mjs';
const MAPS = [
  ['abandoned_city_street_for_games.glb', 1.0],
  ['abandoned_warehouse_-_interior_scene.glb', 1.0],
  ['subway_train_interior.glb', 0.01],
  ['abandoned_classroom.glb', 0.0254],
];
for (const [f, s] of MAPS) {
  const g = await loadMerged('google_drive/' + f, s);
  const b = g.boundingBox;
  const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  console.log(`${f}  scale=${s}  tris=${tris}`);
  console.log(`   min ${b.min.toArray().map(n=>n.toFixed(2))}  max ${b.max.toArray().map(n=>n.toFixed(2))}  size ${b.getSize(new (await import('three')).Vector3()).toArray().map(n=>n.toFixed(2))}`);
  g.dispose();
}
