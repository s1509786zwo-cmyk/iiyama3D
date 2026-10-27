"""Bake navigation grid, collision mesh and a safe spawn point for one GLB map.

Outputs (into assets/maps/):
  <id>.collision.glb  : collision triangles only, already in game world space
  <id>.nav.json       : passable grid + floor heights + spawn + yaw (base64 packed)

World space convention
  p_world = R * (p_model * scale) + offset,  offset = -R * (spawn_model * scale)
  -> the spawn point is exactly the world origin, at floor height y = 0.
"""
import io, json, math, os, struct, sys, base64
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, '/home/user/iiyama3D/tools')
from analyze import GLB
from geo import load_triangles, TriangleIndex
from glb_io import write_glb


# ----------------------------------------------------------------- helpers
def euler_quat_deg(rx, ry, rz):
    """XYZ order Euler (degrees) -> quaternion (x,y,z,w), matching three.js 'XYZ'."""
    hx, hy, hz = [math.radians(a) / 2 for a in (rx, ry, rz)]
    cx, sx = math.cos(hx), math.sin(hx)
    cy, sy = math.cos(hy), math.sin(hy)
    cz, sz = math.cos(hz), math.sin(hz)
    # three.js Quaternion.setFromEuler with order XYZ
    qx = sx * cy * cz + cx * sy * sz
    qy = cx * sy * cz - sx * cy * sz
    qz = cx * cy * sz + sx * sy * cz
    qw = cx * cy * cz - sx * sy * sz
    return np.array([qx, qy, qz, qw])


def quat_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


