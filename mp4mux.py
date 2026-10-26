"""Minimal MP4 / QuickTime MOV writer for the demo viewer's video export.

The browser encodes the frames itself (WebCodecs H.264 in AVCC form) and the sound (AAC where the browser has an AAC
encoder; Opus otherwise, e.g. Firefox; or plain 16-bit PCM for .mov) and posts the packets here; this writes them into
one file with the boxes players and editors need: ftyp, mdat, moov (mvhd + a trak per stream with
stsd/stts/ctts/stss/stsc/stsz/co64). Samples are written as they arrive, the index goes at the end.

    w = Mp4Writer(path, 'mp4' or 'mov', width, height, fps, avcc, audio=(sample_rate, channels, 'aac'|'opus'|'pcm'))
    w.add('video', data, pts_us, key)           # in decode order
    w.add('audio', data, pts_us, True, dur_us)  # an AAC/Opus packet, or a run of interleaved s16le PCM frames
    w.finish(config)                            # -> final path (config: AAC AudioSpecificConfig / OpusHead / None)
"""
import os
import struct
import time

import h264qp

QT_EPOCH = 2082844800                       # seconds from 1904-01-01 to 1970-01-01


def box(kind, *parts):
    body = b''.join(parts)
    return struct.pack('>I4s', 8 + len(body), kind) + body


def fullbox(kind, version, flags, *parts):
    return box(kind, struct.pack('>I', (version << 24) | flags), *parts)


MATRIX = struct.pack('>9I', 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)


def runs(values):
    out = []
    for v in values:
        if out and out[-1][1] == v:
            out[-1][0] += 1
        else:
            out.append([1, v])
    return out


class Track:
    """Samples, and the chunks holding them in the file (one sample per chunk, except PCM runs)."""

    def __init__(self, timescale):
        self.timescale = timescale
        self.sizes = []                     # per sample (empty for constant-size PCM)
        self.durations = []                 # per sample, in timescale units
        self.pts = []                       # per sample (video: composition offsets)
        self.keys = []
        self.chunk_offsets = []
        self.chunk_counts = []              # samples in each chunk
        self.const_size = 0
        self.count = 0

    def total(self):
        return sum(self.durations)


