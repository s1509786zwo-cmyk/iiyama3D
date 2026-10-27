import * as THREE from 'three';

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Collision queries against the original map meshes.
 *
 * The meshes keep their authored geometry and get a BVH fitted at load time
 * (three-mesh-bvh), so the collision surface follows the visual surface
 * exactly - floors, walls, furniture, train interior - without extra invisible
 * colliders or hand-made proxies.
 */
export class CollisionWorld {
  constructor(meshes) {
    this.meshes = meshes;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this.ringDirs = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.ringDirs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
  }

  /** Low level ray cast against the map. */
  raycast(origin, direction, far = 1000, meshes = this.meshes) {
    this.raycaster.set(origin, direction);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0] : null;
  }

  allHits(origin, direction, far = 1000, meshes = this.meshes) {
    this.raycaster.set(origin, direction);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    return this.raycaster.intersectObjects(meshes, false);
  }

  /**
   * Finds the walkable floor of a column: the lowest upward-facing surface.
   * Casting straight down from above hits the roof first, so every hit is
   * inspected and the lowest floor-like surface wins (interior floors sit
   * below rooftops, tables and props).
   */
  floorSurface(x, z, startY, dist) {
    this._origin.set(x, startY, z);
    const hits = this.allHits(this._origin, DOWN, dist);
    let found = null;
    for (const hit of hits) {
      const n = hit.face?.normal;
      if (!n) continue;
      const worldNormal = n.clone().transformDirection(hit.object.matrixWorld);
      if (worldNormal.y > 0.62 && (!found || hit.point.y < found.y)) {
        found = { y: hit.point.y, normal: worldNormal, point: hit.point, object: hit.object };
      }
    }
    return found;
  }

  /** Highest surface at or below originY for the given column. */
  groundInfo(x, z, fromY, dist) {
    this._origin.set(x, fromY, z);
    const hit = this.raycast(this._origin, DOWN, dist);
    if (!hit) return null;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : UP;
    return { y: hit.point.y, normal: n, point: hit.point, object: hit.object };
  }

  /** Vertical clearance above a point (distance to ceiling). */
  ceilingInfo(x, z, fromY, dist) {
    this._origin.set(x, fromY, z);
    const hit = this.raycast(this._origin, UP, dist);
    if (!hit) return null;
    return { y: hit.point.y, clearance: hit.point.y - fromY };
  }

  /**
   * Free-space test for an upright capsule approximated by a ring of rays.
   * @returns {{blocked:boolean, hit?:object}}
   */
  isBlocked(pos, radius, height) {
    const heights = [0.32, Math.max(0.6, height * 0.55), height - 0.12];
    for (const h of heights) {
      for (const dir of this.ringDirs) {
        this._origin.set(pos.x, pos.y + h, pos.z);
        const hit = this.raycast(this._origin, dir, radius);
        if (hit && hit.distance < radius) return { blocked: true, hit };
      }
      // Overhead obstacle check at the top of the capsule.
      this._origin.set(pos.x + 0.02, pos.y + h, pos.z + 0.02);
    }
    return { blocked: false };
  }

  /**
   * Number of horizontal directions (of 8) the capsule can move in without
   * hitting anything. Used to make sure a spawn is never wedged in a corner.
   */
  freeDirections(pos, radius, height) {
    const heights = [0.34, Math.max(0.62, height * 0.55), height - 0.12];
    let free = 0;
    for (const dir of this.ringDirs) {
      let ok = true;
      for (const h of heights) {
        this._origin.set(pos.x, pos.y + h, pos.z);
        if (this.raycast(this._origin, dir, radius)) {
          ok = false;
          break;
        }
      }
      if (ok) free++;
    }
    return free;
  }

  /**
   * Attempts to move the capsule from `pos` by `delta`, resolving each axis
   * separately so the player slides along walls instead of sticking.
   * Mutates and returns `pos` (a clone is returned).
   */
  moveCapsule(pos, delta, radius, height, stepHeight = 0.35) {
    const out = pos.clone();
    const axes = ['x', 'z'];
    for (const axis of axes) {
      const amount = delta[axis];
      if (!amount) continue;
      const test = out.clone();
      test[axis] += amount;
      const { blocked } = this.isBlocked(test, radius, height);
      if (!blocked) {
        out[axis] = test[axis];
      } else {
        // Try a shorter move for a smoother slide against angled walls.
        const half = amount * 0.5;
        const test2 = out.clone();
        test2[axis] += half;
        if (!this.isBlocked(test2, radius, height).blocked) out[axis] = test2[axis];
      }
    }

    // Stepping up small ledges (stairs, kerbs) is resolved by the vertical
    // pass in Player.update(). Only refuse a move onto a surface that is too
    // high to step onto, and only for the axis that caused it.
    const ground = this.groundInfo(out.x, out.z, out.y + stepHeight + 0.35, stepHeight + 1.6);
    if (ground && ground.y - out.y > stepHeight) {
      const withoutX = pos.clone();
      withoutX.z = out.z;
      const gx = this.groundInfo(withoutX.x, withoutX.z, withoutX.y + stepHeight + 0.35, stepHeight + 1.6);
      const withoutZ = pos.clone();
      withoutZ.x = out.x;
      const gz = this.groundInfo(withoutZ.x, withoutZ.z, withoutZ.y + stepHeight + 0.35, stepHeight + 1.6);
      const okX = gx && gx.y - out.y <= stepHeight;
      const okZ = gz && gz.y - out.y <= stepHeight;
      if (okX) return withoutX;
      if (okZ) return withoutZ;
      return pos.clone();
    }
    return out;
  }

  /**
   * Samples a walkable grid over the map bounds - used for spawn validation,
   * collectible placement and enemy patrol nodes.
   */
  sampleWalkable(box, { spacing = 1.2, minClearance = 1.9, minClearanceLoose = 0.9, wallProbe = 0.58, maxCells = 40000 } = {}) {
    const cells = [];
    const startY = box.max.y + 0.5;
    const maxDrop = box.max.y - box.min.y + 2;
    const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / spacing));
    const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / spacing));
    const stride = Math.max(1, Math.ceil(Math.sqrt((nx * nz) / maxCells)));
    const step = spacing * stride;

    for (let x = box.min.x + step * 0.5; x <= box.max.x; x += step) {
      for (let z = box.min.z + step * 0.5; z <= box.max.z; z += step) {
        const floor = this.floorSurface(x, z, startY, maxDrop);
        if (!floor) continue;
        const floorY = floor.y;
        const ceil = this.ceilingInfo(x, z, floorY + 0.08, minClearance + 4);
        const clearance = ceil ? Math.max(0, ceil.clearance) : 99;
        if (clearance < minClearanceLoose) continue;

        let open = clearance >= minClearance;
        if (open) {
          for (let i = 0; i < 4; i++) {
            this._origin.set(x, floorY + 0.95, z);
            if (this.raycast(this._origin, this.ringDirs[i * 2], wallProbe)) {
              open = false;
              break;
            }
          }
        }
        cells.push({ x, y: floorY, z, clearance: Math.min(clearance, 30), open });
      }
    }
    return cells;
  }
}
