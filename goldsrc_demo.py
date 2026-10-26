"""GoldSrc .dem decoder for network protocol 48 (Half-Life, TFC, CS 1.6, DoD...): client demos and HLTV demos.

Unlike Tools/HLDemo/hldem.py (which reads only the recording player's own movement), this decodes the network
messages themselves: delta descriptions, baselines, delta-compressed packet entities (every player and object),
user messages (DeathMsg, TeamInfo, SayText...), weapon events and userinfo (names + SteamIDs).

Wire formats follow Valve's HLTV proxy as rebuilt in ReHLDS (github.com/dreamstalker/rehlds: rehlds/HLTV, Core/src/Server.cpp, World.cpp,
Delta.cpp, common/BitBuffer.cpp, common/DemoFile.cpp) and the engine writers in rehlds/engine/sv_main.cpp.

    python -I goldsrc_demo.py <demo.dem>            # summary + player list
    python -I goldsrc_demo.py <demo.dem> --fields   # also print the delta field names the demo uses
"""
import os
import struct
import sys
from array import array

HEADER_SIZE = 544
DIR_ENTRY_SIZE = 92
DEMO_INFO_SIZE = 436          # demo_info_t on 32-bit GoldSrc
SEQ_INFO_SIZE = 28            # 7 netchan ints

DT_BYTE, DT_SHORT, DT_FLOAT, DT_INTEGER, DT_ANGLE = 1, 2, 4, 8, 16
DT_TIMEWINDOW_8, DT_TIMEWINDOW_BIG, DT_STRING = 32, 64, 128
DT_SIGNED = 0x80000000

STEAM64_BASE = 76561197960265728

# Delta::m_MetaDescription: how svc_deltadescription encodes each field description
META_FIELDS = [
    ('fieldType', DT_INTEGER, 32, 1.0, 1.0),
    ('fieldName', DT_STRING, 1, 1.0, 1.0),
    ('fieldOffset', DT_INTEGER, 16, 1.0, 1.0),
    ('fieldSize', DT_INTEGER, 8, 1.0, 1.0),
    ('significant_bits', DT_INTEGER, 8, 1.0, 1.0),
    ('premultiply', DT_FLOAT, 32, 4000.0, 1.0),
    ('postmultiply', DT_FLOAT, 32, 4000.0, 1.0),
]

# svc_temp_entity payload lengths by type (HLTV Server.cpp TE_LENGTH); -1 = variable, -2 = invalid
TE_LENGTH = [
    24, 20, 6, 11, 6, 10, 12, 17, 16, 6, 6, 6, 8, -1, 9, 19,
    -2, 10, 16, 24, 24, 24, 10, 11, 16, 19, -2, 12, 16, -1, 19, 17,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, 2, 10, 14, 12, 14, 9, 5, 17, 13, 24, 9, 17, 7,
    10, 19, 19, 12, 7, 7, 9, 16, 18, 6, 10, 13, 7, 1, 18, 15,
]
TE_BSPDECAL, TE_TEXTMESSAGE = 13, 29

def _c(v):
    return v / 8.0             # WRITE_COORD: 1/8 unit


def _coords(n, fmt):
    """Unpacker whose first n shorts are coords."""
    def f(p):
        v = struct.unpack(fmt, p)
        return tuple(_c(x) for x in v[:n]) + v[n:]
    return f


# temp entity payloads the viewer draws -> numbers (coords in units, models/sprites as precache model indexes)
TE_DECODE = {
    0: _coords(6, '<6hh10B'),       # BEAMPOINTS: start, end, sprite, startframe, framerate, life, width, noise, r, g, b, a, scroll
    3: _coords(3, '<3hhBBB'),       # EXPLOSION: pos, sprite, scale*10, framerate, flags
    6: _coords(6, '<6h'),           # TRACER: start, end
    8: lambda p: struct.unpack('<hhh10B', p),   # BEAMENTS: start ent, end ent, sprite, ...
    15: _coords(6, '<6hh5B'),       # SPRITETRAIL: start, end, sprite, count, life*10, scale*10, velocity/10, randomness/10
    22: lambda p: struct.unpack('<hh6B', p),    # BEAMFOLLOW: ent (+attachment << 12), sprite, life*10, width*10, r, g, b, a
    27: _coords(3, '<3h6B'),        # DLIGHT: pos, radius/10, r, g, b, life*10, decay/10
    107: _coords(4, '<4hhhB'),      # EXPLODEMODEL: pos, velocity, model, count, life*10
    115: _coords(3, '<3hhhBB'),     # BLOODSPRITE: pos, spray sprite, drop sprite, palette colour, scale
    124: lambda p: (lambda v: (v[0], _c(v[1])) + v[2:])(struct.unpack('<Bhhh', p)),  # PLAYERATTACHMENT: ent, z, model, life*10
    125: lambda p: struct.unpack('<B', p),      # KILLPLAYERATTACHMENTS: ent
}

RES_CUSTOM = 4
T_SOUND, T_MODEL, T_EVENTSCRIPT = 0, 2, 5
EF_NODRAW = 128

TFC_TEAMS = {1: 'Blue', 2: 'Red', 3: 'Yellow', 4: 'Green'}
TFC_CLASSES = {0: '', 1: 'Scout', 2: 'Sniper', 3: 'Soldier', 4: 'Demoman', 5: 'Medic', 6: 'HWGuy', 7: 'Pyro',
               8: 'Spy', 9: 'Engineer', 10: 'Random', 11: 'Civilian'}

# per-frame player info word (see Demo.snapshot)
PF_PRESENT, PF_DUCKED, PF_DEAD, PF_NODRAW, PF_OBSERVER = 1, 2, 4, 8, 16


class DemoError(Exception):
    pass


class Overflow(DemoError):
    pass


