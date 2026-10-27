/**
 * Enemy "Stalker": patrols the baked navigation grid, chases the player on
 * sight and attacks at close range. Movement uses the same capsule controller
 * and BVH as the player, so it can never walk through walls.
 */
import {
  Group, Mesh, CapsuleGeometry, SphereGeometry, BoxGeometry,
  MeshStandardMaterial, Color, Vector3, MathUtils,
} from 'three';
import { CharacterBody } from '../core/collision.js';

const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

function buildVisual(tint) {
  const group = new Group();
  const skin = new MeshStandardMaterial({ color: new Color(tint), roughness: 0.85, metalness: 0.05 });
  const body = new Mesh(new CapsuleGeometry(0.2, 0.85, 4, 10), skin);
  body.position.y = 0.86;
  body.castShadow = true;
  group.add(body);

  const head = new Mesh(new SphereGeometry(0.17, 14, 12), skin);
  head.position.y = 1.52;
  head.castShadow = true;
  group.add(head);

  const eyeMat = new MeshStandardMaterial({
    color: 0xff3b30, emissive: new Color(0xff3b30), emissiveIntensity: 3.2, roughness: 0.4,
  });
  for (const dx of [-0.06, 0.06]) {
    const eye = new Mesh(new BoxGeometry(0.045, 0.03, 0.02), eyeMat);
    eye.position.set(dx, 1.55, 0.155);
    group.add(eye);
  }

  const armMat = new MeshStandardMaterial({ color: 0x11151a, roughness: 0.9 });
  for (const dx of [-0.24, 0.24]) {
    const arm = new Mesh(new CapsuleGeometry(0.055, 0.5, 3, 6), armMat);
    arm.position.set(dx, 1.0, 0.02);
    arm.rotation.z = dx > 0 ? -0.12 : 0.12;
    group.add(arm);
  }
  return group;
}

const STATE = { PATROL: 'patrol', CHASE: 'chase', SEARCH: 'search' };

export class Enemy {
  constructor({ scene, bvh, nav, map, difficulty, spawn, index = 0 }) {
    this.nav = nav;
    this.map = map;
    this.difficulty = difficulty;
    this.body = new CharacterBody({ bvh, radius: 0.24, height: 1.75, gravity: 21 });
    this.body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
    this.visual = buildVisual(index % 2 === 0 ? '#2b333a' : '#33302b');
    this.visual.position.copy(this.body.position);
    scene.add(this.visual);

    this.state = STATE.PATROL;
    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.waitTimer = 0;
    this.attackTimer = 0;
    this.lostTimer = 0;
    this.alertTimer = 0;
    this.target = null;
    this.patrolIndex = index % Math.max(1, map.patrols.length);
    this.stuckTimer = 0;
    this.lastProgressPos = this.body.position.clone();
    this.bob = Math.random() * Math.PI * 2;
  }

  get eye() {
    return _a.copy(this.body.position).setY(this.body.position.y + 1.5);
  }

  say(message) {
    if (this.onSay) this.onSay(message);
  }

  pickPatrolTarget() {
    const nodes = this.map.patrols;
    if (!nodes.length) return null;
    this.patrolIndex = (this.patrolIndex + 1) % nodes.length;
    return nodes[this.patrolIndex];
  }

  setDestination(point, speedHint) {
    const path = this.nav.findPath(this.body.position, point);
    this.path = path;
    this.pathIndex = 0;
    this.speedHint = speedHint;
  }

  canSee(playerPos, losCheck) {
    const eye = this.eye;
    const target = _b.copy(playerPos).setY(playerPos.y + 1.2);
    const distance = eye.distanceTo(target);
    if (distance > this.difficulty.detectRange) return false;
    const dir = _v.subVectors(target, eye).normalize();
    const forward = new Vector3(0, 0, 1).applyQuaternion(this.visual.quaternion);
    const dot = forward.dot(dir);
    // wide field of view, but very close enemies notice you regardless
    if (dot < 0.25 && distance > 2.5) return false;
    return losCheck(eye, target);
  }

