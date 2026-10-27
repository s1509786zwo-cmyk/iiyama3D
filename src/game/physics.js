// First-person character controller on top of the baked collision BVH (three-mesh-bvh).
//
// The player is a vertical capsule approximated by a ring of raycasts at ankle, waist and
// head height: cheap, stable on scanned geometry, and it slides along walls instead of
// sticking.  Step-up is resolved by trying a second sweep from a slightly raised position.
//
// No DOM dependency: exercised by tools/test_game.mjs in Node.
import * as THREE from 'three';

const _ray = new THREE.Ray();
const _tmp = new THREE.Vector3();

export const PLAYER = {
  height: 1.75,  // total standing height (m) - unified across every map
  eyeHeight: 1.65,
  radius: 0.32,
  step: 0.35,
  gravity: -22.0,
  jumpSpeed: 5.2,
  walkSpeed: 3.4,
  runSpeed: 5.8,
  accel: 26.0,
  friction: 12.0,
  maxSlope: 0.75, // cos of the steepest walkable slope (≈41°)
};

const DIRS = [];
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  DIRS.push([Math.sin(a), Math.cos(a)]);
}

export class CharacterController {
  constructor(bvh, opts = {}) {
    this.bvh = bvh;
    this.p = { ...PLAYER, ...opts };
    this.position = new THREE.Vector3(); // feet position
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.groundY = 0;
    this.lastGroundNormal = new THREE.Vector3(0, 1, 0);
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
  }