class Bits:
    """Little-endian bit reader over one network message (BitBuffer: bytes read as 8 bits when aligned)."""
    __slots__ = ('d', 'pos', 'end')

    def __init__(self, data):
        self.d = bytes(data) + b'\0' * 8
        self.pos = 0
        self.end = len(data) * 8

    def bits(self, n):
        p = self.pos
        i = p >> 3
        v = (int.from_bytes(self.d[i:i + 5], 'little') >> (p & 7)) & ((1 << n) - 1)
        p += n
        if p > self.end:
            raise Overflow('read past end of message')
        self.pos = p
        return v

    def peek(self, n):
        p = self.pos
        i = p >> 3
        return (int.from_bytes(self.d[i:i + 5], 'little') >> (p & 7)) & ((1 << n) - 1)

    def sbits(self, n):
        sign = self.bits(1)
        v = self.bits(n - 1)
        return -v if sign else v

    def align(self):
        self.pos = (self.pos + 7) & ~7

    def left(self):
        return self.end - self.pos

    def byte(self):
        return self.bits(8)

    def char(self):
        v = self.bits(8)
        return v - 256 if v > 127 else v

    def short(self):
        v = self.bits(16)
        return v - 65536 if v > 32767 else v

    def word(self):
        return self.bits(16)

    def long(self):
        v = self.bits(32)
        return v - (1 << 32) if v > 0x7FFFFFFF else v

    def float(self):
        return struct.unpack('<f', self.bits(32).to_bytes(4, 'little'))[0]

    def raw(self, n):
        if self.pos & 7:
            return bytes(self.bits(8) for _ in range(n))
        i = self.pos >> 3
        if self.pos + n * 8 > self.end:
            raise Overflow('read past end of message')
        self.pos += n * 8
        return self.d[i:i + n]

    def skip(self, n):
        self.pos += n * 8
        if self.pos > self.end:
            raise Overflow('skip past end of message')

    def string(self):
        if self.pos & 7 == 0:
            i = self.pos >> 3
            j = self.d.find(b'\0', i, (self.end >> 3))
            if j < 0:
                raise Overflow('unterminated string')
            self.pos = (j + 1) * 8
            return self.d[i:j].decode('utf-8', 'replace')
        out = bytearray()
        while True:
            c = self.bits(8)
            if not c:
                return out.decode('utf-8', 'replace')
            out.append(c)

    def bitcoord(self):
        i, f = self.bits(1), self.bits(1)
        if not (i or f):
            return 0.0
        sign = self.bits(1)
        iv = self.bits(12) if i else 0
        fv = self.bits(3) if f else 0
        v = iv + fv / 8.0
        return -v if sign else v

    def vec3coord(self):
        fx, fy, fz = self.bits(1), self.bits(1), self.bits(1)
        return (self.bitcoord() if fx else 0.0, self.bitcoord() if fy else 0.0, self.bitcoord() if fz else 0.0)


class Delta:
    __slots__ = ('name', 'fields', 'index')

    def __init__(self, name, fields):
        self.name = name
        self.fields = fields                          # [(name, type, bits, premultiply, postmultiply)]
        self.index = {f[0]: i for i, f in enumerate(fields)}


META_DELTA = Delta('meta', META_FIELDS)


def parse_delta(b, delta, frm, time=0.0):
    """Delta::ParseDelta: a 3-bit byte count, that many mask bytes, then each sent field in description order."""
    nbytes = b.bits(3)
    mask = 0
    for i in range(nbytes):
        mask |= b.bits(8) << (8 * i)
    to = dict(frm) if frm else {}
    fields = delta.fields
    nf = len(fields)
    bits = b.bits
    while mask:
        low = mask & -mask
        i = low.bit_length() - 1
        mask ^= low
        if i >= nf:
            raise DemoError('delta %s: field %d sent but only %d described' % (delta.name, i, nf))
        name, ft, nb, pre, post = fields[i]
        t = ft & 0x7FFFFFFF
        if t == DT_ANGLE:
            v = bits(nb) * (360.0 / (1 << nb))
        elif t == DT_STRING:
            out = bytearray()
            while True:
                c = bits(8)
                if not c:
                    break
                out.append(c)
            v = out.decode('utf-8', 'replace')
        elif t == DT_TIMEWINDOW_8:
            v = (time * 100.0 - b.sbits(8)) / 100.0
        elif t == DT_TIMEWINDOW_BIG:
            a = b.sbits(nb)
            v = (time * pre - a) / pre if (pre <= 0.9999 or pre >= 1.0001) and pre else time - a
        else:
            if ft & DT_SIGNED:
                s = bits(1)
                v = bits(nb - 1)
                if s:
                    v = -v
            else:
                v = bits(nb)
            if (pre <= 0.9999 or pre >= 1.0001) and pre:
                v = v / pre
            if (post <= 0.9999 or post >= 1.0001) and post:
                v = v * post
            if t != DT_FLOAT:
                v = int(v)
        to[name] = v
    return to


def info_dict(s):
    """Parse a \\key\\value info string."""
    parts = s.split('\\')
    if parts and parts[0] == '':
        parts = parts[1:]
    return {parts[i]: parts[i + 1] for i in range(0, len(parts) - 1, 2)}


def steam_ids(sid64):
    """(STEAM_0:Y:Z, [U:1:N]) for a SteamID64, or None for bots/LAN ids."""
    try:
        n = int(sid64)
    except (TypeError, ValueError):
        return None
    acc = n - STEAM64_BASE
    if acc <= 0 or acc >= (1 << 32):
        return None
    return 'STEAM_0:%d:%d' % (acc & 1, acc >> 1), '[U:1:%d]' % acc


def cstr(b, start=0):
    end = b.find(b'\0', start)
    if end < 0:
        end = len(b)
    return b[start:end].decode('utf-8', 'replace')


def clean_chat(s):
    return ''.join(ch for ch in s if ch >= ' ' or ch == '\t').strip()


def int_or(s, default):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return default


class Player:
    """Everything seen about one client slot (entity index = slot + 1) during the demo."""

    def __init__(self, ent):
        self.ent = ent
        self.names = []
        self.userid = None
        self.steamid64 = None
        self.bot = False
        self.hltv = False
        self.model = ''
        self.cdhash = ''
        self.first = None          # demo time first seen in userinfo
        self.last = None           # demo time last seen in userinfo / entities
        self.left = None           # demo time the userinfo was cleared (disconnect)
        self.team = ''
        self.teams = []            # TeamInfo strings
        self.teamnums = []         # entity_state.team values (TFC: 1 Blue, 2 Red, 3 Yellow, 4 Green)
        self.pclass = 0
        self.classes = []
        self.frags = None
        self.deaths = None
        self.kills_seen = 0
        self.deaths_seen = 0
        self.pings = []
        self.ping_t = []           # [demo time, ms] from svc_pings, kept when it changes (the viewer's lag compensation)
        self.info = {}
        self.looks = []            # [demo time, model, topcolor, bottomcolor] when the userinfo changes them

    @property
    def name(self):
        return self.names[-1] if self.names else ''

    def team_names(self):
        if self.teamnums:
            return [TFC_TEAMS.get(n, str(n)) for n in self.teamnums]
        return [t for t in self.teams if not t.startswith('#')] or self.teams

    def steam(self):
        if self.bot:
            return 'BOT'
        if self.hltv:
            return 'HLTV'
        ids = steam_ids(self.steamid64)
        if ids:
            return ids[0]
        return 'none (bot/LAN)' if not self.steamid64 or self.steamid64 == '0' else self.steamid64


