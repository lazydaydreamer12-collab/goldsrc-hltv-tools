"""Headless HLTV recorder.

Runs Valve's hltv.exe hidden (no window), joins a game server or someone else's HLTV proxy, and records every map to
its own demo. Each finished demo is filed in the output folder as

    <YYYY-MM-DD>_<HH-MM-SS>_<map>.dem          the demo (plays in Half-Life with "viewdemo" or in our viewer)
    <YYYY-MM-DD>_<HH-MM-SS>_<map>_players.txt  everyone seen: names, SteamIDs, profile links, teams, K/D, chat

and every player is added to players_index.csv (search it for a SteamID to find all demos someone is in).
Settings live in hltv_recorder.ini next to this script. Ctrl+C stops recording cleanly.

    python -I hltv_recorder.py                         record the servers in hltv_recorder.ini
    python -I hltv_recorder.py --connect 1.2.3.4:27015 record one server (other settings from the ini)
    python -I hltv_recorder.py --finalize <demo.dem>   write the player list for an existing demo
"""
import argparse
import configparser
import csv
import datetime as dt
import glob
import os
import re
import secrets
import socket
import subprocess
import queue
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import goldsrc_demo  # noqa: E402

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
# hltv.exe console lines worth echoing in the recorder window
# our own rcon 'status' replies also land in hltv.exe's console log; don't echo them back
STATUS_ECHO = re.compile(r'(---|Online|Local|Total|Connected to|Proxy Name|Server Name|Game Time|Recording to|Executing rcon)')
CONSOLE_KEEP = re.compile(r'^(WARNING|ERROR|Dropped|Rejected|Retrying|Start recording|Completed demo|Connection|Redirect|Bad (server )?password|Server is full|Banned|Kicked|Couldn.t|Cannot|Invalid)|password', re.I)
POLL_SECONDS = 2.0
STATUS_SECONDS = 30.0
LOST_SECONDS = 180.0        # this long without a connection: file the open demo and start a fresh hltv.exe
OFFLINE_LOG_SECONDS = 300.0  # while there is no connection, log the status this often instead of every 30 s


# Clicking in a console window starts a text selection, and Windows then blocks every write to it until a key is
# pressed. Console output goes through this thread so a click never stalls the recorder (filing, watchdog, log).
_console = queue.Queue()


def _console_writer():
    while True:
        line = _console.get()
        try:
            print(line, flush=True)
        except Exception:
            pass
        _console.task_done()


threading.Thread(target=_console_writer, daemon=True).start()


def flush_console(timeout=2.0):
    """Wait for the console thread to write everything; False if the window is still blocked by a selection."""
    end = time.time() + timeout
    while _console.unfinished_tasks and time.time() < end:
        time.sleep(0.05)
    return not _console.unfinished_tasks