class Mp4Writer:
    def __init__(self, path, fmt, width, height, fps, avcc, audio=None):
        self.path = path
        self.fmt = 'mov' if fmt == 'mov' else 'mp4'
        self.width, self.height, self.fps = width, height, fps
        self.avcc = avcc
        self.inband = None                  # (SPS, PPS) found inside the first keyframe
        self.qp_reader = None               # h264qp.Reader, or False when the parameter sets can't be read
        self.qps = []                       # each frame's QP: the export's quality report
        self.quality = None
        self.audio = None
        if audio:
            rate, channels = int(audio[0]), int(audio[1])
            codec = audio[2] if len(audio) > 2 else 'aac'
            self.audio = (rate, channels, codec if codec in ('aac', 'opus', 'pcm') else 'aac')
        self.acfg = None
        self.video = Track(90000)
        self.vdelta = round(90000 / fps)
        self.atrack = Track(self.audio[0]) if self.audio else None
        if self.audio and self.audio[2] == 'pcm':
            self.atrack.const_size = 2 * self.audio[1]
        self.tmp = path + '.part'
        self.f = open(self.tmp, 'wb')
        if self.fmt == 'mov':
            self.f.write(box(b'ftyp', b'qt  ', struct.pack('>I', 0x200), b'qt  '))
        else:
            self.f.write(box(b'ftyp', b'isom', struct.pack('>I', 0x200), b'isom', b'iso2', b'avc1', b'mp41'))
        self.mdat_at = self.f.tell()
        self.f.write(struct.pack('>I4sQ', 1, b'mdat', 0))   # 64-bit size, patched in finish()

    def add(self, kind, data, pts_us, key, dur_us=None):
        if kind == 'video':
            if key and not self.inband:
                self.inband = inband_params(data)
            if self.qp_reader is None:
                self.qp_reader = qp_reader(self.inband, self.avcc)
            self.qps.append(self.qp_reader.frame_qp(data) if self.qp_reader else None)
            tr = self.video
            tr.sizes.append(len(data))
            tr.durations.append(self.vdelta)
            tr.pts.append(round(pts_us * 90000 / 1e6))
            tr.keys.append(bool(key))
            n = 1
        else:
            tr = self.atrack
            if tr is None:
                return
            rate, channels, codec = self.audio
            if codec == 'pcm':
                n = len(data) // tr.const_size
                if n <= 0:
                    return
                data = data[:n * tr.const_size]
                tr.count += n
            else:
                n = 1
                d = round(dur_us * rate / 1e6) if dur_us else (1024 if codec == 'aac' else 960)
                tr.sizes.append(len(data))
                tr.durations.append(d)
                tr.count += 1
        tr.chunk_offsets.append(self.f.tell())
        tr.chunk_counts.append(n)
        self.f.write(data)

    def abort(self):
        try:
            self.f.close()
        finally:
            try:
                os.remove(self.tmp)
            except OSError:
                pass

    def finish(self, config=None):
        if self.audio:
            rate, channels, codec = self.audio
            if codec == 'aac':
                self.acfg = config or aac_asc(rate, channels)
            elif codec == 'opus':
                self.acfg = dops(config, channels, rate)
        end = self.f.tell()
        self.f.seek(self.mdat_at + 8)
        self.f.write(struct.pack('>Q', end - self.mdat_at))
        self.f.seek(end)
        self.f.write(self.moov())
        self.f.close()
        os.replace(self.tmp, self.path)
        self.quality = h264qp.report(self.qps, self.fps)
        return self.path

    # ------------------------------------------------------------ boxes
    def moov(self):
        now = int(time.time()) + QT_EPOCH
        movie_ts = 1000
        dur_ms = round(self.video.total() * movie_ts / 90000)
        traks = [self.video_trak(now, movie_ts)]
        if self.atrack and self.atrack.chunk_offsets:
            traks.append(self.audio_trak(now, movie_ts))
        mvhd = fullbox(b'mvhd', 0, 0, struct.pack('>IIII', now, now, movie_ts, dur_ms),
                       struct.pack('>IH', 0x00010000, 0x0100), b'\0' * 10, MATRIX, b'\0' * 24,
                       struct.pack('>I', len(traks) + 1))
        return box(b'moov', mvhd, *traks)

    def hdlr(self, handler, name):
        # QuickTime names the component type ('mhlr' for media); ISO files keep it zero
        pre = b'mhlr' if self.fmt == 'mov' else b'\0\0\0\0'
        return fullbox(b'hdlr', 0, 0, pre, handler, b'\0' * 12, name.encode() + b'\0')

    def dinf(self):
        return box(b'dinf', fullbox(b'dref', 0, 0, struct.pack('>I', 1), fullbox(b'url ', 0, 1)))

    def tkhd(self, now, track_id, dur, volume, width, height):
        return fullbox(b'tkhd', 0, 3, struct.pack('>IIIII', now, now, track_id, 0, dur), b'\0' * 8,
                       struct.pack('>hhhH', 0, 0, volume, 0), MATRIX, struct.pack('>II', width << 16, height << 16))

    def mdhd(self, now, timescale, dur):
        return fullbox(b'mdhd', 0, 0, struct.pack('>IIII', now, now, timescale, dur), struct.pack('>HH', 0x55C4, 0))

    def stbl(self, tr, entry, sync=False, ctts=False):
        parts = [fullbox(b'stsd', 0, 0, struct.pack('>I', 1), entry)]
        if tr.const_size:                                   # PCM: every frame is a sample of the same length
            stts = [[tr.count, 1]]
        else:
            stts = runs(tr.durations)
        parts.append(fullbox(b'stts', 0, 0, struct.pack('>I', len(stts)), b''.join(struct.pack('>II', c, d) for c, d in stts)))
        if ctts:
            # composition offsets when the encoder reordered frames (B-frames): pts - dts per sample
            offs = [p - i * self.vdelta for i, p in enumerate(tr.pts)]
            base = min(offs) if offs else 0
            offs = [o - base for o in offs]
            if any(offs):
                r = runs(offs)
                parts.append(fullbox(b'ctts', 0, 0, struct.pack('>I', len(r)), b''.join(struct.pack('>II', c, o) for c, o in r)))
        if sync and not all(tr.keys):
            ks = [i + 1 for i, k in enumerate(tr.keys) if k]
            parts.append(fullbox(b'stss', 0, 0, struct.pack('>I', len(ks)), struct.pack('>%dI' % len(ks), *ks)))
        stsc, first = [], 1
        for c, n in runs(tr.chunk_counts):
            stsc.append(struct.pack('>III', first, n, 1))
            first += c
        parts.append(fullbox(b'stsc', 0, 0, struct.pack('>I', len(stsc)), *stsc))
        if tr.const_size:
            parts.append(fullbox(b'stsz', 0, 0, struct.pack('>II', tr.const_size, tr.count)))
        else:
            n = len(tr.sizes)
            parts.append(fullbox(b'stsz', 0, 0, struct.pack('>II', 0, n), struct.pack('>%dI' % n, *tr.sizes)))
        m = len(tr.chunk_offsets)
        parts.append(fullbox(b'co64', 0, 0, struct.pack('>I', m), struct.pack('>%dQ' % m, *tr.chunk_offsets)))
        return box(b'stbl', *parts)

    def avc_config(self):
        """The avcC box body. Built from the SPS / PPS inside the first keyframe when the encoder put them there:
        Firefox (158) hands over an avcC whose parameter sets have their first byte doubled, with the reserved bits
        left out. Otherwise the browser's own."""
        if not self.inband:
            return self.avcc
        sps, pps = self.inband
        out = (bytes([1, sps[1], sps[2], sps[3], 0xFF, 0xE1]) + struct.pack('>H', len(sps)) + sps +
               bytes([1]) + struct.pack('>H', len(pps)) + pps)
        if sps[1] in (100, 110, 122, 144):
            out += bytes([0xFC | 1, 0xF8, 0xF8, 0])         # 4:2:0, 8-bit luma and chroma, no SPS extensions
        return out

    def video_trak(self, now, movie_ts):
        tr = self.video
        dur = tr.total()
        avc1 = box(b'avc1', b'\0' * 6, struct.pack('>H', 1), b'\0' * 16,
                   struct.pack('>HHIIIH', self.width, self.height, 0x00480000, 0x00480000, 0, 1),
                   bytes([0]) + b'\0' * 31, struct.pack('>Hh', 0x18, -1), box(b'avcC', self.avc_config()))
        minf = box(b'minf', fullbox(b'vmhd', 0, 1, b'\0' * 8), self.dinf(), self.stbl(tr, avc1, sync=True, ctts=True))
        mdia = box(b'mdia', self.mdhd(now, 90000, dur), self.hdlr(b'vide', 'VideoHandler'), minf)
        return box(b'trak', self.tkhd(now, 1, round(dur * movie_ts / 90000), 0, self.width, self.height), mdia)

    def audio_trak(self, now, movie_ts):
        tr = self.atrack
        rate, channels, codec = self.audio
        dur = tr.count if codec == 'pcm' else tr.total()
        head = b'\0' * 6 + struct.pack('>H', 1) + b'\0' * 8 + struct.pack('>HHHHI', channels, 16, 0, 0, rate << 16)
        if codec == 'aac':
            entry = box(b'mp4a', head, esds(self.acfg, channels))
        elif codec == 'opus':
            entry = box(b'Opus', head, self.acfg)
        else:                                               # 16-bit little-endian PCM (QuickTime 'sowt')
            entry = box(b'sowt', head)
        minf = box(b'minf', fullbox(b'smhd', 0, 0, b'\0' * 4), self.dinf(), self.stbl(tr, entry))
        mdia = box(b'mdia', self.mdhd(now, rate, dur), self.hdlr(b'soun', 'SoundHandler'), minf)
        return box(b'trak', self.tkhd(now, 2, round(dur * movie_ts / rate), 0x0100, 0, 0), mdia)


