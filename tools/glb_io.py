"""Minimal GLB (binary glTF) reader / writer used by the asset pipeline."""
import json, struct


def read_glb(path):
    """Return (json_chunk: dict, bin_chunk: bytes)."""
    with open(path, 'rb') as f:
        d = f.read()
    magic, ver, ln = struct.unpack_from('<4sII', d, 0)
    if magic != b'glTF':
        raise ValueError(f'{path}: not a GLB file')
    if ver != 2:
        raise ValueError(f'{path}: unsupported glTF version {ver}')
    off = 12
    js = None
    binch = b''
    while off < ln:
        clen, ctype = struct.unpack_from('<I4s', d, off)
        off += 8
        chunk = d[off:off + clen]
        off += clen
        if ctype == b'JSON':
            js = json.loads(chunk)
        elif ctype[:3] == b'BIN':
            binch = chunk
    if js is None:
        raise ValueError(f'{path}: missing JSON chunk')
    # normalise missing optional arrays so callers can index them freely
    for key in ('accessors', 'bufferViews', 'meshes', 'materials', 'textures', 'images',
                'nodes', 'scenes', 'samplers'):
        js.setdefault(key, [])
    return js, binch


def write_glb(path, js, binch):
    jb = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = binch + b'\x00' * ((4 - len(binch) % 4) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(jb), b'JSON'))
        f.write(jb)
        f.write(struct.pack('<I4s', len(bb), b'BIN\x00'))
        f.write(bb)
    return total
