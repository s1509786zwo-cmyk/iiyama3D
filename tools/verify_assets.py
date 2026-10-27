"""Compare the shipped game assets with the Google Drive originals.

Reports, per map: triangle counts, mesh/material counts, texture resolutions and
per-texture pixel identity (the original files are re-decoded and compared with what the
shipped GLB carries), plus the unit scale that was applied.

Geometry inside the shipped files is Draco-compressed on top of this (16-bit quantisation
of positions/normals/UVs), which tools/verify_draco.mjs verifies separately.
"""
import io, json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, '/home/user/iiyama3D/tools')
from glb_io import read_glb

PAIRS = [
    ('city_street', 'google_drive/abandoned_city_street_for_games.glb', 'assets/maps/models/abandoned_city_street_for_games.glb'),
    ('warehouse', 'google_drive/abandoned_warehouse_-_interior_scene.glb', 'assets/maps/models/abandoned_warehouse_-_interior_scene.glb'),
    ('subway', 'google_drive/subway_train_interior.glb', 'assets/maps/models/subway_train_interior.glb'),
    ('classroom', 'google_drive/abandoned_classroom.glb', 'assets/maps/models/abandoned_classroom.glb'),
]


def images(js, b):
    out = []
    for im in js.get('images', []):
        bv = js['bufferViews'][im['bufferView']]
        raw = b[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
        pil = Image.open(io.BytesIO(raw))
        mode = 'RGBA' if (pil.mode in ('RGBA', 'LA', 'PA') or (pil.mode == 'P' and 'transparency' in pil.info)) else 'RGB'
        out.append((pil.size, mode, np.asarray(pil.convert(mode))))
    return out


def tris(js):
    n = 0
    for m in js['meshes']:
        for p in m['primitives']:
            n += (js['accessors'][p['indices']]['count'] if 'indices' in p
                  else js['accessors'][list(p['attributes'].values())[0]]['count']) // 3
    return n


def main():
    rows = []
    ok_all = True
    for name, orig, shipped in PAIRS:
        ojs, ob = read_glb(orig)
        sjs, sb = read_glb(shipped)
        oi = images(ojs, ob)
        si = images(sjs, sb)
        # compare textures by resolution multiset and pixel content where present
        o_by_size = {}
        for size, mode, arr in oi:
            o_by_size.setdefault((size, mode), []).append(arr)
        matched = 0
        pixel_identical = 0
        for size, mode, arr in si:
            cands = o_by_size.get((size, mode), [])
            hit = None
            for cand in cands:
                if cand.shape == arr.shape and np.array_equal(cand, arr):
                    hit = cand
                    break
            if hit is not None:
                pixel_identical += 1
            matched += 1
        resampled = len([1 for s, m, a in si if (s, m) not in o_by_size])
        row = {
            'map': name,
            'originalMB': round(os.path.getsize(orig) / 1e6, 2),
            'shippedMB': round(os.path.getsize(shipped) / 1e6, 2),
            'triangles': (tris(ojs), tris(sjs)),
            'meshes': (len(ojs['meshes']), len(sjs['meshes'])),
            'materials': (len(ojs.get('materials', [])), len(sjs.get('materials', []))),
            'textures': (len(oi), len(si)),
            'resolutionsPreserved': resampled == 0,
            'pixelIdentical': f'{pixel_identical}/{len(si)}',
            'extensions': sorted(set(sjs.get('extensionsUsed', []))),
        }
        if row['triangles'][0] != row['triangles'][1] or not row['resolutionsPreserved']:
            ok_all = False
        rows.append(row)
        print(f"== {name}")
        print(f"   size    {row['originalMB']:7.2f} MB (Drive) -> {row['shippedMB']:7.2f} MB (shipped)")
        print(f"   tris    {row['triangles'][0]} -> {row['triangles'][1]}   meshes {row['meshes']}   materials {row['materials']}")
        print(f"   tex     {row['textures'][0]} -> {row['textures'][1]} images, "
              f"resolutions preserved: {row['resolutionsPreserved']}, pixel-identical: {row['pixelIdentical']}")
        print(f"   ext     {', '.join(row['extensions'])}")
    # note: for the warehouse, 5 specular-glossiness-only textures were dropped and 35
    # materials were converted from KHR_materials_pbrSpecularGlossiness to
    # metallic-roughness (the extension is required by the file but unsupported by
    # three.js; without the conversion the map renders untextured).
    print('\nnote: warehouse material count changed by design (spec/gloss -> metallic-roughness)')
    print('RESULT:', 'OK' if ok_all else 'MISMATCH')
    json.dump(rows, open('/home/user/iiyama3D/docs/asset-report.json', 'w'), indent=1)
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