def inband_params(sample):
    """The SPS and PPS an encoder put inside a keyframe (4-byte NAL lengths), or None."""
    sps = pps = None
    o = 0
    while o + 4 <= len(sample):
        n = struct.unpack_from('>I', sample, o)[0]
        nal = sample[o + 4:o + 4 + n]
        if not nal:
            break
        t = nal[0] & 31
        if t == 7 and sps is None:
            sps = bytes(nal)
        elif t == 8 and pps is None:
            pps = bytes(nal)
        elif t in (1, 5):
            break
        o += 4 + n
    return (sps, pps) if sps and pps else None


def qp_reader(inband, avcc):
    """A per-frame QP reader from the in-band parameter sets, else from the avcC (False when neither parses)."""
    sets = inband
    if not sets and avcc and len(avcc) > 8:
        try:
            n = struct.unpack_from('>H', avcc, 6)[0]
            sps = avcc[8:8 + n]
            m = struct.unpack_from('>H', avcc, 9 + n)[0]
            pps = avcc[11 + n:11 + n + m]
            if len(sps) > 1 and sps[1] == sps[0]:       # Firefox's doubled header byte
                sps, pps = sps[1:], pps[1:]
            sets = (sps, pps)
        except struct.error:
            sets = None
    if not sets:
        return False
    try:
        return h264qp.Reader(*sets)
    except (IndexError, ValueError):
        return False


def descr(tag, body):
    n = len(body)
    size = bytes([0x80 | ((n >> 21) & 0x7F), 0x80 | ((n >> 14) & 0x7F), 0x80 | ((n >> 7) & 0x7F), n & 0x7F])
    return bytes([tag]) + size + body


def esds(asc, channels):
    dsi = descr(0x05, asc)
    dcd = descr(0x04, bytes([0x40, 0x15]) + b'\0\0\0' + struct.pack('>II', 320000, 192000) + dsi)
    sl = descr(0x06, b'\x02')
    es = descr(0x03, struct.pack('>HB', 2, 0) + dcd + sl)
    return fullbox(b'esds', 0, 0, es)


def aac_asc(sample_rate, channels):
    """AudioSpecificConfig for AAC-LC, when the encoder didn't hand one over."""
    rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    idx = rates.index(sample_rate) if sample_rate in rates else 3
    v = (2 << 11) | (idx << 7) | (channels << 3)
    return struct.pack('>H', v)


def dops(head, channels, rate):
    """The Opus-in-MP4 'dOps' box from the encoder's OpusHead (little-endian, Ogg style), or defaults."""
    pre_skip, in_rate, gain = 312, rate, 0
    if head and len(head) >= 19 and head[:8] == b'OpusHead':
        channels = head[9]
        pre_skip, in_rate, gain = struct.unpack_from('<HIh', head, 10)
    return box(b'dOps', struct.pack('>BBHIhB', 0, channels, pre_skip, in_rate, gain, 0))
