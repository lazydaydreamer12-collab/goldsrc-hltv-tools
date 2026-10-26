'use strict';
/* Game sound for the demo viewer, on Web Audio, following the GoldSrc engine's rules (S_StartDynamicSound,
   SND_PickChannel, SND_Spatialize):
   - loudness falls off linearly: gain = volume * (1 - distance * attenuation / 1000), so ATTN_NORM (0.8) is silent
     beyond 1250 units and ATTN_NONE (0) is heard everywhere;
   - left/right from the dot product of the listener's right vector and the direction to the sound;
   - a sound on an entity's channel (other than CHAN_AUTO 0) replaces the one already playing there;
   - a WAV with a cue point loops (the server tells us its loop range) until stopped or its entity goes away;
   - the listener's own entity is heard at full volume, in the middle.
   Sounds come from /api/sound/<game>/<path under sound/> as 16-bit WAV (the server converts 8-bit ones).

   Video export runs the same rules offline: beginOffline() switches to an OfflineAudioContext covering a stretch of the
   video, setClock(t) says which moment of it the next calls are about, renderOffline() returns the audio. A following
   beginOffline() carries the sounds still playing into the next stretch. */

const GameAudio = (() => {
  const NOMINAL_CLIP = 1000;               // SOUND_NOMINAL_CLIP_DIST
  let ctx = null, master = null, game = 'valve';
  let volume = 0.7, muted = false, rate = 1;
  const bank = new Map();                  // lower-case name -> { state, buf, loop }
  let voices = new Set();
  let listener = { pos: [0, 0, 0], right: [0, -1, 0], ent: -1 };
  let off = null;                          // offline stretch: { ctx, master, t (seconds into it), len }

  /** Master gain -> a limiter -> the speakers: a gunfight of loud sounds is squashed instead of clipping. */
  function output(c, gain) {
    const m = c.createGain();
    m.gain.value = gain;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 4; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
    m.connect(lim);
    lim.connect(c.destination);
    return m;
  }
  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = output(ctx, muted ? 0 : volume);
    }
    return ctx;
  }
  const C = () => off ? off.ctx : ctx;
  const OUT = () => off ? off.master : master;
  const NOW = () => off ? Math.max(0, off.t) : ctx.currentTime;
  /** Call from a click or key press: browsers only start audio after the user interacts. */
  function unlock() { const c = context(); if (c && c.state === 'suspended') c.resume(); }
  function running() { return !!off || (!!ctx && ctx.state === 'running'); }
  function setGame(g) { if (g !== game) { game = g; bank.clear(); } }
  function setVolume(v, m) {
    volume = v; muted = m;
    if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02);
  }

  function url(name) {
    return `/api/sound/${encodeURIComponent(game)}/${name.split('/').map(encodeURIComponent).join('/')}?v=2`;
  }
  function load(name) {
    const key = name.toLowerCase();
    let e = bank.get(key);
    if (e) return e;
    e = { state: 'loading', buf: null, loop: null };
    bank.set(key, e);
    const c = context();
    if (!c) { e.state = 'missing'; return e; }
    e.promise = fetch(url(name)).then(async r => {
      if (!r.ok) throw new Error(String(r.status));
      const ls = r.headers.get('X-Loop-Start'), le = r.headers.get('X-Loop-End');
      e.buf = await c.decodeAudioData(await r.arrayBuffer());
      if (ls !== null && ls !== '') e.loop = [+ls / e.buf.sampleRate, (le ? +le : e.buf.length) / e.buf.sampleRate];
      e.state = 'ready';
    }).catch(() => { e.state = 'missing'; });
    return e;
  }
  function preload(names) { for (const n of names) if (n) load(n); }
  /** Resolves when every sound asked for so far has loaded (or failed). */
  function loaded() { return Promise.all([...bank.values()].map(e => e.promise).filter(Boolean)); }

  function source(buf, loop, r) {
    const c = C();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    if (loop) { src.loop = true; src.loopStart = loop[0]; src.loopEnd = loop[1]; }
    const g = c.createGain();
    g.gain.value = 0;
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    src.connect(g);
    if (pan) { g.connect(pan); pan.connect(OUT()); } else g.connect(OUT());
    return { src, g, pan };
  }
  function wrap(pos, buf, loop) {
    if (!loop) return pos;
    if (pos < loop[1]) return pos;
    const span = Math.max(0.01, loop[1] - loop[0]);
    return loop[0] + ((pos - loop[0]) % span);
  }

  /**
   * Starts a sound. spec = { name, ent (0 = world), chan, vol (0-1), atten (0.8 = ATTN_NORM, 0 = everywhere), pitch
   * (100 = normal), pos: () => [x, y, z] | null (followed every frame), alive: () => bool (a loop stops when false),
   * at: seconds of demo time since the sound started }. Returns the voice, or null when it could not play.
   */
  function play(spec) {
    if (!running()) return null;
    const e = load(spec.name);
    if (e.state !== 'ready') return null;
    if (spec.chan && spec.ent) stopChannel(spec.ent, spec.chan);
    const pitch = (spec.pitch || 100) / 100;
    const r = Math.max(0.05, pitch * rate);
    const at = Math.max(0, spec.at || 0);
    // live: start now, `at` into the sound; offline: start when it really began (demo seconds / speed ago)
    let when = 0, offset = at;
    if (off) {
      when = off.t - at / Math.max(0.05, rate);
      offset = 0;
      if (when < 0) { offset = -when * r; when = 0; }
    }
    if (!e.loop && offset >= e.buf.duration) return null;
    const n = source(e.buf, e.loop, r);
    const v = { ent: spec.ent || 0, chan: spec.chan || 0, name: spec.name.toLowerCase(), vol: spec.vol ?? 1,
      atten: spec.atten ?? 0.8, pitch, pos: spec.pos || null, alive: spec.alive || null, loop: !!e.loop,
      buf: e.buf, loopRange: e.loop, r, bufPos: offset, bufT: when, ...n };
    v.endT = e.loop ? Infinity : when + (e.buf.duration - offset) / r;
    if (!off) v.src.onended = () => voices.delete(v);
    voices.add(v);
    spatialize(v, true);
    v.src.start(off ? when : 0, wrap(offset, e.buf, e.loop));
    return v;
  }

  function spatialize(v, now) {
    let gain = v.vol, p = 0;
    const o = v.pos ? v.pos() : null;
    if (o && v.atten > 0 && v.ent !== listener.ent) {
      const dx = o[0] - listener.pos[0], dy = o[1] - listener.pos[1], dz = o[2] - listener.pos[2];
      const dist = Math.hypot(dx, dy, dz);
      gain *= Math.max(0, 1 - dist * v.atten / NOMINAL_CLIP);
      if (dist > 1) p = (dx * listener.right[0] + dy * listener.right[1] + dz * listener.right[2]) / dist;
    }
    v.gainNow = gain; v.panNow = p * 0.85;
    if (now) { v.g.gain.value = gain; if (v.pan) v.pan.pan.value = p * 0.85; return; }
    const t = NOW();
    v.g.gain.setTargetAtTime(gain, t, 0.03);
    if (v.pan) v.pan.pan.setTargetAtTime(p * 0.85, t, 0.03);
  }
  /** The camera: position, yaw (degrees), and the entity being watched through (its sounds play centred). */
  function setListener(pos, yaw, ent) {
    const y = yaw * Math.PI / 180;
    listener = { pos, right: [Math.sin(y), -Math.cos(y), 0], ent: ent ?? -1 };
  }
  /** Once a frame: follow moving sources, drop loops whose entity is gone. */
  function update() {
    if (!C()) return;
    for (const v of [...voices]) {
      if (off && v.endT <= off.t) { voices.delete(v); continue; }
      if (v.loop && v.alive && !v.alive()) { stopVoice(v); continue; }
      spatialize(v, false);
    }
  }
  function stopVoice(v) {
    try { v.src.stop(off ? Math.max(NOW(), v.bufT) : 0); } catch (e) { /* already stopped */ }
    voices.delete(v);
  }
  function stopChannel(ent, chan, name) {
    const n = name && name.toLowerCase();
    for (const v of [...voices]) if (v.ent === ent && v.chan === chan && (!n || v.name === n)) stopVoice(v);
  }
  function stopSound(ent, name) {
    const n = name.toLowerCase();
    for (const v of [...voices]) if (v.ent === ent && v.name === n) stopVoice(v);
  }
  function stopAll() { for (const v of [...voices]) stopVoice(v); }
  /** Playback speed: sounds play faster/slower (and higher/lower) with the demo, like a tape. */
  function setRate(r) {
    if (r === rate) return;
    rate = r;
    for (const v of voices) {
      const nr = Math.max(0.05, v.pitch * r);
      if (off) {
        const t = NOW();
        v.bufPos += Math.max(0, t - v.bufT) * v.r; v.bufT = t; v.r = nr;
        if (!v.loop) v.endT = t + Math.max(0, v.buf.duration - v.bufPos) / nr;
        v.src.playbackRate.setValueAtTime(nr, t);
      } else v.src.playbackRate.value = nr;
      v.r = nr;
    }
  }
  function count() { return voices.size; }

  // ---------------------------------------------------------------- offline (video export)
  /** Starts an offline stretch of `seconds`. Sounds still playing at the end of the previous stretch go on in this one. */
  function beginOffline(seconds, sampleRate = 48000, gain = 0.9) {
    const prev = off;
    const c = new OfflineAudioContext(2, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
    const m = output(c, gain);
    const carry = prev ? [...voices].filter(v => v.endT > prev.len) : [];
    if (!prev) { stopAll(); voices = new Set(); }
    off = { ctx: c, master: m, t: 0, len: seconds };
    voices = new Set();
    for (const v of carry) {
      const pos = v.bufPos + Math.max(0, prev.len - v.bufT) * v.r;
      const n = source(v.buf, v.loopRange, v.r);
      Object.assign(v, n, { bufPos: pos, bufT: 0 });
      v.endT = v.loop ? Infinity : (v.buf.duration - pos) / v.r;
      v.g.gain.value = v.gainNow || 0;
      if (v.pan) v.pan.pan.value = v.panNow || 0;
      v.src.start(0, wrap(pos, v.buf, v.loopRange));
      voices.add(v);
    }
  }
  /** Seconds into the current offline stretch that the following play/update/stop calls are about. */
  function setClock(t) { if (off) off.t = t; }
  /** Renders the current stretch: resolves to its AudioBuffer. */
  function renderOffline() { return off.ctx.startRendering(); }
  /** Back to live sound. */
  function endOffline() { off = null; voices = new Set(); rate = 1; }

  return { unlock, running, setGame, setVolume, load, preload, loaded, play, setListener, update, stopChannel, stopSound,
    stopAll, setRate, count, beginOffline, setClock, renderOffline, endOffline };
})();
