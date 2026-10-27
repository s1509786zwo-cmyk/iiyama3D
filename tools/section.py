"""Slab cross-section renderer with a metric reference grid + 1.7 m human silhouette.
Used to validate the real-world scale of each map.
"""
import sys, math
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, '/home/user/iiyama3D/tools')
from geo import load_triangles


def section(path, scale, axis, at, thickness, out, px_per_m=160, pad=1.0,
            color=(200, 200, 200), bg=(12, 12, 14), grid=True):
    G, V, T = load_triangles(path)
    V = V * scale
    tri = V[T]
    # slab selection by centroid
    cen = tri.mean(1)
    ai = {'x': 0, 'z': 2}[axis]
    keep = np.abs(cen[:, ai] - at) < thickness
    tri = tri[keep]
    if len(tri) == 0:
        raise SystemExit('no triangles in slab')
    # 2D axes
    if axis == 'z':
        h_idx, v_idx = 0, 1   # horizontal X, vertical Y
    else:
        h_idx, v_idx = 2, 1
    # project all vertices; clip in slab direction by using centroid only (already)
    P = np.stack([tri[:, :, h_idx], tri[:, :, v_idx]], -1)  # (m,3,2)
    mn = P.reshape(-1, 2).min(0) - pad
    mx = P.reshape(-1, 2).max(0) + pad
    W = int((mx[0] - mn[0]) * px_per_m); H = int((mx[1] - mn[1]) * px_per_m)
    img = Image.new('RGB', (W, H), bg)
    dr = ImageDraw.Draw(img)

    def tx(p):
        return ((p[0] - mn[0]) * px_per_m, H - (p[1] - mn[1]) * px_per_m)

    # painter's order: sort by slab-normal depth (far first)
    depth = cen[keep][:, ai]
    order = np.argsort(-np.abs(depth - at))[::-1]
    for i in order:
        pts = [tx(P[i, 0]), tx(P[i, 1]), tx(P[i, 2])]
        dr.polygon(pts, outline=color)
    if grid:
        # metric grid, 1 m
        x = math.floor(mn[0])
        while x <= mx[1]:
            px = tx((x, 0))[0]
            dr.line([(px, 0), (px, H)], fill=(40, 70, 40) if x % 5 else (60, 120, 60))
            if x % 5 == 0:
                dr.text((px + 2, 2), f'{x}m', fill=(110, 190, 110))
            x += 1
        y = math.floor(mn[1])
        while y <= mx[1]:
            py = tx((0, y))[1]
            dr.line([(0, py), (W, py)], fill=(40, 70, 40) if y % 5 else (60, 120, 60))
            if y % 5 == 0:
                dr.text((2, py - 10), f'{y}m', fill=(110, 190, 110))
            y += 1
    return img, P, mn, mx


def human(dr, x0_m, y0_m, tx, height=1.7, width=0.42, col=(255, 90, 90)):
    """Draw a simple human silhouette standing on y0_m at x0_m."""
    def P(x, y):
        return tx((x0_m + x, y0_m + y))
    head_r = height * 0.075
    hy = height - head_r
    cx, cy = P(0, hy)
    r = head_r
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=2)
    dr.line([P(0, hy - head_r), P(0, height * 0.52)], fill=col, width=3)   # spine->hips
    dr.line([P(-width / 2, height * 0.72), P(width / 2, height * 0.72)], fill=col, width=3)  # shoulders
    dr.line([P(-width / 2, height * 0.72), P(-width / 2.6, height * 0.38)], fill=col, width=2)
    dr.line([P(width / 2, height * 0.72), P(width / 2.6, height * 0.38)], fill=col, width=2)
    dr.line([P(-0.09, height * 0.52), P(-0.11, 0)], fill=col, width=3)
    dr.line([P(0.09, height * 0.52), P(0.11, 0)], fill=col, width=3)
    # eye level marker at 1.65
    dr.line([P(-0.5, 1.65), P(0.5, 1.65)], fill=(90, 160, 255), width=1)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('glb'); ap.add_argument('out')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--axis', default='z')
    ap.add_argument('--at', type=float, default=0.0)
    ap.add_argument('--thick', type=float, default=0.4)
    ap.add_argument('--ppm', type=int, default=140)
    ap.add_argument('--human-at', type=float, default=None)
    a = ap.parse_args()
    img, P, mn, mx = section(a.glb, a.scale / 1.0, a.axis, a.at, a.thick, a.out, a.ppm)
    if a.human_at is not None:
        dr = ImageDraw.Draw(img)
        # place human on the lowest surface near human_at
        hx = a.human_at
        h_idx = 0 if a.axis == 'z' else 1
        verts = P.reshape(-1, 2)
        near = verts[np.abs(verts[:, 0] - hx) < 0.6]
        y0 = np.percentile(near[:, 1], 5) if len(near) else mn[1]
        def tx(p):
            return ((p[0] - mn[0]) * img.width / (mx[0] - mn[0]),
                    img.height - (p[1] - mn[1]) * img.height / (mx[1] - mn[1]))
        human(dr, hx, y0, tx)
    img.save(a.out)
    print('wrote', a.out, img.size, 'bounds', np.round(mn, 2), np.round(mx, 2))
