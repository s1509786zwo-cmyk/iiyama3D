import { loadMerged } from './lib/geom.mjs';
import { MeshBVH } from 'three-mesh-bvh';
import { Ray, Vector3, DoubleSide } from 'three';
const all = {
  city_street:['abandoned_city_street_for_games.glb',1.0],
  warehouse:['abandoned_warehouse_-_interior_scene.glb',1.0],
  subway:['subway_train_interior.glb',0.01],
  classroom:['abandoned_classroom.glb',0.0254],
};
const id = process.argv[2]; const [file, scale] = all[id];
const CELL = 0.4;
const geo = await loadMerged('google_drive/' + file, scale);
const bvh = new MeshBVH(geo, { targetLeafSize: 10 });
const box = geo.boundingBox; const size = box.getSize(new Vector3());
const nx = Math.round(size.x/CELL), nz = Math.round(size.z/CELL);
const ox = (box.min.x+box.max.x)/2 - nx*CELL/2, oz = (box.min.z+box.max.z)/2 - nz*CELL/2;
const down = new Ray(new Vector3(), new Vector3(0,-1,0)), up = new Ray(new Vector3(), new Vector3(0,1,0));
let baseY = 0; { const hist=new Map(); const N=48;
  for(let i=0;i<=N;i++)for(let j=0;j<=N;j++){const x=box.min.x+size.x*i/N,z=box.min.z+size.z*j/N;
   up.origin.set(x,box.min.y-1,z);up.direction.set(0,1,0);const h=bvh.raycastFirst(up,DoubleSide,0,1000);
   if(!h)continue;const k=Math.round(h.point.y*10);hist.set(k,(hist.get(k)||0)+1);}
  let bk=0,bc=0;for(const[k,c]of hist)if(c>bc){bc=c;bk=k;}baseY=bk/10;}
const tmp = {};
const rows=[]; let free=0;
for (let j=nz-1;j>=0;j--){ let row='';
  for (let i=0;i<nx;i++){ const x=ox+(i+0.5)*CELL, z=oz+(j+0.5)*CELL;
    const blocked = [0.4,0.9,1.5].some(h => { tmp.point=null; return !!bvh.closestPointToPoint(new Vector3(x,baseY+h,z), tmp, 0, 0.3); });
    row += blocked ? '#' : '.'; if(!blocked) free++;
  }
  rows.push(row);
}
console.log(`${id} baseY=${baseY} free=${free}/${nx*nz} (${(free*CELL*CELL).toFixed(0)} m2) cell=${CELL}`);
console.log(rows.join('\n'));