class Demo:
    """Decodes a .dem file. After parse(): header, server, players, timeline (times, tracks, objs), events."""

    def __init__(self, path, max_fps=None):
        self.path = path
        self.max_fps = max_fps    # timeline samples per second (default: 64 for HLTV demos, 30 for client demos)
        self.data = open(path, 'rb').read()
        if self.data[:6] != b'HLDEMO':
            raise DemoError('not a GoldSrc demo (no HLDEMO header): %s' % path)
        d = self.data
        self.demo_protocol, self.net_protocol = struct.unpack_from('<ii', d, 8)
        self.mapname = cstr(d[16:276])
        self.gamedir = cstr(d[276:536])
        self.mapcrc, self.diroff = struct.unpack_from('<ii', d, 536)
        self.entries = self._read_directory()
        self.complete = bool(self.entries)
        self.extra = 16 if self.gamedir.lower().startswith('svencoop') else 0
        # protocol state
        self.deltas = {}
        self.usermsgs = {}
        self.resources = {}       # (type, index) -> name
        self.models = {}          # modelindex -> name
        self.eventnames = {}      # event index -> name
        self.sounds = {}
        self.baselines = {}
        self.instanced = []
        self.frames = {}          # seq & 0xFF -> [(num, state)]
        self.cur_ents = []
        self.maxclients = 32
        self.hltv = False
        self.server = {}
        self.serverinfo = {}
        self.time = 0.0           # svc_time (server time)
        self.dtime = 0.0          # demo frame time
        # results
        self.players = {}
        self.times = array('f')
        self.tracks = {}          # ent -> (array('f') 5 per frame, array('I') info per frame, array('I') anim per frame)
        self.player_models = {}   # ent -> [[frame, modelindex], ...] when the player's (server) model changes
        self.objs = []            # [frame, ent, modelindex, x, y, z, pitch, yaw, roll, flags, renderamt, team,
                                  #  body, skin, solid, sequence, frame] on change; [frame, ent, -1] when it disappears.
                                  # flags: 1 = EF_NODRAW, rendermode << 1, renderfx << 4
        self._obj_last = {}
        self._obj_ref = {}
        self.shots = []           # [t, ent, event name index]
        self.kills = []           # [t, killer ent, victim ent, weapon]
        # the recording player's own health and armor (Health / Battery go only to that player, so a client demo has
        # them for whoever recorded it, an HLTV demo for nobody)
        self.health = []          # [t, health]
        self.armor = []           # [t, armor]
        # everyone's, from the hltv_vitals server plugin (HltvVitals, sent only to HLTV proxies):
        # slot -> {'health': [[t, health]], 'armor': [[t, armor]]}, kept when a value changes
        self.vitals = {}
        self.chat = []            # [t, ent, text]
        self.texts = []           # [t, text]   (TextMsg / centerprint)
        self.warnings = []
        self.levels = []          # (demo time, levelname) per svc_serverinfo
        self.level_info = []      # per level: start time/frame, map, its own model and event tables
        self.sound_log = []       # see m_sound
        self.event_log = []       # see log_event
        self.tent_log = []        # (time, TE type, decoded fields...): see TE_DECODE
        self.frame_errors = 0
        self.last_seq = 0
        self.local_view = None

    # ---------------------------------------------------------------- file structure
    def _read_directory(self):
        d = self.data
        off = self.diroff
        if off <= HEADER_SIZE or off + 4 > len(d):
            return []
        n = struct.unpack_from('<i', d, off)[0]
        if n < 1 or n > 1024 or off + 4 + n * DIR_ENTRY_SIZE > len(d):
            return []
        out = []
        for i in range(n):
            o = off + 4 + i * DIR_ENTRY_SIZE
            typ = struct.unpack_from('<i', d, o)[0]
            desc = cstr(d[o + 4:o + 68])
            flags, cd, t, frames, foff, ln = struct.unpack_from('<iifiii', d, o + 68)
            out.append({'type': typ, 'desc': desc, 'time': t, 'frames': frames, 'offset': foff, 'length': ln})
        return out

    def iter_frames(self):
        """Yields (type, time, frame number, offset of payload, end offset) scanning from the header onward.
        Works for unfinished demos (no directory) too: stops at the directory or at the first broken frame."""
        d = self.data
        o = HEADER_SIZE
        end = self.diroff if self.complete else len(d)
        ex = self.extra
        while o + 9 <= end:
            ft = d[o]
            t, fn = struct.unpack_from('<fi', d, o + 1)
            p = o + 9
            if ft in (0, 1):
                q = p + DEMO_INFO_SIZE + ex + SEQ_INFO_SIZE
                if q + 4 > end:
                    return
                ln = struct.unpack_from('<i', d, q)[0]
                if ln < 0 or q + 4 + ln > end:
                    return
                nxt = q + 4 + ln
            elif ft in (2, 5):
                nxt = p
            elif ft == 3:
                nxt = p + 64
            elif ft == 4:
                nxt = p + 32
            elif ft == 6:
                nxt = p + 84
            elif ft == 7:
                nxt = p + 8
            elif ft in (8, 20):
                if p + 8 > end:
                    return
                sl = struct.unpack_from('<i', d, p + 4)[0]
                if sl < 0 or sl > 4096:
                    return
                nxt = p + 8 + sl + 16 + (12 if ft == 20 else 0)
            elif ft == 9:
                if p + 4 > end:
                    return
                ln = struct.unpack_from('<i', d, p)[0]
                if ln < 0:
                    return
                nxt = p + 4 + ln
            else:
                return
            if nxt > end:
                return
            yield ft, t, fn, p, nxt
            o = nxt

    # ---------------------------------------------------------------- top level
    def parse(self, progress=None):
        d = self.data
        n = 0
        total = len(d)
        seg_offset = 0.0
        new_seg = False
        for ft, t, fn, p, nxt in self.iter_frames():
            # client demos restart the clock at the Playback segment: continue from where LOADING ended
            if new_seg:
                seg_offset = max(0.0, self.dtime - t)
                new_seg = False
            if ft == 5:
                new_seg = True
            self.dtime = max(t + seg_offset, self.dtime)
            if ft in (0, 1):
                if not self.hltv:
                    # the recording player's own entity carries no origin: take the demo's view instead
                    ex = self.extra
                    self.local_view = (struct.unpack_from('<3f', d, p + 104), struct.unpack_from('<3f', d, p + 236 + ex + 4))
                q = p + DEMO_INFO_SIZE + self.extra
                seq = struct.unpack_from('<i', d, q)[0]
                ln = struct.unpack_from('<i', d, q + SEQ_INFO_SIZE)[0]
                msg = d[q + SEQ_INFO_SIZE + 4:q + SEQ_INFO_SIZE + 4 + ln]
                self.last_seq = seq
                self.parse_message(msg, seq)
            n += 1
            if progress and n % 2000 == 0:
                progress(p / total)
        self.duration = self.times[-1] - self.times[0] if len(self.times) else 0.0
        for pl in self.players.values():
            if pl.last is None:
                pl.last = pl.first
        return self

    # ---------------------------------------------------------------- messages
    def parse_message(self, msg, seq):
        b = Bits(msg)
        self.packet_this_msg = False
        handlers = HANDLERS
        while b.left() >= 8:
            cmd = b.byte()
            try:
                if cmd >= 64:
                    self.user_message(b, cmd)
                    continue
                h = handlers.get(cmd)
                if h is None:
                    raise DemoError('unknown server message %d' % cmd)
                if h(self, b, seq) is False:
                    break
            except DemoError as e:
                self.frame_errors += 1
                if len(self.warnings) < 50:
                    self.warnings.append('t=%.2f msg %d: %s' % (self.dtime, cmd, e))
                break

    def user_message(self, b, cmd):
        um = self.usermsgs.get(cmd)
        if um is None:
            raise DemoError('unregistered user message %d' % cmd)
        size, name = um
        if size == 255 or size == -1:
            size = b.byte()
        payload = b.raw(size)
        f = USERMSG_HANDLERS.get(name)
        if f:
            try:
                f(self, payload)
            except (IndexError, struct.error):
                pass

    # ---- engine messages
    def m_nop(self, b, seq):
        pass

    def m_bad(self, b, seq):
        raise DemoError('svc_bad')

    def m_disconnect(self, b, seq):
        self.texts.append([round(self.dtime, 2), 'disconnect: ' + b.string()])

    def m_string(self, b, seq):
        b.string()

    def m_print(self, b, seq):
        s = b.string()
        if s and s[0] < ' ':
            s = s[1:]

    def m_centerprint(self, b, seq):
        s = clean_chat(b.string())
        if s:
            self.texts.append([round(self.dtime, 2), s])

    def m_version(self, b, seq):
        b.long()

    def m_short(self, b, seq):
        b.skip(2)

    def m_byte(self, b, seq):
        b.skip(1)

    def m_time(self, b, seq):
        self.time = b.float()

    def m_setangle(self, b, seq):
        b.skip(6)

    def m_serverinfo(self, b, seq):
        protocol = b.long()
        spawncount = b.long()
        b.long()
        b.skip(16)
        self.maxclients = b.byte()
        playernum = b.byte()
        gametype = b.byte()
        gamedir = b.string()
        hostname = b.string()
        levelname = b.string()
        b.string()
        if b.byte():
            n = b.byte()
            b.skip(n + 16)
        self.server = {'protocol': protocol, 'spawncount': spawncount, 'maxclients': self.maxclients,
                       'playernum': playernum, 'gametype': gametype, 'gamedir': gamedir,
                       'hostname': hostname, 'levelname': levelname}
        self.levels.append((self.dtime, levelname))
        # a client demo can span map changes: model/event indexes and entity numbers restart per level
        self.models, self.eventnames, self.sounds = {}, {}, {}
        self.level_info.append({'t': self.dtime, 'frame': len(self.times), 'map': os.path.splitext(os.path.basename(levelname))[0],
                                'models': self.models, 'events': self.eventnames, 'sounds': self.sounds})
        for n in list(self._obj_ref):
            self.objs.append([len(self.times), n, -1])
        self._obj_ref, self._obj_last = {}, {}
        self.baselines = {}
        self.instanced = []
        self.frames = {}
        self.cur_ents = []

    def m_lightstyle(self, b, seq):
        b.byte()
        b.string()

    def m_updateuserinfo(self, b, seq):
        slot = b.byte()
        userid = b.long()
        info = b.string()
        cdhash = b.raw(16)
        ent = slot + 1
        t = round(self.dtime, 2)
        kv = info_dict(info)
        pl = self.players.get(ent)
        if not kv:
            if pl is not None and pl.left is None:
                pl.left = t
            return
        if pl is None or (pl.userid is not None and userid != pl.userid):
            # a new client in this slot: keep the old one under a unique key
            if pl is not None:
                self.players[('old', ent, pl.userid)] = pl
            pl = self.players[ent] = Player(ent)
        pl.userid = userid
        pl.left = None
        name = kv.get('name', '')
        if name and (not pl.names or pl.names[-1] != name):
            pl.names.append(name)
        if kv.get('*sid'):
            pl.steamid64 = kv['*sid']
        pl.bot = kv.get('*bot') == '1' or pl.bot
        pl.hltv = kv.get('*hltv') == '1' or pl.hltv
        pl.model = kv.get('model', pl.model)
        # what the game draws: TFC spies disguise by changing their model (and colours) in the userinfo
        look = [pl.model, int_or(kv.get('topcolor'), 0), int_or(kv.get('bottomcolor'), 0)]
        if not pl.looks or pl.looks[-1][1:] != look:
            pl.looks.append([round(t, 2)] + look)
        pl.cdhash = cdhash.hex()
        pl.info = kv
        if pl.first is None:
            pl.first = t
        pl.last = t

    def m_deltadescription(self, b, seq):
        name = b.string()
        count = b.bits(16)
        fields = []
        for _ in range(count):
            f = parse_delta(b, META_DELTA, None)
            fields.append((f.get('fieldName', ''), f.get('fieldType', 0), f.get('significant_bits', 0),
                           f.get('premultiply', 1.0) or 1.0, f.get('postmultiply', 1.0) or 1.0))
        b.align()
        self.deltas[name] = Delta(name, fields)

    def m_clientdata(self, b, seq):
        if self.hltv:
            return
        if b.bits(1):
            b.bits(8)
        parse_delta(b, self.deltas['clientdata_t'], None, self.time)
        wd = self.deltas.get('weapon_data_t')
        while b.bits(1):
            b.bits(6)
            parse_delta(b, wd, None, self.time)
        b.align()

    def m_pings(self, b, seq):
        while b.bits(1):
            slot = b.bits(5)
            ping = b.bits(12)
            b.bits(7)
            pl = self.players.get(slot + 1)
            if pl is not None and ping < 2000 and len(pl.pings) < 100000:
                pl.pings.append(ping)
                last = pl.ping_t[-1] if pl.ping_t else None
                if last is None or abs(ping - last[1]) >= 3 or self.dtime - last[0] >= 10:
                    pl.ping_t.append([round(self.dtime, 2), ping])
        b.align()

    def m_particle(self, b, seq):
        b.skip(11)

    def m_spawnstatic(self, b, seq):
        b.skip(16)
        if b.byte():
            b.skip(5)

    def m_event(self, b, seq):
        n = b.bits(5)
        ed = self.deltas.get('event_t')
        for _ in range(n):
            idx = b.bits(10)
            ent = None
            if b.bits(1):
                pidx = b.bits(11)
                args = None
                if b.bits(1):
                    args = parse_delta(b, ed, None, self.time)
                if args and args.get('entindex'):
                    ent = args['entindex']
                elif pidx < len(self.cur_ents):
                    ent = self.cur_ents[pidx][0]
            delay = b.bits(16) / 100.0 if b.bits(1) else 0.0
            self.log_event(idx, ent, args, delay)
            if ent and 1 <= ent <= self.maxclients:
                self.shots.append([round(self.dtime, 3), ent, idx])
        b.align()

    def m_event_reliable(self, b, seq):
        idx = b.bits(10)
        args = parse_delta(b, self.deltas.get('event_t'), None, self.time)
        delay = b.bits(16) / 100.0 if b.bits(1) else 0.0
        b.align()
        self.log_event(idx, args.get('entindex'), args, delay)

    def log_event(self, idx, ent, args, delay):
        """[time, entity (0 = none), event index (per level), origin, angles, fparam1, fparam2, iparam1, iparam2,
        bparam1, bparam2, ducking]: what the client's event code needs to replay sounds and effects."""
        g = (args or {}).get
        self.event_log.append((round(self.dtime + delay, 3), ent or 0, idx,
                               g('origin[0]', 0.0), g('origin[1]', 0.0), g('origin[2]', 0.0),
                               g('angles[0]', 0.0), g('angles[1]', 0.0), g('angles[2]', 0.0),
                               g('fparam1', 0.0), g('fparam2', 0.0), g('iparam1', 0), g('iparam2', 0),
                               g('bparam1', 0), g('bparam2', 0), g('ducking', 0)))

    def m_spawnbaseline(self, b, seq):
        ent_d = self.deltas['entity_state_t']
        ply_d = self.deltas['entity_state_player_t']
        cus_d = self.deltas['custom_entity_state_t']
        mc = self.maxclients
        self.baselines = {}
        while b.peek(16) != 0xFFFF:
            idx = b.bits(11)
            typ = b.bits(2)
            if typ & 2:
                dl = cus_d
            else:
                dl = ply_d if 1 <= idx <= mc else ent_d
            self.baselines[idx] = parse_delta(b, dl, None, self.time)
        b.bits(16)
        n = b.bits(6)
        self.instanced = [parse_delta(b, ent_d, None, self.time) for _ in range(n)]
        b.align()

    def m_temp_entity(self, b, seq):
        typ = b.byte()
        ln0 = TE_LENGTH[typ] if typ < len(TE_LENGTH) else -2
        if ln0 > 0 and typ in TE_DECODE:
            raw = b.raw(ln0)
            try:
                self.tent_log.append((round(self.dtime, 3), typ) + tuple(TE_DECODE[typ](raw)))
            except struct.error:       # an effect we read wrong only loses that effect, never the demo
                pass
            return
        ln = TE_LENGTH[typ] if typ < len(TE_LENGTH) else -2
        if ln == -2:
            raise DemoError('bad temp entity type %d' % typ)
        if ln == -1:
            if typ == TE_BSPDECAL:
                b.skip(8)
                if b.word():
                    b.skip(2)
            elif typ == TE_TEXTMESSAGE:
                b.skip(5)
                if b.byte() == 2:
                    b.skip(2)
                b.skip(14)
                s = clean_chat(b.string())
                if s:
                    self.texts.append([round(self.dtime, 2), s])
            return
        b.skip(ln)

    def m_spawnstaticsound(self, b, seq):
        x, y, z, idx, vol, atten, ent, pitch, flags = struct.unpack('<3hhBBhBB', b.raw(14))
        # an ambient loop (ambient_generic): flag 1024 marks it static in the sound log
        self.sound_log.append((round(self.dtime, 3), ent, 0, idx, vol, atten, x / 8.0, y / 8.0, z / 8.0, pitch, flags | 1024))

    def m_cdtrack(self, b, seq):
        b.skip(2)

    def m_restore(self, b, seq):
        b.string()
        for _ in range(b.byte()):
            b.string()

    def m_decalname(self, b, seq):
        b.byte()
        b.string()

    def m_newusermsg(self, b, seq):
        idx = b.byte()
        size = b.byte()
        name = cstr(b.raw(16))
        self.usermsgs[idx] = (size, name)

    def m_resourcelist(self, b, seq):
        total = b.bits(12)
        for _ in range(total):
            typ = b.bits(4)
            name = b.string()
            index = b.bits(12)
            b.bits(24)
            flags = b.bits(3)
            if flags & RES_CUSTOM:
                b.raw(16)
            if b.bits(1):
                b.raw(32)
            self.resources[(typ, index)] = name
            if typ == T_MODEL:
                self.models[index] = name
            elif typ == T_EVENTSCRIPT:
                self.eventnames[index] = name
            elif typ == T_SOUND:
                self.sounds[index] = name
        if b.bits(1):
            while b.bits(1):
                if b.bits(1):
                    b.bits(5)
                else:
                    b.bits(10)
        b.align()

    def m_newmovevars(self, b, seq):
        b.skip(16 * 4 + 1 + 8 * 4)
        b.string()

    def m_resourcerequest(self, b, seq):
        b.skip(8)

    def m_customization(self, b, seq):
        b.byte()
        b.byte()
        b.string()
        b.skip(2 + 4)
        if b.byte() & RES_CUSTOM:
            b.skip(16)

    def m_soundfade(self, b, seq):
        b.skip(4)

    def m_hltv(self, b, seq):
        cmd = b.byte()
        if cmd == 0:
            self.hltv = True
        elif cmd == 1:
            b.skip(10)
        else:
            raise DemoError('svc_hltv command %d' % cmd)

    def m_director(self, b, seq):
        b.skip(b.byte())

    def m_voiceinit(self, b, seq):
        b.string()
        b.byte()

    def m_voicedata(self, b, seq):
        b.byte()
        b.skip(b.word())

    def m_sendextrainfo(self, b, seq):
        b.string()
        b.byte()

    def m_timescale(self, b, seq):
        b.skip(4)

    def m_sendcvarvalue2(self, b, seq):
        b.skip(4)
        b.string()

    def m_exec(self, b, seq):
        if b.byte():
            b.byte()

    def m_sound(self, b, seq):
        mask = b.bits(9)
        vol = b.bits(8) if mask & 1 else 255
        atten = b.bits(8) if mask & 2 else 64            # attenuation * 64 (ATTN_NORM 0.8 = 51)
        chan = b.bits(3)
        ent = b.bits(11)
        idx = b.bits(16 if mask & 4 else 8)
        x, y, z = b.vec3coord()
        pitch = b.bits(8) if mask & 8 else 100
        b.align()
        # [demo time, entity, channel, sound index (per level; a sentence number with SND_SENTENCE 16), volume 0-255,
        #  attenuation*64, origin, pitch, SND_ flags]
        self.sound_log.append((round(self.dtime, 3), ent, chan, idx, vol, atten, x, y, z, pitch, mask))

    # ---- entities
    def encoder(self, num, custom):
        if custom:
            return self.deltas['custom_entity_state_t']
        if 1 <= num <= self.maxclients:
            return self.deltas['entity_state_player_t']
        return self.deltas['entity_state_t']

    def m_packetentities(self, b, seq):
        b.short()
        ents = []
        numbase = 0
        has_inst = bool(self.instanced)
        t = self.time
        while b.peek(16):
            isdelta = b.bits(1)
            if isdelta:
                num = numbase + 1
            elif b.bits(1):
                num = b.bits(11)
            else:
                num = numbase + b.bits(6)
            numbase = num
            custom = b.bits(1)
            newbl = 0
            if has_inst:
                newbl = b.bits(1)
                if newbl:
                    nbi = b.bits(6)
            offset = 0
            if not newbl and b.bits(1):
                offset = b.bits(6)
            if newbl:
                base = self.instanced[nbi] if nbi < len(self.instanced) else None
            elif offset:
                k = len(ents) - offset
                base = ents[k][1] if 0 <= k < len(ents) else None
            else:
                base = self.baselines.get(num)
            ents.append((num, parse_delta(b, self.encoder(num, custom), base, t)))
        b.bits(16)
        b.align()
        self.set_frame(seq, ents)

    def m_deltapacketentities(self, b, seq):
        b.short()
        frm = b.byte()
        old = self.frames.get(frm)
        if old is None:
            old = []
            if len(self.warnings) < 50:
                self.warnings.append('t=%.2f delta from unknown frame %d' % (self.dtime, frm))
        new = []
        oi = 0
        no = len(old)
        numbase = 0
        has_inst = bool(self.instanced)
        t = self.time
        while b.peek(16):
            remove = b.bits(1)
            if b.bits(1):
                num = b.bits(11)
            else:
                num = numbase + b.bits(6)
            numbase = num
            custom = 0
            newbl = 0
            if not remove:
                custom = b.bits(1)
                if has_inst:
                    newbl = b.bits(1)
                    if newbl:
                        nbi = b.bits(6)
            while oi < no and old[oi][0] < num:
                new.append(old[oi])
                oi += 1
            if oi < no and old[oi][0] == num:
                if remove:
                    oi += 1
                    continue
                new.append((num, parse_delta(b, self.encoder(num, custom), old[oi][1], t)))
                oi += 1
            else:
                if remove:
                    continue
                if newbl:
                    base = self.instanced[nbi] if nbi < len(self.instanced) else None
                else:
                    base = self.baselines.get(num)
                new.append((num, parse_delta(b, self.encoder(num, custom), base, t)))
        b.bits(16)
        b.align()
        new.extend(old[oi:])
        self.set_frame(seq, new)

    def set_frame(self, seq, ents):
        self.frames[seq & 0xFF] = ents
        self.cur_ents = ents
        # timeline resolution: HLTV demos keep up to 64 updates/s, client demos (often 100 fps) 30/s
        min_dt = 1.0 / (self.max_fps or (64 if self.hltv else 30))
        if self.times and self.dtime - self.times[-1] < min_dt - 1e-4:
            return
        self.snapshot(ents)

    # ---------------------------------------------------------------- timeline
    def snapshot(self, ents):
        fi = len(self.times)
        self.times.append(self.dtime)
        mc = self.maxclients
        seen = set()
        tracks = self.tracks
        t = round(self.dtime, 2)
        lv = self.local_view
        local = self.server.get('playernum', -1) + 1
        objref = self._obj_ref
        nobj = 0
        for num, st in ents:
            if num <= 0:
                continue
            if num <= mc:
                tr = tracks.get(num)
                if tr is None:
                    tr = tracks[num] = (array('f', bytes(4 * 5 * fi)), array('I', bytes(4 * fi)), array('I', bytes(4 * fi)))
                g = st.get
                a = g('angles[0]', 0.0)
                if a > 180.0:
                    a -= 360.0
                pitch = -a * 3.0
                yaw = g('angles[1]', 0.0)
                flags = PF_PRESENT
                if g('usehull', 0) == 1:
                    flags |= PF_DUCKED
                if g('solid', 3) == 0:
                    flags |= PF_DEAD
                if g('effects', 0) & EF_NODRAW:
                    flags |= PF_NODRAW
                if g('iuser1', 0) or g('spectator', 0):
                    flags |= PF_OBSERVER
                team = g('team', 0) & 7
                pclass = g('playerclass', 0) & 15
                wm = g('weaponmodel', 0) & 1023
                seqn = g('sequence', 0) & 255
                x, y, z = g('origin[0]', 0.0), g('origin[1]', 0.0), g('origin[2]', 0.0)
                if num == local and lv:
                    (x, y, z), (pitch, yaw, _) = lv
                tr[0].extend((x, y, z, pitch, yaw))
                tr[1].append(flags | team << 5 | pclass << 8 | wm << 12 | seqn << 22)
                # the server's model: what the engine tests shots against (TFC: scout.mdl for every class)
                mi = g('modelindex', 0)
                pm = self.player_models.setdefault(num, [])
                if not pm or pm[-1][1] != mi:
                    pm.append([fi, mi])
                # model animation as the client works it out (StudioEstimateFrame / StudioProcessGait): legs sequence,
                # frame (0-255 over the sequence), framerate (x16, signed byte) and how long ago that frame was set
                # (animtime, 1/100 s, 0-2.55)
                age = min(255, max(0, int(round((self.time - g('animtime', 0.0)) * 100.0))))
                tr[2].append((g('gaitsequence', 0) & 255) | (int(g('frame', 0)) & 255) << 8
                             | (int(round(g('framerate', 1.0) * 16.0)) & 255) << 16 | age << 24)
                seen.add(num)
                pl = self.players.get(num)
                if pl is not None and not flags & (PF_NODRAW | PF_OBSERVER):
                    pl.last = t
                    if team and team not in pl.teamnums:
                        pl.teamnums.append(team)
                    if pclass and pclass != pl.pclass:
                        pl.pclass = pclass
                        cname = TFC_CLASSES.get(pclass, str(pclass))
                        if cname not in pl.classes:
                            pl.classes.append(cname)
            else:
                nobj += 1
                g = st.get
                # projectiles (rockets): the server sends no origin, only start/end points and times, and the client
                # places them along that line (Entity_Encode unsets origin when impacttime and starttime are set)
                it, t0 = g('impacttime', 0.0), g('starttime', 0.0)
                proj = it > t0 > 0
                if objref.get(num) is st and not proj:          # unchanged entities keep the same state dict
                    continue
                objref[num] = st
                mi = g('modelindex', 0)
                if proj:
                    fr = min(1.0, max(0.0, (self.time - t0) / (it - t0)))
                    ox = g('startpos[0]', 0.0) + (g('endpos[0]', 0.0) - g('startpos[0]', 0.0)) * fr
                    oy = g('startpos[1]', 0.0) + (g('endpos[1]', 0.0) - g('startpos[1]', 0.0)) * fr
                    oz = g('startpos[2]', 0.0) + (g('endpos[2]', 0.0) - g('startpos[2]', 0.0)) * fr
                else:
                    ox, oy, oz = g('origin[0]', 0.0), g('origin[1]', 0.0), g('origin[2]', 0.0)
                fl = (1 if g('effects', 0) & EF_NODRAW else 0) | (g('rendermode', 0) & 7) << 1 | (g('renderfx', 0) & 255) << 4
                key = (mi, round(ox, 1), round(oy, 1), round(oz, 1),
                       round(g('angles[0]', 0.0), 1), round(g('angles[1]', 0.0), 1), round(g('angles[2]', 0.0), 1),
                       fl, int(g('renderamt', 0)), g('team', 0), g('body', 0), g('skin', 0), g('solid', 0),
                       g('sequence', 0) & 255, int(g('frame', 0)) & 255,
                       g('controller[0]', 0) & 255, g('controller[1]', 0) & 255, round(g('framerate', 0.0), 2),
                       g('colormap', 0) & 0xffff,
                       # MOVETYPE_FOLLOW (12) + aiment: drawn on that entity's skeleton (a carried flag)
                       g('movetype', 0), g('aiment', 0) if g('movetype', 0) == 12 else 0,
                       # rendercolor for kRenderFxGlowShell (TFC goal items glow in their team colour)
                       (int(g('rendercolor.r', 0)) & 255) | (int(g('rendercolor.g', 0)) & 255) << 8 | (int(g('rendercolor.b', 0)) & 255) << 16)
                if self._obj_last.get(num) != key:
                    self._obj_last[num] = key
                    self.objs.append([fi, num] + list(key))
        for num, tr in tracks.items():
            if num not in seen:
                tr[0].extend((0.0, 0.0, 0.0, 0.0, 0.0))
                tr[1].append(0)
                tr[2].append(0)
        if nobj != len(objref):
            present = {n for n, _ in ents if n > mc}
            for n in [n for n in objref if n not in present]:
                del objref[n]
                self._obj_last.pop(n, None)
                self.objs.append([fi, n, -1])

    # ---------------------------------------------------------------- summaries
    def all_players(self):
        """Players in order of first appearance, merged by SteamID (bots/HLTV by name)."""
        merged = {}
        order = []
        for pl in self.players.values():
            if pl.first is None:
                continue
            key = pl.steamid64 if pl.steamid64 and steam_ids(pl.steamid64) else ('name', pl.bot, pl.hltv, pl.name, pl.ent)
            if key not in merged:
                merged[key] = []
                order.append(key)
            merged[key].append(pl)
        out = []
        for key in order:
            group = sorted(merged[key], key=lambda p: p.first)
            out.append(group)
        out.sort(key=lambda g: g[0].first)
        return out

    def model_name(self, mi):
        return self.models.get(mi, '')


