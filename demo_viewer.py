"""HLTV / GoldSrc demo viewer: a small local web server + a browser page (web/) that replays demos in 3D on the real
map, with rewind, speed control, any player's first-person view and an X-ray mode for spotting wallhacks.

    python -I demo_viewer.py            # opens http://127.0.0.1:27500 in your browser
    python -I demo_viewer.py --port 27501 --no-browser

Demos are listed from the recorder's output folder (hltv_recorder.ini) and the Half-Life mod folders; you can also
drag a .dem onto the page. Decoded demos and converted maps are cached in cache/ next to this script.
"""
import argparse
import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import mimetypes
import os
import socket
import struct
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bsp  # noqa: E402
import gamefiles  # noqa: E402
import goldsrc_demo  # noqa: E402
import mdl  # noqa: E402
import mp4mux  # noqa: E402
from hltv_recorder import load_config  # noqa: E402

WEB = os.path.join(HERE, 'web')
CACHE = os.path.join(HERE, 'cache')
UPLOADS = os.path.join(CACHE, 'uploads')
EDITS = os.path.join(HERE, 'edits')          # the Edit tab's shot lists, one JSON per demo
EXPORTS = os.path.join(HERE, 'Exports')      # exported videos
EXPORT_VERSION = 15
OBJ_COLUMNS = 24      # frame, ent, modelindex, origin, angles, flags, renderamt, team, body, skin, solid, sequence,
                      # frame byte, controller 0, controller 1, framerate, colormap (top | bottom << 8: team-coloured sentries),
                      # movetype, aiment (MOVETYPE_FOLLOW: a carried flag), rendercolor (r | g << 8 | b << 16)


class State:
    def __init__(self, cfg_path):
        self.g, _ = load_config(cfg_path)
        self.demos = {}            # id -> path
        self.jobs = {}             # id -> {'progress', 'error', 'done'}
        self.files = {}            # (kind, game, path) -> (status, bytes, headers): converted sounds and sprites
        self.exports = {}          # job id -> {'writer', 'path', 'lock'} while a video export is being written
        self.lock = threading.Lock()

    def roots(self):
        """(label, folder) pairs searched for demos."""
        out = [('Recordings', self.g['output_dir'])]
        hl = self.g['halflife_dir']
        if os.path.isdir(hl):
            for name in sorted(os.listdir(hl)):
                p = os.path.join(hl, name)
                if os.path.isdir(p) and any(f.lower().endswith('.dem') for f in safe_listdir(p)):
                    out.append(('Half-Life/' + name, p))
        out.append(('Dropped here', UPLOADS))
        return out

    def list_demos(self):
        items = []
        for label, folder in self.roots():
            for f in safe_listdir(folder):
                if not f.lower().endswith('.dem'):
                    continue
                path = os.path.join(folder, f)
                try:
                    st = os.stat(path)
                    with open(path, 'rb') as fh:
                        head = fh.read(544)
                except OSError:
                    continue
                if head[:6] != b'HLDEMO':
                    continue
                did = demo_id(path)
                self.demos[did] = path
                diroff = struct.unpack_from('<i', head, 540)[0]
                items.append({
                    'id': did, 'name': f, 'folder': label, 'size': st.st_size, 'mtime': st.st_mtime,
                    'map': goldsrc_demo.cstr(head[16:276]), 'game': goldsrc_demo.cstr(head[276:536]),
                    'recording': f.startswith('hltvrec_') or diroff == 0,
                    'players_txt': os.path.exists(os.path.splitext(path)[0] + '_players.txt'),
                    'cached': os.path.exists(cache_path(path, 'meta.json.gz')),
                })
        items.sort(key=lambda x: (x['folder'] != 'Recordings', -x['mtime']))
        return items


def safe_listdir(p):
    try:
        return os.listdir(p)
    except OSError:
        return []


def demo_id(path):
    return hashlib.sha1(os.path.abspath(path).lower().encode()).hexdigest()[:16]


