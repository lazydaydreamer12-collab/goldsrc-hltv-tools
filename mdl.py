"""GoldSrc studio model loader (.mdl version 10: Half-Life, TFC, CS...) for the demo viewer.

Reads a model with its separate texture file (<name>T.mdl) and sequence group files (<name>01.mdl...), and packs
what web/viewer.js needs to draw and animate it the way the game's StudioModelRenderer does:

    python -I mdl.py <model.mdl>          # prints a summary

Blob layout: b'GSMD', u32 JSON length, JSON, padding to 4 bytes, then the buffers listed in JSON 'buffers' ([offset,
length] from the start of the body):
  verts    float32 x 10 per vertex: position and normal in their bone's space (3 + 3), s and t in texels (2),
           vertex bone, normal bone
  indices  uint16 (uint32 when JSON 'big') triangle list; JSON 'bodyparts'[].models[].draws = [skinref, first, count]
  tex<i>   uint8: width*height palette indices, then the 768-byte RGB palette
  anim<s>  int16 per blend, frame, bone: the 6 raw channel values, i.e. HL's run-length animation data unpacked
           (the game scales them by bone.scale and adds bone.value)
"""
import glob
import json
import os
import struct
import sys

MAGIC = b'GSMD'
FORMAT_VERSION = 1


class ModelError(Exception):
    pass


def cstr(b, o, n):
    s = b[o:o + n]
    z = s.find(b'\0')
    return (s if z < 0 else s[:z]).decode('latin-1')


def game_dirs(halflife_dir, gamedir):
    """Folders searched for game files, in the engine's order (the mod's add-ons and downloads first, valve last)."""
    g = gamedir or 'valve'
    out = []
    for d in (g + '_addon', g + '_downloads', g, g + '_hd', 'valve_addon', 'valve_downloads', 'valve'):
        p = os.path.join(halflife_dir, d)
        if p not in out and os.path.isdir(p):
            out.append(p)
    return out


def find_model(halflife_dir, gamedir, relpath):
    """A game path like 'models/player/scout/scout.mdl' -> the file, or None. Rejects anything outside models/."""
    rel = relpath.replace('\\', '/').strip('/')
    parts = rel.split('/')
    if not rel.lower().endswith('.mdl') or parts[0].lower() != 'models' or any(p in ('', '.', '..') for p in parts) \
            or ':' in rel:
        return None
    if not halflife_dir:
        return None
    for d in game_dirs(halflife_dir, gamedir):
        p = os.path.join(d, *parts)
        if os.path.isfile(p):
            return p
    hits = glob.glob(os.path.join(glob.escape(halflife_dir), '*', *[glob.escape(p) for p in parts]))
    return hits[0] if hits else None


def player_model_path(name):
    """A userinfo model name ('scout') -> its game path."""
    name = os.path.basename(name.strip().replace('\\', '/'))
    return 'models/player/%s/%s.mdl' % (name, name)


