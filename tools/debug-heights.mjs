import { loadMerged } from './lib/geom.mjs';
import { MeshBVH } from 'three-mesh-bvh';
import { Ray, Vector3, DoubleSide } from 'three';
const all = { city_street:['abandoned_city_street_for_games.glb',1.0] };
const [file, scale] = all[process.argv[2]];
const CELL = 0.5;
const geo = await loadMerged('google_drive/' + file, scale);
const bvh = new MeshBVH(geo, { targetLeafSize: 10 });
const box = geo.boundingBox; const size = box.getSize(new Vector3());
const nx = Math.round(size.x/CELL), nz = Math.round(size.z/CELL);
const ox = (box.min.x+box.max.x)/2 - nx*CELL/2, oz = (box.min.z+box.max.z)/2 - nz*CELL/2;
const down = new Ray(new Vector3(), new Vector3(0,-1,0));
const rows=[]; const counts=new Map();
for (let j=nz-1;j>=0;j--){ let row='';
  for (let i=0;i<nx;i++){ const x=ox+(i+0.5)*CELL, z=oz+(j+0.5)*CELL;
    down.origin.set(x, box.max.y+0.5, z); const h=bvh.raycastFirst(down,DoubleSide,0,100);
    if(!h){ row+=' '; continue; }
    const y=h.point.y; const key=(Math.round(y*10)/10).toFixed(1); counts.set(key,(counts.get(key)||0)+1);
    // char by height band
    row += y < -0.3 ? 'v' : y < 0.3 ? '.' : y < 1.2 ? '1' : y < 2.2 ? '2' : y < 3.2 ? '3' : y < 4.2 ? '4' : y < 5.2 ? '5' : '6';
  }
  rows.push(row);
}
console.log('legend: . = ground(-0.3..0.3)  1..6 = height bands (m)   v = below   space = nothing');
console.log(rows.join('\n'));
console.log('height counts:', [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>`${k}:${v}`).join(' '));
