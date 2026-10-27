// Navigation grid baked from each map's real geometry (tools/bake.py).
// Provides: walkability queries, floor height, spawn reachability and A* pathing for the
// enemy AI. Pure data + maths, no DOM, so it is covered by the Node test-suite.

function unpackBits(b64, length) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return out;
}

export class NavGrid {
  constructor(json) {
    this.nx = json.nx;
    this.nz = json.nz;
    this.cell = json.cell;
    this.ox = json.ox;
    this.oz = json.oz;
    this.floorTol = json.floorTol ?? 0.35;
    const n = this.nx * this.nz;
    this.walk = unpackBits(json.walk, n);
    const raw = atob(json.floorQ);
    const q = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      q[i] = (raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    }
    this.floorQ = q;
    this.walkCount = 0;
    for (let i = 0; i < n; i++) if (this.walk[i]) this.walkCount++;
  }

  index(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return ix * this.nz + iz;
  }

  /** world (x,z) -> grid cell */
  cellOf(x, z) {
    const ix = Math.floor((x - this.ox) / this.cell);
    const iz = Math.floor((z - this.oz) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return null;
    return { ix, iz };
  }

  cellCenter(ix, iz) {
    return {
      x: this.ox + (ix + 0.5) * this.cell,
      z: this.oz + (iz + 0.5) * this.cell,
    };
  }

  isWalkable(ix, iz) {
    const i = this.index(ix, iz);
    return i >= 0 && this.walk[i] === 1;
  }

  /** floor height (world y) of a cell; null when not walkable */
  floorAt(ix, iz) {
    const i = this.index(ix, iz);
    if (i < 0 || !this.walk[i]) return null;
    return this.floorQ[i] * 0.02;
  }

  floorAtWorld(x, z) {
    const c = this.cellOf(x, z);
    return c ? this.floorAt(c.ix, c.iz) : null;
  }

  /** nearest walkable cell within `maxRings` (for nudging spawns / enemy positions) */
  nearestWalkable(x, z, maxRings = 6) {
    const c = this.cellOf(x, z);
    if (!c) return null;
    for (let r = 0; r <= maxRings; r++) {
      let best = null;
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = c.ix + dx;
          const iz = c.iz + dz;
          if (!this.isWalkable(ix, iz)) continue;
          const p = this.cellCenter(ix, iz);
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { ix, iz, x: p.x, z: p.z, y: this.floorAt(ix, iz) };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** A* on the grid; returns world-space waypoints or null */
  findPath(sx, sz, tx, tz, maxNodes = 12000) {
    const s = this.nearestWalkable(sx, sz);
    const g = this.nearestWalkable(tx, tz);
    if (!s || !g) return null;
    const n = this.nx * this.nz;
    const start = this.index(s.ix, s.iz);
    const goal = this.index(g.ix, g.iz);
    if (start === goal) return [{ x: g.x, z: g.z, y: this.floorAt(g.ix, g.iz) }];

    const open = new MinHeap();
    const gScore = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const h = (i) => {
      const ix = Math.floor(i / this.nz);
      const iz = i % this.nz;
      return Math.hypot(ix - g.ix, iz - g.iz) * this.cell;
    };
    gScore[start] = 0;
    open.push(start, h(start));
    let expanded = 0;
    while (open.size && expanded < maxNodes) {
      const cur = open.pop();
      if (cur === goal) return this._reconstruct(came, cur, g);
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      const cx = Math.floor(cur / this.nz);
      const cz = cur % this.nz;
      const cy = this.floorQ[cur];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.isWalkable(nx, nz)) continue;
          const ni = this.index(nx, nz);
          if (closed[ni]) continue;
          // no diagonal corner cutting
          if (dx && dz && (!this.isWalkable(cx + dx, cz) || !this.isWalkable(cx, cz + dz))) continue;
          const dy = Math.abs(this.floorQ[ni] - cy) * 0.02;
          if (dy > 0.4) continue;
          const step = Math.hypot(dx, dz) * this.cell;
          const tentative = gScore[cur] + step + dy * 0.5;
          if (tentative < gScore[ni]) {
            gScore[ni] = tentative;
            came[ni] = cur;
            open.push(ni, tentative + h(ni));
          }
        }
      }
    }
    return null;
  }

  _reconstruct(came, goal, goalCell) {
    const cells = [];
    let cur = goal;
    while (cur !== -1) {
      cells.push(cur);
      cur = came[cur];
    }
    cells.reverse();
    const out = [];
    const stride = Math.max(1, Math.floor(cells.length / 24));
    for (let k = 0; k < cells.length; k += stride) {
      const i = cells[k];
      const ix = Math.floor(i / this.nz);
      const iz = i % this.nz;
      const p = this.cellCenter(ix, iz);
      out.push({ x: p.x, z: p.z, y: this.floorAt(ix, iz) });
    }
    out.push({ x: goalCell.x, z: goalCell.z, y: this.floorAt(goalCell.ix, goalCell.iz) });
    return out;
  }

  /** true when (x,z) is on a walkable cell whose floor is close to y */
  isStandable(x, z, y, tolerance = 0.5) {
    const f = this.floorAtWorld(x, z);
    return f !== null && Math.abs(f - y) <= tolerance;
  }
}

class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, key) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(i, p);
      i = p;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastKey = this.keys.pop();
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.keys[l] < this.keys[m]) m = l;
        if (r < n && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(i, m);
        i = m;
      }
    }
    return top;
  }

  _swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