# TFC / HL user messages worth keeping
def u_deathmsg(demo, p):
    killer, victim = p[0], p[1]
    weapon = cstr(p, 2)
    t = round(demo.dtime, 2)
    demo.kills.append([t, killer, victim, weapon])
    k = demo.players.get(killer)
    v = demo.players.get(victim)
    if victim > demo.maxclients:          # TFC: a building (sentry, dispenser) was destroyed
        return
    if k is not None and killer != victim:
        k.kills_seen += 1
    if v is not None:
        v.deaths_seen += 1


def u_teaminfo(demo, p):
    ent = p[0]
    team = cstr(p, 1)
    pl = demo.players.get(ent)
    if pl is not None and team:
        pl.team = team
        if team not in pl.teams:
            pl.teams.append(team)


def u_scoreinfo(demo, p):
    ent = p[0]
    pl = demo.players.get(ent)
    if pl is not None and len(p) >= 5:
        pl.frags, pl.deaths = struct.unpack_from('<hh', p, 1)


def u_saytext(demo, p):
    ent = p[0]
    text = clean_chat(cstr(p, 1))
    if text:
        demo.chat.append([round(demo.dtime, 2), ent, text])


def u_textmsg(demo, p):
    parts = [clean_chat(s.decode('utf-8', 'replace')) for s in p[1:].split(b'\0')]
    parts = [s for s in parts if s]
    if parts:
        demo.texts.append([round(demo.dtime, 2), ' '.join(parts)])


