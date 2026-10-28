/**
 * Collision & navigation.
 *
 *  - buildCollision(): merges the loaded map into one geometry and builds a BVH.
 *  - CharacterBody: capsule character controller resolved against that BVH.
 *  - NavGrid: A* over the pre-baked walkable grid (enemy path finding).
 */
import { Vector3, Ray, DoubleSide } from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';

const _p = new Vector3();
const _hit = {};
const _push = new Vector3();
const _ray = new Ray();

/** Merge every mesh of `root` into a single geometry and build a BVH over it. */
export function buildCollision(root) {
  const generator = new StaticGeometryGenerator(root);
  generator.attributes = ['position'];
  generator.useGroups = false;
  const geometry = generator.generate();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bvh = new MeshBVH(geometry, { targetLeafSize: 10 });
  return { bvh, geometry };
}

export class CharacterBody {
  constructor({ bvh, radius = 0.24, height = 1.75, gravity = 21 }) {
    this.bvh = bvh;
    this.radius = radius;
    this.height = height;
    this.gravity = gravity;
    this.position = new Vector3(); // feet position
    this.velocity = new Vector3();
    this.grounded = false;
    this.stepHeight = 0.45;
    this.stepDown = 0.32;
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }

  /** distance to ground below the feet (null when nothing within `maxDrop`) */
  groundY(maxDrop = this.stepDown + 0.16) {
    const originY = this.position.y + 0.14;
    _p.set(this.position.x, originY, this.position.z);
    // closest surface point in a small sphere below the feet
    const reach = 0.14 + maxDrop;
    const hit = this.bvh.closestPointToPoint(_p, _hit, 0, reach);
    if (!hit || hit.distance > reach) return null;
    if (hit.point.y > this.position.y + 0.05) return null; // wall / overhead, not ground
    return hit.point.y;
  }

