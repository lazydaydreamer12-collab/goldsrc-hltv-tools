"""GoldSrc BSP (version 30) -> one binary blob for the browser viewer: triangles with texture + lightmap UVs grouped
per model and texture, decoded textures (from the BSP or the map's WADs), a lightmap atlas, and the hull-0 BSP tree
(planes / nodes / leaf contents) so the viewer can ray-test line of sight against the real map geometry.

    python -I bsp.py <map.bsp> [halflife_dir]      # print a summary
"""
import glob
import json
import os
import struct
import sys

LUMP_ENTITIES, LUMP_PLANES, LUMP_TEXTURES, LUMP_VERTICES, LUMP_VISIBILITY, LUMP_NODES, LUMP_TEXINFO, LUMP_FACES, \
    LUMP_LIGHTING, LUMP_CLIPNODES, LUMP_LEAVES, LUMP_MARKSURFACES, LUMP_EDGES, LUMP_SURFEDGES, LUMP_MODELS = range(15)

SKIP_TEXTURES = {'aaatrigger', 'clip', 'null', 'origin', 'skip', 'hint', 'bevel', 'noclip', 'clipbevel', 'clipsky'}
CONTENTS_SOLID, CONTENTS_SKY = -2, -6


def cstr(b):
    i = b.find(b'\0')
    return (b if i < 0 else b[:i]).decode('latin1')


def parse_entities(text):
    ents, cur, key = [], None, None
    tok = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '{':
            cur = {}
            i += 1
        elif c == '}':
            if cur is not None:
                ents.append(cur)
            cur = None
            i += 1
        elif c == '"':
            j = text.find('"', i + 1)
            if j < 0:
                break
            tok.append(text[i + 1:j])
            if len(tok) == 2 and cur is not None:
                cur[tok[0]] = tok[1]
                tok = []
            i = j + 1
        else:
            i += 1
    return ents


def decode_miptex(data, off, length=None):
    """(name, width, height, rgba bytes, has_alpha) from a miptex at data[off], or None if it has no pixels."""
    name = cstr(data[off:off + 16])
    w, h = struct.unpack_from('<II', data, off + 16)
    o0, o1, o2, o3 = struct.unpack_from('<4I', data, off + 24)
    if not o0 or w == 0 or h == 0 or w > 4096 or h > 4096:
        return name, w, h, None, False
    pix = data[off + o0:off + o0 + w * h]
    pal_off = off + o3 + (w // 8) * (h // 8) + 2
    pal = data[pal_off:pal_off + 768]
    if len(pix) < w * h or len(pal) < 768:
        return name, w, h, None, False
    alpha = name.startswith('{')
    lut = []
    for i in range(256):
        r, g, b = pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]
        if alpha and i == 255:
            lut.append(b'\0\0\0\0')
        else:
            lut.append(bytes((r, g, b, 255)))
    rgba = b''.join(lut[p] for p in pix)
    return name, w, h, rgba, alpha


class WadIndex:
    """All WAD3 files under the Half-Life folder, looked up by texture name (map's own WAD list first)."""

    def __init__(self, halflife_dir):
        self.files = {}
        if halflife_dir and os.path.isdir(halflife_dir):
            for path in glob.glob(os.path.join(halflife_dir, '*', '*.wad')):
                self.files.setdefault(os.path.basename(path).lower(), []).append(path)
        self.cache = {}

    def lumps(self, path):
        if path in self.cache:
            return self.cache[path]
        out = {}
        try:
            data = open(path, 'rb').read()
            if data[:4] in (b'WAD3', b'WAD2'):
                n, ofs = struct.unpack_from('<ii', data, 4)
                for i in range(n):
                    pos, disk, size, typ, comp = struct.unpack_from('<iiibb', data, ofs + i * 32)
                    name = cstr(data[ofs + i * 32 + 16:ofs + i * 32 + 32]).lower()
                    if typ == 0x43 and comp == 0:
                        out[name] = (data, pos)
        except OSError:
            pass
        self.cache[path] = out
        return out

    def find(self, texname, wad_order):
        texname = texname.lower()
        tried = set()
        for wad in wad_order:
            for path in self.files.get(wad.lower(), []):
                tried.add(path)
                hit = self.lumps(path).get(texname)
                if hit:
                    return hit
        for paths in self.files.values():
            for path in paths:
                if path in tried:
                    continue
                hit = self.lumps(path).get(texname)
                if hit:
                    return hit
        return None


