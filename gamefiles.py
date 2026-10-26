"""Game sounds and sprites for the demo viewer.

    find_file(halflife_dir, game, 'sound/weapons/sbarrel1.wav') -> path in the mod's folders (add-ons, downloads,
                                                                    the mod, then valve), like the engine searches
    wav_for_web(path) -> (16-bit PCM WAV bytes, loop start, loop end): GoldSrc WAVs are often 8-bit, and a 'cue '
                         chunk makes the engine loop them (from the cue point to the end, or for the ltxt length)
    sprite_blob(path) -> b'GSPR' + json + RGBA frames for a .spr (version 2)
"""
import json
import os
import struct

import mdl

ALLOWED = ('sound', 'sprites')


def find_file(halflife_dir, game, relpath):
    rel = relpath.replace('\\', '/').strip('/')
    parts = rel.split('/')
    if parts[0].lower() not in ALLOWED or any(p in ('', '.', '..') for p in parts) or ':' in rel or not halflife_dir:
        return None
    for d in mdl.game_dirs(halflife_dir, game):
        p = os.path.join(d, *parts)
        if os.path.isfile(p):
            return p
    return None


def wav_for_web(path):
    d = open(path, 'rb').read()
    if d[:4] != b'RIFF' or d[8:12] != b'WAVE':
        raise ValueError('not a WAV file')
    fmt = data = None
    cue = None
    loop_len = None
    o = 12
    while o + 8 <= len(d):
        cid, ln = d[o:o + 4], struct.unpack_from('<I', d, o + 4)[0]
        body = d[o + 8:o + 8 + ln]
        if cid == b'fmt ':
            fmt = struct.unpack_from('<HHIIHH', body)
        elif cid == b'data':
            data = body
        elif cid == b'cue ' and len(body) >= 28:
            cue = struct.unpack_from('<I', body, 4 + 20)[0]        # first cue point's sample offset
        elif cid == b'LIST' and body[:4] == b'adtl':
            p = 4
            while p + 8 <= len(body):
                sid, sl = body[p:p + 4], struct.unpack_from('<I', body, p + 4)[0]
                if sid == b'ltxt' and sl >= 8:
                    loop_len = struct.unpack_from('<I', body, p + 12)[0]
                p += 8 + sl + (sl & 1)
        o += 8 + ln + (ln & 1)
    if not fmt or data is None:
        raise ValueError('WAV without fmt/data')
    tag, ch, rate, _, _, bits = fmt
    if tag != 1 or bits not in (8, 16) or ch not in (1, 2):
        raise ValueError('unsupported WAV format (tag %d, %d bits, %d channels)' % (tag, bits, ch))
    if bits == 8:                            # unsigned 8 -> signed 16 (little-endian): the old byte becomes the high byte
        hi = data.translate(bytes((b - 128) & 255 for b in range(256)))
        pcm = bytearray(2 * len(data))
        pcm[1::2] = hi
        pcm = bytes(pcm)
    else:
        pcm = data[:len(data) & ~1]
    frames = len(pcm) // (2 * ch)
    loop_start = loop_end = None
    if cue is not None and cue < frames:
        loop_start = cue
        loop_end = min(frames, cue + loop_len) if loop_len else frames
    out = (b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVE' +
           b'fmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, rate * ch * 2, ch * 2, 16) +
           b'data' + struct.pack('<I', len(pcm)) + pcm)
    return out, loop_start, loop_end, rate


def sprite_blob(path):
    d = open(path, 'rb').read()
    if d[:4] != b'IDSP':
        raise ValueError('not a sprite')
    ver, typ, texfmt, radius, w, h, nframes, beamlen, sync = struct.unpack_from('<iiifiiifi', d, 4)
    if ver != 2:
        raise ValueError('sprite version %d (GoldSrc uses 2)' % ver)
    o = 40
    ncolors = struct.unpack_from('<h', d, o)[0]
    o += 2
    pal = d[o:o + ncolors * 3]
    o += ncolors * 3
    lut = []
    for i in range(256):
        r, g, b = pal[i * 3:i * 3 + 3] if i < ncolors else (0, 0, 0)
        if texfmt == 2:                      # SPR_INDEXALPHA: one colour (the last), alpha = index
            r, g, b = pal[(ncolors - 1) * 3:(ncolors - 1) * 3 + 3]
            a = i
        elif texfmt == 3:                    # SPR_ALPHTEST: index 255 is a hole (black, so filtering doesn't bleed its colour)
            a = 0 if i == 255 else 255
            if i == 255:
                r = g = b = 0
        else:
            a = 255
        lut.append(bytes((r, g, b, a)))
    frames, blobs = [], []
    total = 0

    def single(o, interval):
        nonlocal total
        ox, oy, fw, fh = struct.unpack_from('<iiii', d, o)
        o += 16
        px = d[o:o + fw * fh]
        rgba = b''.join(lut[p] for p in px)
        frames.append({'w': fw, 'h': fh, 'ox': ox, 'oy': oy, 'off': total, 'interval': interval})
        blobs.append(rgba)
        total += len(rgba)
        return o + fw * fh

    for _ in range(nframes):
        ftype = struct.unpack_from('<i', d, o)[0]
        o += 4
        if ftype == 0:
            o = single(o, 0.1)
        else:
            n = struct.unpack_from('<i', d, o)[0]
            o += 4
            intervals = struct.unpack_from('<%df' % n, d, o)
            o += 4 * n
            prev = 0.0
            for k in range(n):
                o = single(o, max(0.01, intervals[k] - prev))
                prev = intervals[k]
    meta = {'type': typ, 'format': texfmt, 'radius': radius, 'width': w, 'height': h, 'frames': frames}
    js = json.dumps(meta, separators=(',', ':')).encode()
    head = b'GSPR' + struct.pack('<I', len(js)) + js
    head += b' ' * ((-len(head)) % 4)
    return head + b''.join(blobs)
