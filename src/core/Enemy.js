import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();

/**
 * "Custodian" drone: hovers, patrols pre-sampled walkable nodes and chases the
 * player once it has line of sight. It uses the same collision world as the
 * player, so it cannot walk through walls of the authored geometry.
 */
export class Enemy {
  constructor(collision, { nodes, spawn, speed = 1.7, damage = 12, detectionRange = 14, difficultyScale = 1 }) {
    this.collision = collision;
    this.nodes = nodes;
    this.position = spawn.clone();
    this.speed = speed * difficultyScale;
    this.damage = damage;
    this.detectionRange = detectionRange;
    this.state = 'patrol';
    this.targetNode = null;
    this.cooldown = 0;
    this.hoverPhase = Math.random() * Math.PI * 2;
    this.stuckTime = 0;
    this.floorY = spawn.y - 0.9;   // floor beneath the drone
    this.alertLevel = 0;
    this.dead = false;
    this.radius = 0.36;
    this.height = 1.45;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2a3338,
      roughness: 0.45,
      metalness: 0.75,
      emissive: 0x120a04,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0xff7043,
      emissive: 0xff5a1f,
      emissiveIntensity: 3.2,
      roughness: 0.3,
    });

    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), bodyMat);
    body.scale.set(1, 0.82, 1);
    group.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 8, 28), bodyMat);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), this.eyeMat);
    eye.position.set(0, 0.02, -0.29);
    group.add(eye);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.12), bodyMat);
      const a = (i / 3) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 0.36, -0.18, Math.sin(a) * 0.36);
      group.add(fin);
    }
    this.mesh = group;
    this.mesh.position.copy(this.position);
    this._pickNode();
  }

  _pickNode() {
    if (!this.nodes.length) return;
    const eye = this.position.clone();
    const usable = this.nodes.filter((n) => {
      const dist = n.distanceTo(this.position);
      if (dist < 3.5 || dist > 16) return false;
      // Only patrol towards nodes it can actually see: walking into props and
      // sliding around them made patrols stall.
      const dir = n.clone().sub(eye);
      const len = dir.length();
      dir.normalize();
      return !this.collision.raycast(eye, dir, Math.max(0.2, len - 0.6));
    });
    const far = this.nodes.filter((n) => n.distanceTo(this.position) > 3.5);
    const pool = usable.length ? usable : far.length ? far : this.nodes;
    this.targetNode = pool[Math.floor(Math.random() * pool.length)].clone();
  }

  canSee(playerPos) {
    _toPlayer.copy(playerPos).setY(playerPos.y + 1.2).sub(this.position.clone().setY(this.position.y + 0.6));
    const dist = _toPlayer.length();
    if (dist > this.detectionRange) return false;
    _toPlayer.normalize();
    const hit = this.collision.raycast(this.position, _toPlayer, dist - 0.2);
    return !hit;
  }

  update(dt, playerPos, gameTime) {
    if (this.dead) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const seesPlayer = this.canSee(playerPos);
    const distanceToPlayer = this.position.distanceTo(playerPos);

    if (seesPlayer) {
      this.state = distanceToPlayer < 1.6 ? 'attack' : 'chase';
      this.alertLevel = Math.min(1, this.alertLevel + dt * 2);
    } else {
      this.alertLevel = Math.max(0, this.alertLevel - dt * 0.5);
      if (this.alertLevel <= 0.02) this.state = 'patrol';
    }

    let goal;
    if (this.state === 'chase' || this.state === 'attack') {
      goal = playerPos;
    } else {
      if (!this.targetNode || this.position.distanceTo(this.targetNode) < 1.2) this._pickNode();
      goal = this.targetNode;
    }
    if (!goal) return;

    _dir.copy(goal);
    _dir.y = this.position.y;
    _dir.sub(this.position);
    const dist = _dir.length();
    if (dist > 0.05) {
      _dir.normalize();
      const speed = this.state === 'attack' ? this.speed * 0.35 : this.state === 'chase' ? this.speed * 1.45 : this.speed;
      const step = speed * dt;
      const next = this.collision.moveCapsule(this.position, { x: _dir.x * step, z: _dir.z * step }, this.radius, this.height, 0.4);
      let moved = Math.hypot(next.x - this.position.x, next.z - this.position.z);
      if (moved < step * 0.35) {
        // Slide: try offset headings when stuck.
        for (const angle of [0.9, -0.9, 1.7, -1.7]) {
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const ox = _dir.x * c - _dir.z * s;
          const oz = _dir.x * s + _dir.z * c;
          const alt = this.collision.moveCapsule(this.position, { x: ox * step, z: oz * step }, this.radius, this.height, 0.4);
          const m2 = Math.hypot(alt.x - this.position.x, alt.z - this.position.z);
          if (m2 > moved) {
            next.x = alt.x;
            next.z = alt.z;
            moved = m2;
            break;
          }
        }
        if (moved < 1e-3 && this.state === 'patrol') this._pickNode();
      }
      this.position.x = next.x;
      this.position.z = next.z;

      // Node the drone cannot reach (blocked by props): give up and re-pick.
      this.stuckTime = moved < step * 0.25 ? this.stuckTime + dt : 0;
      if (this.state === 'patrol' && this.stuckTime > 1.2) {
        this.stuckTime = 0;
        this._pickNode();
      }
    }

    // Vertical follow: only step to a floor that is within one stair of the
    // current one, so the drone can never drift onto roofs or catwalks.
    const floor = this.collision.floorSurface(this.position.x, this.position.z, this.floorY + 0.55, 1.6);
    if (floor && Math.abs(floor.y - this.floorY) <= 0.45) this.floorY = floor.y;
    const targetY = this.floorY + 0.95;
    this.position.y += (targetY - this.position.y) * Math.min(1, dt * 6);

    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(gameTime * 2.2 + this.hoverPhase) * 0.06;
    this.mesh.lookAt(playerPos.x, this.position.y, playerPos.z);
    this.mesh.rotateY(Math.PI);
    this.eyeMat.emissiveIntensity = 2.2 + Math.sin(gameTime * 6) * 0.8 + (this.state === 'chase' ? 1.6 : 0);
  }

  tryAttack(distance) {
    if (this.state !== 'attack' || this.cooldown > 0 || distance > 1.9) return 0;
    this.cooldown = 1.05;
    return this.damage;
  }
}

/**
 * Picks a patrol node far from the player. Never falls back to the player's
 * own position (that would spawn an enemy on top of the player); when no node
 * is far enough the farthest available node is used.
 */
export function pickEnemySpawn(nodes, playerSpawn, minDistance = 8) {
  if (!nodes.length) return null;
  const far = nodes.filter((n) => n.distanceTo(playerSpawn) > minDistance);
  if (far.length) return far[Math.floor(Math.random() * far.length)].clone();
  let farthest = nodes[0];
  let best = -Infinity;
  for (const n of nodes) {
    const d = n.distanceTo(playerSpawn);
    if (d > best) {
      best = d;
      farthest = n;
    }
  }
  return farthest.clone();
}
