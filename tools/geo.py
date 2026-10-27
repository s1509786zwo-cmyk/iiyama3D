"""Geometry utilities: load GLB triangles in world space, spatial-hash raycasting.

Used for offline analysis / collision baking. No rendering.
"""
import io, json, math, struct, sys
import numpy as np
from PIL import Image

sys.path.insert(0, '/home/user/iiyama3D/tools')
from analyze import GLB


def load_triangles(path):
    """Return (V, T) where V is (N,3) float64 world-space vertices and T is (M,3) int indices."""
    G = GLB(path)
    g = G.g
    verts, tris = [], []
    base = 0

    def rec(ni, P):
        nonlocal base
        n = g['nodes'][ni]
        M = P @ G.node_matrix(n)
        if 'mesh' in n:
            for p in g['meshes'][n['mesh']]['primitives']:
                if p.get('mode', 4) != 4:
                    continue
                pos = G.acc(p['attributes']['POSITION']).astype(np.float64)
                v = (pos @ M[:3, :3].T) + M[:3, 3]
                if 'indices' in p:
                    ii = G.acc(p['indices']).astype(np.int64).reshape(-1)
                else:
                    ii = np.arange(len(v), dtype=np.int64)
                verts.append(v)
                tris.append(ii.reshape(-1, 3) + base)
                base += len(v)
        for c in n.get('children', []):
            rec(c, M)

    for r in g['scenes'][g.get('scene', 0)]['nodes']:
        rec(r, np.eye(4))
    V = np.concatenate(verts)
    T = np.concatenate(tris)
    return G, V, T


class TriangleIndex:
    """Uniform XZ bucket grid over triangles, for fast near-vertical / horizontal ray queries."""

    def __init__(self, V, T, cell=None):
        self.V = V
        self.T = T
        mn, mx = V.min(0), V.max(0)
        self.mn = mn
        span = mx - mn
        if cell is None:
            cell = max(span.max() / 220.0, 1e-6)
        self.cell = cell
        self.nx = max(1, int(math.ceil(span[0] / cell)) + 1)
        self.nz = max(1, int(math.ceil(span[2] / cell)) + 1)
        tri = V[T]
        tx0 = np.floor((tri[:, :, 0].min(1) - mn[0]) / cell).astype(np.int64)
        tx1 = np.floor((tri[:, :, 0].max(1) - mn[0]) / cell).astype(np.int64)
        tz0 = np.floor((tri[:, :, 2].min(1) - mn[2]) / cell).astype(np.int64)
        tz1 = np.floor((tri[:, :, 2].max(1) - mn[2]) / cell).astype(np.int64)
        np.clip(tx0, 0, self.nx - 1, out=tx0); np.clip(tx1, 0, self.nx - 1, out=tx1)
        np.clip(tz0, 0, self.nz - 1, out=tz0); np.clip(tz1, 0, self.nz - 1, out=tz1)
        cells = {}
        w = tx1 - tx0 + 1
        h = tz1 - tz0 + 1
        cnt = w * h
        order = np.repeat(np.arange(len(T)), cnt)
        # build local cell offsets
        idx = np.arange(len(T))
        starts = np.repeat(np.cumsum(cnt) - cnt, cnt)
        off = np.arange(cnt.sum()) - starts
        cx = tx0[order] + off % np.repeat(w, cnt)
        cz = tz0[order] + off // np.repeat(w, cnt)
        key = cx * self.nz + cz
        srt = np.argsort(key, kind='stable')
        key = key[srt]; tids = order[srt]
        uniq, start = np.unique(key, return_index=True)
        self.keys = uniq
        self.starts = np.append(start, len(key))
        self.tids = tids
        self.bbox = (mn, mx)

    def _lookup(self, xs, zs):
        mn, mx = self.bbox
        cell = self.cell
        cx = np.clip(np.floor((xs - mn[0]) / cell).astype(np.int64), 0, self.nx - 1)
        cz = np.clip(np.floor((zs - mn[2]) / cell).astype(np.int64), 0, self.nz - 1)
        key = cx * self.nz + cz
        pos = np.searchsorted(self.keys, key)
        pos = np.clip(pos, 0, len(self.keys) - 1)
        found = self.keys[pos] == key
        lo = self.starts[pos]
        hi = self.starts[pos + 1]
        return found, lo, hi

    def raycast(self, origins, dirs, max_hits=8, scale=1.0, far=None):
        """Vectorised Möller–Trumbore. origins/dirs: (K,3). Returns list of hit arrays.
        Each element: dict with sorted t values, normals and face indices.
        Cells are walked along the ray (DDA-ish sampling), so horizontal rays work too."""
        K = len(origins)
        out = []
        if far is None:
            far = float(np.linalg.norm(np.subtract(self.bbox[1], self.bbox[0]))) + 2.0
        step = self.cell * 0.5
        nsteps = int(far / step) + 2
        frac = np.arange(nsteps) * step
        for k in range(K):
            o = origins[k]; d = dirs[k]
            px = o[0] + d[0] * frac
            pz = o[2] + d[2] * frac
            found, lo, hi = self._lookup(px, pz)
            keep = found & (hi > lo)
            if not keep.any():
                out.append(None); continue
            cand = np.unique(np.concatenate([self.tids[a:b] for a, b in zip(lo[keep], hi[keep])]))
            if len(cand) == 0:
                out.append(None); continue
            tri = self.V[self.T[cand]]
            e1 = tri[:, 1] - tri[:, 0]
            e2 = tri[:, 2] - tri[:, 0]
            pv = np.cross(d, e2)
            det = (e1 * pv).sum(1)
            good = np.abs(det) > 1e-12
            inv = np.where(good, 1.0 / np.where(good, det, 1.0), 0.0)
            tv = o - tri[:, 0]
            u = (tv * pv).sum(1) * inv
            qv = np.cross(tv, e1)
            v = (qv * d).sum(1) * inv
            t = (e2 * qv).sum(1) * inv
            m = good & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-9)
            if not m.any():
                out.append(None); continue
            tt = t[m]
            nrm = np.cross(e1[m], e2[m])
            ln = np.linalg.norm(nrm, axis=1); ln[ln < 1e-12] = 1
            nrm = nrm / ln[:, None]
            order = np.argsort(tt)
            out.append(dict(t=tt[order] * scale,
                            n=nrm[order],
                            tri=cand[m][order],
                            t_ns=tt[order]))
        return out

    def surface_at(self, x, z, scale=1.0, above=1e9):
        """All downward hits at (x,z) starting from the top of the model."""
        mn, mx = self.bbox
        o = np.array([[x / scale, mx[1] + 1.0, z / scale]])
        d = np.array([[0.0, -1.0, 0.0]])
        r = self.raycast(o, d, scale=scale)[0]
        if r is None:
            return None
        # y of each hit
        y = o[0, 1] - r['t_ns'] * scale
        return y, r['n']


def measure(path, scale=1.0, verbose=True):
    G, V, T = load_triangles(path)
    return G, V * scale, T
