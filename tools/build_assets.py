"""Build the game assets from the four Google Drive GLB files.

Steps per file
  1. KHR_materials_pbrSpecularGlossiness -> core metallic-roughness
     (diffuseFactor/diffuseTexture -> baseColor*, metallic=0, roughness=1-glossiness).
     Needed because the glTF spec extension is deprecated and three.js GLTFLoader no
     longer implements it: without the conversion the warehouse would render untextured.
     Diffuse colours, diffuse textures, UVs and double-sided flags are preserved.
  2. Textures: re-encode to WebP **lossless** when that is smaller, otherwise keep the
     original bytes.  Pixel data and resolution are never modified by default
     (--max-dim can opt in to a downscale; it is off unless requested).
  3. 32-bit indices -> 16-bit when all indices fit.
Geometry, UVs, normals, node transforms, sampler settings and materials are otherwise
untouched.  Every step is verified by tools/verify_assets.py.
"""
import io, json, os, struct, sys, shutil
import numpy as np
from PIL import Image

sys.path.insert(0, '/home/user/iiyama3D/tools')
from glb_io import read_glb, write_glb

DRIVE = {
    'abandoned_classroom': 'google_drive/abandoned_classroom.glb',
    'abandoned_city_street': 'google_drive/abandoned_city_street_for_games.glb',
    'abandoned_warehouse': 'google_drive/abandoned_warehouse_-_interior_scene.glb',
    'subway_train': 'google_drive/subway_train_interior.glb',
}


def fix_specgloss(g):
    """Convert deprecated spec/gloss materials to metallic-roughness in place."""
    n = 0
    for m in g.get('materials', []):
        sg = m.get('extensions', {}).pop('KHR_materials_pbrSpecularGlossiness', None)
        if sg is None:
            continue
        pbr = m.setdefault('pbrMetallicRoughness', {})
        if 'diffuseFactor' in sg:
            pbr.setdefault('baseColorFactor', sg['diffuseFactor'])
        if 'diffuseTexture' in sg:
            pbr.setdefault('baseColorTexture', sg['diffuseTexture'])
        pbr['metallicFactor'] = 0.0
        gloss = float(sg.get('glossinessFactor', 1.0))
        pbr['roughnessFactor'] = round(min(1.0, max(0.02, 1.0 - gloss)), 4)
        spec = sg.get('specularFactor', [1.0, 1.0, 1.0])
        if max(spec[:3]) >= 0.5:
            m.setdefault('extensions', {})['KHR_materials_specular'] = {
                'specularFactor': 1.0, 'specularColorFactor': [1.0, 1.0, 1.0]}
            eu = set(g.get('extensionsUsed', [])); eu.add('KHR_materials_specular')
            g['extensionsUsed'] = sorted(eu)
        else:
            m.setdefault('extensions', {})['KHR_materials_specular'] = {'specularFactor': 0.0}
            eu = set(g.get('extensionsUsed', [])); eu.add('KHR_materials_specular')
            g['extensionsUsed'] = sorted(eu)
        if not m['extensions']:
            m.pop('extensions')
        n += 1
    for key in ('extensionsUsed', 'extensionsRequired'):
        if key in g:
            g[key] = [e for e in g[key] if e != 'KHR_materials_pbrSpecularGlossiness']
            if not g[key]:
                g.pop(key)
    return n