def find_map(halflife_dir, gamedir, mapname):
    """Locate maps/<mapname>.bsp in the mod, its _downloads/_addon/_hd folders, then valve."""
    if not halflife_dir:
        return None
    cands = []
    g = gamedir or 'valve'
    for d in (g + '_addon', g + '_downloads', g, g + '_hd', 'valve_addon', 'valve_downloads', 'valve'):
        cands.append(os.path.join(halflife_dir, d, 'maps', mapname + '.bsp'))
    for c in cands:
        if os.path.exists(c):
            return c
    hits = glob.glob(os.path.join(halflife_dir, '*', 'maps', mapname + '.bsp'))
    return hits[0] if hits else None


class Atlas:
    """Shelf packer for face lightmaps (1-texel border so bilinear filtering doesn't bleed)."""

    def __init__(self, size):
        self.w = self.h = size
        self.x = self.y = self.row = 0
        self.pix = bytearray(size * size * 3)

    def place(self, w, h):
        bw, bh = w + 2, h + 2
        if self.x + bw > self.w:
            self.x, self.y, self.row = 0, self.y + self.row, 0
        if self.y + bh > self.h or bw > self.w:
            return None
        pos = (self.x + 1, self.y + 1)
        self.x += bw
        self.row = max(self.row, bh)
        return pos

    def blit(self, x, y, w, h, rgb):
        W = self.w
        for j in range(-1, h + 1):
            sj = min(max(j, 0), h - 1)
            row = rgb[sj * w * 3:(sj + 1) * w * 3]
            row = row[:3] + row + row[-3:]
            o = ((y + j) * W + x - 1) * 3
            self.pix[o:o + len(row)] = row