class MapBaker:
    def __init__(self, path, scale=1.0, rot=(0, 0, 0), cell=0.25,
                 min_tri_area=0.0001, clearance=1.80, floor_band=None, label='',
                 floor_tol=0.35, probe_radius=0.28, max_tris=160000):
        self.path = path
        self.scale = scale
        self.q = euler_quat_deg(*rot)
        self.R = quat_matrix(self.q)
        self.cell = cell
        self.min_tri_area = min_tri_area
        self.clearance = clearance
        self.floor_band = floor_band
        self.floor_tol = floor_tol
        self.probe_radius = probe_radius
        self.label = label
        G, V, T = load_triangles(path)
        self.G = G
        # raw triangles in metric-rotated space (no offset yet)
        P = (V * scale) @ self.R.T
        # Collision triangle selection: drop sub-centimetre slivers, then honour a hard
        # budget so the runtime BVH stays cheap. The nav grid is baked from exactly the
        # retained set, so AI navigation can never disagree with what the player collides
        # with.
        tri = P[T]
        area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) * 0.5
        thr = min_tri_area
        keep = area >= thr
        if keep.sum() > max_tris:
            lo, hi = thr, float(area.max())
            for _ in range(40):
                mid = (lo + hi) / 2
                if (area >= mid).sum() > max_tris:
                    lo = mid
                else:
                    hi = mid
            thr = hi
            keep = area >= thr
            print(f'[{label}] triangle budget {max_tris}: adaptive min area {thr:.5f} m^2')
        self.P = P
        self.T = T[keep]
        self.area_threshold = thr
        self.tris_total = len(T)
        print(f'[{label}] collision/nav triangles: {keep.sum()}/{len(T)} '
              f'(min area {thr:.5f} m^2)')
        print(f'[{label}] triangles={len(T)} metric bounds min={np.round(self.P.min(0),2)} max={np.round(self.P.max(0),2)}')

    # ------------------------------------------------------------- floor level
    def detect_floor(self):
        """Main walkable floor = lowest large, up-facing, horizontal plane.
        Returns (floorY, band) with band = [floorY-0.4, floorY+2.4]."""
        P, T = self.P, self.T
        tri = P[T]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        ln = np.linalg.norm(n, axis=1); ln[ln < 1e-12] = 1
        ny = (n / ln[:, None])[:, 1]
        area = ln * 0.5
        up = ny > 0.7
        cen_y = tri.mean(1)[:, 1]
        ymin, ymax = cen_y[up].min(), cen_y[up].max()
        nb = max(8, int((ymax - ymin) / 0.05))
        hist, edges = np.histogram(cen_y[up], bins=nb, range=(ymin, ymax), weights=area[up])
        peak = hist.max()
        big = np.nonzero(hist >= peak * 0.35)[0]
        fy = float((edges[big[0]] + edges[big[0] + 1]) / 2)
        band = (fy - 0.40, fy + 2.40)
        print(f'   floor detected at y={fy:.2f} m  (band {band[0]:.2f}..{band[1]:.2f})')
        self.floor_y0 = fy
        return fy, band

    # ------------------------------------------------------------- nav grid
    def build_nav(self):
        """Per-cell terrain scan with exact raycasts (robust for noisy photo-scans).

        For every cell centre:
          1. cast a ray straight down from above the model and collect all hits,
          2. the floor is the LOWEST up-facing hit inside the floor band,
          3. cast a ray straight up from just above that floor: the free headroom
             decides walkability (desks, shelves, car bodies block the cell),
          4. probe 8 horizontal directions at hip height so cells hugging walls or
             pillars are rejected (the player needs ~0.3 m of body clearance).
        """
        P, T = self.P, self.T
        mn, mx = P.min(0), P.max(0)
        cell = self.cell
        x0, z0 = mn[0] - cell, mn[2] - cell
        nx = int(math.ceil((mx[0] - x0) / cell)) + 1
        nz = int(math.ceil((mx[2] - z0) / cell)) + 1
        self.origin = np.array([x0, z0])
        self.nx, self.nz = nx, nz
        print(f'   grid {nx} x {nz} cells @ {cell} m')
        if self.floor_band is None:
            fy0, self.floor_band = self.detect_floor()
        band = self.floor_band
        ti = self.tri_index()
        ytop = mx[1] + 1.0
        floor_y = np.full(nx * nz, np.nan, np.float32)
        head = np.zeros(nx * nz, np.float32)
        side = np.zeros(nx * nz, np.float32)
        d_ray = np.array([[0.0, -1.0, 0.0]])
        u_ray = np.array([[0.0, 1.0, 0.0]])
        # horizontal probes at hip height, 8 directions
        angs = np.radians(np.arange(0, 360, 45.0))
        hdirs = np.stack([-np.sin(angs), np.zeros_like(angs), -np.cos(angs)], 1)
        probe_len = self.probe_radius
        for a in range(nx):
            for b in range(nz):
                cx = x0 + (a + 0.5) * cell
                cz = z0 + (b + 0.5) * cell
                ci = a * nz + b
                o = np.array([[cx, ytop, cz]])
                r = ti.raycast(o, d_ray)[0]
                if r is None:
                    continue
                ys = ytop - r['t_ns']
                ok = (r['n'][:, 1] > 0.5) & (ys >= band[0]) & (ys <= band[1])
                if not ok.any():
                    continue
                fy = float(ys[ok].min())
                floor_y[ci] = fy
                # headroom
                o2 = np.array([[cx, fy + 0.03, cz]])
                rh = ti.raycast(o2, u_ray)[0]
                head[ci] = rh['t_ns'].min() if rh is not None else 99.0
                # body clearance, 8 directions
                o3 = np.tile(np.array([[cx, fy + 0.95, cz]]), (len(hdirs), 1))
                nrm = np.linalg.norm(hdirs, axis=1)
                r3 = ti.raycast(o3, hdirs / nrm[:, None])
                md = 99.0
                for rr in r3:
                    if rr is not None:
                        md = min(md, float(rr['t_ns'].min()))
                side[ci] = md
        self.floor = floor_y.reshape(nx, nz)
        self.headroom = head.reshape(nx, nz)
        self.sideclear = side.reshape(nx, nz)
        have_floor = ~np.isnan(self.floor)
        main = np.abs(np.nan_to_num(self.floor, nan=1e9) - self.floor_y0) <= self.floor_tol
        walk = have_floor & main & (self.headroom >= self.clearance) & (self.sideclear >= probe_len)
        self.walk_raw = walk
        print(f'   cells with floor: {have_floor.sum()} ; headroom>= {self.clearance}m: '
              f'{(self.headroom >= self.clearance).sum()} ; walkable: {walk.sum()}')
        return walk

    def smooth_nav(self, passes=1, min_open=3):
        """Morphological cleanup:
           1) closing (dilate 1, erode 1) fills single-cell holes made by thin detail and
              by sampling cracks between triangles,
           2) isolated specks are dropped unless >=70% of their 3x3 neighbourhood is walkable."""
        w = self.walk_raw.copy()

        def dilate(x):
            d = x.copy()
            d[1:, :] |= x[:-1, :]; d[:-1, :] |= x[1:, :]
            d[:, 1:] |= x[:, :-1]; d[:, :-1] |= x[:, 1:]
            return d

        def erode(x):
            e = x.copy()
            e[1:, :] &= x[:-1, :]; e[:-1, :] &= x[1:, :]
            e[:, 1:] &= x[:, :-1]; e[:, :-1] &= x[:, 1:]
            e[0, :] = False; e[-1, :] = False; e[:, 0] = False; e[:, -1] = False
            return e

        for _ in range(passes):
            w = erode(dilate(w))
        acc = np.zeros(w.shape, np.int32)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                acc += np.roll(np.roll(w, dx, 0), dz, 1)
        w = w & (acc >= 7)
        # drop cells on the very border of the grid (no data beyond)
        w[0, :] = False; w[-1, :] = False; w[:, 0] = False; w[:, -1] = False
        self.walk = w
        print(f'   walkable after closing/cleanup: {w.sum()}')
        return w

    def largest_region(self, max_step=0.35):
        """Flood fill with step tolerance; returns boolean mask of the largest region."""
        w = self.walk
        nx, nz = w.shape
        seen = np.zeros_like(w, bool)
        best = None
        best_n = 0
        for sx in range(nx):
            for sz in range(nz):
                if not w[sx, sz] or seen[sx, sz]:
                    continue
                stack = [(sx, sz)]
                seen[sx, sz] = True
                cells = []
                while stack:
                    a, b = stack.pop()
                    cells.append((a, b))
                    for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        na, nb = a + da, b + db
                        if 0 <= na < nx and 0 <= nb < nz and w[na, nb] and not seen[na, nb]:
                            if abs(self.floor[na, nb] - self.floor[a, b]) <= max_step:
                                seen[na, nb] = True
                                stack.append((na, nb))
                if len(cells) > best_n:
                    best_n = len(cells); best = cells
        region = np.zeros_like(w, bool)
        for a, b in best:
            region[a, b] = True
        self.region = region
        print(f'   largest connected region: {region.sum()} cells')
        return region

    # ------------------------------------------------------------- collision
    def bake_collision(self, spawn_world, yaw_deg=0.0, max_area_keep=None):
        P, T = self.P, self.T
        Vk = P.reshape(-1, 3)
        offset = -spawn_world
        Vw = Vk + offset
        tk = T
        used = np.unique(tk)
        remap = -np.ones(len(Vw), np.int64)
        remap[used] = np.arange(len(used))
        pos = Vw[used].astype(np.float32)
        idx = remap[tk].astype(np.uint32).reshape(-1)
        self.collision = dict(pos=pos, idx=idx, offset=offset)
        print(f'   collision mesh: {len(pos)} verts, {len(idx)//3} tris')
        return pos, idx

    def collision_glb(self, path, pos, idx):
        js = {
            'asset': {'version': '2.0', 'generator': 'iiyama3D bake'},
            'scene': 0,
            'scenes': [{'nodes': [0]}],
            'nodes': [{'name': 'collision', 'mesh': 0}],
            'meshes': [{'name': 'collision', 'primitives': [
                {'attributes': {'POSITION': 0}, 'indices': 1, 'mode': 4}]}],
            'accessors': [
                {'bufferView': 0, 'componentType': 5126, 'count': len(pos), 'type': 'VEC3',
                 'min': [float(x) for x in pos.min(0)], 'max': [float(x) for x in pos.max(0)]},
                {'bufferView': 1, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'},
            ],
            'bufferViews': [
                {'buffer': 0, 'byteOffset': 0, 'byteLength': int(pos.nbytes), 'target': 34962},
                {'buffer': 0, 'byteOffset': int(pos.nbytes), 'byteLength': int(idx.nbytes), 'target': 34963},
            ],
            'buffers': [{'byteLength': int(pos.nbytes + idx.nbytes)}],
        }
        write_glb(path, js, pos.tobytes() + idx.tobytes())
        return os.path.getsize(path)

    # ------------------------------------------------------------- spawn
    def pick_spawn(self, eye=1.65):
        """Choose an open cell in the biggest region; face the longest sight line."""
        region = self.region
        cell = self.cell
        w2 = region.copy()
        # distance transform (chebyshev, approximate) = iterations of erosion count
        dist = np.zeros(w2.shape, np.int32)
        cur = w2.copy()
        while cur.any():
            dist[cur] += 1
            e = cur.copy()
            e[1:, :] &= cur[:-1, :]; e[:-1, :] &= cur[1:, :]
            e[:, 1:] &= cur[:, :-1]; e[:, :-1] &= cur[:, 1:]
            e[1:, 1:] &= cur[:-1, :-1]; e[1:, :-1] &= cur[:-1, 1:]
            e[:-1, 1:] &= cur[1:, :-1]; e[:-1, :-1] &= cur[1:, 1:]
            cur = e
        # candidate cells: spacious, and prefer cells near the region centroid
        cells = np.argwhere(region)
        ys = np.array([self.floor[a, b] for a, b in cells])
        cen = cells.mean(0)
        best = None; best_score = -1e9
        stride = max(1, len(cells) // 240)
        cand = []
        for a, b in cells[::stride]:
            clear = dist[a, b] * cell
            if clear < 0.9:
                continue
            x = self.origin[0] + (a + 0.5) * cell
            z = self.origin[1] + (b + 0.5) * cell
            y = float(self.floor[a, b])
            view = np.mean([self.free_distance(np.array([x, y, z]), ang, 1.65, maxd=30)
                            for ang in range(0, 360, 45)])
            # the spawn view must not contain anything within arm's reach, otherwise the
            # player starts staring at a pole / wall corner
            # arm's-reach test at eye and waist height, 16 directions: reject cells that
            # have a pole / wall / seat right next to them
            near = min([self.free_distance(np.array([x, y, z]), ang, h, maxd=30)
                        for ang in [i * 22.5 for i in range(16)] for h in (0.95, 1.65)])
            if near < 1.1:
                continue
            score = (min(clear, 3.5) * 0.8 + min(view, 12.0) * 0.7
                     + min(near, 6.0) * 0.8 - 0.02 * math.hypot(a - cen[0], b - cen[1]))
            cand.append((score, a, b))
        cand.sort(reverse=True)
        if cand:
            best = (cand[0][1], cand[0][2])
        else:
            best = (int(cen[0]), int(cen[1]))
        a, b = best
        x = self.origin[0] + (a + 0.5) * cell
        z = self.origin[1] + (b + 0.5) * cell
        y = float(self.floor[a, b])
        pos = np.array([x, y, z])
        yaw = self.best_yaw(pos, eye)
        print(f'   spawn: {np.round(pos,2)}  clearance {dist[a,b]*cell:.2f} m  yaw {yaw:.0f} deg')
        return pos, yaw, dist

    def best_yaw(self, pos, eye=1.65):
        """Pick the heading with the longest clear sight line (never into a nearby wall)."""
        best_yaw, best_score = 0.0, -1e9
        for i in range(48):
            yaw = i * 7.5
            d = self.free_distance(pos, yaw, eye, maxd=45)
            # average of the two neighbouring headings keeps us from aiming at a gap edge
            d2 = self.free_distance(pos, yaw + 7.5, eye, maxd=45)
            d3 = self.free_distance(pos, yaw - 7.5, eye, maxd=45)
            score = d * 0.6 + min(d2, d3) * 0.4
            if score > best_score:
                best_score, best_yaw = score, yaw
        return best_yaw

    def tri_index(self):
        if not hasattr(self, '_ti'):
            self._ti = TriangleIndex(self.P, self.T, cell=max(self.cell, 0.25))
        return self._ti

    def free_distance(self, pos, yaw_deg, eye, maxd=40.0):
        ti = self.tri_index()
        th = math.radians(yaw_deg)
        # three.js convention: forward = (sin(yaw), 0, cos(yaw)) is -Z when yaw=180...
        # we use forward = (-sin, 0, -cos) so yaw=0 -> -Z
        d = np.array([-math.sin(th), 0.0, -math.cos(th)])
        o = pos + np.array([0, eye, 0])
        r = ti.raycast(o[None, :], d[None, :])[0]
        if r is None:
            return maxd
        return float(min(r['t_ns'].min(), maxd))

    # ------------------------------------------------------------- export
    def save_nav(self, path, spawn, yaw_deg, extra=None):
        walk = self.region
        floor = np.where(walk, self.floor, np.nan).astype(np.float32)
        # floor heights relative to spawn floor
        fy = floor - spawn[1]
        fq = np.where(np.isnan(fy), 0, np.round(fy / 0.02)).astype(np.int16)
        d = dict(
            nx=int(self.nx), nz=int(self.nz), cell=self.cell,
            floorTol=self.floor_tol, clearance=self.clearance,
            ox=float(self.origin[0] - spawn[0]), oz=float(self.origin[1] - spawn[2]),
            spawn=[0.0, 0.0, 0.0], spawnYawDeg=float(yaw_deg),
            walk=base64.b64encode(np.packbits(walk, axis=None).tobytes()).decode(),
            floorQ=base64.b64encode(fq.tobytes()).decode(),
        )
        if extra:
            d.update(extra)
        json.dump(d, open(path, 'w'))
        return d

    def debug_png(self, path, spawn=(0, 0, 0)):
        walk = self.region
        H, W = walk.shape[1], walk.shape[0]
        img = Image.new('RGB', (W * 4 + 8, H * 4 + 8), (10, 10, 12))
        dr = ImageDraw.Draw(img)
        for a in range(W):
            for b in range(H):
                col = (40, 90, 50) if walk[a, b] else (25, 25, 30)
                dr.rectangle([4 + a * 4, 4 + b * 4, 4 + a * 4 + 3, 4 + b * 4 + 3], fill=col)
        a = int((spawn[0] - self.origin[0]) / self.cell)
        b = int((spawn[2] - self.origin[1]) / self.cell)
        dr.ellipse([4 + a * 4 - 3, 4 + b * 4 - 3, 4 + a * 4 + 5, 4 + b * 4 + 5], fill=(255, 80, 80))
        img.save(path)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('glb'); ap.add_argument('--out', default='/tmp/bake')
    ap.add_argument('--label', default='map')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--rot', default='0,0,0')
    ap.add_argument('--cell', type=float, default=0.25)
    ap.add_argument('--minarea', type=float, default=0.0001)
    ap.add_argument('--clearance', type=float, default=1.8)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    b = MapBaker(a.glb, a.scale, [float(x) for x in a.rot.split(',')],
                 cell=a.cell, min_tri_area=a.minarea, clearance=a.clearance, label=a.label)
    b.build_nav(); b.smooth_nav(); b.largest_region()
    spawn, yaw, dist = b.pick_spawn()
    pos, idx = b.bake_collision(spawn, yaw)
    b.debug_png(f'{a.out}/{a.label}_nav.png', spawn)
    b.save_nav(f'{a.out}/{a.label}.nav.json', spawn, yaw)
    n = b.collision_glb(f'{a.out}/{a.label}.collision.glb', pos, idx)
    meta = dict(id=a.label, source=os.path.basename(a.glb), scale=a.scale,
                rotDeg=[float(x) for x in a.rot.split(',')],
                offset=[round(float(v), 5) for v in b.collision['offset']],
                spawnModel=[round(float(v), 4) for v in (spawn - b.collision['offset'])],
                spawnWorld=[0.0, 0.0, 0.0], yawDeg=yaw,
                floorYModel=round(float(b.floor_y0), 4),
                boundsWorld=[[round(float(v), 3) for v in b.P.min(0) + b.collision['offset']],
                             [round(float(v), 3) for v in b.P.max(0) + b.collision['offset']]],
                collisionTris=int(len(idx) // 3),
                totalTris=int(len(b.T)))
    json.dump(meta, open(f'{a.out}/{a.label}.bake.json', 'w'), indent=1)
    print(f'   bake metadata -> {a.out}/{a.label}.bake.json')
    print(f'   collision glb {n/1e6:.2f} MB ; nav png written')