class Studio:
    def __init__(self, path):
        self.path = path
        self.dir = os.path.dirname(path)
        self.base = os.path.splitext(os.path.basename(path))[0]
        d = self.d = open(path, 'rb').read()
        if len(d) < 244 or d[:4] != b'IDST':
            raise ModelError('%s is not a studio model' % os.path.basename(path))
        ver = self.i(4)
        if ver != 10:
            raise ModelError('%s is studio model version %d, not 10' % (os.path.basename(path), ver))
        self.td = d
        if self.i(180) == 0:
            # textures live in <name>T.mdl
            for cand in (os.path.join(self.dir, self.base + 'T.mdl'), os.path.join(self.dir, self.base + 't.mdl')):
                if os.path.isfile(cand):
                    td = open(cand, 'rb').read()
                    if td[:4] == b'IDST':
                        self.td = td
                    break
        self.groups = {}

    def i(self, o, d=None):
        return struct.unpack_from('<i', self.d if d is None else d, o)[0]

    def f(self, o):
        return struct.unpack_from('<f', self.d, o)[0]

    def v3(self, o):
        return list(struct.unpack_from('<3f', self.d, o))

    def group_data(self, g):
        """Animation data of sequence group g: the model itself for 0, <name>01.mdl... for the rest."""
        if g == 0:
            return self.d
        if g not in self.groups:
            p = os.path.join(self.dir, '%s%02d.mdl' % (self.base, g))
            self.groups[g] = open(p, 'rb').read() if os.path.isfile(p) else None
        return self.groups[g]

    # ------------------------------------------------------------------ parse
    def build(self):
        d = self
        nb, bi = d.i(140), d.i(144)
        if nb <= 0 or nb > 128:
            raise ModelError('bad bone count %d' % nb)
        bones = []
        for k in range(nb):
            o = bi + k * 112
            bones.append({
                'name': cstr(self.d, o, 32), 'parent': d.i(o + 32), 'flags': d.i(o + 36),
                'ctl': list(struct.unpack_from('<6i', self.d, o + 40)),
                'value': list(struct.unpack_from('<6f', self.d, o + 64)),
                'scale': list(struct.unpack_from('<6f', self.d, o + 88)),
            })
        controllers = []
        nc, ci = d.i(148), d.i(152)
        for k in range(nc):
            o = ci + k * 24
            controllers.append({'bone': d.i(o), 'type': d.i(o + 4), 'start': d.f(o + 8), 'end': d.f(o + 12),
                                'rest': d.i(o + 16), 'index': d.i(o + 20)})
        hitboxes = []
        nh, hi = d.i(156), d.i(160)
        for k in range(nh):
            o = hi + k * 32
            hitboxes.append({'bone': d.i(o), 'group': d.i(o + 4), 'min': d.v3(o + 8), 'max': d.v3(o + 20)})
        attachments = []
        na, ai = d.i(212), d.i(216)
        for k in range(na):
            o = ai + k * 88
            attachments.append({'bone': d.i(o + 36), 'org': d.v3(o + 40)})

        # textures and skin families (from T.mdl when the model has none)
        td = self.td
        nt, ti = self.i(180, td), self.i(184, td)
        nsr, nsf, si = self.i(192, td), self.i(196, td), self.i(200, td)
        textures, bufs = [], {}
        for k in range(nt):
            o = ti + k * 80
            name = cstr(td, o, 64)
            flags, w, h, idx = struct.unpack_from('<4i', td, o + 64)
            t = {'name': name, 'flags': flags, 'w': w, 'h': h, 'data': -1, 'remap': remap_ranges(name)}
            if 0 < w <= 4096 and 0 < h <= 4096 and idx > 0 and idx + w * h + 768 <= len(td):
                bufs['tex%d' % k] = td[idx:idx + w * h + 768]
                t['data'] = k
            textures.append(t)
        skins = []
        for fam in range(max(nsf, 0)):
            skins.append([struct.unpack_from('<h', td, si + (fam * nsr + r) * 2)[0] for r in range(nsr)])
        if not skins:
            skins = [[]]

        # geometry: every model of every body part, one vertex per strip/fan corner
        verts = []
        indices = []
        bodyparts = []
        nbp, bpi = d.i(204), d.i(208)
        for b in range(nbp):
            bo = bpi + b * 76
            part = {'name': cstr(self.d, bo, 64), 'base': max(1, d.i(bo + 68)), 'models': []}
            for m in range(d.i(bo + 64)):
                mo = d.i(bo + 72) + m * 112
                part['models'].append({'name': cstr(self.d, mo, 64), 'draws': self.add_model(mo, verts, indices)})
            bodyparts.append(part)
        nverts = len(verts) // 10
        big = nverts > 65535

        # sequences
        ns, sqi = d.i(164), d.i(168)
        seqs = []
        for k in range(ns):
            o = sqi + k * 176
            nf = max(1, d.i(o + 56))
            nbl = max(1, d.i(o + 120))
            sq = {
                'label': cstr(self.d, o, 32), 'fps': d.f(o + 32), 'flags': d.i(o + 36), 'activity': d.i(o + 40),
                'frames': nf, 'motiontype': d.i(o + 68), 'motionbone': d.i(o + 72), 'linear': d.v3(o + 76),
                'blends': nbl, 'blendtype': d.i(o + 128), 'blendstart': d.f(o + 136), 'blendend': d.f(o + 144),
                'group': d.i(o + 156), 'anim': -1,
            }
            ad = self.group_data(sq['group'])
            if ad is not None:
                try:
                    bufs['anim%d' % k] = decode_anim(ad, d.i(o + 124), nb, nf, nbl)
                    sq['anim'] = k
                except (struct.error, IndexError):
                    pass
            seqs.append(sq)

        from array import array
        va = array('f', verts)
        ia = array('I' if big else 'H', indices)
        if sys.byteorder != 'little':
            va.byteswap()
            ia.byteswap()
        bufs['verts'] = va.tobytes()
        bufs['indices'] = ia.tobytes()
        meta = {
            'format': FORMAT_VERSION, 'name': cstr(self.d, 8, 64), 'file': os.path.basename(self.path),
            'eye': d.v3(76), 'flags': d.i(136), 'bones': bones, 'controllers': controllers, 'hitboxes': hitboxes,
            'attachments': attachments, 'textures': textures, 'skins': skins, 'bodyparts': bodyparts,
            'sequences': seqs, 'verts': nverts, 'big': big,
        }
        return meta, bufs

    def add_model(self, mo, verts, indices):
        """Appends one mstudiomodel_t's meshes; returns its draws [skinref, first index, index count]."""
        d = self.d
        nmesh, meshi = self.i(mo + 72), self.i(mo + 76)
        nv, vinfo, vi = self.i(mo + 80), self.i(mo + 84), self.i(mo + 88)
        nn, ninfo, ni = self.i(mo + 92), self.i(mo + 96), self.i(mo + 100)
        draws = []
        if nv <= 0:
            return draws
        for m in range(nmesh):
            me = meshi + m * 20
            tri, skinref = self.i(me + 4), self.i(me + 8)
            first = len(indices)
            p = tri
            for _ in range(100000):
                count = struct.unpack_from('<h', d, p)[0]
                p += 2
                if count == 0:
                    break
                fan = count < 0
                count = abs(count)
                base = len(verts) // 10
                for k in range(count):
                    v, n, s, t = struct.unpack_from('<4h', d, p)
                    p += 8
                    bone = d[vinfo + v] if 0 <= v < nv else 0
                    nbone = d[ninfo + n] if 0 <= n < nn else bone
                    x, y, z = struct.unpack_from('<3f', d, vi + v * 12) if 0 <= v < nv else (0.0, 0.0, 0.0)
                    a, b, c = struct.unpack_from('<3f', d, ni + n * 12) if 0 <= n < nn else (0.0, 0.0, 1.0)
                    verts.extend((x, y, z, a, b, c, float(s), float(t), float(bone), float(nbone)))
                for k in range(count - 2):
                    if fan:
                        indices.extend((base, base + k + 1, base + k + 2))
                    elif k & 1 == 0:
                        indices.extend((base + k, base + k + 1, base + k + 2))
                    else:
                        indices.extend((base + k + 1, base + k, base + k + 2))
            if len(indices) > first:
                draws.append([skinref, first, len(indices) - first])
        return draws