def u_health(demo, p):
    if p and (not demo.health or demo.health[-1][1] != p[0]):
        demo.health.append([round(demo.dtime, 2), p[0]])


def u_battery(demo, p):
    if len(p) >= 2:
        a = struct.unpack_from('<h', p, 0)[0]
        if not demo.armor or demo.armor[-1][1] != a:
            demo.armor.append([round(demo.dtime, 2), a])


def u_hltvvitals(demo, p):
    # the hltv_vitals metamod plugin (plugin/hltv_vitals in this repository) on a server you run:
    # per player slot byte, health short, armor short; the players whose values changed, everyone once a second
    t = round(demo.dtime, 2)
    for o in range(0, len(p) - 4, 5):
        s, h, a = struct.unpack_from('<Bhh', p, o)
        v = demo.vitals.get(s)
        if v is None:
            v = demo.vitals[s] = {'health': [], 'armor': []}
        if not v['health'] or v['health'][-1][1] != h:
            v['health'].append([t, h])
        if not v['armor'] or v['armor'][-1][1] != a:
            v['armor'].append([t, a])


USERMSG_HANDLERS = {'DeathMsg': u_deathmsg, 'TeamInfo': u_teaminfo, 'ScoreInfo': u_scoreinfo,
                    'SayText': u_saytext, 'TextMsg': u_textmsg, 'Health': u_health, 'Battery': u_battery,
                    'HltvVitals': u_hltvvitals}

