'use strict';
/* Demo editor (the Edit tab): turn a demo into a video.

   An edit is a cut list over the demo's time: each shot starts at a demo moment and lasts until the next one, and says
   where the camera is: through a player's eyes, following them, on a dolly path through camera keyframes (which can
   also turn to track a player and zoom), or top-down. A shot can play slower or faster than real time, and can blend
   in from the previous shot instead of cutting. In / Out limit what gets exported. "Auto POV" builds a shot list from
   the kills. The edit is saved next to the tool (edits/<demo>.json).

   Export renders every frame exactly (not a screen capture) at the chosen size and frame rate, draws the overlays
   (kill feed, names, crosshair, caption, chat) onto it, encodes H.264 with the browser's WebCodecs encoder, mixes the
   game sound offline (GameAudio's offline mode, the same rules as live playback) into AAC, and the local server writes
   the packets into an .mp4 or .mov in Exports/ (mp4mux.py). */

const Editor = (() => {
  const RES = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4K': [3840, 2160] };
  const BPP = { high: 0.16, medium: 0.09, low: 0.05 };          // bits per pixel per frame
  const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];
  const BLENDS = [0, 0.5, 1, 2, 3];
  const CAMS = { eye: 'Eyes', follow: 'Follow', dolly: 'Dolly', top: 'Top-down' };
  const COLORS = { eye: '#4fd07a', follow: '#4f8ff7', dolly: '#f0a030', top: '#b07cf0' };
  const DEFAULTS = { res: '1080p', fps: 60, format: 'mp4', quality: 'high', sound: true, killfeed: true, names: false,
    crosshair: true, caption: true, chat: false, vitals: true, name: '', pipCorner: 'br', pipSize: 0.3 };
  const AUDIO_RATE = 48000, AUDIO_SEG = 60;

  let E = null, demo = null, saveTimer = 0, preview = false, sel = -1, job = null, lastCur = -2;
  const auto = { who: 0, lead: 3, victim: 1 };

  function blank() { return { v: 1, in: null, out: null, shots: [], settings: { ...DEFAULTS } }; }
  async function open(id) {
    demo = id; E = blank(); preview = false; sel = -1; lastCur = -2;
    try {
      const r = await fetch('/api/edit/' + id);
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.shots)) E = { ...blank(), ...j, settings: { ...DEFAULTS, ...(j.settings || {}) } };
      }
    } catch (e) { /* a new edit */ }
    sortShots();
    panel();
  }
  function sortShots() { if (E) E.shots.sort((a, b) => a.t - b.t); }
  function changed(rebuild = true) {
    sortShots();
    if (rebuild) panel();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }
  async function save() {
    if (!demo || !E) return;
    try {
      await fetch('/api/edit/' + demo, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(E) });
    } catch (e) { /* tried again on the next change */ }
  }

  // ---------------------------------------------------------------- time
  /** Where the video ends when Out isn't set: a dolly shot's last keyframe, else 8 s into the last shot. */
  function autoEnd() {
    const last = E && E.shots[E.shots.length - 1];
    if (!last) return S.meta.end;
    const keys = last.cam === 'dolly' ? (last.keys || []) : [];
    const end = keys.length > 1 ? keys[keys.length - 1].t + 1 : last.t + 8;
    return Math.min(S.meta.end, Math.max(end, last.t + 2));
  }
  /** What goes into the video: In to Out; without them, from the first shot to the end of the last one. */
  function range() {
    const has = E && E.shots.length > 0;
    const a = E && E.in != null ? E.in : (has ? E.shots[0].t : S.meta.start);
    const b = E && E.out != null ? E.out : (has ? autoEnd() : S.meta.end);
    return [Math.max(S.meta.start, Math.min(a, b)), Math.min(S.meta.end, Math.max(a, b))];
  }
  function shotAt(t) {
    if (!E || !E.shots.length) return -1;
    let k = 0;
    for (let i = 0; i < E.shots.length; i++) if (E.shots[i].t <= t + 1e-6) k = i;
    return k;
  }
  function speedAt(t) {
    const k = shotAt(t);
    return k >= 0 ? (E.shots[k].speed || 1) : 1;
  }
  /** Output (video) time <-> demo time: each shot's stretch of the demo plays at its speed. */
  function timeMap() {
    const [a, b] = range();
    const cuts = [a];
    for (const s of E.shots) if (s.t > a + 1e-6 && s.t < b - 1e-6) cuts.push(s.t);
    cuts.push(b);
    const segs = [];
    let out = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const sp = speedAt(cuts[i]), d = (cuts[i + 1] - cuts[i]) / sp;
      segs.push({ t0: cuts[i], t1: cuts[i + 1], sp, o0: out, o1: out + d });
      out += d;
    }
    return { segs, total: out };
  }
  function demoTime(map, T) {
    for (const s of map.segs) if (T < s.o1) return s.t0 + (T - s.o0) * s.sp;
    const l = map.segs[map.segs.length - 1];
    return l ? l.t1 : S.meta.start;
  }

  // ---------------------------------------------------------------- cameras
  const smooth01 = u => u * u * (3 - 2 * u);
  function pstate(s, t) {
    const [i, f] = frameAt(t);
    return playerState(s, i, f) || lastPlayerState(s, i);
  }
  /** A player's position averaged over t +- half (ignoring teleports), so cameras don't shake with every step. */
  function avgPos(s, t, half) {
    const c = pstate(s, t);
    if (!c) return null;
    let x = 0, y = 0, z = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const p = pstate(s, t + k * half / 2);
      if (!p || Math.abs(p.x - c.x) + Math.abs(p.y - c.y) + Math.abs(p.z - c.z) > 250) continue;
      x += p.x; y += p.y; z += p.z; n++;
    }
    return { ...c, x: x / n, y: y / n, z: z / n };
  }
  function avgYaw(s, t, half) {
    let sx = 0, sy = 0;
    for (let k = -3; k <= 3; k++) {
      const p = pstate(s, t + k * half / 3);
      if (p) { sx += Math.cos(p.yaw * DEG); sy += Math.sin(p.yaw * DEG); }
    }
    return Math.atan2(sy, sx) / DEG;
  }
  function aim(from, to) {
    const d = sub(to, from);
    return { yaw: Math.atan2(d[1], d[0]) / DEG, pitch: -Math.atan2(d[2], Math.hypot(d[0], d[1])) / DEG };
  }
  function followCam(sh, t) {
    const c = avgPos(sh.s, t, 0.3);
    if (!c) return null;
    const target = [c.x, c.y, c.z + (c.ducked ? 10 : 22)];
    const yaw = avgYaw(sh.s, t, 0.5) + (sh.side || 0), pitch = sh.height ?? 15, dist = sh.dist || 110;
    let pos = sub(target, mulv(forward(pitch, yaw), dist));
    const fr = traceLine(target, pos, frameAt(t)[0]);
    if (fr >= 0) pos = addv(target, mulv(sub(pos, target), Math.max(0.05, fr - 8 / dist)));
    return { pos, pitch, yaw, pov: null, fov: 90 };
  }
  function hermite(p0, v0, p1, v1, dt, u) {
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * v1;
  }
  /** A camera on a smooth path through the keyframes (position, yaw, pitch, zoom), timed by the demo clock. With
      "smooth" the camera eases out of the first key and into the last; with a tracked player it turns to follow them. */
  function dollyCam(sh, t) {
    const K = sh.keys || [];
    if (!K.length) return null;
    const ch = K.map(k => [k.pos[0], k.pos[1], k.pos[2], k.yaw, k.pitch, k.fov || 90]);
    for (let i = 1; i < ch.length; i++) ch[i][3] = ch[i - 1][3] + ((((ch[i][3] - ch[i - 1][3]) % 360) + 540) % 360 - 180);
    let v;
    const n = K.length;
    if (n === 1 || t <= K[0].t) v = ch[0];
    else if (t >= K[n - 1].t) v = ch[n - 1];
    else {
      let j = 0;
      while (j + 2 < n && K[j + 1].t <= t) j++;
      const dt = K[j + 1].t - K[j].t, u = dt > 0 ? (t - K[j].t) / dt : 0;
      const vel = k => {
        if (k === 0 || k === n - 1) {
          if (sh.smooth !== false) return ch[k].map(() => 0);
          const a = k === 0 ? 0 : n - 2, d = (K[a + 1].t - K[a].t) || 1;
          return ch[a + 1].map((x, c) => (x - ch[a][c]) / d);
        }
        const d = (K[k + 1].t - K[k - 1].t) || 1;
        return ch[k + 1].map((x, c) => (x - ch[k - 1][c]) / d);
      };
      const v0 = vel(j), v1 = vel(j + 1);
      v = ch[j].map((x, c) => hermite(x, v0[c], ch[j + 1][c], v1[c], dt, u));
    }
    let yaw = v[3], pitch = v[4];
    if (sh.look) {
      const p = avgPos(sh.look, t, 0.4);
      if (p) ({ yaw, pitch } = aim([v[0], v[1], v[2]], chestOf(p)));
    }
    return { pos: [v[0], v[1], v[2]], pitch, yaw, pov: null, fov: v[5] };
  }
  function shotCam(sh, t) {
    if (sh.cam === 'eye') {
      const [i, f] = frameAt(t);
      const p = playerState(sh.s, i, f);
      if (p && !p.hidden) return { pos: eyeOf(p), pitch: p.pitch, yaw: p.yaw, pov: p, fov: 90 };
      return followCam({ s: sh.s, dist: 110, height: 15 }, t);        // spectating or gone: watch from outside
    }
    if (sh.cam === 'follow') return followCam(sh, t);
    if (sh.cam === 'top') {
      const c = sh.s ? avgPos(sh.s, t, 0.6) : null;
      const m = c ? [c.x, c.y, c.z] : (sh.center || [0, 0, 0]);
      return { pos: [m[0], m[1], m[2] + (sh.h || 1400)], pitch: 89.9, yaw: 90, pov: null, fov: 90 };
    }
    if (sh.cam === 'dolly') return dollyCam(sh, t);
    return null;
  }
  /** The edit's camera at demo time t: { pos, pitch, yaw, pov, fov }, or null. */
  function cameraAt(t) {
    const k = shotAt(t);
    if (k < 0) return null;
    const sh = E.shots[k];
    let cam = shotCam(sh, t);
    if (cam && sh.blend > 0 && k > 0 && t >= sh.t && t < sh.t + sh.blend) {
      const prev = shotCam(E.shots[k - 1], t);
      if (prev) {
        const a = smooth01((t - sh.t) / sh.blend);
        cam = { pos: prev.pos.map((x, i) => lerp(x, cam.pos[i], a)), yaw: lerpAngle(prev.yaw, cam.yaw, a),
          pitch: lerp(prev.pitch, cam.pitch, a), fov: lerp(prev.fov || 90, cam.fov || 90, a), pov: a > 0.995 ? cam.pov : null };
      }
    }
    if (cam && sh.s && (sh.cam === 'eye' || sh.cam === 'follow')) S.sel = sh.s;
    return cam;
  }
  /** Called by the viewer's render(): the edit's camera while previewing or exporting, else null. */
  /** The player a shot is about (the one whose eyes, back or track it shows), or 0. */
  function subjectOf(sh) { return sh.cam === 'eye' || sh.cam === 'follow' ? sh.s : sh.cam === 'dolly' ? sh.look || 0 : sh.s || 0; }
  /** The victim of the next kill by slot s that hasn't landed more than 1.5 s ago, if it falls before `until`. */
  function nextVictim(s, t, until) {
    const mc = S.meta.maxclients;
    for (const k of S.meta.kills) {
      if (k[0] + 1.5 < t) continue;
      if (k[0] > until) break;
      if (k[1] === s && k[2] !== s && k[2] > 0 && k[2] <= mc) return k[2];
    }
    return 0;
  }
  /** The shot's picture in picture at demo time t, as the viewer's pipCamera takes it: { s | target, mode, label }. */
  function pipAt(t) {
    const k = shotAt(t);
    if (k < 0) return null;
    const sh = E.shots[k], pp = sh.pip;
    if (!pp) return null;
    const mode = pp.mode || 'eye';
    if (pp.who === 'target') return { target: true, mode };
    if (pp.who === 'victim') {
      const s0 = subjectOf(sh), end = k + 1 < E.shots.length ? E.shots[k + 1].t : range()[1];
      const v = s0 ? nextVictim(s0, t, end + 0.5) : 0;
      return v ? { s: v, mode, label: 'victim' } : null;
    }
    return pp.s ? { s: pp.s, mode } : null;
  }
  function pip() { return E && E.shots.length && (preview || job) ? pipAt(S.t) : null; }
  function pipLayout() { return { corner: (E && E.settings.pipCorner) || 'br', size: (E && +E.settings.pipSize) || 0.3 }; }
  function camera() {
    if (!E || !E.shots.length || !(preview || job)) return null;
    return cameraAt(S.t);
  }
  function active() { return !!E && E.shots.length > 0 && (preview || !!job); }
  function exporting() { return !!job; }
  /** After the viewer moved the clock while previewing: stop at Out. */
  function afterAdvance() {
    if (!preview || !E) return;
    const [, b] = range();
    if (S.t >= b) { S.t = b; S.playing = false; }
  }
  function setPreview(on) {
    preview = !!on && !!E && E.shots.length > 0;
    if (preview) {
      const [a, b] = range();
      if (S.t < a || S.t >= b - 0.05) seek(a);
    }
    panel();
  }
  function stopPreview() { if (preview) { preview = false; panel(); } }

  // ---------------------------------------------------------------- editing
  function curView() {
    const c = lastCam;
    return c ? { pos: c.pos.slice(), yaw: c.yaw, pitch: c.pitch, fov: c.fov || S.cam.fov || 90 } : null;
  }
  function addShotFromView() {
    const t = S.t, m = S.mode;
    let sh;
    if (m === 'eye') sh = { t, cam: 'eye', s: S.sel };
    else if (m === 'chase') sh = { t, cam: 'follow', s: S.sel, dist: S.orbit.dist || 110, height: Math.round(S.orbit.pitch ?? 15), side: 0 };
    else if (m === 'top') sh = { t, cam: 'top', s: 0, center: [S.top.x, S.top.y, 0], h: S.top.h || 1400 };
    else { const v = curView(); sh = { t, cam: 'dolly', keys: v ? [{ t, ...v }] : [], look: 0, smooth: true }; }
    sh.speed = 1; sh.blend = 0;
    E.shots = E.shots.filter(s => Math.abs(s.t - t) > 1e-3);
    E.shots.push(sh);
    sortShots();
    sel = E.shots.indexOf(sh);
    changed();
  }
  /** The current free camera as a keyframe of the dolly shot playing now (a new dolly shot if it isn't one). */
  function addKey() {
    if (!E) return;
    preview = false;
    if (S.mode !== 'free') setMode('free');
    const v = { t: S.t, pos: S.cam.pos.slice(), yaw: S.cam.yaw, pitch: S.cam.pitch, fov: S.cam.fov || 90 };
    const k = shotAt(S.t);
    let sh = k >= 0 && E.shots[k].t <= S.t + 1e-6 ? E.shots[k] : null;
    if (!sh || sh.cam !== 'dolly') {
      sh = { t: S.t, cam: 'dolly', keys: [], look: 0, smooth: true, speed: 1, blend: 0 };
      E.shots.push(sh);
    }
    sh.keys = sh.keys.filter(x => Math.abs(x.t - v.t) > 1e-3);
    sh.keys.push(v);
    sh.keys.sort((a, b) => a.t - b.t);
    sortShots();
    sel = E.shots.indexOf(sh);
    changed();
  }
  function setIn() { E.in = S.t; if (E.out != null && E.out <= E.in) E.out = null; changed(); }
  function setOut() { E.out = S.t; if (E.in != null && E.in >= E.out) E.in = null; changed(); }

  function playersNear(t) {
    const out = [];
    const [i] = frameAt(t);
    for (const s of S.D.slots) {
      const p = playerState(s, i, 0), pl = who(s, t);
      if (!pl || pl.hltv) continue;
      if (p || Math.abs(pl.first - t) < 5) out.push({ s, name: pl.name, team: p ? p.team : 0 });
    }
    return out.sort((a, b) => (a.team - b.team) || a.name.localeCompare(b.name));
  }
  function ident(pl) { return pl ? (pl.sid64 || 'n:' + pl.name) : ''; }

  /** Auto POV: through the killer's eyes from `lead` seconds before each kill, following the next killer through quiet
      stretches. A shot stays at least AUTO_MIN seconds and until its kill has landed; a kill that comes too soon to cut
      to in time is left out (the camera stays where it is). Only one player's kills if `whoSlot` is set (and following
      them in between). Replaces the shots between In and Out (the whole demo when they aren't set). */
  const AUTO_MIN = 2.5, AUTO_AFTER = 1.0, AUTO_QUIET = 2.5;
  function autoShots(whoSlot, lead) {
    const a = E.in != null ? E.in : S.meta.start, b = E.out != null ? E.out : S.meta.end;
    const mc = S.meta.maxclients;
    const want = whoSlot ? ident(who(whoSlot, S.t)) : '';
    const kills = S.meta.kills.filter(k => k[0] >= a && k[0] <= b && k[1] > 0 && k[1] <= mc && k[1] !== k[2] &&
      (!want || ident(who(k[1], k[0])) === want));
    if (!kills.length) return 0;
    const shots = [];
    const follow = (t, s) => shots.push({ t, cam: 'follow', s: whoSlot || s, dist: 120, height: 15, side: 0, speed: 1, blend: 0 });
    let cur = null;                      // the eyes shot on now: { s, t0, until (its last kill + a moment) }
    for (const k of kills) {
      const tk = k[0], s = k[1];
      if (cur && cur.s === s && tk - lead <= cur.until + AUTO_QUIET) { cur.until = tk + AUTO_AFTER; continue; }
      const wantAt = Math.max(a, tk - lead);
      const cut = cur ? Math.max(wantAt, cur.t0 + AUTO_MIN, cur.until) : wantAt;
      if (cut > tk - 0.6) continue;      // no time to see it coming: stay on the current shot
      const quietFrom = cur ? cur.until : a;
      if (cut - quietFrom > AUTO_QUIET) follow(quietFrom, s);
      shots.push({ t: cut, cam: 'eye', s, speed: 1, blend: 0, ...(auto.victim ? { pip: { who: 'victim', mode: 'eye' } } : {}) });
      cur = { s, t0: cut, until: tk + AUTO_AFTER };
    }
    if (b - cur.until > AUTO_QUIET) follow(cur.until, cur.s);
    E.shots = E.shots.filter(s => s.t < a || s.t >= b).concat(shots);
    if (E.in == null && E.out == null) {
      E.in = Math.max(S.meta.start, shots[0].t - 1);
      E.out = Math.min(S.meta.end, cur.until + 1);
    }
    sel = -1;
    changed();
    return shots.length;
  }

  // ---------------------------------------------------------------- the Edit tab
  function shotLabel(sh) {
    const name = s => s ? nameOf(s, sh.t) : '?';
    if (sh.cam === 'eye') return `Eyes · ${name(sh.s)}`;
    if (sh.cam === 'follow') return `Follow · ${name(sh.s)}`;
    if (sh.cam === 'top') return sh.s ? `Top-down · ${name(sh.s)}` : 'Top-down';
    const n = (sh.keys || []).length;
    return `Dolly · ${n} key${n === 1 ? '' : 's'}${sh.look ? ' · tracking ' + name(sh.look) : ''}`;
  }
  function pipLabel(sh) {
    const pp = sh.pip;
    if (!pp) return '';
    return ' ▣ ' + (pp.who === 'victim' ? 'victim' : pp.who === 'target' ? 'target' : nameOf(pp.s, sh.t));
  }
  const opt = (v, label, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  function panel() {
    const box = document.getElementById('tab-edit');
    if (!box || !S.D || !E) return;
    const [a, b] = range();
    const map = timeMap(), st = E.settings;
    const cur = shotAt(S.t);
    const has = E.shots.length > 0, rel = t => fmtTime(t - S.meta.start);
    let h = `<div class="ed"><div class="ed-top">`;
    h += `<div class="ed-row"><button class="btn${preview ? ' on' : ''}" data-ed="preview"${has ? '' : ' disabled'} title="Watch the edit: the camera follows the shots (P)">${preview ? '■ Stop preview' : '▶ Preview'}</button>`;
    if (!job) h += `<button class="btn primary" data-ed="export"${has ? '' : ' disabled'} title="Export the part between In and Out, with the settings below">Export video</button>`;
    h += `</div>`;
    h += has ? `<div class="ed-range">Video: <b>${rel(a)} → ${rel(b)}</b> of the demo · ${fmtTime(map.total)} long</div>`
      : `<div class="ed-range muted">Add a shot to start a video.</div>`;
    h += `<div class="ed-row"><button class="btn" data-ed="in" title="Start the video at the current moment (I)">In ${rel(a)}${E.in == null && has ? ' · first shot' : ''}</button>
      <button class="btn" data-ed="out" title="End the video at the current moment (O)">Out ${rel(b)}${E.out == null && has ? ' · auto' : ''}</button>
      ${E.in != null || E.out != null ? '<button class="btn" data-ed="clearrange" title="From the first shot to the end of the last one">Fit to shots</button>' : ''}
      <button class="btn" data-ed="wholedemo" title="The whole demo, start to end">Whole demo</button></div>`;
    if (has && E.out == null) {
      const last = E.shots[E.shots.length - 1], keyed = last.cam === 'dolly' && (last.keys || []).length > 1;
      h += `<p class="muted ed-help">With no Out point the video ends ${keyed ? 'just after the last camera key' : '8 s into the last shot'}. Go to where it should end and press <b>O</b>.</p>`;
    }
    if (job) {
      h += `<div class="ed-prog"><div class="bar"><div style="width:${Math.round((job.progress || 0) * 100)}%"></div></div>
        <div class="muted">${esc(job.status || '')}</div><button class="btn" data-ed="cancel">Cancel</button></div>`;
    } else if (S.lastExport) {
      h += `<div class="ed-done">${esc(S.lastExport.msg)}${S.lastExport.qmsg ? `<div class="ed-q${S.lastExport.qwarn ? ' warn' : ''}">${esc(S.lastExport.qmsg)}</div>` : ''}${S.lastExport.file ? `<div class="ed-row" style="margin-top:5px">` +
        `<a class="btn" href="/api/export/file/${encodeURIComponent(S.lastExport.file)}" target="_blank" rel="noopener">Watch</a>` +
        `<button class="btn" data-ed="reveal">Show in folder</button></div>` : ''}</div>`;
    }
    h += `</div>`;
    h += `<div class="section">Shots</div>`;
    if (!E.shots.length) h += `<p class="muted ed-help">A shot starts at a moment of the demo and runs until the next one. Set up a view (Eyes, Follow, Free or Top), then add it as a shot. In Free view, <b>C</b> adds a camera keyframe: the camera glides from key to key (a dolly shot). Or let Auto POV cut to every killer's eyes.</p>`;
    E.shots.forEach((sh, k) => {
      const inside = sh.t >= a - 1e-6 && sh.t < b;
      h += `<div class="shot${k === sel ? ' sel' : ''}${k === cur ? ' cur' : ''}${inside ? '' : ' outside'}" data-k="${k}">
        <span class="sw" style="background:${COLORS[sh.cam] || '#888'}"></span><span class="st">${fmtTime(sh.t - S.meta.start)}</span>
        <span class="sd">${esc(shotLabel(sh) + pipLabel(sh))}</span><span class="ss">${(sh.speed || 1) !== 1 ? (sh.speed) + '×' : ''}${sh.blend ? ' ⤳' : ''}</span></div>`;
      if (k === sel) h += shotEditor(sh, k);
    });
    h += `<div class="ed-row"><button class="btn" data-ed="addshot" title="A shot starting now, with the current view">+ Shot from this view</button>
      <button class="btn" data-ed="addkey" title="The free camera as a keyframe of the dolly shot playing now (C)">+ Camera key</button></div>`;
    h += `<div class="section">Auto POV</div><div class="ed-row">
      <select data-auto="who" title="Whose kills">${opt(0, 'Every kill', auto.who)}${playersNear(S.t).map(p => opt(p.s, p.name + "'s kills", auto.who)).join('')}</select>
      <select data-auto="lead" title="How long before each kill to cut to the killer">${[2, 3, 4, 5, 8].map(x => opt(x, x + ' s before', auto.lead)).join('')}</select>
      <button class="btn" data-ed="auto" title="Replaces the shots between In and Out">Make shots</button></div>
      <div class="ed-checks"><label title="Through the killer's eyes, with the victim's eyes in a corner"><input type="checkbox" data-auto="victim"${auto.victim ? ' checked' : ''}> Victim in picture in picture</label></div>`;
    h += `<div class="section">Export settings</div><div class="ed-grid">
      <label>Size <select data-set="res">${Object.keys(RES).map(r => opt(r, r, st.res)).join('')}</select></label>
      <label>Frames <select data-set="fps">${[24, 30, 60].map(f => opt(f, f + ' fps', st.fps)).join('')}</select></label>
      <label>File <select data-set="format">${opt('mp4', 'MP4', st.format)}${opt('mov', 'MOV', st.format)}</select></label>
      <label>Quality <select data-set="quality">${['high', 'medium', 'low'].map(q => opt(q, q, st.quality)).join('')}</select></label>
      <label title="Where shots with an inset show it">Inset corner <select data-set="pipCorner">${[['br', 'bottom right'], ['bl', 'bottom left'], ['tr', 'top right'], ['tl', 'top left']].map(([v, l]) => opt(v, l, st.pipCorner || 'br')).join('')}</select></label>
      <label>Inset size <select data-set="pipSize">${[[0.22, 'small'], [0.3, 'medium'], [0.4, 'large']].map(([v, l]) => opt(v, l, st.pipSize || 0.3)).join('')}</select></label>
      <label class="wide">Name <input data-set="name" placeholder="${esc((S.meta.file || 'demo').replace(/\.dem$/i, ''))}_date" value="${esc(st.name || '')}"></label></div>
      <div class="ed-checks">${[['sound', 'Sound'], ['killfeed', 'Kill feed'], ['names', 'Names'], ['crosshair', 'Crosshair'], ['caption', 'Player caption'], ['chat', 'Chat']]
        .concat(S.meta.vitals ? [['vitals', 'Health & armor']] : [])
        .map(([k, l]) => `<label><input type="checkbox" data-set="${k}"${st[k] ? ' checked' : ''}> ${l}</label>`).join('')}</div>
      <p class="muted ed-help">X-ray, aim lines and hitboxes show in the video when they're on.${has ? ` ${sizeNote(map.total)}` : ''}</p>`;
    h += `</div>`;
    box.innerHTML = h;
    lastCur = cur;
  }
  function shotEditor(sh, k) {
    let h = `<div class="shot-edit" data-k="${k}">`;
    h += `<label>Camera <select data-sf="cam">${Object.entries(CAMS).map(([v, l]) => opt(v, l, sh.cam)).join('')}</select></label>`;
    const ps = playersNear(sh.t);
    for (const s of [sh.s, sh.look]) if (s && !ps.some(p => p.s === s)) ps.push({ s, name: nameOf(s, sh.t) + ' (not in the game)', team: 9 });
    if (sh.cam !== 'dolly') h += `<label>Player <select data-sf="s">${sh.cam === 'top' ? opt(0, 'nobody (fixed)', sh.s || 0) : ''}${ps.map(p => opt(p.s, p.name, sh.s)).join('')}</select></label>`;
    if (sh.cam === 'dolly') h += `<label>Track <select data-sf="look">${opt(0, 'nobody (keys aim)', sh.look || 0)}${ps.map(p => opt(p.s, p.name, sh.look)).join('')}</select></label>
      <label class="chk"><input type="checkbox" data-sf="smooth"${sh.smooth !== false ? ' checked' : ''}> ease in and out</label>`;
    if (sh.cam === 'follow') h += `<label>Distance <input type="range" min="40" max="500" step="5" data-sf="dist" value="${sh.dist || 110}"></label>
      <label>Height <input type="range" min="-20" max="80" step="1" data-sf="height" value="${sh.height ?? 15}"></label>
      <label>Angle <input type="range" min="-180" max="180" step="5" data-sf="side" value="${sh.side || 0}"></label>`;
    if (sh.cam === 'top') h += `<label>Height <input type="range" min="300" max="4000" step="50" data-sf="h" value="${sh.h || 1400}"></label>`;
    h += `<label>Speed <select data-sf="speed">${SPEEDS.map(x => opt(x, x === 1 ? 'real time' : x + '×', sh.speed || 1)).join('')}</select></label>`;
    h += `<label>Into it <select data-sf="blend">${BLENDS.map(x => opt(x, x ? `blend ${x} s` : 'cut', sh.blend || 0)).join('')}</select></label>`;
    const pp = sh.pip || null, pv = !pp ? '' : pp.who === 'victim' ? 'victim' : pp.who === 'target' ? 'target' : 'p' + pp.s;
    h += `<label title="A second view in a corner (picture in picture)">Inset <select data-sf="pip">${opt('', 'none', pv)}${opt('victim', "victim of the next kill", pv)}${opt('target', 'whoever they aim at', pv)}${ps.map(q => opt('p' + q.s, q.name, pv)).join('')}</select></label>`;
    if (pp) h += `<label>Inset view <select data-sf="pipmode">${[['eye', 'eyes'], ['follow', 'follow'], ['top', 'top-down']].map(([v, l]) => opt(v, l, pp.mode === 'chase' ? 'follow' : pp.mode || 'eye')).join('')}</select></label>`;
    if (sh.cam === 'dolly') {
      h += `<div class="keys">${(sh.keys || []).map((kk, j) => `<div class="key" data-j="${j}"><span>key ${j + 1} · ${fmtTime(kk.t - S.meta.start)} · zoom ${Math.round(kk.fov || 90)}°</span>
        <button class="btn" data-ek="go" title="Go there in Free view to adjust it">Go</button><button class="btn" data-ek="set" title="Replace with the current free camera and moment">Set</button><button class="btn" data-ek="del">×</button></div>`).join('')}</div>
        <p class="muted ed-help">Free view: WASD to move, drag to look, 9 / 0 to zoom. <b>C</b> adds a key at the current moment.</p>`;
    }
    h += `<div class="ed-row"><button class="btn" data-ss="only" title="Set In and Out to this shot, to export just it">Video = this shot</button></div>`;
    h += `<div class="ed-row"><button class="btn" data-ss="here" title="Move this shot's start to the current moment">Start here</button>
      <button class="btn" data-ss="go">Go to start</button><button class="btn" data-ss="del">Delete shot</button></div></div>`;
    return h;
  }
  /** Cheap per-frame update: highlight the shot playing now. */
  function tick() {
    if (!E || job) return;
    const cur = shotAt(S.t);
    if (cur === lastCur) return;
    lastCur = cur;
    document.querySelectorAll('#tab-edit .shot').forEach(el => el.classList.toggle('cur', +el.dataset.k === cur));
  }

  function bind() {
    const box = document.getElementById('tab-edit');
    box.addEventListener('click', e => {
      const t = e.target;
      const ed = t.closest('[data-ed]')?.dataset.ed;
      if (ed) {
        if (ed === 'preview') setPreview(!preview);
        else if (ed === 'in') setIn();
        else if (ed === 'out') setOut();
        else if (ed === 'clearrange') { E.in = E.out = null; changed(); }
        else if (ed === 'wholedemo') { E.in = S.meta.start; E.out = S.meta.end; changed(); }
        else if (ed === 'addshot') addShotFromView();
        else if (ed === 'addkey') addKey();
        else if (ed === 'auto') { const n = autoShots(auto.who, auto.lead); if (!n) alert('No kills in that range.'); }
        else if (ed === 'export') exportVideo();
        else if (ed === 'cancel') { if (job) job.cancel = true; }
        else if (ed === 'reveal' && S.lastExport) fetch('/api/export/reveal', { method: 'POST', body: JSON.stringify({ file: S.lastExport.file }) });
        return;
      }
      const ek = t.closest('[data-ek]')?.dataset.ek;
      if (ek) {
        const sh = E.shots[sel], j = +t.closest('.key').dataset.j, kk = sh.keys[j];
        if (ek === 'go') { preview = false; seek(kk.t); setMode('free'); S.cam.pos = kk.pos.slice(); S.cam.yaw = kk.yaw; S.cam.pitch = kk.pitch; S.cam.fov = kk.fov || 90; panel(); }
        else if (ek === 'set') { if (S.mode !== 'free') setMode('free'); sh.keys[j] = { t: S.t, pos: S.cam.pos.slice(), yaw: S.cam.yaw, pitch: S.cam.pitch, fov: S.cam.fov || 90 }; sh.keys.sort((x, y) => x.t - y.t); changed(); }
        else if (ek === 'del') { sh.keys.splice(j, 1); changed(); }
        return;
      }
      const ss = t.closest('[data-ss]')?.dataset.ss;
      if (ss) {
        const sh = E.shots[sel];
        if (ss === 'here') { sh.t = S.t; sortShots(); sel = E.shots.indexOf(sh); changed(); }
        else if (ss === 'only') {
          const next = E.shots[sel + 1];
          E.in = sh.t;
          E.out = next ? next.t : autoEnd();
          changed();
        }
        else if (ss === 'go') seek(sh.t);
        else if (ss === 'del') { E.shots.splice(sel, 1); sel = -1; if (!E.shots.length) preview = false; changed(); }
        return;
      }
      const row = t.closest('.shot');
      if (row) {
        const k = +row.dataset.k;
        if (sel === k) seek(E.shots[k].t); else sel = k;
        panel();
      }
    });
    const onField = (e, final) => {
      const t = e.target;
      if (t.dataset.set) {
        E.settings[t.dataset.set] = t.type === 'checkbox' ? t.checked : (t.dataset.set === 'fps' ? +t.value : t.value);
        changed(false);
        return;
      }
      if (t.dataset.auto) { auto[t.dataset.auto] = t.type === 'checkbox' ? (t.checked ? 1 : 0) : +t.value; return; }
      const f = t.dataset.sf;
      if (!f || sel < 0) return;
      const sh = E.shots[sel];
      if (f === 'cam') {
        sh.cam = t.value;
        if (sh.cam === 'dolly') { sh.keys = sh.keys || []; if (!sh.keys.length) { const v = curView(); if (v) sh.keys.push({ t: sh.t, ...v }); } sh.smooth = sh.smooth !== false; }
        if ((sh.cam === 'eye' || sh.cam === 'follow') && !sh.s) sh.s = S.sel;
      } else if (f === 'smooth') sh.smooth = t.checked;
      else if (f === 'pip') {
        const v = t.value, mode = (sh.pip && sh.pip.mode) || 'eye';
        sh.pip = !v ? null : v === 'victim' || v === 'target' ? { who: v, mode } : { who: 'player', s: +v.slice(1), mode };
      } else if (f === 'pipmode') { if (sh.pip) sh.pip.mode = t.value === 'follow' ? 'chase' : t.value; }
      else sh[f] = +t.value;
      changed(final);
    };
    box.addEventListener('change', e => onField(e, true));
    box.addEventListener('input', e => { if (e.target.type === 'range') onField(e, false); });
  }

  /** Keys while the Edit tab's features are wanted: C camera key, I / O in and out, P preview. */
  function key(k) {
    if (!E || !S.D) return false;
    if (k === 'c' || k === 'C') { addKey(); return true; }
    if (k === 'i' || k === 'I') { setIn(); return true; }
    if (k === 'o' || k === 'O') { setOut(); return true; }
    if (k === 'p' || k === 'P') { setPreview(!preview); return true; }
    return false;
  }
  /** Shots, In / Out and keyframes on the timeline. */
  function drawTimeline(c, X, w, h) {
    if (!E) return;
    const [a, b] = range();
    if (E.shots.length || E.in != null || E.out != null) {
      c.fillStyle = 'rgba(0,0,0,.45)';
      c.fillRect(0, 0, X(a), h); c.fillRect(X(b), 0, w - X(b), h);
      c.fillStyle = '#f0a030'; c.fillRect(X(a) - 1, 0, 2, h); c.fillRect(X(b) - 1, 0, 2, h);
    }
    E.shots.forEach((sh, k) => {
      const t1 = k + 1 < E.shots.length ? E.shots[k + 1].t : S.meta.end;
      c.fillStyle = COLORS[sh.cam] || '#888';
      c.globalAlpha = preview ? 0.95 : 0.6;
      c.fillRect(X(sh.t), h / 2 + 4, Math.max(2, X(t1) - X(sh.t) - 1), 3);
      c.globalAlpha = 1;
      c.fillRect(X(sh.t) - 0.5, h / 2 - 6, 1.5, 13);
      if (sh.cam === 'dolly') for (const kk of sh.keys || []) {
        const x = X(kk.t);
        c.fillStyle = '#fff';
        c.beginPath(); c.moveTo(x, h / 2 - 7); c.lineTo(x + 3, h / 2 - 4); c.lineTo(x, h / 2 - 1); c.lineTo(x - 3, h / 2 - 4); c.fill();
      }
    });
  }

  // ---------------------------------------------------------------- export
  const yieldNow = () => new Promise(r => { const m = new MessageChannel(); m.port1.onmessage = () => r(); m.port2.postMessage(0); });
  function b64(buf) {
    const u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /** The lowest H.264 High level that fits the size and frame rate (macroblocks per frame and per second). */
  function avcCodec(W, H, fps) {
    const fs = Math.ceil(W / 16) * Math.ceil(H / 16), mbps = fs * fps;
    const levels = [[31, 108000, 3600], [32, 216000, 5120], [40, 245760, 8192], [42, 522240, 8704], [50, 589824, 22080],
      [51, 983040, 36864], [52, 2073600, 36864]];
    const out = [];
    for (const [l, m, f] of levels) if (m >= mbps && f >= fs) out.push('avc1.6400' + l.toString(16).padStart(2, '0'));
    return out;
  }
  /** The video bitrate for a size, frame rate and quality. Firefox's encoder gets constant-rate mode and a third more:
      in its variable mode it starves busy moments (QP 45-51, measured on 1440p60 footage of a real edit: 10.8% of
      frames at QP 35+), while constant 35 / 60 Mbit/s gave 1.8% / 0%. Chrome's and Edge's variable mode stays clean. */
  function videoRate(W, H, fps, quality) {
    const base = W * H * fps * (BPP[quality] || BPP.high);
    return IS_FIREFOX ? { bitrate: Math.round(base * 1.3), bitrateMode: 'constant' } : { bitrate: Math.round(base), bitrateMode: 'variable' };
  }
  async function videoConfig(W, H, fps, rate) {
    for (const codec of avcCodec(W, H, fps)) {
      for (const mode of [rate.bitrateMode, undefined]) {
        const cfg = { codec, width: W, height: H, framerate: fps, bitrate: rate.bitrate, avc: { format: 'avc' }, latencyMode: 'quality' };
        if (mode) cfg.bitrateMode = mode;
        try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { /* next */ }
      }
    }
    return null;
  }
  async function waitLoaded(limitMs) {
    const end = performance.now() + limitMs;
    while (performance.now() < end && (Studio.busy() || FX.busy())) await new Promise(r => setTimeout(r, 50));
  }

  // overlays drawn onto each video frame (the page's own labels are HTML and not part of the picture)
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function teamCss(s, t) { const p = pstate(s, t); return rgbCss(TEAM_RGB[p ? p.team : 0] || TEAM_RGB[0]); }
  function overlays(c, W, H, cam, VP, st) {
    const u = H / 1080, t = S.t;
    // whose health and armor to show: the shot's player, when the demo has theirs (client demos: the recording
    // player's; HLTV demos: everyone's when the server ran the hltv_vitals plugin)
    const shk = shotAt(t), shn = shk >= 0 ? E.shots[shk] : null;
    const subj = shn && (shn.cam === 'eye' || shn.cam === 'follow') ? shn.s : (shn && shn.cam === 'dolly' ? shn.look : 0);
    const vit = st.vitals && subj ? vitalsAt(subj, t) : null;
    c.textBaseline = 'middle';
    if (st.names && VP) {
      c.font = `600 ${Math.round(17 * u)}px system-ui, Segoe UI, sans-serif`;
      c.textAlign = 'center';
      for (const p of playersAt(S.fi, 0)) {
        if (p.hidden || p.dead || (cam.pov && cam.pov.s === p.s)) continue;
        const head = [p.x, p.y, p.z + (p.ducked ? 24 : 42)];
        const sp = project(VP, head, W, H);
        if (!sp || (traceLine(cam.pos, head, S.fi) >= 0 && !prefs.xray)) continue;
        const name = nameOf(p.s, t), tw = c.measureText(name).width;
        c.fillStyle = 'rgba(0,0,0,.5)'; roundRect(c, sp[0] - tw / 2 - 6 * u, sp[1] - 13 * u, tw + 12 * u, 24 * u, 5 * u); c.fill();
        c.fillStyle = rgbCss(TEAM_RGB[p.team] || TEAM_RGB[0]); c.fillRect(sp[0] - tw / 2 - 6 * u, sp[1] + 9 * u, tw + 12 * u, 2 * u);
        c.fillStyle = '#fff'; c.fillText(name, sp[0], sp[1] - 1 * u);
      }
    }
    if (st.killfeed) {
      c.font = `600 ${Math.round(19 * u)}px system-ui, Segoe UI, sans-serif`;
      c.textAlign = 'left';
      const ks = S.meta.kills.filter(k => k[0] <= t && k[0] > t - 5).slice(-5);
      let y = 34 * u;
      for (const k of ks) {
        const a = nameOf(k[1], k[0]), wpn = ` [${k[3]}] `, v = victimName(k);
        const wa = c.measureText(a).width, ww = c.measureText(wpn).width, wv = c.measureText(v).width, tot = wa + ww + wv;
        const x = W - 28 * u - tot;
        c.fillStyle = 'rgba(0,0,0,.5)'; roundRect(c, x - 10 * u, y - 15 * u, tot + 20 * u, 30 * u, 6 * u); c.fill();
        c.fillStyle = k[1] > 0 && k[1] <= S.meta.maxclients ? teamCss(k[1], k[0] - 0.05) : '#ddd'; c.fillText(a, x, y);
        c.fillStyle = '#bbb'; c.fillText(wpn, x + wa, y);
        c.fillStyle = k[2] <= S.meta.maxclients ? teamCss(k[2], k[0] - 0.05) : '#ddd'; c.fillText(v, x + wa + ww, y);
        y += 36 * u;
      }
    }
    if (st.chat) {
      c.font = `500 ${Math.round(18 * u)}px system-ui, Segoe UI, sans-serif`;
      c.textAlign = 'left';
      const cs = S.meta.chat.filter(m => m[0] <= t && m[0] > t - 8).slice(-5);
      let y = H - ((st.caption ? 110 : 60) + (vit ? 68 : 0)) * u - (cs.length - 1) * 28 * u;
      for (const m of cs) {
        const tw = c.measureText(m[2]).width;
        c.fillStyle = 'rgba(0,0,0,.45)'; roundRect(c, 24 * u, y - 13 * u, tw + 16 * u, 26 * u, 5 * u); c.fill();
        c.fillStyle = '#f3f3f3'; c.fillText(m[2], 32 * u, y);
        y += 28 * u;
      }
    }
    if (st.crosshair && cam.pov && !cam.pov.dead) {
      const x = W / 2, y = H / 2, g = 4 * u, l = 9 * u;
      c.strokeStyle = 'rgba(80,255,120,.95)'; c.lineWidth = Math.max(1, 2 * u);
      c.beginPath(); c.moveTo(x - g - l, y); c.lineTo(x - g, y); c.moveTo(x + g, y); c.lineTo(x + g + l, y);
      c.moveTo(x, y - g - l); c.lineTo(x, y - g); c.moveTo(x, y + g); c.lineTo(x, y + g + l); c.stroke();
    }
    if (vit) {
      // HL-style HUD numbers in the bottom-left corner (the caption moves up above them)
      c.textAlign = 'left';
      const y = H - 34 * u, big = `700 ${Math.round(44 * u)}px system-ui, Segoe UI, sans-serif`, small = `600 ${Math.round(15 * u)}px system-ui, Segoe UI, sans-serif`;
      c.fillStyle = 'rgba(0,0,0,.35)'; roundRect(c, 20 * u, y - 34 * u, 300 * u, 58 * u, 8 * u); c.fill();
      c.fillStyle = vit.hp <= 25 ? 'rgba(255,70,50,.95)' : 'rgba(255,170,40,.95)';
      c.font = small; c.fillText('HEALTH', 32 * u, y - 18 * u);
      c.font = big; c.fillText(String(vit.hp), 32 * u, y + 6 * u);
      c.fillStyle = 'rgba(255,170,40,.95)';
      c.font = small; c.fillText('ARMOR', 170 * u, y - 18 * u);
      c.font = big; c.fillText(String(vit.ap), 170 * u, y + 6 * u);
    }
    const pr = S.pipRect, psh = S.pipShown;
    if (pr && psh) {
      const x = pr.x, y = H - pr.y - pr.h, bw = Math.max(2, Math.round(3 * u));
      c.strokeStyle = 'rgba(240,160,48,.95)'; c.lineWidth = bw;
      c.strokeRect(x + bw / 2, y + bw / 2, pr.w - bw, pr.h - bw);
      const name = nameOf(psh.s, t), tag = psh.label === 'victim' ? `${name} · victim` : psh.target ? `${name} · in the crosshair` : name;
      c.font = `600 ${Math.round(16 * u)}px system-ui, Segoe UI, sans-serif`; c.textAlign = 'left';
      const tw = c.measureText(tag).width;
      c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x + bw, y + bw, tw + 16 * u, 26 * u);
      c.fillStyle = teamCss(psh.s, t); c.fillRect(x + bw, y + bw, 4 * u, 26 * u);
      c.fillStyle = '#fff'; c.fillText(tag, x + bw + 10 * u, y + bw + 13 * u);
    }
    if (st.caption) {
      const k = shotAt(t), sh = k >= 0 ? E.shots[k] : null;
      const s = sh && (sh.cam === 'eye' || sh.cam === 'follow' || (sh.cam === 'dolly' && sh.look)) ? (sh.cam === 'dolly' ? sh.look : sh.s) : 0;
      if (s) {
        const p = pstate(s, t), name = nameOf(s, t), sub2 = p ? [className(p.cls), teamName(p.team)].filter(Boolean).join(' · ') : '';
        c.textAlign = 'left';
        c.font = `700 ${Math.round(26 * u)}px system-ui, Segoe UI, sans-serif`;
        const w1 = c.measureText(name).width;
        c.font = `500 ${Math.round(17 * u)}px system-ui, Segoe UI, sans-serif`;
        const w2 = c.measureText(sub2).width;
        const bw = Math.max(w1, w2) + 34 * u, y0 = H - (vit ? 160 : 92) * u;
        c.fillStyle = 'rgba(0,0,0,.5)'; roundRect(c, 24 * u, y0, bw, 64 * u, 8 * u); c.fill();
        c.fillStyle = teamCss(s, t); c.fillRect(24 * u, y0, 5 * u, 64 * u);
        c.fillStyle = '#fff'; c.font = `700 ${Math.round(26 * u)}px system-ui, Segoe UI, sans-serif`; c.fillText(name, 40 * u, y0 + 22 * u);
        c.fillStyle = '#ccc'; c.font = `500 ${Math.round(17 * u)}px system-ui, Segoe UI, sans-serif`; c.fillText(sub2, 40 * u, y0 + 47 * u);
      }
    }
  }

  /** Whether this browser can really encode audio with cfg: asks, then encodes a moment of silence (Firefox, for one,
      has WebCodecs but no AAC encoder, and some builds say yes and then fail). */
  function probeAudio(cfg) {
    if (typeof AudioEncoder === 'undefined') return Promise.resolve(false);
    return AudioEncoder.isConfigSupported(cfg).then(r => !r.supported ? false : new Promise(res => {
      let got = false, done = false;
      const fin = v => { if (done) return; done = true; try { enc.close(); } catch (e) { /* closed */ } res(v); };
      const enc = new AudioEncoder({ output: () => { got = true; }, error: () => fin(false) });
      try {
        enc.configure(cfg);
        const n = 4800, ad = new AudioData({ format: 'f32-planar', sampleRate: cfg.sampleRate, numberOfFrames: n,
          numberOfChannels: cfg.numberOfChannels, timestamp: 0, data: new Float32Array(n * cfg.numberOfChannels) });
        enc.encode(ad);
        ad.close();
        enc.flush().then(() => fin(got), () => fin(false));
        setTimeout(() => fin(got), 4000);
      } catch (e) { fin(false); }
    }), () => false);
  }
  /** The sound format for the file: AAC where the browser has it; else Opus in an .mp4 (Firefox), or plain 16-bit
      PCM in a .mov (what video editors like best anyway). null: no sound possible (an .mp4 without AAC or Opus). */
  async function audioPlan(format) {
    const aac = { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192000 };
    if (await probeAudio(aac)) return { codec: 'aac', cfg: aac, label: 'AAC' };
    if (format === 'mov') return { codec: 'pcm', label: 'uncompressed PCM (this browser has no AAC encoder)' };
    const opus = { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 160000 };
    if (await probeAudio(opus)) return { codec: 'opus', cfg: opus, label: 'Opus (this browser has no AAC encoder)' };
    return null;
  }

  const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
  /** About how big the file gets at the current settings (constant-rate Firefox files are about this; variable-rate ones
      usually smaller). */
  function sizeNote(seconds) {
    const st = E.settings, [W, H] = RES[st.res] || RES['1080p'], r = videoRate(W, H, st.fps || 60, st.quality);
    const mb = seconds * (r.bitrate + (st.sound ? 192000 : 0)) / 8 / 1e6;
    const size = mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
    return `File: ${r.bitrateMode === 'constant' ? 'about' : 'up to about'} ${size} (${Math.round(r.bitrate / 1e6)} Mbit/s${IS_FIREFOX ? ', constant rate: Firefox\'s encoder needs it to stay sharp' : ''}).`;
  }
  /** The server reads every frame's quantizer back from the file (h264qp.py): say whether the encoder kept the picture
      clean, or where it ran short and went blocky. */
  function qualityNote(q) {
    if (!q) return {};
    if (q.blocky_pct < 0.3 && q.max < 42) return { qmsg: 'Picture: clean all the way through.', qwarn: false };
    const at = q.worst.slice(0, 4).map(([a, b]) => b - a >= 1 ? `${fmtTime(a)}–${fmtTime(b + 1)}` : fmtTime(a)).join(', ');
    const tip = IS_FIREFOX
      ? `Firefox's video encoder runs short in busy moments. For a clean video, export from Chrome or Edge: open ${location.origin} there (the edit is the same).`
      : 'A higher Quality setting or a smaller size gives the encoder more room.';
    return { qmsg: `Picture: heavily compressed (blocky) in ${q.spans} place${q.spans === 1 ? '' : 's'}, ${q.blocky_pct}% of the video. Worst at ${at}. ${tip}`, qwarn: true };
  }

  async function exportVideo() {
    if (job || !E || !E.shots.length) return;
    if (typeof VideoEncoder === 'undefined') { alert('This browser cannot encode video (no WebCodecs). Use a current Chrome or Edge.'); return; }
    const st = E.settings, [W, H] = RES[st.res] || RES['1080p'], fps = st.fps || 60;
    const map = timeMap(), N = Math.max(1, Math.round(map.total * fps));
    const cfg = await videoConfig(W, H, fps, videoRate(W, H, fps, st.quality));
    if (!cfg) { alert(`This browser can't encode H.264 at ${W}x${H} ${fps} fps. Try a smaller size.`); return; }
    const plan = st.sound ? await audioPlan(st.format) : null;
    if (st.sound && !plan && !confirm('This browser can encode neither AAC nor Opus sound for an MP4 file.\n\nOK: export the MP4 without sound.\nCancel: stop here (MOV keeps the sound, as uncompressed audio).')) return;
    const saved = { t: S.t, playing: S.playing, preview };
    job = { progress: 0, status: 'Getting ready…', cancel: false, started: performance.now() };
    S.playing = false; preview = false; S.lastExport = null;
    GameAudio.stopAll(); S.audioT = null;
    panel();
    const veil = document.getElementById('exportVeil');
    if (veil) veil.classList.remove('hidden');
    const comp = document.createElement('canvas');
    comp.width = W; comp.height = H;
    const c2 = comp.getContext('2d');
    let server = null, avcc = null, failed = null, pend = [], pendBytes = 0, acfg = null;
    // packets for the server: u8 track (0 video, 1 audio), u8 key, u32 size, f64 pts (us), f64 duration (us), data
    const pushRaw = (track, key, pts, dur, data) => { pend.push({ track, key, pts, dur, data }); pendBytes += data.length + 22; };
    const push = (track, chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      pushRaw(track, chunk.type === 'key' ? 1 : 0, chunk.timestamp, chunk.duration || 0, data);
    };
    const flush = async () => {
      if (!server || !pend.length) return;
      const buf = new Uint8Array(pendBytes), dv = new DataView(buf.buffer);
      let o = 0;
      for (const p of pend) {
        dv.setUint8(o, p.track); dv.setUint8(o + 1, p.key); dv.setUint32(o + 2, p.data.length, true);
        dv.setFloat64(o + 6, p.pts, true); dv.setFloat64(o + 14, p.dur, true);
        buf.set(p.data, o + 22); o += 22 + p.data.length;
      }
      pend = []; pendBytes = 0;
      const r = await fetch(`/api/export/${server.job}/packets`, { method: 'POST', body: buf });
      if (!r.ok) throw new Error('the server did not take the video data (' + r.status + ')');
    };
    const enc = new VideoEncoder({
      output: (chunk, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description && !avcc) avcc = meta.decoderConfig.description; push(0, chunk); },
      error: e => { failed = e; },
    });
    try {
      enc.configure(cfg);
      S.renderSize = [W, H];
      // the first frame of every shot that cuts in (no blend) starts a new picture: give it a keyframe
      const cutFrames = new Set(map.segs.filter(sg => { const k = shotAt(sg.t0); return k >= 0 && !(E.shots[k].blend > 0); }).map(sg => Math.round(sg.o0 * fps)));
      // warm up: load every model, weapon and sprite the video will show
      job.status = 'Loading models…'; panel();
      for (let T = 0; T < map.total; T += 0.5) { S.t = demoTime(map, T); render(); if (Studio.busy() || FX.busy()) await waitLoaded(4000); }
      await waitLoaded(8000);
      for (let k = 0; k < N; k++) {
        if (job.cancel) throw new Error('cancelled');
        if (failed) throw failed;
        S.t = demoTime(map, k / fps);
        render();
        c2.drawImage(canvas, 0, 0, W, H);
        overlays(c2, W, H, lastCam, S.lastVP, st);
        const frame = new VideoFrame(comp, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(frame, { keyFrame: k % (fps * 2) === 0 || cutFrames.has(k) });
        frame.close();
        while (enc.encodeQueueSize > 4) await yieldNow();
        if (!server && avcc) {
          const r = await fetch('/api/export/start', { method: 'POST', body: JSON.stringify({ demo, format: st.format, width: W, height: H, fps,
            avcc: b64(avcc), audio: plan ? { rate: AUDIO_RATE, channels: 2, codec: plan.codec } : null, name: st.name || '' }) });
          if (!r.ok) throw new Error('the server could not start the file (' + r.status + ')');
          server = await r.json();
        }
        if (pendBytes > 4 << 20) await flush();
        if (k % 15 === 0) {
          const el = (performance.now() - job.started) / 1000;
          job.progress = (k / N) * (plan ? 0.85 : 0.97);
          job.status = `Frame ${k + 1} of ${N} · ${(k / fps / Math.max(0.01, el)).toFixed(1)}× real time`;
          panelProgress();
          await yieldNow();
        }
      }
      await enc.flush();
      if (failed) throw failed;
      if (!server) throw new Error('the encoder produced no video');
      await flush();
      if (plan) acfg = await exportAudio(map, N, fps, push, pushRaw, flush, plan);
      job.status = 'Writing the file…'; job.progress = 0.99; panelProgress();
      await flush();
      const r = await fetch(`/api/export/${server.job}/finish`, { method: 'POST', body: JSON.stringify({ config: acfg ? b64(acfg) : null }) });
      if (!r.ok) throw new Error('the server could not finish the file');
      const done = await r.json();
      const sound = plan ? (plan.codec === 'aac' ? '' : ` Sound: ${plan.label}.`) : (st.sound ? ' No sound: this browser has no AAC or Opus encoder (MOV keeps the sound).' : '');
      S.lastExport = { file: done.file, msg: `Saved Exports\\${done.file} (${(done.size / 1e6).toFixed(1)} MB, ${fmtTime(map.total)}).${sound}`, ...qualityNote(done.quality) };
    } catch (e) {
      if (server) { try { await fetch(`/api/export/${server.job}/cancel`, { method: 'POST' }); } catch (e2) { /* gone */ } }
      S.lastExport = { file: null, msg: e.message === 'cancelled' ? 'Export cancelled.' : 'Export failed: ' + (e.message || e) };
    } finally {
      try { enc.close(); } catch (e) { /* closed */ }
      GameAudio.endOffline();
      S.renderSize = null;
      job = null;
      S.t = saved.t; preview = saved.preview; S.audioT = null;
      if (veil) veil.classList.add('hidden');
      panel();
    }
  }
  function panelProgress() {
    const bar = document.querySelector('#tab-edit .ed-prog .bar > div'), txt = document.querySelector('#tab-edit .ed-prog .muted');
    if (bar) bar.style.width = `${Math.round(job.progress * 100)}%`;
    if (txt) txt.textContent = job.status;
    const v = document.querySelector('#exportVeil .msg');
    if (v) v.textContent = `Exporting video… ${Math.round(job.progress * 100)}%  ${job.status}`;
  }
  /** The game sound of the whole video, mixed offline in 60 s stretches and encoded as `plan` says (AAC / Opus with
      the browser's encoder, or 16-bit PCM as it is). Returns the codec's config bytes (AAC AudioSpecificConfig, OpusHead). */
  async function exportAudio(map, N, fps, push, pushRaw, flush, plan) {
    job.status = 'Loading sounds…'; panelProgress();
    await GameAudio.loaded();
    let acfg = null, failed = null, aenc = null;
    if (plan.codec !== 'pcm') {
      aenc = new AudioEncoder({
        output: (chunk, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description && !acfg) acfg = meta.decoderConfig.description; push(1, chunk); },
        error: e => { failed = e; },
      });
      aenc.configure(plan.cfg);
    }
    const total = N / fps;
    let k = 0, prevT = demoTime(map, 0), written = 0;
    for (let s0 = 0; s0 < total - 1e-6; s0 += AUDIO_SEG) {
      if (job.cancel) throw new Error('cancelled');
      const len = Math.min(AUDIO_SEG, total - s0);
      GameAudio.beginOffline(len, AUDIO_RATE);
      for (; k < N && k / fps < s0 + len - 1e-9; k++) {
        const T = k / fps, t = demoTime(map, T);
        S.t = t; S.fi = frameAt(t)[0];
        GameAudio.setClock(T - s0);
        GameAudio.setRate(speedAt(t));
        if (k === 0) FX.startStatics(t); else FX.playSounds(prevT, t);
        prevT = t;
        const cam = cameraAt(t);
        if (cam) GameAudio.setListener(cam.pos, cam.yaw, cam.pov ? cam.pov.s : -1);
        GameAudio.update();
      }
      job.status = `Mixing sound ${Math.min(100, Math.round((s0 + len) / total * 100))}%`; job.progress = 0.85 + 0.12 * (s0 + len) / total; panelProgress();
      const buf = await GameAudio.renderOffline();
      const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1), STEP = 4800;
      for (let o = 0; o < n; o += STEP) {
        const m = Math.min(STEP, n - o), pts = Math.round(written / AUDIO_RATE * 1e6);
        if (!aenc) {                                           // PCM: interleaved signed 16-bit little-endian
          const out = new Int16Array(m * 2);
          for (let i = 0; i < m; i++) {
            out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(L[o + i] * 32767)));
            out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R[o + i] * 32767)));
          }
          pushRaw(1, 1, pts, m / AUDIO_RATE * 1e6, new Uint8Array(out.buffer));
        } else {
          if (failed) throw failed;
          if (aenc.state !== 'configured') throw new Error('the sound encoder stopped (' + aenc.state + ')');
          const data = new Float32Array(m * 2);
          data.set(L.subarray(o, o + m), 0); data.set(R.subarray(o, o + m), m);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: m, numberOfChannels: 2, timestamp: pts, data });
          aenc.encode(ad);
          ad.close();
          while (aenc.encodeQueueSize > 8) await yieldNow();
        }
        written += m;
      }
      if (failed) throw failed;
      await flush();
    }
    if (aenc) {
      await aenc.flush();
      aenc.close();
    }
    if (failed) throw failed;
    return acfg;
  }

  return { open, camera, cameraAt, active, exporting, afterAdvance, speedAt, stopPreview, setPreview, key, drawTimeline,
    panel, tick, bind, addKey, pip, pipLayout };
})();