def cache_path(path, suffix):
    try:
        st = os.stat(path)
        key = '%s|%d|%d|%d' % (os.path.abspath(path).lower(), st.st_size, int(st.st_mtime), EXPORT_VERSION)
    except OSError:
        key = path
    return os.path.join(CACHE, 'demos', hashlib.sha1(key.encode()).hexdigest()[:20] + '_' + suffix)


# ------------------------------------------------------------------ demo export
def export_demo(dm):
    """Decoded demo -> (meta dict, binary). Binary: times, per-slot positions/info, object keyframes."""
    n = len(dm.times)
    slots = sorted(dm.tracks)
    body = bytearray()
    layout = {}

    def put(name, b):
        while len(body) % 4:
            body.append(0)
        layout[name] = [len(body), len(b)]
        body.extend(b)

    put('times', dm.times.tobytes())
    for s in slots:
        pos, info, anim = dm.tracks[s]
        put('pos%d' % s, pos.tobytes())
        put('info%d' % s, info.tobytes())
        put('anim%d' % s, anim.tobytes())
    from array import array
    objs = array('f')
    for k in dm.objs:
        row = (k + [0] * OBJ_COLUMNS)[:OBJ_COLUMNS]
        objs.extend(float(x) for x in row)
    put('objs', objs.tobytes())
    # sound, event and temp-entity logs as flat float rows (see goldsrc_demo: m_sound, log_event, TE_DECODE)
    for name, rows, width in (('sounds', dm.sound_log, 11), ('events', dm.event_log, 16), ('tents', dm.tent_log, 16)):
        a = array('f')
        for r in rows:
            a.extend(float(x) for x in (tuple(r) + (0,) * width)[:width])
        put(name, a.tobytes())

    players = []
    for key, p in dm.players.items():
        if p.first is None:
            continue
        players.append({
            'ent': p.ent, 'name': p.name, 'names': p.names, 'steam': p.steam(),
            'sid64': p.steamid64 if goldsrc_demo.steam_ids(p.steamid64) else '',
            'bot': p.bot, 'hltv': p.hltv, 'first': p.first, 'left': p.left, 'last': p.last,
            'teams': p.team_names(), 'classes': p.classes, 'kills': p.kills_seen, 'deaths': p.deaths_seen,
            'ping': round(sum(p.pings) / len(p.pings)) if p.pings else None, 'pings': p.ping_t,
            'model': p.model, 'looks': p.looks,
        })
    players.sort(key=lambda p: (p['ent'], p['first']))
    meta = {
        'version': EXPORT_VERSION, 'file': os.path.basename(dm.path), 'map': dm.mapname, 'game': dm.gamedir,
        'hltv': dm.hltv, 'complete': dm.complete, 'duration': dm.duration, 'frames': n,
        'start': dm.times[0] if n else 0.0, 'end': dm.times[-1] if n else 0.0,
        'maxclients': dm.maxclients, 'server': dm.server, 'slots': slots, 'players': players,
        'models': {str(k): v for k, v in (dm.level_info[0]['models'] if dm.level_info else dm.models).items()},
        'events': {str(k): v for k, v in (dm.level_info[0]['events'] if dm.level_info else dm.eventnames).items()},
        'levels': [{'t': lv['t'], 'frame': lv['frame'], 'map': lv['map'],
                    'models': {str(k): v for k, v in lv['models'].items()},
                    'sounds': {str(k): v for k, v in lv.get('sounds', {}).items()},
                    'events': {str(k): v for k, v in lv.get('events', {}).items()}} for lv in dm.level_info]
                  or [{'t': 0.0, 'frame': 0, 'map': dm.mapname, 'models': {str(k): v for k, v in dm.models.items()}}],
        'pmodels': {str(k): v for k, v in dm.player_models.items()},
        'kills': dm.kills, 'chat': dm.chat, 'texts': dm.texts[:5000], 'shots': dm.shots,
        # health and armor per slot: {"<slot>": {health: [[t, hp]], armor: [[t, ap]]}} or None
        'vitals': vitals_by_slot(dm),
        'warnings': dm.warnings[:20], 'buffers': layout,
        'teams': goldsrc_demo.TFC_TEAMS if dm.gamedir.lower().startswith('tfc') else {},
        'classes': goldsrc_demo.TFC_CLASSES if dm.gamedir.lower().startswith('tfc') else {},
    }
    return meta, bytes(body)


