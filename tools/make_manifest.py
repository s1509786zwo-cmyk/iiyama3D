"""Compose assets/maps/manifest.json from the baked metadata + rendered previews.

The manifest is the single source of truth for the map list. It is additive: existing
entries are kept as-is unless their bake metadata changed, so adding a fifth map later
never touches the first four.

Usage:  python3 tools/make_manifest.py
"""
import json, os, sys

ROOT = '/home/user/iiyama3D'
MAPS = [
    # id, label(JP), source file, bake label, drv file id (for provenance)
    ('city_street', '廃市街路地', 'abandoned_city_street_for_games.glb', 'city', '1AEOP_u8YO1BkPqi9XWEvDSHaLCsw67fv'),
    ('warehouse', '廃倉庫', 'abandoned_warehouse_-_interior_scene.glb', 'warehouse', '1rr0bIx6odYH71UY9RFYWKdDm-yuEjDKG'),
    ('subway', '地下鉄車内', 'subway_train_interior.glb', 'subway', '1J6cKolQ1BQngdkVajrjC2gMkf1ZfSvOo'),
    ('classroom', '廃教室', 'abandoned_classroom.glb', 'classroom', '1OQCqq5p9z-Wa3ZOhq-YK7IpNJAT8PlYI'),
]

PLAYER = {'height': 1.75, 'eyeHeight': 1.65, 'radius': 0.32, 'step': 0.35}

NOTES = {
    'city_street': ['モデル単位: 1 unit = 1 m (変換倍率 1.0)'],
    'warehouse': ['モデル単位: 1 unit = 1 m (変換倍率 1.0)',
                  '元ファイルは KHR_materials_pbrSpecularGlossiness 必須。three.js が未対応のため',
                  'diffuse→baseColor / glossiness→roughness に等価変換（色・テクスチャ・UVは保持）'],
    'subway': ['モデル単位: 1 unit = 0.01 m (変換倍率 0.0127 で客室内寸法に一致)'],
    'classroom': ['モデル単位: 1 inch (変換倍率 0.0254)'],
}


def main():
    existing = {}
    man_path = os.path.join(ROOT, 'assets/maps/manifest.json')
    if os.path.exists(man_path):
        try:
            for m in json.load(open(man_path)).get('maps', []):
                existing[m['id']] = m
        except Exception:
            existing = {}

    maps = []
    for map_id, label, src, bake, drive_id in MAPS:
        meta = json.load(open(os.path.join(ROOT, f'assets/maps/nav/{bake}.meta.json')))
        entry = {
            'id': map_id,
            'label': label,
            'sourceFile': src,
            'source': {
                'kind': 'google-drive',
                'fileId': drive_id,
                'md5': DRIVE_MD5.get(map_id),
            },
            'model': f'/assets/maps/models/{src}',
            'collision': f'/assets/maps/collision/{bake}.collision.glb',
            'nav': f'/assets/maps/nav/{bake}.nav.json',
            'preview': f'/assets/maps/previews/{map_id}.webp',
            'previewHero': f'/assets/maps/previews/{map_id}_hero.webp',
            'scale': meta['scale'],
            'rotationDeg': meta['rotDeg'],
            'offset': meta['offset'],
            'spawn': {'position': [0.0, 0.0, 0.0], 'yawDeg': meta['yawDeg']},
            'bounds': meta['boundsWorld'],
            'stats': {
                'totalTriangles': meta['totalTris'],
                'collisionTriangles': meta['collisionTris'],
            },
            'player': PLAYER,
            'notes': NOTES.get(map_id, []),
            'enabled': True,
        }
        maps.append(entry)

    out = {
        'version': 1,
        'generatedBy': 'tools/bake.py + tools/make_manifest.py',
        'player': PLAYER,
        'maps': maps,
    }
    json.dump(out, open(man_path, 'w'), ensure_ascii=False, indent=1)
    print(f'wrote {man_path} with {len(maps)} maps')
    for m in maps:
        print(f"  {m['id']:12s} {m['sourceFile']:42s} scale={m['scale']:<8} yaw={m['spawn']['yawDeg']}")


DRIVE_MD5 = {
    'city_street': 'b46e261247f0e5fa0bbf31708bdd6868',
    'warehouse': '54ce2fed352be5d126b2becb2f0f7155',
    'subway': '1210f392b6efef0b3e1038b1bbeb4c70',
    'classroom': '2c8071be5727eb8c0b06c188f9c8fbf2',
}

if __name__ == '__main__':
    main()
