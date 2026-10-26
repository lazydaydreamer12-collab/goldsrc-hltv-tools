"""The quantizer (QP) an H.264 encoder chose for each frame, read from the slice headers without decoding.

QP runs from 0 (best) to 51 (worst). Game footage looks clean at about 20-28 and visibly blocky from about 38. The
video export uses this to tell whether a browser's encoder starved some stretches of bits (Firefox's does).

    r = Reader(sps_nal, pps_nal)        # parameter sets, NAL header byte included
    r.frame_qp(sample)                  # one AVCC sample (4-byte NAL lengths) -> QP of its first slice, or None
    report(qps, fps)                    # -> summary dict for the export's message
"""
import struct


class Bits:
    def __init__(self, data):
        out, z = bytearray(), 0
        for x in data:                       # drop emulation-prevention bytes (00 00 03)
            if z >= 2 and x == 3:
                z = 0
                continue
            out.append(x)
            z = z + 1 if x == 0 else 0
        self.d, self.p = bytes(out), 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.p >> 3] >> (7 - (self.p & 7))) & 1)
            self.p += 1
        return v

    def ue(self):
        z = 0
        while self.u(1) == 0:
            z += 1
        return (1 << z) - 1 + self.u(z)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def parse_sps(nal):
    r = Bits(nal[1:64])
    prof = r.u(8)
    r.u(8); r.u(8); r.ue()
    if prof in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        cf = r.ue()
        if cf == 3:
            r.u(1)
        r.ue(); r.ue(); r.u(1)
        if r.u(1):                           # scaling matrices
            for i in range(8 if cf != 3 else 12):
                if r.u(1):
                    last, nxt = 8, 8
                    for _ in range(16 if i < 6 else 64):
                        if nxt:
                            nxt = (last + r.se() + 256) % 256
                        last = nxt or last
    s = {'log2_frame_num': r.ue() + 4, 'poc_type': r.ue()}
    if s['poc_type'] == 0:
        s['log2_poc_lsb'] = r.ue() + 4
    elif s['poc_type'] == 1:
        s['delta_always_zero'] = r.u(1)
        r.se(); r.se()
        for _ in range(r.ue()):
            r.se()
    r.ue(); r.u(1); r.ue(); r.ue()
    s['frame_mbs_only'] = r.u(1)
    return s


def parse_pps(nal):
    r = Bits(nal[1:64])
    r.ue(); r.ue()
    p = {'cabac': r.u(1), 'bottom_field_poc': r.u(1)}
    if r.ue() + 1 > 1:
        raise ValueError('slice groups')
    r.ue(); r.ue()
    p['weighted_pred'] = r.u(1)
    p['weighted_bipred'] = r.u(2)
    p['init_qp'] = 26 + r.se()
    r.se(); r.se(); r.u(1); r.u(1)
    p['redundant'] = r.u(1)
    return p


class Reader:
    def __init__(self, sps_nal, pps_nal):
        self.sps, self.pps = parse_sps(sps_nal), parse_pps(pps_nal)

    def slice_qp(self, nal):
        sps, pps = self.sps, self.pps
        ref_idc, typ = (nal[0] >> 5) & 3, nal[0] & 31
        r = Bits(nal[1:96])
        r.ue()
        st = r.ue() % 5
        r.ue()
        r.u(sps['log2_frame_num'])
        field = 0
        if not sps['frame_mbs_only']:
            field = r.u(1)
            if field:
                r.u(1)
        if typ == 5:
            r.ue()
        if sps['poc_type'] == 0:
            r.u(sps['log2_poc_lsb'])
            if pps['bottom_field_poc'] and not field:
                r.se()
        elif sps['poc_type'] == 1 and not sps.get('delta_always_zero'):
            r.se()
            if pps['bottom_field_poc'] and not field:
                r.se()
        if pps['redundant']:
            r.ue()
        if st == 1:
            r.u(1)
        if st in (0, 1, 3) and r.u(1):
            r.ue()
            if st == 1:
                r.ue()
        if st not in (2, 4):
            for _ in range(2 if st == 1 else 1):
                if r.u(1):
                    while r.ue() != 3:
                        r.ue()
        if (pps['weighted_pred'] and st in (0, 3)) or (pps['weighted_bipred'] == 1 and st == 1):
            return None                      # a prediction weight table would follow: not worth parsing here
        if ref_idc:
            if typ == 5:
                r.u(1); r.u(1)
            elif r.u(1):
                while True:
                    op = r.ue()
                    if op == 0:
                        break
                    if op in (1, 3):
                        r.ue()
                    if op == 2:
                        r.ue()
                    if op in (3, 6):
                        r.ue()
                    if op == 4:
                        r.ue()
        if pps['cabac'] and st not in (2, 4):
            r.ue()
        return pps['init_qp'] + r.se()

    def frame_qp(self, sample):
        o = 0
        while o + 4 <= len(sample):
            n = struct.unpack_from('>I', sample, o)[0]
            nal = sample[o + 4:o + 4 + n]
            if nal and (nal[0] & 31) in (1, 5):
                try:
                    q = self.slice_qp(nal)
                except (IndexError, ValueError):
                    return None
                return q if q is not None and 0 <= q <= 51 else None
            o += 4 + n
        return None


BLOCKY = 38          # from here on a frame looks heavily compressed


def report(qps, fps):
    """Summary of per-frame QPs: share of blocky frames and the worst stretches (start second, end second, max QP)."""
    good = [q for q in qps if q is not None]
    if not good:
        return None
    bad = [i for i, q in enumerate(qps) if q is not None and q >= BLOCKY]
    spans = []
    for i in bad:
        t = i / fps
        if spans and t - spans[-1][1] <= 1.0:
            spans[-1][1] = t
            spans[-1][2] = max(spans[-1][2], qps[i])
        else:
            spans.append([t, t, qps[i]])
    spans.sort(key=lambda s: (-s[2], -(s[1] - s[0])))
    return {'frames': len(qps), 'mean': round(sum(good) / len(good), 1), 'max': max(good),
            'blocky': len(bad), 'blocky_pct': round(100 * len(bad) / len(qps), 2),
            'worst': [[round(a, 1), round(b, 1), q] for a, b, q in spans[:6]], 'spans': len(spans)}