HANDLERS = {
    0: Demo.m_bad, 1: Demo.m_nop, 2: Demo.m_disconnect, 3: Demo.m_event, 4: Demo.m_version, 5: Demo.m_short,
    6: Demo.m_sound, 7: Demo.m_time, 8: Demo.m_print, 9: Demo.m_string, 10: Demo.m_setangle,
    11: Demo.m_serverinfo, 12: Demo.m_lightstyle, 13: Demo.m_updateuserinfo, 14: Demo.m_deltadescription,
    15: Demo.m_clientdata, 16: Demo.m_short, 17: Demo.m_pings, 18: Demo.m_particle, 19: Demo.m_nop,
    20: Demo.m_spawnstatic, 21: Demo.m_event_reliable, 22: Demo.m_spawnbaseline, 23: Demo.m_temp_entity,
    24: Demo.m_byte, 25: Demo.m_byte, 26: Demo.m_centerprint, 27: Demo.m_nop, 28: Demo.m_nop,
    29: Demo.m_spawnstaticsound, 30: Demo.m_nop, 31: Demo.m_string, 32: Demo.m_cdtrack, 33: Demo.m_restore,
    34: Demo.m_string, 35: Demo.m_short, 36: Demo.m_decalname, 37: Demo.m_short, 38: Demo.m_short,
    39: Demo.m_newusermsg, 40: Demo.m_packetentities, 41: Demo.m_deltapacketentities, 42: Demo.m_nop,
    43: Demo.m_resourcelist, 44: Demo.m_newmovevars, 45: Demo.m_resourcerequest, 46: Demo.m_customization,
    47: Demo.m_short, 48: Demo.m_soundfade, 49: Demo.m_string, 50: Demo.m_hltv, 51: Demo.m_director,
    52: Demo.m_voiceinit, 53: Demo.m_voicedata, 54: Demo.m_sendextrainfo, 55: Demo.m_timescale,
    56: Demo.m_string, 57: Demo.m_string, 58: Demo.m_sendcvarvalue2, 59: Demo.m_exec,
}


