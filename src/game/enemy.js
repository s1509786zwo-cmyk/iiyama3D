// Wandering hostile. Paths over the same baked nav grid that placed the player, so it
// never walks through walls, and it only uses the map's own geometry for line of sight.
import * as THREE from 'three';

export const DIFFICULTIES = [
  {
    id: 'easy',
    label: 'EASY',
    desc: '敵は少なく鈍い。探索向け。',
    enemies: 2,
    speed: 1.5,
    sight: 9,
    damage: 8,
    reaction: 1.2,
    hp: 100,
  },
  {
    id: 'normal',
    label: 'NORMAL',
    desc: '標準。敵は追跡してくる。',
    enemies: 4,
    speed: 2.2,
    sight: 13,
    damage: 13,
    reaction: 0.7,
    hp: 100,
  },
  {
    id: 'hard',
    label: 'HARD',
    desc: '敵が多い・速い・高ダメージ。',
    enemies: 6,
    speed: 3.0,
    sight: 18,
    damage: 20,
    reaction: 0.35,
    hp: 100,
  },
];

export class Enemy {
  constructor(scene, nav, bvh, spawnCell, cfg) {
    this.nav = nav;
    this.bvh = bvh;
    this.cfg = cfg;
    this.pos = new THREE.Vector3(spawnCell.x, spawnCell.y, spawnCell.z);
    this.path = null;
    this.pathIndex = 0;
    this.repathTimer = Math.random() * 1.5;
    this.attackTimer = 0;
    this.tired = 0;

    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b3a34, roughness: 0.85, metalness: 0.1 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x9fb2a6, roughness: 0.6 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff5f5f });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 6, 12), bodyMat);
    body.position.y = 0.95;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), headMat);
    head.position.y = 1.6;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eyeMat);
    eyeL.position.set(-0.07, 1.63, -0.17);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.07;
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8), bodyMat);
    legs.position.y = 0.3;
    g.add(body, head, eyeL, eyeR, legs);
    this.mesh = g;
    scene.add(g);
    this.syncMesh();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
  }

  lineOfSight(target) {
    const dir = new THREE.Vector3().subVectors(target, this.pos);
    const dist = dir.length();
    if (dist < 1e-3) return true;
    dir.divideScalar(dist);
    const ray = new THREE.Ray(this.pos.clone().setY(this.pos.y + 1.5), dir);
    const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
    return !hit || hit.distance > dist - 0.35;
  }

  update(dt, player, difficulty, onDamage) {
    const distToPlayer = this.pos.distanceTo(player);
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.repathTimer -= dt;

    const canSee = distToPlayer < difficulty.sight && this.lineOfSight(player);
    if (canSee) {
      this.tired = 3.0;
    } else {
      this.tired = Math.max(0, this.tired - dt);
    }

    // (re)path
    if (this.repathTimer <= 0) {
      this.repathTimer = canSee ? 0.5 : 1.8;
      if (canSee || this.tired > 0) {
        this.path = this.nav.findPath(this.pos.x, this.pos.z, player.x, player.z);
      } else {
        // idle wander
        const c = this.nav.cellOf(this.pos.x, this.pos.z);
        if (c) {
          const r = 5;
          const ix = c.ix + Math.round((Math.random() - 0.5) * r * 2);
          const iz = c.iz + Math.round((Math.random() - 0.5) * r * 2);
          if (this.nav.isWalkable(ix, iz)) {
            const p = this.nav.cellCenter(ix, iz);
            const y = this.nav.floorAt(ix, iz);
            this.path = [{ x: p.x, z: p.z, y }];
          }
        }
      }
      this.pathIndex = 0;
    }

    // follow path
    let speed = canSee ? difficulty.speed : difficulty.speed * 0.45;
    if (this.path && this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const dx = wp.x - this.pos.x;
      const dz = wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.22) {
        this.pathIndex++;
      } else {
        const step = Math.min(d, speed * dt);
        const nx = this.pos.x + (dx / d) * step;
        const nz = this.pos.z + (dz / d) * step;
        const fy = this.nav.floorAtWorld(nx, nz);
        if (fy !== null && Math.abs(fy - this.pos.y) < 0.5) {
          this.pos.x = nx;
          this.pos.z = nz;
          this.pos.y += (fy - this.pos.y) * Math.min(1, dt * 12);
        } else {
          this.path = null;
          this.repathTimer = 0;
        }
      }
    } else if (canSee && distToPlayer > 1.1) {
      // direct chase when visible but no path found
      const dir = new THREE.Vector3().subVectors(player, this.pos).setY(0).normalize();
      const nx = this.pos.x + dir.x * speed * dt;
      const nz = this.pos.z + dir.z * speed * dt;
      const fy = this.nav.floorAtWorld(nx, nz);
      if (fy !== null && Math.abs(fy - this.pos.y) < 0.5) {
        this.pos.x = nx;
        this.pos.z = nz;
        this.pos.y += (fy - this.pos.y) * Math.min(1, dt * 12);
      }
    }

    if (distToPlayer < 1.25 && this.attackTimer <= 0) {
      this.attackTimer = 1.1;
      onDamage(difficulty.damage);
    }

    // face the player
    const yaw = Math.atan2(player.x - this.pos.x, player.z - this.pos.z);
    this.mesh.rotation.y = yaw;
    this.syncMesh();
  }
}

export function spawnEnemies(scene, nav, bvh, playerSpawn, cfg, count) {
  const out = [];
  const wc = nav.walkCount;
  if (!wc) return out;
  // deterministic-ish spread: walk the grid with a stride that grows with count
  const cells = [];
  const stride = Math.max(1, Math.floor(wc / Math.max(24, count * 8)));
  let n = 0;
  for (let ix = 0; ix < nav.nx; ix++) {
    for (let iz = 0; iz < nav.nz; iz++) {
      if (!nav.isWalkable(ix, iz)) continue;
      if (n++ % stride) continue;
      const c = nav.cellCenter(ix, iz);
      const y = nav.floorAt(ix, iz);
      const d = Math.hypot(c.x - playerSpawn.x, c.z - playerSpawn.z);
      if (d > 6.5 && d < 42) cells.push({ x: c.x, y, z: c.z });
    }
  }
  cells.sort((a, b) => Math.hypot(a.x - playerSpawn.x, a.z - playerSpawn.z) - Math.hypot(b.x - playerSpawn.x, b.z - playerSpawn.z));
  const stride2 = Math.max(1, Math.floor(cells.length / count));
  for (let i = 0; i < count && i * stride2 < cells.length; i++) {
    out.push(new Enemy(scene, nav, bvh, cells[i * stride2], cfg));
  }
  return out;
}