def decode_anim(ad, animindex, nbones, nframes, nblends):
    """Unpacks mstudioanim_t run-length channels into int16 [blend][frame][bone][6] (StudioCalcBoneQuaterion's reads)."""
    from array import array
    out = array('h', bytes(2 * nblends * nframes * nbones * 6))
    for bl in range(nblends):
        for b in range(nbones):
            ao = animindex + (bl * nbones + b) * 12
            offs = struct.unpack_from('<6H', ad, ao)
            for j in range(6):
                if offs[j] == 0:
                    continue
                p = ao + offs[j]
                k = 0
                base = (bl * nframes * nbones + b) * 6 + j
                step = nbones * 6
                guard = 0
                while k < nframes and guard < 100000:
                    guard += 1
                    valid, total = ad[p], ad[p + 1]
                    if total == 0:
                        break
                    for r in range(total):
                        if k >= nframes:
                            break
                        # inside the run's stored values, or the run repeats its last one
                        out[base + k * step] = struct.unpack_from('<h', ad, p + 2 * (r + 1 if r < valid else valid))[0]
                        k += 1
                    p += (valid + 1) * 2
    if sys.byteorder != 'little':
        out.byteswap()
    return out.tobytes()


def remap_ranges(name):
    """Player colour ranges [topStart, topEnd, bottomStart, bottomEnd] for DM_Base / RemapN_aaa_bbb_ccc textures."""
    n = os.path.splitext(os.path.basename(name))[0]
    low = n.lower()
    if low.startswith('dm_base'):
        return [160, 191, 192, 223]
    if not low.startswith('remap'):
        return None
    parts = n.split('_')
    nums = []
    for p in parts[1:]:
        if not p.isdigit():
            break
        nums.append(int(p))
    if len(nums) >= 3:
        a, b, c = nums[:3]
        return [a, b, b + 1, c] if b > a else [1, 0, b + 1, c]
    if len(nums) == 2:
        # RemapX_aaa_bbb: one range, taking the top colour
        return [nums[0], nums[1], 1, 0]
    return None


def build(path):
    return Studio(path).build()


def pack(meta, bufs):
    body = bytearray()
    layout = {}
    for name, b in bufs.items():
        while len(body) % 4:
            body.append(0)
        layout[name] = [len(body), len(b)]
        body.extend(b)
    meta = dict(meta, buffers=layout)
    js = json.dumps(meta, separators=(',', ':')).encode()
    head = MAGIC + struct.pack('<I', len(js)) + js
    while len(head) % 4:
        head += b' '
    return head + bytes(body)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    meta, bufs = build(sys.argv[1])
    blob = pack(meta, bufs)
    print('%s: %d bones, %d controllers, %d textures, %d skin families, %d sequences, %d verts, %d tris, %.0f KB' % (
        meta['file'], len(meta['bones']), len(meta['controllers']), len(meta['textures']), len(meta['skins']),
        len(meta['sequences']), meta['verts'], len(bufs['indices']) // (8 if meta['big'] else 6), len(blob) / 1024))
    for t in meta['textures']:
        print('  texture %-28s %4dx%-4d flags %d remap %s' % (t['name'], t['w'], t['h'], t['flags'], t['remap']))
    for k, s in enumerate(meta['sequences']):
        print('  seq %3d %-26s %3d frames %5.1f fps blends %d%s' % (k, s['label'], s['frames'], s['fps'], s['blends'],
                                                                  '' if s['anim'] >= 0 else '  (no data)'))


if __name__ == '__main__':
    main()