def repair(path):
    """Give an unfinished demo (recorder crashed, power cut) the closing frame + directory HL needs to play it.
    Returns True if the file was changed."""
    dm = Demo(path)
    if dm.complete:
        return False
    d = dm.data
    seg_starts = [HEADER_SIZE]
    last_end = HEADER_SIZE
    last_t, last_fn = 0.0, 0
    frames = [0, 0]
    seg = 0
    for ft, t, fn, p, nxt in dm.iter_frames():
        last_end, last_t, last_fn = nxt, t, fn
        frames[min(seg, 1)] += 1
        if ft == 5 and seg == 0:
            seg = 1
            seg_starts.append(nxt)
    if len(seg_starts) < 2:
        return False
    with open(path, 'r+b') as f:
        f.seek(last_end)
        f.truncate()
        f.write(struct.pack('<Bfi', 5, last_t, last_fn))
        diroff = f.tell()
        load = struct.pack('<i64siifiii', 0, b'LOADING', 0, -1, 0.0, frames[0], seg_starts[0], seg_starts[1] - seg_starts[0])
        game = struct.pack('<i64siifiii', 1, b'Playback', 0, -1, last_t, last_fn, seg_starts[1], diroff - seg_starts[1])
        f.write(struct.pack('<i', 2) + load + game)
        f.seek(540)
        f.write(struct.pack('<i', diroff))
    return True