def vitals_by_slot(dm):
    """Health and armor timelines per player slot: everyone's from the hltv_vitals server plugin (HLTV demos of the
    servers you run), and in a client demo the recording player's own from Health/Battery (the game sends those
    only to that player). None when the demo has nobody's."""
    out = {str(s): {'health': v['health'], 'armor': v['armor']} for s, v in sorted(dm.vitals.items()) if v['health']}
    if not dm.hltv and len(dm.health) > 1:
        out[str(dm.server.get('playernum', -1) + 1)] = {'health': dm.health, 'armor': dm.armor}
    return out or None


def write_gz(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(gzip.compress(data, 4))
    os.replace(tmp, path)


def decode_job(state, did, path):
    job = state.jobs[did]
    try:
        live = False
        with open(path, 'rb') as fh:
            head = fh.read(544)
        live = struct.unpack_from('<i', head, 540)[0] == 0
        dm = goldsrc_demo.Demo(path)
        dm.parse(progress=lambda f: job.__setitem__('progress', round(f, 3)))
        meta, data = export_demo(dm)
        meta['live'] = live
        job['live'] = live
        job['meta'] = gzip.compress(json.dumps(meta, separators=(',', ':')).encode(), 4)
        job['data'] = gzip.compress(data, 4)
        if not live:                                    # a demo still being recorded changes: don't cache it
            write_gz(cache_path(path, 'meta.json.gz'), json.dumps(meta, separators=(',', ':')).encode())
            write_gz(cache_path(path, 'data.bin.gz'), data)
        job['finished'] = time.time()
        job['done'] = True
    except Exception as e:
        traceback.print_exc()
        job['error'] = '%s: %s' % (type(e).__name__, e)


def map_blob(state, game, mapname):
    path = bsp.find_map(state.g['halflife_dir'], game, mapname)
    if not path:
        return None
    st = os.stat(path)
    key = hashlib.sha1(('%s|%d|%d|2' % (path.lower(), st.st_size, int(st.st_mtime))).encode()).hexdigest()[:20]
    cp = os.path.join(CACHE, 'maps', '%s_%s.bin.gz' % (mapname, key))
    if os.path.exists(cp):
        return open(cp, 'rb').read()
    meta, bufs = bsp.build(path, state.g['halflife_dir'])
    blob, _ = bsp.pack(meta, bufs)
    write_gz(cp, blob)
    return open(cp, 'rb').read()


model_lock = threading.Lock()


def model_blob(state, game, name):
    """A studio model for the viewer (mdl.py format, gzipped), converted once and cached in cache/models.
    name is a game path ('models/p_sniper.mdl') or a player model name from the userinfo ('scout')."""
    rel = name if ('/' in name or name.lower().endswith('.mdl')) else mdl.player_model_path(name)
    path = mdl.find_model(state.g['halflife_dir'], game, rel)
    if not path:
        return None
    stamp = []
    for p in (path, os.path.splitext(path)[0] + 'T.mdl'):
        if os.path.exists(p):
            st = os.stat(p)
            stamp.append('%s|%d|%d' % (p.lower(), st.st_size, int(st.st_mtime)))
    key = hashlib.sha1(('%s|%d' % ('|'.join(stamp), mdl.FORMAT_VERSION)).encode()).hexdigest()[:20]
    base = os.path.splitext(os.path.basename(path))[0]
    cp = os.path.join(CACHE, 'models', '%s_%s.bin.gz' % (base, key))
    with model_lock:
        if not os.path.exists(cp):
            meta, bufs = mdl.build(path)
            write_gz(cp, mdl.pack(meta, bufs))
    return open(cp, 'rb').read()


# ------------------------------------------------------------------ http
class Handler(BaseHTTPRequestHandler):
    state = None
    server_version = 'HLTVDemoViewer/1.0'

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype='application/json', gz=False, cache=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(',', ':')).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        if gz:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'max-age=3600' if cache else 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self.route_get()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            traceback.print_exc()
            try:
                self.send(500, {'error': str(e)})
            except OSError:
                pass

    def route_get(self):
        st = self.state
        u = urllib.parse.urlparse(self.path)
        parts = [p for p in u.path.split('/') if p]
        if not parts:
            return self.static('index.html')
        if parts[0] == 'web' and len(parts) == 2:
            return self.static(parts[1])
        if parts[:2] == ['api', 'demos']:
            return self.send(200, {'demos': st.list_demos(), 'output_dir': st.g['output_dir']})
        if parts[:3] == ['api', 'export', 'file'] and len(parts) == 4:
            return self.export_file(urllib.parse.unquote(parts[3]))
        if parts[:2] == ['api', 'edit'] and len(parts) == 3:
            path = self.edit_path(parts[2])
            if not path:
                return self.send(404, {'error': 'unknown demo'})
            if not os.path.exists(path):
                return self.send(200, {})
            with open(path, 'rb') as f:
                return self.send(200, f.read())
        if parts[:2] == ['api', 'demo'] and len(parts) == 4:
            did, what = parts[2], parts[3]
            path = st.demos.get(did)
            if path is None:
                st.list_demos()
                path = st.demos.get(did)
            if path is None:
                return self.send(404, {'error': 'unknown demo'})
            if what == 'open':
                return self.open_demo(did, path)
            if what in ('meta', 'data'):
                job = st.jobs.get(did)
                if job and job.get('done'):
                    return self.send(200, job[what], 'application/json' if what == 'meta' else 'application/octet-stream', gz=True)
                cp = cache_path(path, 'meta.json.gz' if what == 'meta' else 'data.bin.gz')
                if os.path.exists(cp):
                    return self.send(200, open(cp, 'rb').read(), 'application/json' if what == 'meta' else 'application/octet-stream', gz=True)
                return self.send(409, {'error': 'not decoded yet'})
            if what == 'players':
                txt = os.path.splitext(path)[0] + '_players.txt'
                if os.path.exists(txt):
                    return self.send(200, open(txt, 'rb').read(), 'text/plain; charset=utf-8')
                return self.send(404, 'no player list for this demo', 'text/plain')
        if parts[:2] == ['api', 'map'] and len(parts) == 4:
            blob = map_blob(st, urllib.parse.unquote(parts[2]), urllib.parse.unquote(parts[3]))
            if blob is None:
                return self.send(404, {'error': 'map %s not found under %s' % (parts[3], st.g['halflife_dir'])})
            return self.send(200, blob, 'application/octet-stream', gz=True, cache=True)
        if parts[:2] in (['api', 'sound'], ['api', 'sprite']) and len(parts) >= 4:
            return self.game_file(parts[1], urllib.parse.unquote(parts[2]), '/'.join(urllib.parse.unquote(x) for x in parts[3:]))
        if parts[:2] == ['api', 'model'] and len(parts) == 4:
            name = urllib.parse.unquote(parts[3])
            try:
                blob = model_blob(st, urllib.parse.unquote(parts[2]), name)
            except (mdl.ModelError, struct.error, IndexError, ValueError) as e:
                return self.send(422, {'error': 'model %s: %s' % (name, e)})
            if blob is None:
                return self.send(404, {'error': 'model %s not found under %s' % (name, st.g['halflife_dir'])})
            return self.send(200, blob, 'application/octet-stream', gz=True, cache=True)
        return self.send(404, {'error': 'not found'})

    def game_file(self, kind, game, rel):
        """/api/sound/<game>/<path under sound/> -> 16-bit WAV (+ X-Loop-Start/End in samples when the engine loops it);
        /api/sprite/<game>/<path under sprites/> -> GSPR blob. Converted once per run and kept in memory."""
        st = self.state
        top = 'sound' if kind == 'sound' else 'sprites'
        if not rel.lower().startswith(top + '/'):
            rel = top + '/' + rel
        key = (kind, game.lower(), rel.lower())
        hit = st.files.get(key)
        if hit is None:
            path = gamefiles.find_file(st.g['halflife_dir'], game, rel)
            if path is None:
                hit = (404, None, {})
            else:
                try:
                    if kind == 'sound':
                        data, ls, le, rate = gamefiles.wav_for_web(path)
                        hdr = {'X-Loop-Start': str(ls), 'X-Loop-End': str(le)} if ls is not None else {}
                        hit = (200, data, hdr)
                    else:
                        hit = (200, gamefiles.sprite_blob(path), {})
                except (ValueError, struct.error, IndexError) as e:
                    hit = (422, str(e).encode(), {})
            with st.lock:
                st.files[key] = hit
        code, data, hdr = hit
        if code != 200:
            return self.send(code, {'error': '%s %s: %s' % (kind, rel, (data or b'not found').decode('utf-8', 'replace'))})
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav' if kind == 'sound' else 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'max-age=3600')
        self.send_header('Access-Control-Expose-Headers', 'X-Loop-Start, X-Loop-End')
        for k, v in hdr.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def open_demo(self, did, path):
        st = self.state
        with st.lock:
            job = st.jobs.get(did)
            cached = os.path.exists(cache_path(path, 'meta.json.gz')) and os.path.exists(cache_path(path, 'data.bin.gz'))
            if cached and not (job and not job.get('done') and not job.get('error')):
                return self.send(200, {'state': 'ready'})
            stale_live = job is not None and job.get('done') and job.get('live') and time.time() - job.get('finished', 0) > 20
            if job is None or job.get('error') or stale_live:
                job = st.jobs[did] = {'progress': 0.0, 'done': False, 'error': None}
                threading.Thread(target=decode_job, args=(st, did, path), daemon=True).start()
        if job.get('error'):
            return self.send(200, {'state': 'error', 'error': job['error']})
        if job.get('done'):
            return self.send(200, {'state': 'ready'})
        return self.send(200, {'state': 'decoding', 'progress': job['progress']})

    def static(self, name):
        if '/' in name or '\\' in name or name.startswith('.'):
            return self.send(404, 'no', 'text/plain')
        p = os.path.join(WEB, name)
        if not os.path.isfile(p):
            return self.send(404, 'not found', 'text/plain')
        ctype = mimetypes.guess_type(p)[0] or 'application/octet-stream'
        if name.endswith('.js'):
            ctype = 'text/javascript'
        return self.send(200, open(p, 'rb').read(), ctype + ('; charset=utf-8' if ctype.startswith('text') else ''))

    def do_POST(self):
        try:
            self.route_post()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            traceback.print_exc()
            try:
                self.send(500, {'error': str(e)})
            except OSError:
                pass

    def same_origin(self):
        """POSTs only from this page: another site open in the browser could otherwise post to 127.0.0.1 too."""
        origin = self.headers.get('Origin')
        if not origin:
            return True
        host = urllib.parse.urlparse(origin).netloc
        port = self.server.server_address[1]
        return host in ('127.0.0.1:%d' % port, 'localhost:%d' % port, '[::1]:%d' % port)

    def body(self, limit):
        n = int(self.headers.get('Content-Length', 0))
        if n < 0 or n > limit:
            raise ValueError('bad size')
        data = io.BytesIO()
        left = n
        while left:
            chunk = self.rfile.read(min(left, 1 << 20))
            if not chunk:
                break
            data.write(chunk)
            left -= len(chunk)
        return data.getvalue()

    def edit_path(self, did):
        path = self.state.demos.get(did)
        if path is None:
            self.state.list_demos()
            path = self.state.demos.get(did)
        if path is None:
            return None
        return os.path.join(EDITS, os.path.splitext(os.path.basename(path))[0] + '.json')

    def route_post(self):
        u = urllib.parse.urlparse(self.path)
        parts = [p for p in u.path.split('/') if p]
        if not self.same_origin():
            return self.send(403, {'error': 'wrong origin'})
        if parts[:2] == ['api', 'edit'] and len(parts) == 3:
            path = self.edit_path(parts[2])
            if not path:
                return self.send(404, {'error': 'unknown demo'})
            raw = self.body(4 << 20)
            json.loads(raw)                                 # only valid JSON gets saved
            os.makedirs(EDITS, exist_ok=True)
            with open(path + '.tmp', 'wb') as f:
                f.write(raw)
            os.replace(path + '.tmp', path)
            return self.send(200, {'saved': os.path.basename(path)})
        if parts[:2] == ['api', 'export']:
            return self.export_post(parts[2:])
        if u.path != '/api/upload':
            return self.send(404, {'error': 'not found'})
        q = urllib.parse.parse_qs(u.query)
        name = os.path.basename(q.get('name', ['dropped.dem'])[0]) or 'dropped.dem'
        if not name.lower().endswith('.dem'):
            name += '.dem'
        raw = self.body(1 << 30)
        if raw[:6] != b'HLDEMO':
            return self.send(400, {'error': 'not a GoldSrc demo'})
        os.makedirs(UPLOADS, exist_ok=True)
        path = os.path.join(UPLOADS, name)
        with open(path, 'wb') as f:
            f.write(raw)
        did = demo_id(path)
        self.state.demos[did] = path
        return self.send(200, {'id': did})

    def export_file(self, name):
        """An exported video, with byte ranges so the page's video player can seek in it."""
        p = os.path.join(EXPORTS, os.path.basename(name))
        if not os.path.isfile(p) or not p.lower().endswith(('.mp4', '.mov')):
            return self.send(404, {'error': 'no such file'})
        size = os.path.getsize(p)
        start, end = 0, size - 1
        rng = self.headers.get('Range', '')
        if rng.startswith('bytes='):
            a, _, b = rng[6:].split(',')[0].partition('-')
            if a:
                start = int(a)
                end = int(b) if b else size - 1
            elif b:
                start = max(0, size - int(b))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(200)
        self.send_header('Content-Type', 'video/quicktime' if p.lower().endswith('.mov') else 'video/mp4')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        with open(p, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ------------------------------------------------------------ video export (the Edit tab)
    # The page renders and encodes the frames (WebCodecs H.264 + AAC) and posts the packets; mp4mux writes the file.
    def export_post(self, rest):
        st = self.state
        if rest == ['start']:
            a = json.loads(self.body(1 << 20))
            fmt = 'mov' if a.get('format') == 'mov' else 'mp4'
            width, height, fps = int(a['width']), int(a['height']), int(a['fps'])
            if not (16 <= width <= 7680 and 16 <= height <= 4320 and 1 <= fps <= 240):
                return self.send(400, {'error': 'bad size'})
            src = st.demos.get(a.get('demo', ''), '')
            stem = os.path.splitext(os.path.basename(src))[0] if src else 'demo'
            name = ''.join(c if c.isalnum() or c in '-_ .()' else '_' for c in (a.get('name') or '')).strip(' .')
            name = name or '%s_%s' % (stem, dt.datetime.now().strftime('%Y-%m-%d_%H-%M-%S'))
            os.makedirs(EXPORTS, exist_ok=True)
            path = os.path.join(EXPORTS, name + '.' + fmt)
            k = 2
            while os.path.exists(path):
                path = os.path.join(EXPORTS, '%s (%d).%s' % (name, k, fmt))
                k += 1
            audio = a.get('audio')
            w = mp4mux.Mp4Writer(path, fmt, width, height, fps, base64.b64decode(a['avcc']),
                                 (int(audio['rate']), int(audio['channels']), audio.get('codec', 'aac')) if audio else None)
            job = hashlib.sha1(('%s%f' % (path, time.time())).encode()).hexdigest()[:12]
            st.exports[job] = {'writer': w, 'path': path, 'lock': threading.Lock()}
            return self.send(200, {'job': job, 'file': os.path.basename(path)})
        if rest == ['reveal']:
            a = json.loads(self.body(1 << 16))
            p = os.path.abspath(os.path.join(EXPORTS, os.path.basename(a.get('file', ''))))
            if not os.path.exists(p):
                return self.send(404, {'error': 'no such file'})
            if os.name == 'nt':
                import subprocess
                subprocess.Popen(['explorer', '/select,', p])
            return self.send(200, {'ok': True})
        if len(rest) != 2 or rest[0] not in st.exports:
            return self.send(404, {'error': 'unknown export'})
        job, what = st.exports[rest[0]], rest[1]
        w = job['writer']
        if what == 'packets':
            raw = self.body(256 << 20)
            with job['lock']:
                o = 0
                # packets: u8 track (0 video, 1 audio), u8 key, u32 size, f64 pts (us), f64 duration (us), data
                while o + 22 <= len(raw):
                    track, key, size = struct.unpack_from('<BBI', raw, o)
                    pts, dur = struct.unpack_from('<dd', raw, o + 6)
                    w.add('video' if track == 0 else 'audio', raw[o + 22:o + 22 + size], pts, key, dur)
                    o += 22 + size
            return self.send(200, {'ok': True})
        if what == 'finish':
            a = json.loads(self.body(1 << 16) or b'{}')
            with job['lock']:
                path = w.finish(base64.b64decode(a['config']) if a.get('config') else None)
            del st.exports[rest[0]]
            return self.send(200, {'file': os.path.basename(path), 'folder': EXPORTS, 'size': os.path.getsize(path), 'quality': w.quality})
        if what == 'cancel':
            with job['lock']:
                w.abort()
            del st.exports[rest[0]]
            return self.send(200, {'ok': True})
        return self.send(404, {'error': 'not found'})


class LocalServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second viewer bind the same port silently while the old one keeps the requests
    allow_reuse_address = os.name != 'nt'
    daemon_threads = True


class LocalServer6(LocalServer):
    address_family = socket.AF_INET6


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', default=os.path.join(HERE, 'hltv_recorder.ini'))
    ap.add_argument('--port', type=int, default=27500)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('demo', nargs='?', help='a .dem to open right away')
    args = ap.parse_args()
    Handler.state = State(args.config)
    os.makedirs(CACHE, exist_ok=True)
    url = 'http://127.0.0.1:%d/' % args.port
    try:
        httpd = LocalServer(('127.0.0.1', args.port), Handler)
    except OSError:
        # most likely a viewer is already running: just open the page instead of failing quietly
        print('Port %d is already in use, so the viewer is probably already running: %s' % (args.port, url), flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        return
    try:                                    # also answer http://localhost:<port>, which some browsers try as ::1 first
        httpd6 = LocalServer6(('::1', args.port), Handler)
        threading.Thread(target=httpd6.serve_forever, daemon=True).start()
    except OSError:
        pass
    if args.demo:
        path = os.path.abspath(args.demo)
        did = demo_id(path)
        Handler.state.demos[did] = path
        url += '#demo=' + did
    print('Demo viewer running at %s  (Ctrl+C to stop)' % url, flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