def log(msg):
    line = '%s  %s' % (dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        with open(os.path.join(HERE, 'hltv_recorder.log'), 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass
    _console.put(line)


# ------------------------------------------------------------------ config
def load_config(path):
    cp = configparser.ConfigParser(inline_comment_prefixes=(';',), interpolation=None)
    if os.path.exists(path):
        cp.read(path, encoding='utf-8')
    rec = cp['recorder'] if cp.has_section('recorder') else {}
    base = os.path.dirname(os.path.abspath(path))
    out = rec.get('output_dir', 'Recordings') or 'Recordings'
    g = {
        'halflife_dir': rec.get('halflife_dir', r'C:\Program Files (x86)\Steam\steamapps\common\Half-Life'),
        'output_dir': out if os.path.isabs(out) else os.path.join(base, out),
        'label_in_filename': str(rec.get('label_in_filename', 'no')).lower() in ('1', 'yes', 'true', 'on'),
    }
    servers = []
    for sec in cp.sections():
        if not sec.lower().startswith('server:'):
            continue
        s = cp[sec]
        servers.append(server_settings(sec.split(':', 1)[1].strip() or 'main', s))
    return g, servers


def server_settings(label, s):
    return {
        'label': label,
        'address': s.get('address', '').strip(),
        'password': s.get('password', '').strip(),
        'proxy_password': s.get('proxy_password', '').strip(),
        'hltv_port': int(s.get('hltv_port', 27120) or 27120),
        'name': s.get('name', 'HLTV Recorder').strip() or 'HLTV Recorder',
        'updaterate': int(s.get('updaterate', 60) or 60),
        'rate': int(s.get('rate', 30000) or 30000),
        'delay': float(s.get('delay', 0) or 0),
    }


def safe(s):
    s = re.sub(r'[^A-Za-z0-9_.\-]+', '_', s).strip('_.')
    return s or 'x'


# ------------------------------------------------------------------ process plumbing
class KillOnExitJob:
    """Windows job object: hidden hltv.exe processes die with this script even if its window is closed."""

    def __init__(self):
        self.job = None
        if os.name != 'nt':
            return
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.WinDLL('kernel32', use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
            k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
            k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)

            class Basic(ctypes.Structure):
                _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                            ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                            ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                            ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                            ('SchedulingClass', wintypes.DWORD)]

            class Extended(ctypes.Structure):
                _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', ctypes.c_ulonglong * 6),
                            ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                            ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

            job = k32.CreateJobObjectW(None, None)
            info = Extended()
            info.BasicLimitInformation.LimitFlags = 0x2000          # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if job and k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                self.job, self.k32 = job, k32
        except Exception:
            self.job = None

    def add(self, proc):
        if self.job:
            self.k32.AssignProcessToJobObject(self.job, int(proc._handle))


def rcon(port, password, command, timeout=1.5):
    """Send a console command to our own hltv.exe (needs adminpassword) and return what it printed."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    addr = ('127.0.0.1', port)
    try:
        s.sendto(b'\xff\xff\xff\xffchallenge rcon\n', addr)
        data, _ = s.recvfrom(4096)
        parts = data[4:].split()
        if len(parts) < 3:
            return None
        s.sendto(b'\xff\xff\xff\xffrcon %s %s %s\n' % (parts[2], password.encode(), command.encode()), addr)
        out = b''
        while True:
            try:
                data, _ = s.recvfrom(65535)
            except socket.timeout:
                break
            out += data[5:] if data[:4] == b'\xff\xff\xff\xff' else data
            s.settimeout(0.3)
        return out.decode('utf-8', 'replace')
    except (socket.timeout, OSError):
        return None
    finally:
        s.close()


# ------------------------------------------------------------------ one recorder per server
class Recorder:
    def __init__(self, g, srv, job):
        self.g, self.srv, self.job = g, srv, job
        self.label = srv['label']
        self.prefix = 'hltvrec_' + safe(self.label)
        self.password = secrets.token_hex(8)
        self.proc = None
        self.restart_at = 0.0
        self.backoff = 5.0
        self.started = 0.0
        self.next_status = 0.0
        self.current = None
        self.stopping = False
        self.was_connected = False
        self.lost_since = None
        self.last_offline_log = 0.0

    def exe(self):
        return os.path.join(self.g['halflife_dir'], 'hltv.exe')

    def command_line(self):
        s = self.srv
        cmd = [self.exe(), '-port', str(s['hltv_port']), '-nodns', '+logfile', self.prefix + '_console.txt',
               '+name', s['name'], '+maxclients', '0', '+delay', '%g' % s['delay'], '+nomaster', '1',
               '+chatmode', '0', '+rate', str(s['rate']), '+updaterate', str(s['updaterate']),
               '+autoretry', '1', '+adminpassword', self.password]
        if s['password']:
            cmd += ['+serverpassword', s['password']]
        if s['proxy_password']:
            cmd += ['+proxypassword', s['proxy_password']]
        cmd += ['+record', self.prefix, '+connect', s['address']]
        return cmd

    def start(self):
        if not os.path.exists(self.exe()):
            raise SystemExit('hltv.exe not found in %s (set halflife_dir in hltv_recorder.ini)' % self.g['halflife_dir'])
        self.finalize_leftovers()
        # hltv.exe reads its console with GetNumberOfConsoleInputEvents and quits without a real console, so it
        # gets its own console with the window hidden; its output is read back from its log file
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0                                         # SW_HIDE
        self.open_console_log()
        self.proc = subprocess.Popen(self.command_line(), cwd=self.g['halflife_dir'], startupinfo=si,
                                     creationflags=CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP)
        self.job.add(self.proc)
        self.started = time.time()
        self.next_status = self.started + 8
        log('[%s] hltv.exe started (pid %d, port %d), joining %s' % (self.label, self.proc.pid, self.srv['hltv_port'], self.srv['address']))

    def open_console_log(self):
        self.console_path = None
        self.console_pos = 0
        self.console_since = time.time()

    def read_console_log(self):
        if not self.console_path:
            found = glob.glob(os.path.join(self.g['halflife_dir'], self.prefix + '_console.txt')) + \
                glob.glob(os.path.join(self.g['halflife_dir'], '*', self.prefix + '_console.txt'))
            if not found:
                return
            newest = max(found, key=os.path.getmtime)
            if os.path.getmtime(newest) < self.console_since - 1:
                return            # still the previous hltv.exe's log; the new one overwrites it when it starts
            self.console_path = newest
        try:
            with open(self.console_path, 'rb') as f:
                f.seek(self.console_pos)
                chunk = f.read()
        except OSError:
            return
        if b'\n' not in chunk:
            return
        chunk = chunk[:chunk.rindex(b'\n') + 1]
        self.console_pos += len(chunk)
        for line in chunk.decode('utf-8', 'replace').splitlines():
            line = line.strip()
            if line and CONSOLE_KEEP.search(line) and 'rcon' not in line.lower() and not STATUS_ECHO.match(line):
                log('[%s] hltv: %s' % (self.label, line))

    def demo_files(self):
        return sorted(glob.glob(os.path.join(self.g['halflife_dir'], '*', self.prefix + '-*.dem')))

    def poll(self):
        now = time.time()
        self.read_console_log()
        if self.proc is not None and self.proc.poll() is not None:
            log('[%s] hltv.exe exited (code %s); restarting in %.0f s' % (self.label, self.proc.returncode, self.backoff))
            self.current = None
            self.proc = None
            self.restart_at = now + self.backoff
            self.backoff = min(self.backoff * 2, 120.0)
        if self.proc is None and not self.stopping and now >= self.restart_at:
            self.start()
        if self.proc is not None and now - self.started > 300:
            self.backoff = 5.0
        # a demo HLTV has closed can be renamed; the one it is writing is locked
        for f in self.demo_files():
            if not self.try_finalize(f) and f != self.current:
                self.current = f
                log('[%s] recording %s' % (self.label, os.path.basename(f)))
        if self.proc is not None and now >= self.next_status:
            self.next_status = now + STATUS_SECONDS
            self.report_status()

    def report_status(self):
        out = rcon(self.srv['hltv_port'], self.password, 'status')
        if out is None:
            log('[%s] (no answer from hltv.exe yet)' % self.label)
            return
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        now = time.time()
        offline = any(ln.startswith('Not connected') for ln in lines)
        if any(ln.startswith('Connected to') for ln in lines):
            if self.lost_since is not None and self.was_connected:
                log('[%s] connected again after %s without a connection' % (self.label, fmt_dur(now - self.lost_since)))
            self.was_connected, self.lost_since = True, None
        elif offline:
            if self.lost_since is None:
                self.lost_since = now
            if self.current and now - self.lost_since >= LOST_SECONDS:
                self.restart_offline(now)
                return
            if now - self.last_offline_log < OFFLINE_LOG_SECONDS:
                return
            self.last_offline_log = now
        keep = [ln for ln in lines if re.search(r'Game|Map|Recording|Connected|connect|Players|offline|Source', ln, re.I)]
        size = ''
        if self.current and os.path.exists(self.current):
            size = ' | demo %.1f MB' % (os.path.getsize(self.current) / 1e6)
        mem = process_memory_mb(self.proc.pid) if self.proc else None
        if mem:
            size += ' | hltv.exe %.0f MB' % mem
        log('[%s] %s%s' % (self.label, ' | '.join(keep[:4]) or lines[:1], size))

    def restart_offline(self, now):
        """The server has been gone a while. HLTV would carry on with the same demo whenever the server comes back,
        so the open demo stays unfiled meanwhile, and recording again in this hltv.exe would start from its last stale
        frame. Close the demo (it gets filed) and start a fresh hltv.exe, which keeps retrying and starts a new demo
        once it is connected again."""
        log('[%s] no connection for %s: filing %s and restarting hltv.exe; it keeps retrying and records again when '
            '%s is back' % (self.label, fmt_dur(now - self.lost_since), os.path.basename(self.current), self.srv['address']))
        rcon(self.srv['hltv_port'], self.password, 'stoprecording')
        time.sleep(1.0)
        rcon(self.srv['hltv_port'], self.password, 'quit')
        try:
            self.proc.wait(8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(5)
        self.proc = None
        self.restart_at = time.time() + 2
        time.sleep(0.5)
        for f in self.demo_files():
            self.try_finalize(f)

    def try_finalize(self, f):
        tmp = f[:-4] + '.closing'
        try:
            os.replace(f, tmp)
        except OSError:
            return False          # still being written
        if f == self.current:
            self.current = None
        try:
            finalize(tmp, self.g, self.srv, original_name=os.path.basename(f))
        except Exception as e:     # never lose a demo over a report problem
            log('[%s] could not write the player list for %s: %s' % (self.label, os.path.basename(f), e))
            try:
                os.makedirs(self.g['output_dir'], exist_ok=True)
                move(tmp, unique(os.path.join(self.g['output_dir'], os.path.basename(f))))
            except Exception as e2:
                log('[%s] could not move %s to the output folder (%s); it stays at %s' % (self.label, os.path.basename(f), e2, tmp))
        return True

    def finalize_leftovers(self):
        for f in self.demo_files() + glob.glob(os.path.join(self.g['halflife_dir'], '*', self.prefix + '-*.closing')):
            if f.endswith('.closing'):
                try:
                    os.replace(f, f[:-8] + '.dem')
                except OSError:
                    continue
                f = f[:-8] + '.dem'
            log('[%s] filing demo left over from an earlier run: %s' % (self.label, os.path.basename(f)))
            self.try_finalize(f)

    def quick_stop(self):
        """Window is closing: have hltv.exe close the demo properly; it gets filed on the next start."""
        self.stopping = True
        if self.proc is None:
            return
        rcon(self.srv['hltv_port'], self.password, 'stoprecording', timeout=0.8)
        rcon(self.srv['hltv_port'], self.password, 'quit', timeout=0.5)
        try:
            self.proc.wait(2)
        except subprocess.TimeoutExpired:
            pass

    def stop(self):
        self.stopping = True
        if self.proc is None:
            return
        rcon(self.srv['hltv_port'], self.password, 'stoprecording')
        time.sleep(1.0)
        rcon(self.srv['hltv_port'], self.password, 'quit')
        try:
            self.proc.wait(8)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None
        time.sleep(0.5)
        for f in self.demo_files():
            self.try_finalize(f)


def move(src, dst):
    """Rename, or copy + delete when the output folder is on another drive than Half-Life."""
    try:
        os.replace(src, dst)
    except OSError:
        import shutil
        shutil.move(src, dst)


def process_memory_mb(pid):
    """Working set of a process in MB (tasklist), or None."""
    try:
        out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH'], capture_output=True,
                             text=True, timeout=5, creationflags=0x08000000).stdout
        last = out.strip().split('","')[-1]                 # e.g. "12,345 K"
        return int(re.sub(r'\D', '', last)) / 1024.0
    except Exception:
        return None


def unique(path):
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    i = 2
    while os.path.exists('%s_%d%s' % (root, i, ext)):
        i += 1
    return '%s_%d%s' % (root, i, ext)


# ------------------------------------------------------------------ filing + player list
def start_time(path, original_name):
    """Wall-clock start of the recording: HLTV's YYMMDDhhmm stamp in the name, seconds from the file's creation time."""
    st = os.stat(path)
    created = dt.datetime.fromtimestamp(getattr(st, 'st_birthtime', None) or st.st_ctime)
    m = re.search(r'-(\d{10})-', original_name or '')
    if m:
        stamp = dt.datetime.strptime(m.group(1), '%y%m%d%H%M')
        if abs((created - stamp).total_seconds()) < 120:
            return created
        return stamp
    return created


def fmt_dur(sec):
    sec = int(round(sec))
    h, m, s = sec // 3600, sec // 60 % 60, sec % 60
    return '%dh%02dm%02ds' % (h, m, s) if h else '%dm%02ds' % (m, s)


def finalize(path, g, srv=None, original_name=None):
    """Repair (if HLTV died mid-map), parse, rename to <date>_<time>_<map>.dem and write the player list."""
    repaired = goldsrc_demo.repair(path)
    demo = goldsrc_demo.Demo(path).parse()
    start = start_time(path, original_name or os.path.basename(path))
    mapname = safe(demo.mapname or 'unknown')
    base = '%s_%s' % (start.strftime('%Y-%m-%d_%H-%M-%S'), mapname)
    if srv and g.get('label_in_filename'):
        base += '_' + safe(srv['label'])
    out_dir = g['output_dir']
    os.makedirs(out_dir, exist_ok=True)
    dem = unique(os.path.join(out_dir, base + '.dem'))
    base = os.path.splitext(os.path.basename(dem))[0]
    txt = os.path.join(out_dir, base + '_players.txt')
    with open(txt, 'w', encoding='utf-8') as f:
        f.write(players_report(demo, start, os.path.basename(dem), srv, repaired))
    move(path, dem)
    append_index(os.path.join(out_dir, 'players_index.csv'), demo, start, os.path.basename(dem))
    log('filed %s (%s, %d players, %s)%s' % (os.path.basename(dem), fmt_dur(demo.duration),
                                              sum(1 for r in merged_rows(demo) if not r['hltv']), os.path.basename(txt),
                                              ' [repaired: recording was cut off]' if repaired else ''))
    return dem, txt


def merged_rows(demo):
    rows = []
    for group in demo.all_players():
        names = []
        for p in group:
            for n in p.names:
                if n not in names:
                    names.append(n)
        first = min(p.first for p in group)
        end = demo.times[-1] if len(demo.times) else 0.0       # still connected = on the server until the end
        last = max((p.left if p.left is not None else end) or 0 for p in group)
        teams, classes = [], []
        for p in group:
            for t in p.team_names():
                if t not in teams:
                    teams.append(t)
            for c in p.classes:
                if c not in classes:
                    classes.append(c)
        if not teams and not classes:
            teams = ['spec']
        pings = [x for p in group for x in p.pings]
        rows.append({
            'names': names, 'steam': group[0].steam(), 'sid64': group[0].steamid64 if goldsrc_demo.steam_ids(group[0].steamid64) else '',
            'bot': group[0].bot, 'hltv': group[0].hltv, 'first': first, 'last': last,
            'still_in': any(p.left is None for p in group), 'teams': teams, 'classes': classes,
            'kills': sum(p.kills_seen for p in group), 'deaths': sum(p.deaths_seen for p in group),
            'ping': (sum(pings) / len(pings)) if pings else None, 'slots': sorted({p.ent for p in group}),
        })
    return rows


def players_report(demo, start, demo_name, srv=None, repaired=False):
    end = start + dt.timedelta(seconds=demo.duration)
    rows = merged_rows(demo)
    people = [r for r in rows if not r['hltv']]

    def wall(t):
        return (start + dt.timedelta(seconds=t or 0)).strftime('%H:%M:%S')

    lines = []
    lines.append('HLTV recording   %s  ->  %s   (%s)' % (start.strftime('%Y-%m-%d %H:%M:%S'), end.strftime('%H:%M:%S'),
                                                      fmt_dur(demo.duration)))
    lines.append('Map              %s' % demo.mapname)
    host = re.sub(r'(:\d+)+$', '', demo.server.get('hostname', ''))   # HLTV appends ':<n>'
    lines.append('Server           %s%s' % (host, ('   (%s)' % srv['address']) if srv else ''))
    lines.append('Demo file        %s' % demo_name)
    lines.append('Players seen     %d   (%d with a SteamID, %d bots/no ID)' % (
        len(people), sum(1 for r in people if r['sid64']), sum(1 for r in people if not r['sid64'])))
    if srv and srv.get('delay'):
        lines.append('Note             HLTV delay %g s: wall-clock times are that much behind the live game' % srv['delay'])
    if repaired:
        lines.append('Note             the recording was cut off (HLTV stopped mid-map); the demo was repaired so it still plays')
    lines.append('')
    hdr = '%-28s %-22s %-18s %-8s %-22s %-19s %-9s %s' % ('Name', 'SteamID', 'SteamID64', 'Team', 'Classes',
                                                           'On server', 'K / D', 'Profile')
    lines.append(hdr)
    lines.append('-' * len(hdr))
    for r in people:
        on = '%s-%s%s' % (wall(r['first']), wall(r['last']), '' if not r['still_in'] else '+')
        lines.append('%-28s %-22s %-18s %-8s %-22s %-19s %-9s %s' % (
            r['names'][-1][:28], r['steam'], r['sid64'], '/'.join(r['teams'])[:8], ','.join(r['classes'])[:22], on,
            '%d / %d' % (r['kills'], r['deaths']),
            ('https://steamcommunity.com/profiles/%s' % r['sid64']) if r['sid64'] else ''))
    lines.append('')
    lines.append('"+" after the time = still on the server when the recording ended. Times are wall-clock.')
    renamed = [r for r in people if len(r['names']) > 1]
    if renamed:
        lines.append('')
        lines.append('Name changes')
        for r in renamed:
            lines.append('  %-22s %s' % (r['steam'], '  ->  '.join(r['names'])))
    if demo.chat:
        lines.append('')
        lines.append('Chat')
        for t, ent, text in demo.chat:
            lines.append('  [%s] %s' % (wall(t), text))
    if demo.kills:
        lines.append('')
        lines.append('Kills')
        names = {}
        for key, p in demo.players.items():
            if isinstance(key, int):
                names[key] = p.name
        for t, k, v, w in demo.kills:
            kn = names.get(k, 'world' if k == 0 else '#%d' % k)
            if v > demo.maxclients:
                lines.append('  [%s] %-24s destroyed a %s' % (wall(t), kn[:24], w))
                continue
            vn = names.get(v, '#%d' % v)
            lines.append('  [%s] %-24s %-14s %s' % (wall(t), kn[:24], w[:14], vn))
    return '\n'.join(lines) + '\n'


def append_index(path, demo, start, demo_name):
    new = not os.path.exists(path)
    with open(path, 'a', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        if new:
            w.writerow(['date', 'start', 'map', 'demo', 'name', 'other names', 'steamid', 'steamid64', 'team',
                        'kills', 'deaths', 'joined', 'left'])
        for r in merged_rows(demo):
            if r['hltv']:
                continue
            w.writerow([start.strftime('%Y-%m-%d'), start.strftime('%H:%M:%S'), demo.mapname, demo_name,
                        r['names'][-1], ' / '.join(r['names'][:-1]), r['steam'], r['sid64'], '/'.join(r['teams']),
                        r['kills'], r['deaths'],
                        (start + dt.timedelta(seconds=r['first'] or 0)).strftime('%H:%M:%S'),
                        (start + dt.timedelta(seconds=r['last'] or 0)).strftime('%H:%M:%S')])


# ------------------------------------------------------------------ main
def keep_awake():
    """Ask Windows not to idle-sleep while the recorder runs (like a video player; ends when the process exits)."""
    if os.name != 'nt':
        return
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    except Exception:
        pass


def on_window_close(callback):
    """Run callback when the console window is closed (Windows gives ~5 s): enough to let hltv.exe finish the
    demo file. Ctrl+C is left to Python (KeyboardInterrupt), which also files the demo right away."""
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes
        proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

        def handler(event):
            if event in (2, 5, 6):          # CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT
                callback()
                return True
            return False

        h = proto(handler)
        ctypes.windll.kernel32.SetConsoleCtrlHandler(h, True)
        return h                            # caller keeps it alive
    except Exception:
        return None


class SingleInstance:
    def __init__(self, name):
        self.f = open(os.path.join(HERE, name), 'a+')
        try:
            import msvcrt
            msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
        except (ImportError, OSError):
            raise SystemExit('The recorder is already running (close the other window first).')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', default=os.path.join(HERE, 'hltv_recorder.ini'))
    ap.add_argument('--connect', help='record this ip:port instead of the servers in the ini')
    ap.add_argument('--hours', type=float, help='stop by itself after this many hours (the last demo is filed normally)')
    ap.add_argument('--finalize', nargs='+', metavar='DEMO', help='write player lists for existing demos (copies them into the output folder)')
    args = ap.parse_args()
    g, servers = load_config(args.config)

    if args.finalize:
        import shutil
        for path in args.finalize:
            tmp = os.path.join(g['output_dir'], '_import_' + os.path.basename(path))
            os.makedirs(g['output_dir'], exist_ok=True)
            shutil.copy2(path, tmp)
            finalize(tmp, g, None, original_name=os.path.basename(path))
        return

    if args.connect:
        base = dict(servers[0]) if servers else server_settings('main', {})
        base['address'] = args.connect
        base['label'] = safe(args.connect.replace(':', '_'))
        servers = [base]
    servers = [s for s in servers if s['address']]
    if not servers:
        raise SystemExit('No server to record: set address in hltv_recorder.ini or use --connect ip:port')
    ports = [s['hltv_port'] for s in servers]
    if len(set(ports)) != len(ports):
        raise SystemExit('Each [server:...] needs its own hltv_port.')

    lock = SingleInstance('hltv_recorder.lock')  # noqa: F841 (held until exit)
    os.makedirs(g['output_dir'], exist_ok=True)
    log('HLTV recorder: %d server(s), demos go to %s' % (len(servers), g['output_dir']))
    keep_awake()
    job = KillOnExitJob()
    recs = [Recorder(g, s, job) for s in servers]

    def closing():
        log('window closed: finishing the demo (it is filed the next time the recorder starts)')
        for r in recs:
            try:
                r.quick_stop()
            except Exception:
                pass
    close_handler = on_window_close(closing)  # noqa: F841 (must stay referenced)
    try:
        for r in recs:
            r.start()
        until = time.time() + args.hours * 3600 if args.hours else None
        if until:
            log('recording for %g hour(s), until %s' % (args.hours, dt.datetime.fromtimestamp(until).strftime('%H:%M')))
        while True:
            time.sleep(POLL_SECONDS)
            if until and time.time() >= until:
                log('time is up')
                break
            for r in recs:
                try:
                    r.poll()
                except Exception as e:      # keep recording whatever goes wrong while filing
                    log('[%s] error: %s' % (r.label, e))
    except KeyboardInterrupt:
        log('stopping (finishing the current demos)...')
    finally:
        for r in recs:
            try:
                r.stop()
            except Exception as e:
                log('[%s] stop failed: %s' % (r.label, e))
        log('recorder stopped')


if __name__ == '__main__':
    try:
        main()
    finally:
        if not flush_console():
            os._exit(1)     # Python's own exit would wait forever on the blocked console (everything is filed by now)