def main():
    import time
    if len(sys.argv) < 2:
        print(__doc__)
        return
    path = sys.argv[1]
    t0 = time.time()
    dm = Demo(path).parse()
    print('%s: map %s, game %s, protocol %d/%d, %s demo, %s, %.0f s, %d frames, parsed in %.1f s'
          % (os.path.basename(path), dm.mapname, dm.gamedir, dm.demo_protocol, dm.net_protocol,
             'HLTV' if dm.hltv else 'client', 'complete' if dm.complete else 'UNFINISHED (no directory)',
             dm.duration, len(dm.times), time.time() - t0))
    print('server:', dm.server.get('hostname'), '| maxclients', dm.maxclients)
    for group in dm.all_players():
        pl = group[0]
        names = []
        for p in group:
            for n in p.names:
                if n not in names:
                    names.append(n)
        print('  slot %-2d %-20s %-22s %s  teams %s  classes %s  kills %d deaths %d' % (
            pl.ent, ' / '.join(names)[:40], pl.steam(), pl.steamid64 or '', ','.join(pl.team_names()),
            ','.join(pl.classes), sum(p.kills_seen for p in group), sum(p.deaths_seen for p in group)))
    print('tracks:', sorted(dm.tracks), ' objects keyframes:', len(dm.objs), ' shots:', len(dm.shots),
          ' kills:', len(dm.kills), ' chat:', len(dm.chat))
    if dm.vitals:
        print('health/armor (HltvVitals) for slots %s: %d health and %d armor changes'
              % (sorted(dm.vitals), sum(len(v['health']) for v in dm.vitals.values()),
                 sum(len(v['armor']) for v in dm.vitals.values())))
    elif len(dm.health) > 1:
        print('health/armor of the recording player: %d health and %d armor changes' % (len(dm.health), len(dm.armor)))
    if dm.warnings:
        print('warnings (%d frames with errors):' % dm.frame_errors)
        for w in dm.warnings[:20]:
            print('  ', w)
    if '--fields' in sys.argv:
        for name, dl in dm.deltas.items():
            print(name, [f[0] for f in dl.fields])


if __name__ == '__main__':
    main()