  /**
   * Raycast against the collision BVH.
   * The normal is re-oriented to face the ray origin: photo-scanned and mirrored geometry
   * frequently has flipped winding, and a downward-facing floor normal must still count as
   * ground. Returns null when there is no hit within `far`.
   */
  _cast(origin, dir, far) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide);
    if (!hit) return null;
    if (hit.distance > far) return null;
    if (hit.face && hit.face.normal) {
      const n = hit.face.normal.clone();
      // face normals are in the collision mesh's own space (identity transform)
      if (n.dot(dir) > 0) n.negate();
      hit.normal = n;
    }
    return hit;
  }

  /** distance from (x,y,z) to the nearest surface in direction `dir` */
  probe(x, y, z, dir, far) {
    _tmp.set(x, y, z);
    const hit = this._cast(_tmp, dir, far);
    return hit ? { distance: hit.distance, normal: hit.normal ? hit.normal.clone() : new THREE.Vector3(0, 1, 0) } : null;
  }

  /** highest floor under (x,z) starting at y+step; returns {y, normal} or null */
  groundBelow(x, z, fromY, far = 60) {
    _tmp.set(x, fromY, z);
    const hit = this._cast(_tmp, DOWN, far);
    if (!hit) return null;
    const normal = hit.normal ? hit.normal.clone() : new THREE.Vector3(0, 1, 0);
    return { y: fromY - hit.distance, normal };
  }

  /**
   * Advance the controller by dt with a desired horizontal move vector (world space,
   * already rotated by the camera yaw) and a jump request.
   */
  update(dt, wishDir, running, jump) {
    const p = this.p;
    const step = Math.min(dt, 0.05);

    // ---- horizontal wish velocity
    const speed = running ? p.runSpeed : p.walkSpeed;
    const target = new THREE.Vector3(wishDir.x, 0, wishDir.z);
    if (target.lengthSq() > 1) target.normalize();
    target.multiplyScalar(speed);

    const horiz = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const blend = 1 - Math.exp(-(target.lengthSq() > 0.01 ? p.accel : p.friction) * step);
    horiz.lerp(target, blend);

    // ---- gravity
    this.velocity.y += p.gravity * step;
    if (jump && this.onGround) {
      this.velocity.y = p.jumpSpeed;
      this.onGround = false;
    }

    // ---- integrate
    const move = new THREE.Vector3(horiz.x * step, this.velocity.y * step, horiz.z * step);
    this._move(move, step);

    // ---- ground check
    const feetY = this.position.y;
    const g = this.groundBelow(this.position.x, this.position.z, feetY + p.step + 0.02, p.step + 0.35);
    this.onGround = false;
    if (g) {
      const slopeOk = g.normal.y >= p.maxSlope && !this._ceilingBlocked(this.position, g.y);
      if (slopeOk) {
        const snapDist = feetY - g.y;
        if (snapDist >= -0.05 && snapDist <= p.step + 0.06) {
          this.position.y = g.y;
          if (this.velocity.y < 0) this.velocity.y = 0;
          this.onGround = true;
          this.groundY = g.y;
          this.lastGroundNormal.copy(g.normal);
        }
      }
    }
    if (this.velocity.y < -35) this.velocity.y = -35;
    return this.onGround;
  }

  _ceilingBlocked(position, groundY) {
    // refuse to snap into a hole that is too low to stand in
    _tmp.set(position.x, groundY + 0.06, position.z);
    const hit = this._cast(_tmp, UP, this.p.height * 0.85);
    return !!hit;
  }

  /** Move with wall sliding + step-up. */
  _move(move, dt) {
    const p = this.p;
    const r = p.radius;
    const start = this.position.clone();

    // resolve horizontal penetration iteratively
    const tryMove = (offset, from) => {
      const next = from.clone().add(offset);
      const hit = this._obstruct(next);
      if (!hit) return { ok: true, pos: next };
      return { ok: false, pos: from.clone().add(offset.multiplyScalar(Math.max(0, 1 - (r - hit.distance + 0.02) / Math.max(offset.length(), 1e-4)))) };
    };

    // attempt with step-up when blocked
    let proposed = start.clone();
    let blocked = false;

    // 1) vertical part first (falling / jumping)
    if (Math.abs(move.y) > 1e-6) {
      const vNext = proposed.clone().add(new THREE.Vector3(0, move.y, 0));
      const vHit = move.y < 0 ? this._obstruct(vNext, true) : this._obstruct(vNext, false, true);
      if (vHit) {
        this.velocity.y = 0;
      } else {
        proposed.copy(vNext);
      }
    }

    // 2) horizontal sweep, split into sub-steps so we cannot tunnel
    const hLen = Math.hypot(move.x, move.z);
    const sub = Math.max(1, Math.ceil(hLen / (r * 0.6)));
    const subMove = new THREE.Vector3(move.x / sub, 0, move.z / sub);
    for (let s = 0; s < sub; s++) {
      const target = proposed.clone().add(subMove);
      const hit = this._obstruct(target);
      if (!hit) {
        proposed.copy(target);
        continue;
      }
      // try step-up: raise, move, drop
      const raised = proposed.clone();
      raised.y += p.step;
      const stepped = raised.clone().add(subMove);
      if (!this._obstruct(stepped) && !this._obstruct(stepped, true)) {
        const g = this.groundBelow(stepped.x, stepped.z, raised.y + p.step + 0.05, p.step + 0.1);
        if (g && g.normal.y >= p.maxSlope) {
          proposed.copy(stepped);
          proposed.y = g.y;
          continue;
        }
      }
      blocked = true;
      // slide: remove the component into the surface
      const n = hit.normal.clone();
      n.y = 0;
      if (n.lengthSq() > 1e-6) {
        n.normalize();
        const into = subMove.x * n.x + subMove.z * n.z;
        if (into < 0) {
          const slide = new THREE.Vector3(subMove.x - n.x * into, 0, subMove.z - n.z * into);
          const slidTarget = proposed.clone().add(slide);
          if (!this._obstruct(slidTarget)) {
            proposed.copy(slidTarget);
            continue;
          }
        }
      }
      break;
    }

    // kill horizontal velocity into the wall so we do not accumulate
    if (blocked) {
      this.velocity.x *= 0.2;
      this.velocity.z *= 0.2;
    }
    this.position.copy(proposed);
  }

  /** Returns the closest blocking hit for the capsule centred at `pos` (feet at pos.y). */
  _obstruct(pos, ignoreLow = false, ignoreHigh = false) {
    const p = this.p;
    const r = p.radius;
    const heights = [0.25, 0.95, Math.min(p.height - 0.18, 1.55)];
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let best = null;
    for (const h of heights) {
      if (ignoreLow && h < 0.5) continue;
      if (ignoreHigh && h > 1.3) continue;
      const y = pos.y + Math.min(h, p.height - 0.05);
      for (const [dx, dz] of DIRS) {
        origin.set(pos.x, y, pos.z);
        dir.set(dx, 0, dz);
        const hit = this._cast(origin, dir, r);
        if (!hit) continue;
        if (!best || hit.distance < best.distance) {
          const n = hit.normal ? hit.normal.clone() : new THREE.Vector3(-dx, 0, -dz);
          if (n.lengthSq() < 1e-8) n.set(-dx, 0, -dz);
          best = { distance: hit.distance, normal: n.normalize(), height: h };
        }
      }
    }
    return best;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
function normalize(out, v) {
  out.copy(v);
  if (out.lengthSq() < 1e-12) out.set(0, 1, 0);
  return out.normalize();
}
