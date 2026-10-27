import { loadMerged } from './lib/geom.mjs';
import { MeshBVH } from 'three-mesh-bvh';
import { Ray, Vector3, DoubleSide } from 'three';
const MAPS = [
  ['city_street','abandoned_city_street_for_games.glb',1.0],
  ['warehouse','abandoned_warehouse_-_interior_scene.glb',1.0],
  ['subway','subway_train_interior.glb',0.01],
  ['classroom','abandoned_classroom.glb',0.0254],
];
for (const [id, file, scale] of MAPS) {
  const geo = await loadMerged('google_drive/' + file, scale);
  const bvh = new MeshBVH(geo, { targetLeafSize: 10 });
  const box = geo.boundingBox;
  const down = new Ray(new Vector3(), new Vector3(0,-1,0));
  const up = new Ray(new Vector3(), new Vector3(0,1,0));
  const hist = new Map(); let miss = 0, hits = 0;
  const N = 40;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = box.min.x + (box.max.x-box.min.x) * i / N;
    const z = box.min.z + (box.max.z-box.min.z) * j / N;
    up.origin.set(x, box.min.y - 1, z); up.direction.set(0,1,0);
    const h = bvh.raycastFirst(up, DoubleSide, 0, 1000);
    if (!h) { miss++; continue; }
    hits++;
    const key = (Math.round(h.point.y * 10) / 10).toFixed(1);
    hist.set(key, (hist.get(key)||0)+1);
  }
  const top = [...hist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8);
  console.log(`${id}: bbox Y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}  bottom-up samples hit=${hits}/${(N+1)**2} miss=${miss}`);
  console.log(`   lowest surface histogram: ${top.map(([y,c])=>`${y}m:${c}`).join('  ')}`);
  geo.dispose();
}
