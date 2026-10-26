'use strict';
/* GoldSrc studio models (players and their weapons) for the demo viewer.
   Data comes from mdl.py through /api/model/<game>/<game path>. Posing follows the game's own client code
   (the HL SDK's cl_dll/StudioModelRenderer.cpp): StudioEstimateFrame, StudioCalcRotations, StudioPlayerBlend,
   StudioProcessGait, the 0.2 s blend from the previous sequence, the gait copy onto the legs, StudioMergeBones for
   the weapon. Skinning runs on the GPU with one bone per vertex, like the game. GoldSrc axes and units throughout. */

const Studio = (() => {
  const MAX_BONES = 128;
  const STUDIO_LOOPING = 1;
  const NF_FLATSHADE = 1, NF_CHROME = 2, NF_FULLBRIGHT = 4, NF_ADDITIVE = 32, NF_MASKED = 64;
  const STUDIO_X = 1, STUDIO_Y = 2, STUDIO_Z = 4, STUDIO_RLOOP = 0x8000;

  const MAX_ROWS = 128;           // posed models per frame (a player and their weapon are two)
  const BONE_UNIT = 2;            // texture unit of the bone matrices (0: skins, 1: the world's lightmap)

  let gl = null, P = null, boneTex = null;
  const boneData = new Float32Array(MAX_BONES * 12 * MAX_ROWS);
  let rows = 0;
  const models = new Map();     // key -> { state: 'loading' | 'ready' | 'missing', model, promise, error }

  // ---------------------------------------------------------------- GL
  // Bone matrices of every posed model go in one float texture (a row per model, 3 texels per bone), uploaded once a
  // frame: per-draw uniform arrays cost far more in WebGL than the drawing.
  function init(glctx, makeProgram) {
    gl = glctx;
    if ((gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0) < MAX_BONES * 3) return false;
    P = makeProgram(`#version 300 es
      layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aST; layout(location=3) in vec2 aBone;
      uniform mat4 uVP; uniform highp sampler2D uBoneTex; uniform int uRow;
      uniform vec2 uTexSize; uniform float uChrome; uniform float uFlatShade; uniform float uFull;
      uniform vec3 uCamPos; uniform vec3 uCamRight; uniform vec3 uLightVec; uniform float uAmbient; uniform float uShade;
      uniform float uShell;
      out vec2 vUV; out float vLight; out vec3 vN; out vec3 vW;
      vec4 bt(int i) { return texelFetch(uBoneTex, ivec2(i, uRow), 0); }
      vec3 xf(int b, vec4 p) { return vec3(dot(bt(b * 3), p), dot(bt(b * 3 + 1), p), dot(bt(b * 3 + 2), p)); }
      void main() {
        int b = int(aBone.x + 0.5), nb = int(aBone.y + 0.5);
        vec3 w = xf(b, vec4(aPos, 1.0));
        vec3 n = normalize(xf(nb, vec4(aNor, 0.0)));
        w += n * uShell;                       // kRenderFxGlowShell: the shell pass pushes the surface out
        gl_Position = uVP * vec4(w, 1.0);
        vN = n; vW = w;
        vUV = aST / uTexSize;
        if (uChrome > 0.5) {
          // R_StudioChrome: s and t from the normal against vectors from the eye to the bone
          vec3 bonePos = vec3(bt(nb * 3).w, bt(nb * 3 + 1).w, bt(nb * 3 + 2).w);
          vec3 tmp = normalize(bonePos - uCamPos);
          vec3 up = normalize(cross(tmp, uCamRight));
          vec3 right = normalize(cross(tmp, up));
          vUV = vec2((dot(n, right) + 1.0) * 32.0, (dot(n, up) + 1.0) * 32.0) / uTexSize;
        }
        // R_StudioLighting: ambient + shade, with the lambert 1.5 wrap
        float illum = uAmbient;
        if (uFlatShade > 0.5) illum += uShade * 0.8;
        else {
          illum += uShade;
          float lc = (dot(n, uLightVec) + 0.5) / 1.5;
          if (lc > 0.0) illum -= uShade * lc;
        }
        vLight = mix(clamp(illum, 0.0, 1.0), 1.0, uFull);
      }`,
    `#version 300 es
      precision highp float;
      in vec2 vUV; in float vLight; in vec3 vN; in vec3 vW;
      uniform sampler2D uTex; uniform vec4 uFlat; uniform float uMasked; uniform float uAlpha;
      uniform float uShell; uniform vec3 uShellColor; uniform vec3 uCamPos; uniform float uShellTime;
      out vec4 o;
      void main() {
        if (uShell > 0.0) {
          // glow shell in rendercolor: GoldSrc maps the dim shellchrome sprite over it, scrolling (r_glowshellfreq 2.2);
          // here a moving band pattern, brightest where the surface turns away from the eye. Both sides are drawn, so
          // each is kept faint.
          float rim = 1.0 - abs(dot(normalize(vN), normalize(uCamPos - vW)));
          float band = 0.55 + 0.45 * sin(dot(vW, vec3(0.071, 0.053, 0.089)) + uShellTime * 2.2);
          o = vec4(uShellColor * (0.08 + 0.42 * rim * rim) * band, 1.0);
          return;
        }
        if (uFlat.a > 0.0) {
          vec3 n = normalize(vN);
          float l = 0.55 + 0.35 * max(dot(n, normalize(vec3(0.35, 0.25, 0.9))), 0.0) + 0.1 * abs(n.x);
          o = vec4(uFlat.rgb * l, uFlat.a);
          return;
        }
        vec4 c = texture(uTex, vUV);
        if (uMasked > 0.5 && c.a < 0.5) discard;
        o = vec4(min(c.rgb * vLight, vec3(1.0)), uAlpha);
      }`);
    boneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, boneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_BONES * 3, MAX_ROWS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return true;
  }

  /** Starts a frame's bone uploads. */
  function beginBones() { rows = 0; }
  /** Queues a posed model's matrices; returns its row for draw(), or -1 when the frame is full. */
  function addBones(bones, nb) {
    if (rows >= MAX_ROWS) return -1;
    boneData.set(bones.subarray(0, nb * 12), rows * MAX_BONES * 12);
    return rows++;
  }
  /** Uploads the frame's bone matrices (one texture upload for every model). */
  function flushBones() {
    if (!rows) return;
    gl.activeTexture(gl.TEXTURE0 + BONE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, boneTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_BONES * 3, rows, gl.RGBA, gl.FLOAT, boneData, 0);
    gl.activeTexture(gl.TEXTURE0);
  }
  function available() { return !!P; }

  // ---------------------------------------------------------------- loading
  function load(game, path) {
    const key = (game + '|' + path).toLowerCase();
    let e = models.get(key);
    if (e) return e.promise;
    e = { state: 'loading', model: null, promise: null, error: null };
    models.set(key, e);
    e.promise = (async () => {
      try {
        if (!P) throw new Error('no WebGL support for skinned models');
        const r = await fetch(`/api/model/${encodeURIComponent(game)}/${encodeURIComponent(path)}`);
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `${r.status}`); }
        e.model = parse(key, await r.arrayBuffer());
        if (e.model.nb > MAX_BONES) throw new Error(`${e.model.nb} bones`);
        e.state = 'ready';
      } catch (err) {
        e.state = 'missing';
        e.error = err.message;
        e.model = null;
      }
      return e.model;
    })();
    return e.promise;
  }
  /** The model if it is loaded; otherwise starts loading it and returns null. */
  function get(game, path) {
    const e = models.get((game + '|' + path).toLowerCase());
    if (!e) { load(game, path); return null; }
    return e.state === 'ready' ? e.model : null;
  }
  function status(game, path) { const e = models.get((game + '|' + path).toLowerCase()); return e ? e.state : 'none'; }
  /** How many models are still loading (video export waits for none). */
  function busy() { let n = 0; for (const e of models.values()) if (e.state === 'loading') n++; return n; }

  function parse(key, buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x444d5347) throw new Error('bad model data');
    const jl = dv.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const body = (8 + jl + 3) & ~3;
    const B = (n, T) => { const [o, l] = meta.buffers[n]; return new T(buf, body + o, l / T.BYTES_PER_ELEMENT); };
    const nb = meta.bones.length;
    const M = { key, meta, nb, seqs: meta.sequences, textures: meta.textures, skins: meta.skins, glTex: new Map() };
    M.parent = Int16Array.from(meta.bones.map(b => b.parent));
    M.bValue = new Float64Array(nb * 6); M.bScale = new Float64Array(nb * 6); M.bCtl = new Int16Array(nb * 6);
    meta.bones.forEach((b, i) => { for (let j = 0; j < 6; j++) { M.bValue[i * 6 + j] = b.value[j]; M.bScale[i * 6 + j] = b.scale[j]; M.bCtl[i * 6 + j] = b.ctl[j]; } });
    M.byName = new Map(meta.bones.map((b, i) => [b.name.toLowerCase(), i]));
    // StudioSetupBones' gait copy: the root and pelvis, then from the first bone hanging off the pelvis (the legs) on
    M.gaitCopy = new Uint8Array(nb);
    let copy = 1;
    for (let i = 0; i < nb; i++) {
      const par = meta.bones[i].parent;
      if (meta.bones[i].name === 'Bip01 Spine') copy = 0;
      else if (par >= 0 && meta.bones[par].name === 'Bip01 Pelvis') copy = 1;
      M.gaitCopy[i] = copy;
    }
    M.anim = meta.sequences.map(s => s.anim >= 0 ? B('anim' + s.anim, Int16Array) : null);
    M.texData = meta.textures.map(t => t.data >= 0 ? B('tex' + t.data, Uint8Array) : null);
    // default body: model 0 of each body part
    M.draws = [];
    for (const bp of meta.bodyparts) if (bp.models.length) M.draws.push(...bp.models[0].draws);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, B('verts', Float32Array), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 40, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 40, 32);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, B('indices', meta.big ? Uint32Array : Uint16Array), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    M.vao = vao;
    M.idxType = meta.big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    M.idxSize = meta.big ? 4 : 2;
    return M;
  }

  // ---------------------------------------------------------------- textures (player colours like the engine)
  /** PaletteHueReplace: entries start..end take the new hue (0-255 round the wheel), keeping value and saturation. */
  function hueReplace(pal, newHue, start, end) {
    const hue = newHue * (360 / 255);
    for (let i = Math.max(0, start); i <= Math.min(255, end); i++) {
      let r = pal[i * 3], g = pal[i * 3 + 1], b = pal[i * 3 + 2];
      const maxc = Math.max(r, g, b) / 255, minc0 = Math.min(r, g, b) / 255;
      if (maxc === 0) continue;
      const val = maxc, sat = (maxc - minc0) / maxc, minc = val * (1 - sat);
      if (hue <= 120) {
        b = minc;
        if (hue < 60) { r = val; g = minc + hue * (val - minc) / (120 - hue); }
        else { g = val; r = minc + (120 - hue) * (val - minc) / hue; }
      } else if (hue <= 240) {
        r = minc;
        if (hue < 180) { g = val; b = minc + (hue - 120) * (val - minc) / (240 - hue); }
        else { b = val; g = minc + (240 - hue) * (val - minc) / (hue - 120); }
      } else {
        g = minc;
        if (hue < 300) { b = val; r = minc + (hue - 240) * (val - minc) / (360 - hue); }
        else { r = val; b = minc + (360 - hue) * (val - minc) / (hue - 240); }
      }
      pal[i * 3] = r * 255; pal[i * 3 + 1] = g * 255; pal[i * 3 + 2] = b * 255;
    }
  }
  function textureFor(M, ti, top, bottom) {
    const t = M.textures[ti];
    const remap = t.remap;
    const k = remap ? `${ti}|${top}|${bottom}` : String(ti);
    let tex = M.glTex.get(k);
    if (tex !== undefined) return tex;
    const data = M.texData[ti];
    if (!data) { M.glTex.set(k, null); return null; }
    const w = t.w, h = t.h, n = w * h;
    const pal = new Uint8ClampedArray(data.subarray(n, n + 768));
    if (remap) { hueReplace(pal, top, remap[0], remap[1]); hueReplace(pal, bottom, remap[2], remap[3]); }
    const masked = (t.flags & NF_MASKED) !== 0;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = data[i], o = i * 4;
      px[o] = pal[c * 3]; px[o + 1] = pal[c * 3 + 1]; px[o + 2] = pal[c * 3 + 2];
      px[o + 3] = masked && c === 255 ? 0 : 255;
    }
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    M.glTex.set(k, tex);
    return tex;
  }

  // ---------------------------------------------------------------- animation math (HL's studio_util / renderer)
  const DEG = Math.PI / 180;
  function angleQuat(x, y, z, q, o) {
    const sr = Math.sin(x * 0.5), cr = Math.cos(x * 0.5), sp = Math.sin(y * 0.5), cp = Math.cos(y * 0.5);
    const sy = Math.sin(z * 0.5), cy = Math.cos(z * 0.5);
    q[o] = sr * cp * cy - cr * sp * sy;
    q[o + 1] = cr * sp * cy + sr * cp * sy;
    q[o + 2] = cr * cp * sy - sr * sp * cy;
    q[o + 3] = cr * cp * cy + sr * sp * sy;
  }
  /** QuaternionSlerp into out (may be p). */
  function slerp(p, po, q, qo, t, out, oo) {
    let a = 0, b = 0;
    for (let i = 0; i < 4; i++) { const d = p[po + i] - q[qo + i], e = p[po + i] + q[qo + i]; a += d * d; b += e * e; }
    let q0 = q[qo], q1 = q[qo + 1], q2 = q[qo + 2], q3 = q[qo + 3];
    if (a > b) { q0 = -q0; q1 = -q1; q2 = -q2; q3 = -q3; }
    const p0 = p[po], p1 = p[po + 1], p2 = p[po + 2], p3 = p[po + 3];
    const cosom = p0 * q0 + p1 * q1 + p2 * q2 + p3 * q3;
    if (1 + cosom > 1e-6) {
      let sp, sq;
      if (1 - cosom > 1e-6) { const om = Math.acos(cosom), so = Math.sin(om); sp = Math.sin((1 - t) * om) / so; sq = Math.sin(t * om) / so; }
      else { sp = 1 - t; sq = t; }
      out[oo] = sp * p0 + sq * q0; out[oo + 1] = sp * p1 + sq * q1; out[oo + 2] = sp * p2 + sq * q2; out[oo + 3] = sp * p3 + sq * q3;
    } else {
      const sp = Math.sin((1 - t) * 0.5 * Math.PI), sq = Math.sin(t * 0.5 * Math.PI);
      out[oo] = sp * p0 - sq * q1; out[oo + 1] = sp * p1 + sq * q0; out[oo + 2] = sp * p2 - sq * q3; out[oo + 3] = q2;
    }
  }

  /** StudioEstimateFrame: the frame from the networked frame byte, framerate and time since animtime. */
  function estimateFrame(M, si, frameByte, framerate, elapsed) {
    const sq = M.seqs[si];
    const nf = sq.frames;
    let f = nf <= 1 ? 0 : frameByte * (nf - 1) / 256;
    if (elapsed > 0) f += elapsed * framerate * sq.fps;
    if (sq.flags & STUDIO_LOOPING) {
      if (nf > 1) f -= Math.trunc(f / (nf - 1)) * (nf - 1);
      if (f < 0) f += nf - 1;
    } else {
      if (f >= nf - 1.001) f = nf - 1.001;
      if (f < 0) f = 0;
    }
    return f;
  }

  /** StudioCalcBoneAdj with every controller latched (no dadt blend): ctl[0..3] are bytes, the mouth is shut. */
  function boneAdj(M, ctl, adj) {
    const C = M.meta.controllers;
    for (let j = 0; j < C.length; j++) {
      const c = C[j], i = c.index;
      let v;
      if (i <= 3) {
        if (c.type & STUDIO_RLOOP) v = ctl[i] * (360 / 256) + c.start;
        else { const x = Math.min(1, Math.max(0, ctl[i] / 255)); v = (1 - x) * c.start + x * c.end; }
      } else v = c.start;
      adj[j] = (c.type & 0x7fff) >= 8 ? v * DEG : v;
    }
  }

  const a1 = new Float64Array(3), a2 = new Float64Array(3), qa = new Float64Array(4), qb = new Float64Array(4);
  /** StudioCalcRotations: bone positions and quaternions of sequence si, blend bl, at frame f. serverSide: the
      engine's SV_StudioSetupBones, which calls the per-bone functions directly (no frame wrap, motion bone kept). */
  function calcRotations(M, si, bl, f, adj, pos, q, serverSide) {
    const sq = M.seqs[si], nf = sq.frames, nb = M.nb;
    if (serverSide) { /* f is always inside the sequence there */ }
    else if (f > nf - 1) f = 0;
    else if (f < -0.01) f = -0.01;
    const frame = Math.trunc(f), s = f - frame;
    const A = M.anim[si];
    const blend = Math.min(bl, sq.blends - 1);
    const k0 = Math.min(Math.max(frame, 0), nf - 1), k1 = Math.min(k0 + 1, nf - 1);
    const o0 = (blend * nf + k0) * nb * 6, o1 = (blend * nf + k1) * nb * 6;
    const V = M.bValue, S = M.bScale, C = M.bCtl;
    for (let b = 0; b < nb; b++) {
      const bo = b * 6;
      let same = true;
      for (let j = 0; j < 3; j++) {
        const c = bo + 3 + j;
        let x = V[c], y = V[c];
        if (A) { x += A[o0 + c] * S[c]; y += A[o1 + c] * S[c]; }
        if (C[c] >= 0) { x += adj[C[c]]; y += adj[C[c]]; }
        a1[j] = x; a2[j] = y;
        if (x !== y) same = false;
      }
      if (same) angleQuat(a1[0], a1[1], a1[2], q, b * 4);
      else {
        angleQuat(a1[0], a1[1], a1[2], qa, 0);
        angleQuat(a2[0], a2[1], a2[2], qb, 0);
        slerp(qa, 0, qb, 0, s, q, b * 4);
      }
      for (let j = 0; j < 3; j++) {
        const c = bo + j;
        let v = V[c];
        if (A) v += (A[o0 + c] * (1 - s) + A[o1 + c] * s) * S[c];
        if (C[c] >= 0) v += adj[C[c]];
        pos[b * 3 + j] = v;
      }
    }
    const mb = sq.motionbone;
    if (!serverSide && mb >= 0 && mb < nb) {
      if (sq.motiontype & STUDIO_X) pos[mb * 3] = 0;
      if (sq.motiontype & STUDIO_Y) pos[mb * 3 + 1] = 0;
      if (sq.motiontype & STUDIO_Z) pos[mb * 3 + 2] = 0;
    }
  }
  /** StudioSlerpBones: q1/pos1 become q1/pos1 slerped s of the way to q2/pos2. */
  function slerpBones(nb, q1, pos1, q2, pos2, s) {
    s = Math.min(1, Math.max(0, s));
    const s1 = 1 - s;
    for (let i = 0; i < nb; i++) {
      slerp(q1, i * 4, q2, i * 4, s, q1, i * 4);
      pos1[i * 3] = pos1[i * 3] * s1 + pos2[i * 3] * s;
      pos1[i * 3 + 1] = pos1[i * 3 + 1] * s1 + pos2[i * 3 + 1] * s;
      pos1[i * 3 + 2] = pos1[i * 3 + 2] * s1 + pos2[i * 3 + 2] * s;
    }
  }

  /** AngleMatrix (pitch, yaw, roll in degrees) + origin, as a row-major 3x4. */
  function entityMatrix(origin, pitch, yaw, roll, m) {
    const y = yaw * DEG, p = pitch * DEG, r = roll * DEG;
    const sy = Math.sin(y), cy = Math.cos(y), sp = Math.sin(p), cp = Math.cos(p), sr = Math.sin(r), cr = Math.cos(r);
    m[0] = cp * cy; m[1] = sr * sp * cy - cr * sy; m[2] = cr * sp * cy + sr * sy; m[3] = origin[0];
    m[4] = cp * sy; m[5] = sr * sp * sy + cr * cy; m[6] = cr * sp * sy - sr * cy; m[7] = origin[1];
    m[8] = -sp; m[9] = sr * cp; m[10] = cr * cp; m[11] = origin[2];
    return m;
  }
  /** QuaternionMatrix + position, concatenated onto the parent (ConcatTransforms) into out at bone b. */
  function boneMatrix(q, pos, b, parent, po, out) {
    const x = q[b * 4], y = q[b * 4 + 1], z = q[b * 4 + 2], w = q[b * 4 + 3];
    const l00 = 1 - 2 * y * y - 2 * z * z, l01 = 2 * x * y - 2 * w * z, l02 = 2 * x * z + 2 * w * y;
    const l10 = 2 * x * y + 2 * w * z, l11 = 1 - 2 * x * x - 2 * z * z, l12 = 2 * y * z - 2 * w * x;
    const l20 = 2 * x * z - 2 * w * y, l21 = 2 * y * z + 2 * w * x, l22 = 1 - 2 * x * x - 2 * y * y;
    const tx = pos[b * 3], ty = pos[b * 3 + 1], tz = pos[b * 3 + 2];
    const o = b * 12;
    for (let r = 0; r < 3; r++) {
      const p0 = parent[po + r * 4], p1 = parent[po + r * 4 + 1], p2 = parent[po + r * 4 + 2], p3 = parent[po + r * 4 + 3];
      out[o + r * 4] = p0 * l00 + p1 * l10 + p2 * l20;
      out[o + r * 4 + 1] = p0 * l01 + p1 * l11 + p2 * l21;
      out[o + r * 4 + 2] = p0 * l02 + p1 * l12 + p2 * l22;
      out[o + r * 4 + 3] = p0 * tx + p1 * ty + p2 * tz + p3;
    }
  }

  // scratch poses
  const mk = (n) => new Float64Array(MAX_BONES * n);
  const pos1 = mk(3), q1 = mk(4), pos2 = mk(3), q2 = mk(4), pos3 = mk(3), q3 = mk(4), pos4 = mk(3), q4 = mk(4);
  const adj = new Float64Array(32), ctlBytes = new Float64Array(4);
  /** Storage for one posed player (posePlayer) and its weapon (poseMerged). */
  function newPose() {
    return { bones: new Float32Array(MAX_BONES * 12), entity: new Float64Array(12), seq: 0, frame: 0,
      weapon: new Float32Array(MAX_BONES * 12) };
  }

  /** Sequence si at frame f with blend (0-255): StudioCalcRotations of both blends + StudioSlerpBones. */
  function seqPose(M, si, f, blend, pos, q, tpos, tq) {
    calcRotations(M, si, 0, f, adj, pos, q);
    if (M.seqs[si].blends > 1) {
      calcRotations(M, si, 1, f, adj, tpos, tq);
      slerpBones(M.nb, q, pos, tq, tpos, blend / 255);
    }
  }

  /**
   * A player's bones as the TFC / HL client poses them. a = {
   *   origin, viewPitch (+ = down), viewYaw, roll (optional), seq, frameByte, framerate, elapsed (s since the frame byte was set),
   *   gait (gaitsequence, 0 = none), gaitYaw, gaitDist (distance walked, for the gait frame), time (for gaits with no
   *   ground speed), prev: null | { seq, frameByte, framerate, elapsed, s } (StudioSetupBones' blend from the last
   *   sequence, s = its weight) }
   * Writes 12 floats per bone into out.bones (Float32Array), the model's own transform into out.entity.
   */
  function posePlayer(M, a, pose) {
    const nb = M.nb, seqs = M.seqs, out = pose.bones;
    const si = a.seq < seqs.length ? a.seq : 0;
    const sq = seqs[si];
    let entPitch = -a.viewPitch / 3;          // entity_state angles[PITCH] of a player
    let yaw = a.viewYaw, blend = 0;
    const gait = a.gait > 0 && a.gait < seqs.length ? a.gait : 0;
    if (gait) {
      // StudioPlayerBlend: aim up/down by the sequence's blend, the rest by tilting the model
      let ib = Math.trunc(entPitch * 3);
      if (ib < sq.blendstart) { entPitch -= sq.blendstart / 3; ib = 0; }
      else if (ib > sq.blendend) { entPitch -= sq.blendend / 3; ib = 255; }
      else {
        ib = sq.blendend - sq.blendstart < 0.1 ? 127 : Math.trunc(255 * (ib - sq.blendstart) / (sq.blendend - sq.blendstart));
        entPitch = 0;
      }
      blend = ib;
      // StudioProcessGait: the legs face the way they move, the torso twists (bone controllers 0-3) to the view
      let gy = a.gaitYaw;
      let fy = yaw - gy;
      fy -= Math.trunc(fy / 360) * 360;
      if (fy < -180) fy += 360;
      if (fy > 180) fy -= 360;
      if (fy > 120) { gy -= 180; fy -= 180; } else if (fy < -120) { gy += 180; fy += 180; }
      const c = Math.trunc(((fy / 4) + 30) / (60 / 255)) & 255;
      ctlBytes[0] = ctlBytes[1] = ctlBytes[2] = ctlBytes[3] = c;
      yaw = gy;
    } else {
      ctlBytes[0] = ctlBytes[1] = ctlBytes[2] = ctlBytes[3] = 127;
    }
    boneAdj(M, ctlBytes, adj);

    const f = estimateFrame(M, si, a.frameByte, a.framerate, a.elapsed);
    seqPose(M, si, f, blend, pos1, q1, pos2, q2);
    const pv = a.prev;
    if (pv && pv.s > 0) {
      const ps = pv.seq < seqs.length ? pv.seq : 0;
      seqPose(M, ps, estimateFrame(M, ps, pv.frameByte, pv.framerate, pv.elapsed), blend, pos3, q3, pos4, q4);
      slerpBones(nb, q1, pos1, q3, pos3, pv.s);
    }
    if (gait) {
      const gs = seqs[gait];
      let gf = gs.linear[0] > 0 ? a.gaitDist / gs.linear[0] * gs.frames : a.time * gs.fps;
      gf -= Math.trunc(gf / gs.frames) * gs.frames;
      if (gf < 0) gf += gs.frames;
      calcRotations(M, gait, 0, gf, adj, pos2, q2);
      const G = M.gaitCopy;
      for (let i = 0; i < nb; i++) {
        if (!G[i]) continue;
        pos1[i * 3] = pos2[i * 3]; pos1[i * 3 + 1] = pos2[i * 3 + 1]; pos1[i * 3 + 2] = pos2[i * 3 + 2];
        q1[i * 4] = q2[i * 4]; q1[i * 4 + 1] = q2[i * 4 + 1]; q1[i * 4 + 2] = q2[i * 4 + 2]; q1[i * 4 + 3] = q2[i * 4 + 3];
      }
    }
    // StudioSetUpTransform: models pitch the other way round
    const E = pose.entity;
    entityMatrix(a.origin, -entPitch, yaw, a.roll || 0, E);
    for (let i = 0; i < nb; i++) {
      const par = M.parent[i];
      if (par < 0) boneMatrix(q1, pos1, i, E, 0, out);
      else boneMatrix(q1, pos1, i, out, par * 12, out);
    }
    pose.seq = si;
    pose.frame = f;
    return pose;
  }

  /**
   * The bones a player's hitboxes hang on, as the server poses them for a shot (rehlds r_studio.cpp:
   * SV_HullForStudioModel -> R_StudioPlayerBlend -> R_StudioHull -> SV_StudioSetupBones, used by HL and TFC, whose game
   * DLLs bring no blending interface of their own). Unlike the client's pose: the server's own model, no gait sequence
   * (the legs play the main sequence), no torso twist (controllers 0x7F), the frame as last set (no animtime
   * extrapolation), the aim blend from angles[0]. a = { origin, angles: [pitch, yaw, roll] (entity_state angles),
   * seq, frameByte }. Writes 12 floats per bone into out and returns it.
   */
  function poseServer(M, a, out) {
    const nb = M.nb, seqs = M.seqs;
    const si = a.seq >= 0 && a.seq < seqs.length ? a.seq : 0;
    const sq = seqs[si];
    let pitch = a.angles[0];
    let ib = Math.trunc(pitch * 3);
    if (ib < sq.blendstart) { ib = 0; pitch -= sq.blendstart / 3; }
    else if (ib <= sq.blendend) {
      const d = sq.blendend - sq.blendstart;
      ib = d >= 0.1 ? Math.trunc((ib - sq.blendstart) * 255 / d) : 127;
      pitch = 0;
    } else { ib = 255; pitch -= sq.blendend / 3; }
    ctlBytes[0] = ctlBytes[1] = ctlBytes[2] = ctlBytes[3] = 0x7f;
    boneAdj(M, ctlBytes, adj);
    const f = sq.frames > 1 ? (sq.frames - 1) * a.frameByte / 256 : 0;
    calcRotations(M, si, 0, f, adj, pos1, q1, true);
    if (sq.blends > 1) {
      calcRotations(M, si, 1, f, adj, pos2, q2, true);
      slerpBones(nb, q1, pos1, q2, pos2, ib / 255);
    }
    // R_StudioHull hands SV_StudioSetupBones the pitch negated, like the client's StudioSetUpTransform
    entityMatrix(a.origin, -pitch, a.angles[1], a.angles[2] || 0, ent);
    for (let i = 0; i < nb; i++) {
      const par = M.parent[i];
      if (par < 0) boneMatrix(q1, pos1, i, ent, 0, out);
      else boneMatrix(q1, pos1, i, out, par * 12, out);
    }
    return out;
  }
  const ent = new Float64Array(12);

  /** World corners of hitbox h (mstudiobbox_t: bone, group, min, max) under bones -> 24 floats (8 corners). */
  function hitboxCorners(h, bones, out) {
    const o = h.bone * 12;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? h.max[0] : h.min[0], y = k & 2 ? h.max[1] : h.min[1], z = k & 4 ? h.max[2] : h.min[2];
      for (let r = 0; r < 3; r++) out[k * 3 + r] = bones[o + r * 4] * x + bones[o + r * 4 + 1] * y + bones[o + r * 4 + 2] * z + bones[o + r * 4 + 3];
    }
    return out;
  }
  /** Distance along a ray (origin p, unit direction d) to where it enters hitbox h, or -1. The engine traces against
      the box grown by about half a unit (sv_clienttrace 1). */
  function rayHitbox(h, bones, p, d, maxDist) {
    const o = h.bone * 12;
    let t0 = 0, t1 = maxDist;
    for (let ax = 0; ax < 3; ax++) {
      // the bone's axis ax is column ax of its rotation
      const nx = bones[o + ax], ny = bones[o + 4 + ax], nz = bones[o + 8 + ax];
      const rel = (p[0] - bones[o + 3]) * nx + (p[1] - bones[o + 7]) * ny + (p[2] - bones[o + 11]) * nz;
      const dir = d[0] * nx + d[1] * ny + d[2] * nz;
      const lo = h.min[ax] - 0.5, hi = h.max[ax] + 0.5;
      if (Math.abs(dir) < 1e-9) { if (rel < lo || rel > hi) return -1; continue; }
      let a = (lo - rel) / dir, b = (hi - rel) / dir;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    return t0;
  }

  /**
   * Any other studio entity (rocket, grenade, sentry, flag, a first-person v_ model) the way StudioDrawModel poses it:
   * a = { origin, angles: [pitch, yaw, roll] (entity_state angles; studio models pitch the other way round), seq,
   * frameByte, framerate, elapsed (s since the frame byte was set), ctl: [4 controller bytes] }. Writes into out.
   */
  function poseEntity(M, a, out) {
    const nb = M.nb, seqs = M.seqs;
    const si = a.seq >= 0 && a.seq < seqs.length ? a.seq : 0;
    const c = a.ctl || [127, 127, 127, 127];
    ctlBytes[0] = c[0] ?? 127; ctlBytes[1] = c[1] ?? 127; ctlBytes[2] = c[2] ?? 127; ctlBytes[3] = c[3] ?? 127;
    boneAdj(M, ctlBytes, adj);
    const f = estimateFrame(M, si, a.frameByte || 0, a.framerate ?? 1, a.elapsed || 0);
    seqPose(M, si, f, 0, pos1, q1, pos2, q2);
    entityMatrix(a.origin, -(a.angles[0] || 0), a.angles[1] || 0, a.angles[2] || 0, ent);
    for (let i = 0; i < nb; i++) {
      const par = M.parent[i];
      if (par < 0) boneMatrix(q1, pos1, i, ent, 0, out);
      else boneMatrix(q1, pos1, i, out, par * 12, out);
    }
    return out;
  }
  /** Index of the first sequence whose name matches re (e.g. /shoot|fire|attack/), or -1. */
  function findSequence(M, re) { return M.seqs.findIndex(s => re.test(s.label || '')); }

  /** StudioSetupModel: which model of each body part pev->body picks (index = body / base % nummodels). */
  function drawsFor(M, body) {
    body = body | 0;
    if (!body) return M.draws;
    let d = (M.bodyDraws ||= new Map()).get(body);
    if (!d) {
      d = [];
      for (const bp of M.meta.bodyparts) {
        if (!bp.models.length) continue;
        const k = Math.floor(body / (bp.base || 1)) % bp.models.length;
        d.push(...bp.models[k].draws);
      }
      M.bodyDraws.set(body, d);
    }
    return d;
  }

  /** StudioMergeBones: the weapon (p_ model) takes the player's matrices for every bone of the same name. */
  /** W on the skeleton of M's pose (StudioMergeBones): bones named like M's take M's transforms, the rest are
      animated by W. A weapon (p_ model) uses the player's sequence at frame 0; a MOVETYPE_FOLLOW entity (a carried
      flag) passes its own a = { seq, frameByte, framerate, elapsed, origin, angles }, and its root bones that M doesn't
      have hang from its own origin and angles. */
  function poseMerged(W, M, pose, out, a) {
    const playerBones = pose.bones;
    let map = W.mergeMaps && W.mergeMaps.get(M.key);
    if (!map) {
      map = Int16Array.from(W.meta.bones.map(b => { const j = M.byName.get(b.name.toLowerCase()); return j === undefined ? -1 : j; }));
      (W.mergeMaps ||= new Map()).set(M.key, map);
    }
    let needOwn = false;
    for (let i = 0; i < W.nb; i++) if (map[i] < 0) { needOwn = true; break; }
    if (needOwn) {
      ctlBytes[0] = ctlBytes[1] = ctlBytes[2] = ctlBytes[3] = 127;
      boneAdj(W, ctlBytes, adj);
      const sq = a ? a.seq : pose.seq, si = sq >= 0 && sq < W.seqs.length ? sq : 0;
      const f = a ? estimateFrame(W, si, a.frameByte || 0, a.framerate ?? 1, a.elapsed || 0) : estimateFrame(W, si, 0, 0, 0);
      calcRotations(W, si, 0, f, adj, pos1, q1);
    }
    let root = pose.entity;
    if (needOwn && a && a.origin) {
      const an = a.angles || [0, 0, 0];
      entityMatrix(a.origin, -(an[0] || 0), an[1] || 0, an[2] || 0, ent);
      root = ent;
    }
    for (let i = 0; i < W.nb; i++) {
      const j = map[i];
      if (j >= 0) { for (let k = 0; k < 12; k++) out[i * 12 + k] = playerBones[j * 12 + k]; continue; }
      const par = W.parent[i];
      if (par < 0) boneMatrix(q1, pos1, i, root, 0, out);
      else boneMatrix(q1, pos1, i, out, par * 12, out);
    }
    return out;
  }

  // ---------------------------------------------------------------- drawing
  // uniform values already set in this pass (each WebGL call costs more than the drawing it sets up)
  const cur = {};
  function set1(name, v) { if (cur[name] !== v) { cur[name] = v; gl.uniform1f(P.u[name], v); } }
  /** Sets the program up for a pass. light = { ambient, shade } (0-1). */
  function begin(VP, camPos, camYaw, light) {
    gl.useProgram(P.p);
    for (const k in cur) delete cur[k];
    gl.uniformMatrix4fv(P.u.uVP, false, VP);
    gl.uniform3f(P.u.uCamPos, camPos[0], camPos[1], camPos[2]);
    const y = camYaw * DEG;
    gl.uniform3f(P.u.uCamRight, Math.sin(y), -Math.cos(y), 0);
    // light from above and a little in front, like a typical r_lightvec
    gl.uniform3f(P.u.uLightVec, 0.3, 0.2, -0.93);
    gl.uniform1f(P.u.uAmbient, light.ambient);
    gl.uniform1f(P.u.uShade, light.shade);
    gl.uniform1f(P.u.uAlpha, 1);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniform1i(P.u.uBoneTex, BONE_UNIT);
    gl.activeTexture(gl.TEXTURE0 + BONE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, boneTex);
    gl.activeTexture(gl.TEXTURE0);
  }
  /** Draws M with the matrices queued at row. o = { top, bottom } player colours, or { flat: [r, g, b, a] };
      o.shell = { color: [r, g, b] (0-1), amt } adds kRenderFxGlowShell's shell, pushed out renderamt * 0.05 units. */
  function draw(M, row, o) {
    if (row < 0) return;
    gl.bindVertexArray(M.vao);
    gl.uniform1i(P.u.uRow, row);
    const flat = o.flat;
    const fk = flat ? flat.join() : '';
    if (cur.flat !== fk) { cur.flat = fk; gl.uniform4f(P.u.uFlat, flat ? flat[0] : 0, flat ? flat[1] : 0, flat ? flat[2] : 0, flat ? flat[3] : 0); }
    // o.skin: skin family (pev->skin), o.body: body group value (pev->body)
    const skin = M.skins[o.skin | 0] || M.skins[0] || [];
    for (const [ref, first, count] of drawsFor(M, o.body)) {
      const ti = ref >= 0 && ref < skin.length ? skin[ref] : ref;
      const t = M.textures[ti];
      const fl = t ? t.flags : 0;
      const additive = !flat && (fl & NF_ADDITIVE);
      if (!flat) {
        const tex = t ? textureFor(M, ti, o.top | 0, o.bottom | 0) : null;
        if (!tex) continue;
        if (cur.tex !== tex) { cur.tex = tex; gl.bindTexture(gl.TEXTURE_2D, tex); }
        if (cur.tw !== t.w || cur.th !== t.h) { cur.tw = t.w; cur.th = t.h; gl.uniform2f(P.u.uTexSize, t.w, t.h); }
        set1('uChrome', fl & NF_CHROME ? 1 : 0);
        set1('uFlatShade', fl & NF_FLATSHADE ? 1 : 0);
        set1('uFull', fl & (NF_FULLBRIGHT | NF_ADDITIVE) ? 1 : 0);
        set1('uMasked', fl & NF_MASKED ? 1 : 0);
      } else {
        set1('uChrome', 0);
      }
      if (additive) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false); }
      gl.drawElements(gl.TRIANGLES, count, M.idxType, first * M.idxSize);
      if (additive) { gl.disable(gl.BLEND); gl.depthMask(true); }
    }
    if (o.shell && !flat) {
      const c = o.shell.color;
      gl.uniform1f(P.u.uShell, Math.max(0.5, (o.shell.amt || 0) * 0.05));
      gl.uniform3f(P.u.uShellColor, c[0], c[1], c[2]);
      gl.uniform1f(P.u.uShellTime, o.shell.time || 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false);
      for (const [, first, count] of drawsFor(M, o.body)) gl.drawElements(gl.TRIANGLES, count, M.idxType, first * M.idxSize);
      gl.disable(gl.BLEND); gl.depthMask(true);
      gl.uniform1f(P.u.uShell, 0);
    }
  }

  return { init, available, load, get, status, busy, newPose, posePlayer, poseMerged, poseServer, poseEntity, findSequence, hitboxCorners, rayHitbox,
    beginBones, addBones, flushBones, begin, draw };
})();
