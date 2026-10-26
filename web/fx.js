'use strict';
/* Weapon sounds and effects for the demo viewer.

   Two sources, both decoded by goldsrc_demo.py:
   - what the server sent: svc_sound (footsteps, pain, pickups, the rocket's flight loop, sentries...) and temp entities
     (explosions, tracers, blood, grenade/rocket trails, sparks, things attached to players);
   - weapon events: the game client plays gunfire and grenade explosions itself when an event arrives. EVENTS below
     replays TFC's own handlers (tfc/cl_dlls/client.dll, decompiled; table and addresses in docs/tfc_events.md).

   Visual effects are worked out from the timeline position alone (rewinding and scrubbing show the right thing);
   sounds are started only while the demo plays forward. Uses viewer.js globals (S, gl, frameAt, playerState,
   traceLine, ...) at call time. */

const FX = (() => {
  const ATTN_NORM = 0.8, ATTN_EXPLOSION = 0.3;
  const CHAN_AUTO = 0, CHAN_WEAPON = 1, CHAN_VOICE = 2, CHAN_ITEM = 3, CHAN_STATIC = 6;
  const SND_SENTENCE = 16, SND_STOP = 32, SND_CHANGE_VOL = 64, SND_CHANGE_PITCH = 128, SND_STATIC = 1024;
  const TE_BEAMPOINTS = 0, TE_EXPLOSION = 3, TE_TRACER = 6, TE_SPRITETRAIL = 15, TE_BEAMFOLLOW = 22, TE_BLOODSPRITE = 115,
    TE_PLAYERATTACHMENT = 124, TE_KILLPLAYERATTACHMENTS = 125;
  const TE_EXPLFLAG_NOADDITIVE = 1, TE_EXPLFLAG_NOSOUND = 4;
  const MAX_LIFE = 3.5;            // longest visual effect, for the "what is on screen now" search
  const ASSET_VERSION = 2;         // bump when the server's sound/sprite conversion changes (browsers cache them)

  // deterministic per-event random numbers, so a replay of the same moment looks and sounds the same
  function rng(seed) {
    let x = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  }
  const rl = (r, a, b) => a + Math.floor(r() * (b - a + 1));
  const rf = (r, a, b) => a + r() * (b - a);
  const snd = (name, chan, vol, atten, pitch) => ({ name, chan, vol, atten: atten ?? ATTN_NORM, pitch: pitch ?? 100 });
  const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

  // ---------------------------------------------------------------- TFC event handlers (client.dll)
  // (ev, r) -> { s: sounds, stop: [[chan, name?]], fx: visuals }. ev = { name, ent, origin, angles, f1, f2, i1, i2, b1, b2 }
  const explosion = (mag, scale) => ({ kind: 'explosion', mag, scale });
  const EVENTS = {
    'wpn/tf_sg': (e, r) => ({ s: [snd('weapons/sbarrel1.wav', CHAN_WEAPON, rf(r, 0.95, 1), ATTN_NORM, rl(r, 93, 124))], fx: [{ kind: 'muzzle' }] }),
    'wpn/tf_ssg': (e, r) => ({ s: [snd('weapons/shotgn2.wav', CHAN_WEAPON, rf(r, 0.95, 1), ATTN_NORM, rl(r, 93, 124))], fx: [{ kind: 'muzzle' }] }),
    'wpn/tf_sgpump': (e, r) => ({ s: [snd('weapons/scock1.wav', CHAN_ITEM, 1, ATTN_NORM, rl(r, 95, 126))] }),
    'wpn/tf_sgreload': (e, r) => ({ s: [snd(r() < 0.5 ? 'weapons/reload3.wav' : 'weapons/reload1.wav', CHAN_ITEM, 1, ATTN_NORM, rl(r, 85, 116))] }),
    'wpn/tf_sniper': () => ({ s: [snd('ambience/rifle1.wav', CHAN_WEAPON, 0.9)], fx: [{ kind: 'muzzle' }] }),
    'wpn/tf_ar': () => ({ s: [snd('weapons/sniper.wav', CHAN_WEAPON, 0.9)], fx: [{ kind: 'muzzle' }] }),
    'wpn/tf_sniperhit': e => ({ s: [snd(e.b2 ? 'common/bodysplat.wav' : e.b1 ? 'weapons/bullet_hit2.wav' : 'weapons/ric3.wav',
      CHAN_STATIC, e.b2 ? 1 : (e.i1 || 100) / 100)], at: 'origin' }),
    'wpn/tf_nail': (e, r) => ({ s: [snd('weapons/airgun_1.wav', CHAN_WEAPON, rf(r, 0.95, 1), ATTN_NORM, rl(r, 93, 124))],
      fx: [{ kind: 'nail', speed: 1000 }] }),
    'wpn/tf_snail': (e, r) => ({ s: [snd('weapons/spike2.wav', CHAN_WEAPON, 1, ATTN_NORM, rl(r, 94, 109))], fx: [{ kind: 'nail', speed: 1000 }] }),
    'wpn/tf_tranq': () => ({ s: [snd('weapons/dartgun.wav', CHAN_WEAPON, 0.9)], fx: [{ kind: 'nail', speed: 1500 }] }),
    'wpn/tf_rail': () => ({ s: [snd('weapons/railgun.wav', CHAN_WEAPON, 0.9)], fx: [{ kind: 'nail', speed: 1500, rail: true }] }),
    'wpn/tf_rpg': () => ({ s: [snd('weapons/rocketfire1.wav', CHAN_WEAPON, 0.9), snd('weapons/glauncher.wav', CHAN_ITEM, 0.7)] }),
    'wpn/tf_ic': () => ({ s: [snd('weapons/sgun1.wav', CHAN_WEAPON, 0.9)] }),
    'wpn/tf_gl': () => ({ s: [snd('weapons/glauncher.wav', CHAN_ITEM, 0.7)] }),
    'wpn/tf_pipel': () => ({ s: [snd('weapons/glauncher.wav', CHAN_ITEM, 0.7)] }),
    'wpn/tf_acwu': () => ({ stop: [[CHAN_STATIC], [CHAN_WEAPON]], s: [snd('weapons/asscan1.wav', CHAN_WEAPON, 0.98, ATTN_NORM, 125)] }),
    'wpn/tf_acstart': () => ({ stop: [[CHAN_STATIC]], s: [snd('weapons/asscan2.wav', CHAN_STATIC, 0.98, ATTN_NORM, 125)] }),
    'wpn/tf_acsspin': () => ({ stop: [[CHAN_STATIC]], s: [snd('weapons/asscan4.wav', CHAN_STATIC, 0.98, ATTN_NORM, 125)] }),
    'wpn/tf_acwd': e => ({ stop: [[CHAN_STATIC], [CHAN_WEAPON]], s: e.b1 ? [] : [snd('weapons/asscan3.wav', CHAN_WEAPON, 0.98, ATTN_NORM, 125)] }),
    'wpn/tf_acfire': () => ({ fx: [{ kind: 'muzzle' }] }),
    'wpn/tf_flame': e => (e.b1 ? { fx: [{ kind: 'flame', water: true }] } : { s: [snd('weapons/flmfire2.wav', CHAN_WEAPON, 0.9)], fx: [{ kind: 'flame' }] }),
    'wpn/tf_axe': (e, r) => ({ melee: true, r }),
    'wpn/tf_knife': (e, r) => ({ melee: true, r }),
    'wpn/tf_mednormal': () => ({ s: [snd('items/medshot4.wav', CHAN_ITEM, 1)] }),
    'wpn/tf_medsuper': () => ({ s: [snd('items/medshot5.wav', CHAN_ITEM, 1)] }),
    'wpn/tf_medsteam': () => ({ s: [snd('ambience/steamburst1.wav', CHAN_ITEM, 1)] }),
    'explode/tf_pipe': () => ({ fx: [explosion(120)], at: 'origin' }),
    'explode/tf_gren': () => ({ fx: [explosion(120)], at: 'origin' }),
    'explode/tf_normalgren': () => ({ fx: [explosion(180)], at: 'origin' }),
    'explode/tf_engrgren': () => ({ fx: [explosion(180)], at: 'origin' }),
    'explode/tf_ng': () => ({ fx: [explosion(180)], at: 'origin' }),
    'explode/tf_mirv': () => ({ fx: [explosion(180)], at: 'origin' }),
    'explode/tf_mirvmain': () => ({ fx: [explosion(180)], at: 'origin' }),
    'explode/tf_fire': () => ({ fx: [explosion(0, 3)], at: 'origin' }),
    'explode/tf_concuss': (e, r) => ({ s: [snd(pick(r, ['weapons/concgren_blast1.wav', 'weapons/concgren_blast2.wav', 'weapons/concgren_blast3.wav']), CHAN_VOICE, 1)],
      fx: [{ kind: 'shockwave' }], at: 'origin', world: true }),
    'explode/tf_emp': () => ({ s: [snd('weapons/emp_1.wav', CHAN_VOICE, 1)], fx: [{ kind: 'shockwave' }], at: 'origin', world: true }),
    'explode/tf_gas': () => ({ fx: [{ kind: 'gas' }], at: 'origin' }),
    'explode/tf_burn': () => ({ fx: [{ kind: 'burn' }] }),
    'explode/tf_nailgren': (e, r) => ({ s: [snd(r() < 0.5 ? 'weapons/airgun_1.wav' : 'weapons/spike2.wav', CHAN_WEAPON, 0.6, ATTN_NORM, rl(r, 93, 108))] }),
    'misc/gibs': () => ({ s: [snd('common/bodysplat.wav', CHAN_WEAPON, 1)] }),
  };
  const EXPLODE_SOUNDS = ['weapons/explode3.wav', 'weapons/explode4.wav', 'weapons/explode5.wav'];
  const DEBRIS_SOUNDS = ['weapons/debris1.wav', 'weapons/debris2.wav', 'weapons/debris3.wav'];

  // ---------------------------------------------------------------- data
  let D = null, meta = null;
  let snd_ = null, evt = null, tent = null;           // Float32 rows
  let evItems = [];                                   // decoded weapon events: { t, row, key, ent, h (handler result) }
  let tentItems = [];
  let attachments = [];
  const sprites = new Map();                          // name -> { state, frames: [{ tex, w, h, ox, oy }], format, type }
  let SP = null, quad = null;                         // sprite program

  function eventKey(name) { return (name || '').replace(/^events\//, '').replace(/\.sc$/, ''); }
  function levelAt(t) { return levelForFrame(frameAt(t)[0]); }

  function build(m, data) {
    meta = m; D = data;
    const L = m.buffers;
    const F = (n, w) => L[n] ? new Float32Array(D.buf, L[n][0], L[n][1] / 4) : new Float32Array(0);
    snd_ = F('sounds'); evt = F('events'); tent = F('tents');
    evItems = [];
    for (let r = 0, n = evt.length / 16; r < n; r++) {
      const o = r * 16, t = evt[o];
      const name = levelAt(t).events[evt[o + 2]];
      const key = eventKey(name);
      if (!EVENTS[key]) continue;
      evItems.push({ t, row: r, key, ent: evt[o + 1] });
    }
    tentItems = [];
    attachments = [];
    for (let r = 0, n = tent.length / 16; r < n; r++) {
      const o = r * 16, t = tent[o], type = tent[o + 1];
      if (type === TE_PLAYERATTACHMENT) { attachments.push({ t, ent: tent[o + 2], z: tent[o + 3], model: tent[o + 4], life: tent[o + 5] / 10, end: Infinity }); continue; }
      if (type === TE_KILLPLAYERATTACHMENTS) { for (const a of attachments) if (a.ent === tent[o + 2] && a.end === Infinity && a.t <= t) a.end = t; continue; }
      tentItems.push({ t, row: r, type });
    }
    // sounds and sprites we are going to need
    const names = new Set([...EXPLODE_SOUNDS, ...DEBRIS_SOUNDS]);
    for (let r = 0, n = snd_.length / 11; r < n; r++) {
      const o = r * 11;
      if ((snd_[o + 10] & SND_SENTENCE)) continue;
      const nm = levelAt(snd_[o]).sounds[snd_[o + 3]];
      if (nm && nm[0] !== '!' && nm[0] !== '*') names.add(nm);
    }
    for (const it of evItems.slice(0, 4000)) {
      const h = handle(it);
      for (const s of h.s || []) names.add(s.name);
    }
    if (EVENTS['wpn/tf_axe']) ['weapons/cbar_miss1.wav', 'weapons/cbar_hitbod1.wav', 'weapons/cbar_hitbod2.wav', 'weapons/cbar_hitbod3.wav',
      'weapons/cbar_hit1.wav', 'weapons/cbar_hit2.wav'].forEach(n => names.add(n));
    return { sounds: names, events: evItems.length, effects: tentItems.length };
  }

  /** The handler result for event item it (cached: random numbers are fixed per event). */
  function handle(it) {
    if (it.h) return it.h;
    const o = it.row * 16;
    const e = { ent: it.ent, origin: [evt[o + 3], evt[o + 4], evt[o + 5]], angles: [evt[o + 6], evt[o + 7], evt[o + 8]],
      f1: evt[o + 9], f2: evt[o + 10], i1: evt[o + 11], i2: evt[o + 12], b1: evt[o + 13], b2: evt[o + 14] };
    it.e = e;
    it.h = EVENTS[it.key](e, rng(it.row)) || {};
    return it.h;
  }

  // ---------------------------------------------------------------- positions
  function objectAt(ent, i, f) {
    const rows = S.D.objByEnt.get(ent);
    if (!rows) return null;
    const k = lastRow(rows, i);
    if (k < 0) return null;
    const O = S.D.objs, o = rows[k] * OBJ_STRIDE;
    if (O[o + 2] < 0) return null;
    // MOVETYPE_FOLLOW (a carried flag) is wherever its aiment is
    if (O[o + 21] === 12 && O[o + 22] > 0 && O[o + 22] <= S.meta.maxclients) {
      const p = playerState(O[o + 22], i, f);
      return p ? [p.x, p.y, p.z] : null;
    }
    let x = O[o + 3], y = O[o + 4], z = O[o + 5];
    if (f > 0 && k + 1 < rows.length && rowFrame(rows[k + 1]) === i + 1) {
      const q = rows[k + 1] * OBJ_STRIDE;
      if (O[q + 2] === O[o + 2]) { x += (O[q + 3] - x) * f; y += (O[q + 4] - y) * f; z += (O[q + 5] - z) * f; }
    }
    return [x, y, z];
  }
  /** Where entity ent is at time t (players: their origin; objects: theirs), or null. */
  function entityPos(ent, t) {
    if (!ent || ent >= 1023) return null;
    const [i, f] = frameAt(t);
    if (ent <= S.meta.maxclients) {
      const p = playerState(ent, i, f);
      return p ? [p.x, p.y, p.z] : null;
    }
    return objectAt(ent, i, f);
  }
  function entityExists(ent, t) { return !!entityPos(ent, t); }
  /** The shooter's state at event time: origin, eye, aim. */
  function shooter(it) {
    const [i, f] = frameAt(it.t);
    const p = it.ent >= 1 && it.ent <= S.meta.maxclients ? playerState(it.ent, i, f) : null;
    if (!p) return null;
    return { p, eye: eyeOf(p), dir: forward(p.pitch, p.yaw), yaw: p.yaw, pitch: p.pitch };
  }
  function eventOrigin(it) {
    const e = it.e;
    if (e.origin[0] || e.origin[1] || e.origin[2]) return e.origin;
    return entityPos(it.ent, it.t) || e.origin;
  }

  // ---------------------------------------------------------------- sound scheduling
  /** First row index with time > t in a Float32 row table of width w (rows are in time order). */
  function firstAfter(A, w, t) {
    let lo = 0, hi = A.length / w;
    while (lo < hi) { const m = (lo + hi) >> 1; if (A[m * w] <= t) lo = m + 1; else hi = m; }
    return lo;
  }
  function firstItemAfter(list, t) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Starts every sound due in (t0, t1]. */
  function playSounds(t0, t1) {
    if (!GameAudio.running()) return;
    // server sounds
    for (let r = firstAfter(snd_, 11, t0), n = snd_.length / 11; r < n; r++) {
      const o = r * 11, t = snd_[o];
      if (t > t1) break;
      const flags = snd_[o + 10];
      if (flags & SND_SENTENCE) continue;
      const name = levelAt(t).sounds[snd_[o + 3]];
      if (!name || name[0] === '!' || name[0] === '*') continue;
      const ent = snd_[o + 1], chan = snd_[o + 2];
      if (flags & SND_STOP) { GameAudio.stopSound(ent, name); continue; }
      if (flags & (SND_CHANGE_VOL | SND_CHANGE_PITCH)) continue;
      const fixed = [snd_[o + 6], snd_[o + 7], snd_[o + 8]];
      const follow = ent > 0 && ent < 1023;
      GameAudio.play({ name, ent, chan, vol: snd_[o + 4] / 255, atten: snd_[o + 5] / 64, pitch: snd_[o + 9],
        pos: follow ? () => entityPos(ent, S.t) || fixed : () => fixed,
        alive: follow ? () => entityExists(ent, S.t) : null, at: t1 - t });
    }
    // weapon events
    for (let k = firstItemAfter(evItems, t0); k < evItems.length && evItems[k].t <= t1; k++) {
      const it = evItems[k], h = handle(it);
      const ent = it.ent;
      const at = h.at === 'origin' ? eventOrigin(it) : null;
      for (const st of h.stop || []) GameAudio.stopChannel(ent, st[0], st[1]);
      const pos = at ? () => at : () => entityPos(ent, S.t) || eventOrigin(it);
      for (const s of h.s || []) GameAudio.play({ ...s, ent: h.world ? 0 : ent, pos, at: t1 - it.t });
      if (h.melee) meleeSound(it, h.r);
      for (const fx of h.fx || []) if (fx.kind === 'explosion') explosionSound(eventOrigin(it), rng(it.row * 7 + 3), t1 - it.t);
    }
    // server explosions
    for (let k = firstItemAfter(tentItems, t0); k < tentItems.length && tentItems[k].t <= t1; k++) {
      const it = tentItems[k];
      if (it.type !== TE_EXPLOSION) continue;
      const o = it.row * 16;
      if (tent[o + 8] & TE_EXPLFLAG_NOSOUND) continue;
      explosionSound([tent[o + 2], tent[o + 3], tent[o + 4]], rng(it.row * 13 + 1), t1 - it.t, true);
    }
  }
  function explosionSound(pos, r, at, engineOnly) {
    GameAudio.play({ name: pick(r, EXPLODE_SOUNDS), ent: 0, chan: CHAN_AUTO, vol: 1, atten: ATTN_EXPLOSION, pitch: 100, pos: () => pos, at });
    if (!engineOnly) GameAudio.play({ name: pick(r, DEBRIS_SOUNDS), ent: 0, chan: CHAN_AUTO, vol: 0.55, atten: ATTN_NORM, pos: () => pos, at });
  }
  /** EV_TFC_Axe: a 32-unit trace; body hit, world hit or a miss. */
  function meleeSound(it, r) {
    const sh = shooter(it);
    if (!sh) return;
    const end = addv(sh.eye, mulv(sh.dir, 32));
    let body = false;
    for (const s of S.D.slots) {
      if (s === it.ent) continue;
      const q = playerState(s, frameAt(it.t)[0], 0);
      if (!q || q.dead || q.hidden) continue;
      if (Math.abs(q.x - end[0]) < 20 && Math.abs(q.y - end[1]) < 20 && Math.abs(q.z - end[2]) < 40) { body = true; break; }
    }
    const world = !body && traceLine(sh.eye, end, frameAt(it.t)[0]) >= 0;
    const pos = () => entityPos(it.ent, S.t) || sh.eye;
    if (body) GameAudio.play({ name: pick(r, ['weapons/cbar_hitbod1.wav', 'weapons/cbar_hitbod2.wav', 'weapons/cbar_hitbod3.wav']), ent: it.ent, chan: CHAN_WEAPON, vol: 1, pos });
    else if (world) GameAudio.play({ name: pick(r, ['weapons/cbar_hit1.wav', 'weapons/cbar_hit2.wav']), ent: it.ent, chan: CHAN_ITEM, vol: 1, pitch: rl(r, 98, 101), pos });
    else GameAudio.play({ name: 'weapons/cbar_miss1.wav', ent: it.ent, chan: CHAN_WEAPON, vol: 1, pitch: rl(r, 94, 109), pos });
  }

  /** Ambient loops (svc_spawnstaticsound) that should be playing at time t: started when playback (re)starts. */
  function startStatics(t) {
    if (!GameAudio.running()) return;
    for (let r = 0, n = snd_.length / 11; r < n; r++) {
      const o = r * 11;
      if (snd_[o] > t) break;
      if (!(snd_[o + 10] & SND_STATIC)) continue;
      const name = levelAt(snd_[o]).sounds[snd_[o + 3]];
      if (!name) continue;
      const pos = [snd_[o + 6], snd_[o + 7], snd_[o + 8]];
      GameAudio.play({ name, ent: snd_[o + 1], chan: CHAN_STATIC, vol: snd_[o + 4] / 255, atten: snd_[o + 5] / 64, pitch: snd_[o + 9], pos: () => pos });
    }
  }

  // ---------------------------------------------------------------- sprites
  function init() {
    SP = program(`#version 300 es
      layout(location=0) in vec2 aC;
      uniform mat4 uVP; uniform vec3 uCenter; uniform vec3 uRight; uniform vec3 uUp; uniform vec4 uRect;
      out vec2 vUV;
      void main() {
        vec3 p = uCenter + uRight * mix(uRect.x, uRect.y, aC.x) + uUp * mix(uRect.z, uRect.w, aC.y);
        gl_Position = uVP * vec4(p, 1.0);
        vUV = vec2(aC.x, 1.0 - aC.y);
      }`,
    `#version 300 es
      precision highp float;
      in vec2 vUV; uniform sampler2D uTex; uniform vec4 uColor; uniform float uAlphaTest;
      out vec4 o;
      void main() {
        vec4 c = texture(uTex, vUV) * uColor;
        if (uAlphaTest > 0.5 && c.a < 0.5) discard;
        o = c;
      }`);
    quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  function sprite(name) {
    const key = (name || '').toLowerCase();
    let e = sprites.get(key);
    if (e) return e;
    e = { state: 'loading', frames: [], format: 0, type: 0 };
    sprites.set(key, e);
    fetch(`/api/sprite/${encodeURIComponent(S.meta.game)}/${key.split('/').map(encodeURIComponent).join('/')}?v=${ASSET_VERSION}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(buf => {
        const dv = new DataView(buf);
        const jl = dv.getUint32(4, true);
        const m = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
        const body = (8 + jl + 3) & ~3;
        e.format = m.format; e.type = m.type;
        e.frames = m.frames.map(fr => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fr.w, fr.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf, body + fr.off, fr.w * fr.h * 4));
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return { tex, w: fr.w, h: fr.h, ox: fr.ox, oy: fr.oy };
        });
        e.state = 'ready';
      }).catch(() => { e.state = 'missing'; });
    return e;
  }
  const SPR_ADDITIVE = 1, SPR_ALPHTEST = 3;
  let camRight = [0, -1, 0], camUp = [0, 0, 1], camFwd = [1, 0, 0];
  function beginSprites(VP, cam) {
    const f = forward(cam.pitch, cam.yaw), y = cam.yaw * DEG;
    camFwd = f;
    camRight = [Math.sin(y), -Math.cos(y), 0];
    camUp = cross(camRight, f);
    gl.useProgram(SP.p);
    gl.uniformMatrix4fv(SP.u.uVP, false, VP);
    gl.uniform1i(SP.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(quad);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
  }
  /** One sprite frame. o = { mode: 'add' | 'alpha' | 'normal', color: [r,g,b,a], right, up (axes, default: face the camera) } */
  function drawSprite(name, frame, pos, scale, o = {}) {
    const e = sprite(name);
    if (e.state !== 'ready' || !e.frames.length) return;
    const fr = e.frames[((frame | 0) % e.frames.length + e.frames.length) % e.frames.length];
    const add = o.mode ? o.mode === 'add' : e.format === SPR_ADDITIVE;
    gl.blendFunc(gl.SRC_ALPHA, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(SP.u.uAlphaTest, !add && e.format === SPR_ALPHTEST ? 1 : 0);
    const c = o.color || [1, 1, 1, 1];
    gl.uniform4f(SP.u.uColor, c[0], c[1], c[2], c[3]);
    const r = o.right || camRight, u = o.up || camUp;
    gl.uniform3f(SP.u.uCenter, pos[0], pos[1], pos[2]);
    gl.uniform3f(SP.u.uRight, r[0], r[1], r[2]);
    gl.uniform3f(SP.u.uUp, u[0], u[1], u[2]);
    // the frame's origin is its top-left corner relative to the sprite's centre (left = ox, up = oy)
    gl.uniform4f(SP.u.uRect, fr.ox * scale, (fr.ox + fr.w) * scale, (fr.oy - fr.h) * scale, fr.oy * scale);
    gl.bindTexture(gl.TEXTURE_2D, fr.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function endSprites() {
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
  function frameCount(name) { const e = sprite(name); return e.state === 'ready' ? e.frames.length : 1; }

  // ---------------------------------------------------------------- drawing
  const lines = [];
  function modelName(mi, t) { return levelAt(t).models[mi] || ''; }

  /** Effects visible at the current time. objs: this frame's objects (sprite entities are drawn here). */
  function draw(VP, cam, objs) {
    if (!D || !SP) return;
    const t = S.t;
    lines.length = 0;
    beginSprites(VP, cam);
    // sprite entities (laser dots, glows, sprites on the map)
    for (const o of objs) {
      if (o.nodraw || !/\.spr$/i.test(o.model)) continue;
      const add = o.rmode === 5 || o.rmode === 3;
      const a = o.rmode ? Math.max(0.05, (o.amt || 255) / 255) : 1;
      drawSprite(o.model, o.frame, o.o, o.scale || 1, { mode: add ? 'add' : undefined, color: [1, 1, 1, a] });
    }
    // weapon events
    for (let k = firstItemAfter(evItems, t - MAX_LIFE); k < evItems.length && evItems[k].t <= t; k++) {
      const it = evItems[k], h = handle(it), age = t - it.t;
      for (const fx of h.fx || []) drawEventFx(it, fx, age);
    }
    // server temp entities
    for (let k = firstItemAfter(tentItems, t - MAX_LIFE); k < tentItems.length && tentItems[k].t <= t; k++) {
      drawTent(tentItems[k], t - tentItems[k].t);
    }
    // things attached to players (TFC: the concussed / burning / "save me" sprites)
    for (const a of attachments) {
      if (a.t > t || t > Math.min(a.end, a.t + (a.life || 1))) continue;
      const pos = entityPos(a.ent, t);
      const name = modelName(a.model, a.t);
      if (pos && /\.spr$/i.test(name)) drawSprite(name, Math.floor((t - a.t) * 10), [pos[0], pos[1], pos[2] + a.z], 1, { mode: 'add' });
    }
    endSprites();
    if (lines.length) drawLineVerts(VP, lines, true);
  }

  function drawEventFx(it, fx, age) {
    if (fx.kind === 'explosion') {
      const scale = fx.scale || (fx.mag - 50) * 0.06, fps = 15;
      const n = frameCount('sprites/explode01.spr');
      if (age > n / fps) return;
      if (!it.boom) {
        // FUN_10002ce0: traced from 8 above to 32 below the origin; on a hit the blast sits (magnitude - 24) * 0.6
        // units off the surface
        const o = eventOrigin(it), a = [o[0], o[1], o[2] + 8], b = [o[0], o[1], o[2] - 32];
        const fr = traceLine(a, b, frameAt(it.t)[0]);
        const lift = ((fx.mag || 74) > 23 ? (fx.mag || 74) - 24 : fx.mag || 0) * 0.6;
        it.boom = fr >= 0 ? [o[0], o[1], a[2] + (b[2] - a[2]) * fr + lift] : o;
      }
      drawSprite('sprites/explode01.spr', age * fps, it.boom, scale, { mode: 'alpha' });
      return;
    }
    if (fx.kind === 'shockwave') {
      // TE_BEAMCYLINDER: a ring that grows 600 units in 0.2 s
      if (age > 0.2) return;
      const p = eventOrigin(it), s = age / 0.2;
      const R = 600 * s / 32;
      drawSprite('sprites/shockwave.spr', 0, [p[0], p[1], p[2] + 16], R, { mode: 'add', right: [1, 0, 0], up: [0, 1, 0], color: [1, 1, 1, 1 - s] });
      return;
    }
    if (fx.kind === 'gas') {
      if (age > 2) return;
      const p = eventOrigin(it);
      drawSprite('sprites/steam1.spr', age * 10, [p[0], p[1], p[2] + 16], 2 + age * 2, { mode: 'alpha', color: [0.6, 0.85, 0.4, 0.5 * (1 - age / 2)] });
      return;
    }
    if (fx.kind === 'burn') {
      if (age > 1) return;
      const p = entityPos(it.ent, S.t);
      if (p) drawSprite('sprites/playerflame.spr', age * 12, [p[0], p[1], p[2] + 10], 1.2, { mode: 'add' });
      return;
    }
    const sh = it.sh || (it.sh = shooter(it) || false);
    if (!sh) return;
    if (fx.kind === 'muzzle') {
      if (age > 0.06) return;
      const p = addv(addv(sh.eye, mulv(sh.dir, 24)), [0, 0, -4]);
      drawSprite('sprites/muzzleflash1.spr', 0, p, 0.18, { mode: 'add' });
      return;
    }
    if (fx.kind === 'nail') {
      // a tempent nail flying straight on until it hits the map
      if (it.hit === undefined) {
        const far = addv(sh.eye, mulv(sh.dir, fx.speed * 2));
        const fr = traceLine(sh.eye, far, frameAt(it.t)[0]);
        it.hit = fr >= 0 ? fr * fx.speed * 2 : fx.speed * 2;
      }
      const d = Math.min(age * fx.speed, it.hit);
      if (age * fx.speed > it.hit + 4 || age > 2) return;
      const a = addv(addv(sh.eye, mulv(sh.dir, d)), [0, 0, -6]);
      const b = addv(a, mulv(sh.dir, -(fx.rail ? 40 : 10)));
      if (fx.rail) pushLine(lines, a, b, [0.4, 0.8, 1], 0.9);
      else pushLine(lines, a, b, [0.85, 0.85, 0.8], 0.95);
      return;
    }
    if (fx.kind === 'flame') {
      if (age > 0.6) return;
      const d = age * 600;
      const p = addv(addv(sh.eye, mulv(sh.dir, 16 + d)), [0, 0, -8]);
      if (fx.water) drawSprite('sprites/bubble.spr', 0, p, 0.5, { mode: 'alpha' });
      else drawSprite('sprites/fthrow.spr', age * 25, p, 0.4 + age * 1.2, { mode: 'add', color: [1, 1, 1, 1 - age / 0.6] });
    }
  }

  function drawTent(it, age) {
    const o = it.row * 16, T = tent;
    switch (it.type) {
      case TE_EXPLOSION: {
        const name = modelName(T[o + 5], it.t), fps = T[o + 7] || 15, scale = T[o + 6] / 10;
        const n = frameCount(name);
        if (age > n / fps) return;
        drawSprite(name, age * fps, [T[o + 2], T[o + 3], T[o + 4]], scale, { mode: T[o + 8] & TE_EXPLFLAG_NOADDITIVE ? 'alpha' : 'add' });
        return;
      }
      case TE_TRACER: {
        // R_TracerEffect: a streak flying from start to end
        const a = [T[o + 2], T[o + 3], T[o + 4]], b = [T[o + 5], T[o + 6], T[o + 7]];
        const L = vlen(sub(b, a)), speed = 6000;
        if (age * speed > L + 64) return;
        const u = mulv(sub(b, a), 1 / Math.max(1, L));
        const p1 = addv(a, mulv(u, Math.min(L, age * speed))), p0 = addv(a, mulv(u, Math.max(0, age * speed - 64)));
        pushLine(lines, p0, p1, [1, 0.9, 0.5], 0.9);
        return;
      }
      case TE_BLOODSPRITE: {
        const name = modelName(T[o + 5], it.t), n = frameCount(name), life = Math.max(0.3, n / 15);
        if (age > life) return;
        drawSprite(name, age * 15, [T[o + 2], T[o + 3], T[o + 4]], Math.max(0.3, T[o + 8] / 10), { mode: 'alpha', color: [0.65, 0.05, 0.05, 1] });
        return;
      }
      case TE_SPRITETRAIL: {
        // sparks: count sprites thrown along start -> end, falling
        const life = Math.max(0.1, T[o + 10] / 10);
        if (age > life) return;
        const a = [T[o + 2], T[o + 3], T[o + 4]], b = [T[o + 5], T[o + 6], T[o + 7]];
        const name = modelName(T[o + 8], it.t), count = Math.min(16, T[o + 9] || 4);
        const vel = (T[o + 12] || 10) * 10, rnd = (T[o + 13] || 10) * 10;
        const r = rng(it.row), dir = mulv(sub(b, a), 1 / Math.max(1, vlen(sub(b, a))));
        for (let k = 0; k < count; k++) {
          const v = addv(mulv(dir, vel), [rf(r, -rnd, rnd), rf(r, -rnd, rnd), rf(r, -rnd, rnd)]);
          const p = addv(a, [v[0] * age, v[1] * age, v[2] * age - 400 * age * age]);
          drawSprite(name, 0, p, Math.max(0.05, T[o + 11] / 10) * 0.5, { mode: 'add', color: [1, 1, 1, 1 - age / life] });
        }
        return;
      }
      case TE_BEAMFOLLOW: {
        // a trail behind a moving entity (rockets, grenades): its own path over the last `life` seconds
        const ent = T[o + 2] & 0x0fff, life = Math.max(0.1, T[o + 4] / 10);
        if (!entityExists(ent, S.t)) return;
        const c = [T[o + 6] / 255, T[o + 7] / 255, T[o + 8] / 255], a = (T[o + 9] || 200) / 255;
        let prev = null;
        for (let k = 0; k <= 12; k++) {
          const tt = S.t - life * k / 12;
          if (tt < it.t) break;
          const p = entityPos(ent, tt);
          if (!p) break;
          if (prev) pushLine(lines, prev, p, c, a * (1 - k / 12));
          prev = p;
        }
        return;
      }
      case TE_BEAMPOINTS: {
        const life = Math.max(0.05, T[o + 11] / 10);
        if (age > life) return;
        pushLine(lines, [T[o + 2], T[o + 3], T[o + 4]], [T[o + 5], T[o + 6], T[o + 7]], [0.8, 0.9, 1], 0.9);   // colour is past the row width
        return;
      }
      default:
    }
  }

  function reset() { for (const it of evItems) { it.h = null; it.sh = undefined; it.hit = undefined; it.boom = undefined; } }

  /** How many sprites are still loading (video export waits for none). */
  function busy() { let n = 0; for (const e of sprites.values()) if (e.state === 'loading') n++; return n; }

  return { init, build, playSounds, startStatics, draw, reset, entityPos, sprite, drawSprite, beginSprites, endSprites, busy };
})();