  /** push the capsule out of every surface it overlaps */
  resolve() {
    const r = this.radius;
    const skin = 0.005;
    const y0 = this.position.y + r;
    const y1 = this.position.y + this.height - r;
    for (let iteration = 0; iteration < 3; iteration++) {
      let pushed = false;
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        _p.set(this.position.x, y0 + (y1 - y0) * t, this.position.z);
        const hit = this.bvh.closestPointToPoint(_p, _hit, 0, r + skin);
        if (!hit || hit.distance > r + skin) continue;
        _push.subVectors(_p, hit.point);
        if (_push.lengthSq() < 1e-9) _push.set(0, 1, 0);
        else _push.normalize();
        const depth = r + skin - hit.distance;
        if (depth <= 0) continue;
        // shallow upwards contact = simply standing on the floor. Resolving it
        // here would lift the capsule every frame; the ground snap handles it.
        if (_push.y > 0.55 && depth < 0.06) continue;
        this.position.addScaledVector(_push, depth + 1e-4);
        pushed = true;
      }
      if (!pushed) break;
    }
  }

  /**
   * True when there is floor under (x, z) at roughly the player's level.
   * Used by the ledge guard so the player can never walk off the end of a model
   * (the subway car ends abruptly, for instance) and fall into the void — that
   * fall/respawn loop was causing violent screen shake.
   */
  hasFloorAt(x, z, maxDrop = 0.34) {
    _p.set(x, this.position.y + 0.14, z);
    const reach = 0.14 + maxDrop;
    const hit = this.bvh.closestPointToPoint(_p, _hit, 0, reach);
    if (!hit || hit.distance > reach) return false;
    // a floor is something at (or just below) the feet, not a wall at eye level
    if (hit.point.y > this.position.y + 0.05) return false;
    return this.position.y - hit.point.y <= maxDrop;
  }

  /**
   * @param {number} dt seconds
   * @param {Vector3} wish normalised wish direction on the XZ plane
   * @param {{speed:number, jump?:boolean, accel?:number, fly?:boolean, ledgeGuard?:boolean}} opts
   */
  update(dt, wish, opts = {}) {
    const speed = opts.speed ?? 3.1;
    const accel = this.grounded ? (opts.accel ?? 14) : 3.5;
    const blend = Math.min(1, accel * dt);

    this.velocity.x += (wish.x * speed - this.velocity.x) * blend;
    this.velocity.z += (wish.z * speed - this.velocity.z) * blend;
    this.velocity.y -= this.gravity * dt;

    if (opts.jump && this.grounded) {
      this.velocity.y = 5.1;
      this.grounded = false;
    }

    const startX = this.position.x;
    const startZ = this.position.z;
    const wantX = this.velocity.x * dt;
    const wantZ = this.velocity.z * dt;
    const ledgeGuard = opts.ledgeGuard !== false && this.grounded;

    this.position.x += wantX;
    this.position.z += wantZ;
    this.resolve();

    // --- ledge guard: refuse to walk off an edge, slide along it instead ---
    if (ledgeGuard && !this.hasFloorAt(this.position.x, this.position.z)) {
      // try sliding on each axis independently
      this.position.x = startX + wantX;
      this.position.z = startZ;
      this.resolve();
      if (this.hasFloorAt(this.position.x, this.position.z)) {
        this.velocity.z = 0;
      } else {
        this.position.x = startX;
        this.position.z = startZ + wantZ;
        this.resolve();
        if (this.hasFloorAt(this.position.x, this.position.z)) {
          this.velocity.x = 0;
        } else {
          this.position.x = startX;
          this.position.z = startZ;
          this.resolve();
          this.velocity.x = 0;
          this.velocity.z = 0;
        }
      }
    }

    // --- step up over small obstacles (kerbs, rubble, stair treads) ---
    const wantLen = Math.hypot(wantX, wantZ);
    if (wantLen > 1e-5) {
      const movedLen = Math.hypot(this.position.x - startX, this.position.z - startZ);
      if (movedLen < wantLen * 0.72) {
        const savedX = this.position.x;
        const savedY = this.position.y;
        const savedZ = this.position.z;
        this.position.set(startX, this.position.y + this.stepHeight, startZ);
        this.position.x += wantX;
        this.position.z += wantZ;
        this.resolve();
        const floor = this.groundY(this.stepHeight + 0.14);
        const rise = floor === null ? Infinity : this.position.y - floor;
        if (floor !== null && rise >= -0.02 && rise <= this.stepHeight + 0.02) {
          this.position.y = floor + 0.002;
          this.velocity.y = 0;
        } else {
          this.position.set(savedX, savedY, savedZ);
        }
      }
    }

    // --- vertical integration ---
    this.position.y += this.velocity.y * dt;
    this.resolve();

    const floor = this.groundY();
    if (floor !== null && this.position.y - floor <= 0.22 && this.velocity.y <= 0.5) {
      this.position.y = floor + 0.001;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }

  /** true when a straight line between two points is unobstructed */
  lineOfSight(a, b) {
    const dir = _push.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.multiplyScalar(1 / len);
    _ray.origin.copy(a);
    _ray.direction.copy(dir);
    return !this.bvh.raycastFirst(_ray, DoubleSide, 0, len);
  }
}