def build(bsp_path, halflife_dir=None):
    """Returns (meta dict, list of binary buffers) describing the map for the viewer."""
    d = open(bsp_path, 'rb').read()
    version = struct.unpack_from('<i', d, 0)[0]
    if version != 30:
        raise ValueError('%s: BSP version %d (GoldSrc maps are 30)' % (bsp_path, version))
    lumps = [struct.unpack_from('<ii', d, 4 + i * 8) for i in range(15)]

    def lump(i):
        o, n = lumps[i]
        return o, n

    eo, en = lump(LUMP_ENTITIES)
    ents = parse_entities(d[eo:eo + en].decode('latin1', 'replace'))
    world = ents[0] if ents else {}
    wads = [os.path.basename(w.replace('\\', '/')) for w in world.get('wad', '').split(';') if w.strip()]

    po, pn = lump(LUMP_PLANES)
    planes = [struct.unpack_from('<4fi', d, po + i * 20) for i in range(pn // 20)]
    vo, vn = lump(LUMP_VERTICES)
    verts = [struct.unpack_from('<3f', d, vo + i * 12) for i in range(vn // 12)]
    eo2, en2 = lump(LUMP_EDGES)
    edges = [struct.unpack_from('<2H', d, eo2 + i * 4) for i in range(en2 // 4)]
    so, sn = lump(LUMP_SURFEDGES)
    surfedges = struct.unpack_from('<%di' % (sn // 4), d, so)
    to, tn = lump(LUMP_TEXINFO)
    texinfo = [struct.unpack_from('<8fii', d, to + i * 40) for i in range(tn // 40)]
    fo, fn = lump(LUMP_FACES)
    faces = [struct.unpack_from('<HhiHh4Bi', d, fo + i * 20) for i in range(fn // 20)]
    lo, ln = lump(LUMP_LIGHTING)
    light = d[lo:lo + ln]
    mo, mn = lump(LUMP_MODELS)
    models = [struct.unpack_from('<9f4i3i', d, mo + i * 64) for i in range(mn // 64)]
    no, nn = lump(LUMP_NODES)
    nodes = [struct.unpack_from('<ihh6hHH', d, no + i * 24) for i in range(nn // 24)]
    lfo, lfn = lump(LUMP_LEAVES)
    leaf_contents = [struct.unpack_from('<i', d, lfo + i * 28)[0] for i in range(lfn // 28)]

    # textures
    xo, xn = lump(LUMP_TEXTURES)
    nmip = struct.unpack_from('<i', d, xo)[0] if xn else 0
    mip_offs = struct.unpack_from('<%di' % nmip, d, xo + 4) if nmip else ()
    wadidx = WadIndex(halflife_dir)
    textures = []           # dicts for meta
    tex_blobs = []
    missing = []
    for i, mo_ in enumerate(mip_offs):
        if mo_ < 0:
            textures.append({'name': '', 'w': 16, 'h': 16, 'data': -1, 'alpha': False})
            continue
        name, w, h, rgba, alpha = decode_miptex(d, xo + mo_)
        if rgba is None:
            hit = wadidx.find(name, wads)
            if hit:
                n2, w2, h2, rgba, alpha = decode_miptex(hit[0], hit[1])
                if rgba is not None:
                    w, h = w2, h2
        entry = {'name': name, 'w': w or 16, 'h': h or 16, 'data': -1, 'alpha': alpha}
        if rgba is not None and name.lower() not in SKIP_TEXTURES and not name.lower().startswith('sky'):
            entry['data'] = len(tex_blobs)
            tex_blobs.append(rgba)
        elif rgba is None:
            missing.append(name)
        textures.append(entry)

    # faces -> triangles, grouped by model then texture
    atlas = Atlas(1024)
    for size in (1024, 2048, 4096):
        atlas = Atlas(size)
        ok = True
        lm_place = {}
        for fi, f in enumerate(faces):
            lm_place[fi] = None
        # first pass: sizes
        dims = {}
        for fi, f in enumerate(faces):
            plane, side, firstedge, numedges, ti, s0, s1, s2, s3, lightofs = f
            if ti < 0 or ti >= len(texinfo) or lightofs < 0:
                continue
            sx, sy, sz, so_, tx, ty, tz, to_, mip, flags = texinfo[ti]
            smin = tmin = 1e9
            smax = tmax = -1e9
            for k in range(numedges):
                se = surfedges[firstedge + k]
                v = verts[edges[se][0]] if se >= 0 else verts[edges[-se][1]]
                s = v[0] * sx + v[1] * sy + v[2] * sz + so_
                t = v[0] * tx + v[1] * ty + v[2] * tz + to_
                smin, smax, tmin, tmax = min(smin, s), max(smax, s), min(tmin, t), max(tmax, t)
            bs0, bt0 = int(_floor(smin / 16)), int(_floor(tmin / 16))
            bs1, bt1 = int(_ceil(smax / 16)), int(_ceil(tmax / 16))
            w, h = bs1 - bs0 + 1, bt1 - bt0 + 1
            if w <= 0 or h <= 0 or w > 64 or h > 64:
                continue
            dims[fi] = (bs0, bt0, w, h)
        order = sorted(dims, key=lambda k: -dims[k][3])
        for fi in order:
            w, h = dims[fi][2], dims[fi][3]
            pos = atlas.place(w, h)
            if pos is None:
                ok = False
                break
            lm_place[fi] = pos
        if ok:
            break
    white = atlas.place(2, 2)
    atlas.blit(white[0], white[1], 2, 2, b'\xff' * 12)

    positions, uvs, luvs, indices = [], [], [], []
    model_ranges = []
    face_model = {}
    for mi, m in enumerate(models):
        firstface, numfaces = m[14], m[15]
        for fi in range(firstface, firstface + numfaces):
            face_model[fi] = mi
    groups = {}   # (model, texture) -> [indices]
    nv = 0
    for fi, f in enumerate(faces):
        plane, side, firstedge, numedges, ti, s0, s1, s2, s3, lightofs = f
        if fi not in face_model or ti < 0 or ti >= len(texinfo) or numedges < 3:
            continue
        sx, sy, sz, so_, tx, ty, tz, to_, mip, flags = texinfo[ti]
        tex = textures[mip] if 0 <= mip < len(textures) else None
        if tex is None:
            continue
        lname = tex['name'].lower()
        if lname in SKIP_TEXTURES or lname.startswith('sky'):
            continue
        place = lm_place.get(fi)
        if place is not None:
            bs0, bt0, w, h = dims[fi]
            # sum the face's light styles (style 0 = normal light; others at their default full brightness)
            nstyles = sum(1 for s in (s0, s1, s2, s3) if s != 255)
            size = w * h * 3
            rgb = bytearray(light[lightofs:lightofs + size])
            if len(rgb) < size:
                rgb = bytearray(b'\x80' * size)
            for k in range(1, nstyles):
                extra = light[lightofs + k * size:lightofs + (k + 1) * size]
                if len(extra) == size and (s0, s1, s2, s3)[k] < 32:
                    rgb = bytearray(min(255, a + b) for a, b in zip(rgb, extra))
            atlas.blit(place[0], place[1], w, h, bytes(rgb))
        base = nv
        for k in range(numedges):
            se = surfedges[firstedge + k]
            v = verts[edges[se][0]] if se >= 0 else verts[edges[-se][1]]
            s = v[0] * sx + v[1] * sy + v[2] * sz + so_
            t = v[0] * tx + v[1] * ty + v[2] * tz + to_
            positions.extend(v)
            uvs.extend((s / tex['w'], t / tex['h']))
            if place is not None:
                lu = (s / 16.0 - bs0 + 0.5 + place[0]) / atlas.w
                lv = (t / 16.0 - bt0 + 0.5 + place[1]) / atlas.h
            else:
                lu = (white[0] + 1.0) / atlas.w
                lv = (white[1] + 1.0) / atlas.h
            luvs.extend((lu, lv))
            nv += 1
        g = groups.setdefault((face_model[fi], mip), [])
        for k in range(1, numedges - 1):
            g.extend((base, base + k, base + k + 1))
    draws = []
    for mi in range(len(models)):
        ranges = []
        for (gm, tex), idx in sorted(groups.items()):
            if gm != mi:
                continue
            ranges.append([tex, len(indices), len(idx)])
            indices.extend(idx)
        draws.append(ranges)

    meta = {
        'name': os.path.splitext(os.path.basename(bsp_path))[0],
        'wads': wads,
        'sky': world.get('skyname', ''),
        'textures': [{'name': t['name'], 'w': t['w'], 'h': t['h'], 'data': t['data'], 'alpha': t['alpha'],
                      'water': t['name'].startswith('!')} for t in textures],
        'missing_textures': missing,
        'models': [{'mins': list(m[0:3]), 'maxs': list(m[3:6]), 'origin': list(m[6:9]), 'headnode': m[9],
                    'draws': draws[i]} for i, m in enumerate(models)],
        'atlas': [atlas.w, atlas.h],
        'counts': {'vertices': nv, 'indices': len(indices), 'planes': len(planes), 'nodes': len(nodes),
                   'leaves': len(leaf_contents)},
        'spawns': [[float(x) for x in e.get('origin', '0 0 0').split()[:3]] for e in ents
                   if e.get('classname', '').startswith('info_player')][:64],
    }
    bufs = {
        'positions': struct.pack('<%df' % len(positions), *positions),
        'uvs': struct.pack('<%df' % len(uvs), *uvs),
        'luvs': struct.pack('<%df' % len(luvs), *luvs),
        'indices': struct.pack('<%dI' % len(indices), *indices),
        'lightmap': bytes(atlas.pix),
        'planes': struct.pack('<%df' % (len(planes) * 4), *[x for p in planes for x in p[:4]]),
        'nodes': struct.pack('<%di' % (len(nodes) * 3), *[x for nd in nodes for x in (nd[0], nd[1], nd[2])]),
        'leaves': struct.pack('<%di' % len(leaf_contents), *leaf_contents),
    }
    for i, blob in enumerate(tex_blobs):
        bufs['tex%d' % i] = blob
    return meta, bufs


def _floor(x):
    import math
    return math.floor(x)


def _ceil(x):
    import math
    return math.ceil(x)


def pack(meta, bufs):
    """Blob layout: b'GSMP', uint32 json length, json, then each buffer 4-byte aligned (offsets in json)."""
    layout = {}
    body = bytearray()
    for name, b in bufs.items():
        while len(body) % 4:
            body.append(0)
        layout[name] = [len(body), len(b)]
        body += b
    meta = dict(meta, buffers=layout)
    js = json.dumps(meta, separators=(',', ':')).encode()
    head = b'GSMP' + struct.pack('<I', len(js)) + js
    pad = (-len(head)) % 4
    head += b' ' * pad
    # offsets are relative to the start of the body
    return head + bytes(body), len(head)


if __name__ == '__main__':
    import time
    t0 = time.time()
    meta, bufs = build(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    blob, hl = pack(meta, bufs)
    print(meta['name'], meta['counts'], 'atlas', meta['atlas'], 'textures', len(meta['textures']),
          'missing', meta['missing_textures'][:10], 'wads', meta['wads'], '%.1f MB' % (len(blob) / 1e6),
          '%.1f s' % (time.time() - t0))