def rebuild_bin(g, binch, images_new, extra_views):
    """Replace the image bufferViews with new blobs (preserving all other bytes)."""
    images = g.get('images', [])
    old_img_bv = set(im['bufferView'] for im in images)
    keep = [i for i in range(len(g['bufferViews'])) if i not in old_img_bv]
    remap = {}
    out = bytearray()
    views = []
    for old_i in keep:
        bv = dict(g['bufferViews'][old_i])
        while len(out) % 4:
            out += b'\x00'
        bv['byteOffset'] = len(out)
        out += binch[bv.get('byteOffset', 0) if False else 0:0]  # placeholder
        views.append((old_i, bv))
    # second pass with real source offsets
    out = bytearray()
    new_views = []
    src_offsets = {}
    for old_i in keep:
        bv = dict(g['bufferViews'][old_i])
        src_off = bv.get('byteOffset', 0)
        src_len = bv['byteLength']
        while len(out) % 4:
            out += b'\x00'
        bv['byteOffset'] = len(out)
        bv.setdefault('buffer', 0)
        new_views.append(bv)
        out += binch[src_off:src_off + src_len]
        remap[old_i] = len(new_views) - 1
    for data, im in images_new:
        while len(out) % 4:
            out += b'\x00'
        new_views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': len(data)})
        im['bufferView'] = len(new_views) - 1
        out += data
    for acc in g.get('accessors', []):
        if 'bufferView' in acc and acc['bufferView'] in remap:
            acc['bufferView'] = remap[acc['bufferView']]
    g['bufferViews'] = new_views
    g['images'] = images
    g['buffers'] = [{'byteLength': len(out)}]
    return bytes(out)