  update(dt, playerPos, losCheck, onAttack) {
    this.repathTimer -= dt;
    this.attackTimer -= dt;
    this.alertTimer -= dt;

    const distance = this.body.position.distanceTo(playerPos);
    const sees = this.canSee(playerPos, losCheck);

    if (sees) {
      if (this.state !== STATE.CHASE && this.alertTimer <= 0) {
        this.alertTimer = 6;
        this.say('chase');
      }
      this.state = STATE.CHASE;
      this.lostTimer = 0;
      this.target = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    } else if (this.state === STATE.CHASE) {
      this.lostTimer += dt;
      if (this.lostTimer > 2.6) {
        this.state = STATE.SEARCH;
        this.searchTimer = 6;
      }
    } else if (this.state === STATE.SEARCH) {
      this.searchTimer -= dt;
      if (this.searchTimer <= 0) {
        this.state = STATE.PATROL;
        this.path = [];
      }
    }

    // ---- decide where to go ----
    if (this.state === STATE.CHASE) {
      if (this.repathTimer <= 0 || this.path.length === 0) {
        this.repathTimer = 0.55;
        this.setDestination(playerPos);
      }
    } else if (this.state === STATE.SEARCH) {
      if (this.target && (this.repathTimer <= 0 || this.path.length === 0)) {
        this.repathTimer = 2.2;
        this.setDestination(this.target);
      }
    } else if (this.path.length === 0) {
      if (this.waitTimer > 0) {
        this.waitTimer -= dt;
      } else {
        const node = this.pickPatrolTarget();
        if (node) this.setDestination(node);
        this.waitTimer = 1.4 + Math.random() * 2.6;
      }
    }

    // ---- follow path ----
    let wishX = 0;
    let wishZ = 0;
    let speed = this.difficulty.enemySpeed * (this.state === STATE.CHASE ? 1.28 : 0.72);
    if (this.state === STATE.PATROL) speed *= 0.72;

    while (this.pathIndex < this.path.length) {
      const node = this.path[this.pathIndex];
      const dx = node.x - this.body.position.x;
      const dz = node.z - this.body.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.42) {
        this.pathIndex++;
        continue;
      }
      wishX = dx / d;
      wishZ = dz / d;
      break;
    }
    if (this.pathIndex >= this.path.length && this.path.length) {
      this.path = [];
      if (this.state === STATE.CHASE) this.repathTimer = 0.3;
    }

    this.body.update(dt, _v.set(wishX, 0, wishZ), { speed, accel: 10 });

    // stuck detection -> repath
    const moved = this.body.position.distanceTo(this.lastProgressPos);
    if (moved < 0.035 && (wishX || wishZ)) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.1) {
        this.stuckTimer = 0;
        this.path = [];
        this.repathTimer = 0;
        this.waitTimer = 0.4;
      }
    } else {
      this.stuckTimer = 0;
      this.lastProgressPos.copy(this.body.position);
    }

    // ---- attack + visuals ----
    if (distance < 1.15 && this.attackTimer <= 0) {
      this.attackTimer = 1.15;
      onAttack(this.difficulty.damage);
    }

    this.visual.position.copy(this.body.position);
    this.bob += dt * (this.state === STATE.CHASE ? 11 : 5);
    this.visual.position.y += Math.sin(this.bob) * 0.025;
    let targetYaw = null;
    if (wishX || wishZ) targetYaw = Math.atan2(wishX, wishZ);
    else if (this.state === STATE.CHASE) targetYaw = Math.atan2(playerPos.x - this.body.position.x, playerPos.z - this.body.position.z);
    if (targetYaw !== null) {
      let delta = targetYaw - this.visual.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.visual.rotation.y += delta * Math.min(1, 9 * dt);
    }
  }

  dispose(scene) {
    scene.remove(this.visual);
    this.visual.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        child.material.dispose();
      }
    });
  }
}