const decodeBase64 = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class NavGrid {
  constructor(grid) {
    this.cell = grid.cell;
    this.nx = grid.nx;
    this.nz = grid.nz;
    this.originX = grid.originX;
    this.originZ = grid.originZ;
    this.bits = decodeBase64(grid.walkable);
    const heightBytes = decodeBase64(grid.heights);
    this.heights = new Int16Array(heightBytes.buffer, heightBytes.byteOffset, heightBytes.length / 2);
    this.count = this.nx * this.nz;
  }

  isWalkable(i, j) {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    const k = j * this.nx + i;
    return (this.bits[k >> 3] & (1 << (k & 7))) !== 0;
  }

  height(i, j) {
    const k = j * this.nx + i;
    const v = this.heights[k];
    return v === -32768 ? null : v / 100;
  }

  cellOf(x, z) {
    return {
      i: Math.floor((x - this.originX) / this.cell),
      j: Math.floor((z - this.originZ) / this.cell),
    };
  }

  center(i, j) {
    return {
      x: this.originX + (i + 0.5) * this.cell,
      y: this.height(i, j) ?? 0,
      z: this.originZ + (j + 0.5) * this.cell,
    };
  }

  nearestWalkable(i, j, maxRadius = 8) {
    if (this.isWalkable(i, j)) return { i, j };
    for (let r = 1; r <= maxRadius; r++) {
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (this.isWalkable(i + di, j + dj)) return { i: i + di, j: j + dj };
        }
      }
    }
    return null;
  }

  /** A* over the walkable cells; returns world-space waypoints (y = floor height) */
  findPath(from, to) {
    const start = this.cellOf(from.x, from.z);
    const goal = this.cellOf(to.x, to.z);
    const s = this.nearestWalkable(start.i, start.j);
    const g = this.nearestWalkable(goal.i, goal.j);
    if (!s || !g) return [];
    const w = this.nx;
    const startK = s.j * w + s.i;
    const goalK = g.j * w + g.i;
    if (startK === goalK) return [{ x: to.x, y: from.y, z: to.z }];

    const open = [startK];
    const cameFrom = new Int32Array(this.count).fill(-1);
    const gScore = new Float32Array(this.count).fill(Infinity);
    const fScore = new Float32Array(this.count).fill(Infinity);
    const closed = new Uint8Array(this.count);
    const inOpen = new Uint8Array(this.count);
    gScore[startK] = 0;
    const h = (k) => {
      const ki = k % w;
      const kj = (k - ki) / w;
      const dx = Math.abs(ki - g.i);
      const dz = Math.abs(kj - g.j);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    fScore[startK] = h(startK);

    const neighbours = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
    ];

    let guard = 0;
    while (open.length && guard++ < 20000) {
      let bestIdx = 0;
      for (let k = 1; k < open.length; k++) if (fScore[open[k]] < fScore[open[bestIdx]]) bestIdx = k;
      const current = open.splice(bestIdx, 1)[0];
      inOpen[current] = 0;
      if (current === goalK) {
        const path = [];
        let n = current;
        while (n !== -1) {
          const ni = n % w;
          const nj = (n - ni) / w;
          const c = this.center(ni, nj);
          path.push({ x: c.x, y: c.y, z: c.z });
          n = cameFrom[n];
        }
        path.reverse();
        path[path.length - 1] = { x: to.x, y: path[path.length - 1].y, z: to.z };
        return path;
      }
      closed[current] = 1;
      const ci = current % w;
      const cj = (current - ci) / w;
      const ch = this.height(ci, cj) ?? 0;
      for (const [di, dj, cost] of neighbours) {
        const ni = ci + di;
        const nj = cj + dj;
        if (!this.isWalkable(ni, nj)) continue;
        const nk = nj * w + ni;
        if (closed[nk]) continue;
        // no corner cutting through blocked cells
        if (di !== 0 && dj !== 0) {
          if (!this.isWalkable(ci + di, cj) || !this.isWalkable(ci, cj + dj)) continue;
        }
        const nh = this.height(ni, nj);
        if (nh === null) continue;
        const climb = Math.abs(nh - ch);
        if (climb > 0.5) continue;
        const tentative = gScore[current] + cost + climb * 2.5;
        if (tentative < gScore[nk]) {
          cameFrom[nk] = current;
          gScore[nk] = tentative;
          fScore[nk] = tentative + h(nk);
          if (!inOpen[nk]) {
            open.push(nk);
            inOpen[nk] = 1;
          }
        }
      }
    }
    return [];
  }
}