def process(src, dst, max_dim=None, verbose=True):
    g, binch = read_glb(src)
    nb = fix_specgloss(g)
    if verbose and nb:
        print(f'   pbrSpecularGlossiness -> metallic-roughness: {nb} materials')
    g.setdefault('samplers', [])
    if not g['samplers']:
        g['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    # ---------------- prune textures/images that no material references any more
    # (converting spec/gloss drops specular-glossiness textures; they must not be shipped)
    def material_texture_refs(mat):
        refs = []

        def walk(o):
            if isinstance(o, dict):
                if 'index' in o and isinstance(o['index'], int):
                    refs.append(o['index'])
                for k, v in o.items():
                    if k != 'index':
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(mat)
        return refs

    if g.get('textures'):
        used_tex = set()
        for mat in g.get('materials', []):
            used_tex.update(material_texture_refs(mat))
        if len(used_tex) < len(g['textures']):
            remap_tex = {}
            kept_tex = []
            for i, t in enumerate(g['textures']):
                if i in used_tex:
                    remap_tex[i] = len(kept_tex)
                    kept_tex.append(t)
            for mat in g.get('materials', []):
                def walk(o):
                    if isinstance(o, dict):
                        if 'index' in o and isinstance(o['index'], int) and o['index'] in remap_tex:
                            o['index'] = remap_tex[o['index']]
                        for v in o.values():
                            walk(v)
                    elif isinstance(o, list):
                        for v in o:
                            walk(v)

                walk(mat)
            print(f'   pruned {len(g["textures"]) - len(kept_tex)} unused textures')
            g['textures'] = kept_tex

    if g.get('images'):
        used = set()
        for tex in g.get('textures', []):
            if 'source' in tex:
                used.add(tex['source'])
            for ex in tex.get('extensions', {}).values():
                if isinstance(ex, dict) and 'source' in ex:
                    used.add(ex['source'])
        if len(used) < len(g['images']):
            remap_img = {}
            kept = []
            for i, im in enumerate(g['images']):
                if i in used:
                    remap_img[i] = len(kept)
                    kept.append(im)
            for tex in g.get('textures', []):
                if 'source' in tex:
                    tex['source'] = remap_img[tex['source']]
                for ex in tex.get('extensions', {}).values():
                    if isinstance(ex, dict) and 'source' in ex:
                        ex['source'] = remap_img[ex['source']]
            print(f'   pruned {len(g["images"]) - len(kept)} unreferenced images')
            g['images'] = kept

    # ---------------- textures
    images_new = []
    blobs = []
    webp_count = 0
    kept = 0
    resized = 0
    for im in g.get('images', []):
        bv = g['bufferViews'][im['bufferView']]
        o = bv.get('byteOffset', 0)
        raw = binch[o:o + bv['byteLength']]
        pil = Image.open(io.BytesIO(raw))
        need = pil.mode in ('RGBA', 'LA', 'PA') or (pil.mode == 'P' and 'transparency' in pil.info)
        conv = pil.convert('RGBA' if need else 'RGB')
        changed_res = False
        if max_dim and max(conv.size) > max_dim:
            s = max_dim / max(conv.size)
            conv = conv.resize((max(1, round(conv.size[0] * s)), max(1, round(conv.size[1] * s))),
                               Image.LANCZOS)
            changed_res = True
        buf = io.BytesIO()
        conv.save(buf, format='WEBP', lossless=True, quality=100, method=6, exact=True)
        data = buf.getvalue()
        if changed_res or len(data) < len(raw):
            # verify round trip is pixel identical (colour management aside)
            chk = Image.open(io.BytesIO(data)).convert(conv.mode)
            assert np.array_equal(np.asarray(conv), np.asarray(chk)), 'webp mismatch'
            images_new.append((data, {'name': im.get('name', ''), 'mimeType': 'image/webp'}))
            webp_count += 1
            resized += int(changed_res)
        else:
            images_new.append((raw, {'name': im.get('name', ''), 'mimeType': im.get('mimeType')}))
            kept += 1
    if verbose:
        print(f'   textures: {webp_count} lossless WebP, {kept} kept original'
              + (f', {resized} downscaled to <= {max_dim}px' if max_dim else ''))
    if g.get('images'):
        eu = set(g.get('extensionsUsed', []))
        er = set(g.get('extensionsRequired', []))
        if webp_count:
            eu.add('EXT_texture_webp'); er.add('EXT_texture_webp')
        g['extensionsUsed'] = sorted(eu)
        if er:
            g['extensionsRequired'] = sorted(er)
        for tex in g.get('textures', []):
            src_i = tex.pop('source', None)
            if src_i is None:
                continue
            if g['images'][src_i]['mimeType'] == 'image/webp':
                tex.setdefault('extensions', {})['EXT_texture_webp'] = {'source': src_i}
            else:
                tex['source'] = src_i
        binch = rebuild_bin(g, binch, images_new, None)
    # ---------------- uint16 indices
    conv_count = 0
    for mesh in g.get('meshes', []):
        for p in mesh['primitives']:
            if 'indices' not in p:
                continue
            acc = g['accessors'][p['indices']]
            if acc['componentType'] != 5125:
                continue
            nv = max(g['accessors'][v]['count'] for v in p['attributes'].values())
            if nv > 65535:
                continue
            bv = g['bufferViews'][acc['bufferView']]
            o = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
            arr = np.frombuffer(binch, dtype=np.uint32, count=acc['count'], offset=o)
            packed = arr.astype(np.uint16).tobytes()
            while len(binch) % 4:
                binch += b'\x00'
            g['bufferViews'].append({'buffer': 0, 'byteOffset': len(binch),
                                     'byteLength': len(packed), 'target': 34963})
            binch += packed
            acc['bufferView'] = len(g['bufferViews']) - 1
            acc['byteOffset'] = 0
            acc['componentType'] = 5123
            conv_count += 1
    if verbose and conv_count:
        print(f'   indices: {conv_count} primitives packed to uint16')
    for bv in g['bufferViews']:
        bv.setdefault('buffer', 0)
    g['buffers'] = [{'byteLength': len(binch)}]
    write_glb(dst, g, binch)
    return os.path.getsize(dst)


if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else '/tmp/assets'
    maxdim = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    os.makedirs(outdir, exist_ok=True)
    tot = 0
    for name, path in DRIVE.items():
        dst = os.path.join(outdir, os.path.basename(path))
        print(f'== {name}')
        n = process(path, dst, max_dim=(maxdim or None))
        tot += n
        print(f'   {os.path.getsize(path)/1e6:.2f} MB -> {n/1e6:.2f} MB')
    print(f'TOTAL {tot/1e6:.2f} MB')
