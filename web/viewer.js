'use strict';
/* HLTV demo viewer front end: a WebGL2 replay of a decoded GoldSrc demo on its BSP map.
   Data comes from demo_viewer.py:
     /api/demo/<id>/meta   JSON: players, kills, chat, shots, model/event names, buffer layout
     /api/demo/<id>/data   binary: frame times, per-slot tracks (x y z pitch yaw + info word), object keyframes
     /api/map/<game>/<map> binary: triangles, textures, lightmap atlas, hull-0 BSP tree for line-of-sight tests
   GoldSrc axes are used throughout: X forward, Y left, Z up; pitch > 0 looks down. */

const $ = (s, el = document) => el.querySelector(s);
const DEG = Math.PI / 180;
const PF_PRESENT = 1, PF_DUCKED = 2, PF_DEAD = 4, PF_NODRAW = 8, PF_OBSERVER = 16;
const TEAM_RGB = { 0: [0.66, 0.68, 0.73], 1: [0.31, 0.56, 0.98], 2: [0.95, 0.32, 0.31], 3: [0.97, 0.78, 0.2], 4: [0.26, 0.81, 0.44] };
const CONTENTS_SOLID = -2, CONTENTS_SKY = -6;
const OBJ_STRIDE = 24;      // see demo_viewer.OBJ_COLUMNS
const FX_DEAD_PLAYER = 17;                 // kRenderFxDeadPlayer: a corpse, drawn as the player in slot renderamt
const FX_GLOW_SHELL = 19;                  // kRenderFxGlowShell: a shell in rendercolor around the model (TFC goal items)
const MOVETYPE_FOLLOW = 12;
// weapon event scripts (events/wpn/tf_*.sc in TFC, events/*.sc in HL / CS) that are not a shot, that fire a projectile,
// and that are melee (a 64-unit trace)
const EV_NOT_FIRE = /(reload|pump|spin|decal|sniperhit|medsteam|_ac(wu|wd|start)\.|building|\/explode\/|\/door\/|gibs|\/misc\/|train)/i;
const EV_PROJECTILE = /(nail|rpg|rocket|_ic\.|flame|tranq|rail|_gl\.|pipel|gren|egon|gauss|crossbow|hornet|snark|satchel|tripmine)/i;
const EV_MELEE = /(axe|knife|crowbar|mednormal|medsuper|spanner|wrench)/i;
// studio hit groups (mstudiobbox_t.group): name, colour
const HITGROUPS = {
  0: ['body', [0.85, 0.85, 0.85]], 1: ['head', [1, 0.15, 0.15]], 2: ['chest', [1, 0.6, 0.15]], 3: ['stomach', [1, 0.9, 0.25]],
  4: ['left arm', [0.35, 0.9, 0.4]], 5: ['right arm', [0.2, 0.8, 0.75]], 6: ['left leg', [0.4, 0.6, 1]], 7: ['right leg', [0.65, 0.5, 1]],
};
function hitgroup(g) { return HITGROUPS[g] || HITGROUPS[0]; }
const VIEW_FOVY = 73.74 * DEG;            // HL's fov 90 at 4:3, kept for any aspect like the 2013+ engine

// ------------------------------------------------------------------ preferences
const DEFAULT_PREFS = { xray: true, aim: true, names: true, hitboxes: false, unlag: true, speed: 1, mode: 'chase', bright: 1.0, volume: 0.7, muted: false,
  pipCorner: 'br', pipSize: 0.3 };
const prefs = (() => {
  try { return Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem('hltvviewer.prefs') || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_PREFS); }
})();
function savePrefs() { try { localStorage.setItem('hltvviewer.prefs', JSON.stringify(prefs)); } catch (e) { /* private window */ } }

// ------------------------------------------------------------------ app state
const S = {
  id: null, meta: null, D: null, map: null, maps: {}, mapErrors: {}, shownLevel: null,
  t: 0, fi: 0, playing: false, dir: 1, speed: prefs.speed,
  mode: prefs.mode, sel: 0,
  cam: { pos: [0, 0, 0], pitch: 20, yaw: 0, fov: 90 },
  orbit: { pitch: 18, yaw: 0, dist: 170, manual: false },
  top: { x: 0, y: 0, h: 2600 },
  keys: {}, drag: null, scrub: false, wasPlaying: false,
  analysis: null, marks: [], lastPanel: 0, labelsFor: [],
};

// ------------------------------------------------------------------ small math
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulv = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = a => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, f) => a + (b - a) * f;
function lerpAngle(a, b, f) { const d = ((b - a) % 360 + 540) % 360 - 180; return a + d * f; }
function forward(pitch, yaw) {
  const p = pitch * DEG, y = yaw * DEG, cp = Math.cos(p);
  return [cp * Math.cos(y), cp * Math.sin(y), -Math.sin(p)];
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  persp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f);
    return m;
  },
  view(pos, pitch, yaw) {
    const f = forward(pitch, yaw), y = yaw * DEG, r = [Math.sin(y), -Math.cos(y), 0], u = cross(r, f);
    return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0,
      -dot(r, pos), -dot(u, pos), dot(f, pos), 1]);
  },
  translate(x, y, z) { const m = M4.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
  scale(x, y, z) { const m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; },
  rotZ(d) { const c = Math.cos(d * DEG), s = Math.sin(d * DEG), m = M4.ident(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  rotY(d) { const c = Math.cos(d * DEG), s = Math.sin(d * DEG), m = M4.ident(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
  rotX(d) { const c = Math.cos(d * DEG), s = Math.sin(d * DEG), m = M4.ident(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
  // GoldSrc R_RotateForEntity: translate, yaw about Z, -pitch about Y, roll about X
  entity(o, a) { return M4.mul(M4.mul(M4.mul(M4.translate(o[0], o[1], o[2]), M4.rotZ(a[1])), M4.rotY(-a[0])), M4.rotX(a[2])); },
};
function project(VP, p, w, h) {
  const x = VP[0] * p[0] + VP[4] * p[1] + VP[8] * p[2] + VP[12];
  const y = VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13];
  const ww = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15];
  if (ww <= 1) return null;
  return [(x / ww * 0.5 + 0.5) * w, (1 - (y / ww * 0.5 + 0.5)) * h, ww];
}

// ------------------------------------------------------------------ formatting
function fmtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rgbCss(c, a = 1) { return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`; }
function wallStart() {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)_/.exec(S.meta?.file || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
function wallAt(t) {
  const w = wallStart();
  if (!w) return '';
  const d = new Date(w.getTime() + (t - S.meta.start) * 1000);
  return d.toTimeString().slice(0, 8);
}

// ------------------------------------------------------------------ WebGL setup
const canvas = $('#gl');
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

let PW, PF, PL, meshes = {}, lineBuf, lineVao, checkerTex, whiteLm;
function initGL() {
  PW = program(`#version 300 es
    layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in vec2 aLUV;
    uniform mat4 uVP; uniform mat4 uModel;
    out vec2 vUV; out vec2 vLUV;
    void main(){ gl_Position = uVP * (uModel * vec4(aPos, 1.0)); vUV = aUV; vLUV = aLUV; }`,
  `#version 300 es
    precision highp float;
    in vec2 vUV; in vec2 vLUV;
    uniform sampler2D uTex; uniform sampler2D uLM;
    uniform float uAlpha; uniform float uAlphaTest; uniform float uBright; uniform float uFull;
    out vec4 o;
    void main(){
      vec4 c = texture(uTex, vUV);
      if (uAlphaTest > 0.5 && c.a < 0.5) discard;
      vec3 l = texture(uLM, vLUV).rgb;
      l = mix(pow(l, vec3(0.62)) * 1.25 * uBright, vec3(1.0), uFull);
      o = vec4(min(c.rgb * l, vec3(1.0)), uAlpha * (uAlphaTest > 0.5 ? 1.0 : c.a));
    }`);
  PF = program(`#version 300 es
    layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;
    uniform mat4 uVP; uniform mat4 uModel;
    out vec3 vN;
    void main(){ gl_Position = uVP * (uModel * vec4(aPos, 1.0)); vN = mat3(uModel) * aNor; }`,
  `#version 300 es
    precision highp float;
    in vec3 vN; uniform vec4 uColor; uniform float uShade;
    out vec4 o;
    void main(){
      vec3 n = normalize(vN);
      float l = mix(1.0, 0.5 + 0.5 * max(dot(n, normalize(vec3(0.35, 0.25, 0.9))), 0.0) + 0.12 * abs(n.x), uShade);
      o = vec4(uColor.rgb * l, uColor.a);
    }`);
  // uPull moves points that many units towards the eye before the depth test (same spot on screen): wireframes inside
  // a body stay visible, walls still hide them
  PL = program(`#version 300 es
    layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol;
    uniform mat4 uVP; uniform vec3 uCam; uniform float uPull; out vec4 vC;
    void main(){
      vec3 p = aPos;
      if (uPull > 0.0) { vec3 d = p - uCam; float L = max(length(d), 0.001); p = uCam + d * max(0.02, (L - uPull) / L); }
      gl_Position = uVP * vec4(p, 1.0); vC = aCol;
    }`,
  `#version 300 es
    precision highp float; in vec4 vC; uniform float uAlpha; out vec4 o; void main(){ o = vec4(vC.rgb, vC.a * uAlpha); }`);

  // a simple mannequin in the player hull (origin = hull centre, standing hull -36..36, eye at +28)
  meshes.body = boxMesh([
    [-4, -8, -36, 4, -1.5, -4], [-4, 1.5, -36, 4, 8, -4],          // legs
    [-6, -10, -5, 6, 10, 20],                                          // torso
    [-3.5, -14, -3, 3.5, -10, 18], [-3.5, 10, -3, 3.5, 14, 18],        // arms
    [-5.5, -5.5, 20, 6, 5.5, 33],                                      // head
    [5, -3, 26, 7, 3, 30],                                             // face marker (which way they face)
  ]);
  meshes.gun = boxMesh([[0, -1.6, -1.6, 24, 1.6, 1.6]]);
  Studio.init(gl, program);
  meshes.cube = boxMesh([[-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]]);
  meshes.ring = boxMesh([[-21, -21, -0.5, 21, -18, 0.5], [-21, 18, -0.5, 21, 21, 0.5], [-21, -18, -0.5, -18, 18, 0.5], [18, -18, -0.5, 21, 18, 0.5]]);

  lineVao = gl.createVertexArray();
  lineBuf = gl.createBuffer();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  gl.bindVertexArray(null);

  checkerTex = makeTex(8, 8, (() => {
    const d = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const on = (x >> 2 ^ y >> 2) & 1, o = (y * 8 + x) * 4;
      d[o] = on ? 160 : 90; d[o + 1] = on ? 160 : 90; d[o + 2] = on ? 170 : 100; d[o + 3] = 255;
    }
    return d;
  })(), true);
  whiteLm = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, whiteLm);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255]));
}

function boxMesh(parts) {
  const pos = [], nor = [], idx = [];
  for (const [x0, y0, z0, x1, y1, z1] of parts) {
    const faces = [
      [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
      [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
      [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]],
    ];
    for (const [n, q] of faces) {
      const b = pos.length / 3;
      for (const v of q) { pos.push(...v); nor.push(...n); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nor), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

function makeTex(w, h, data, nearest) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext && !nearest) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}

// ------------------------------------------------------------------ loading
async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function showLoading(title, frac, text) {
  $('#loading').classList.remove('hidden');
  $('#loadTitle').textContent = title;
  $('#loadBar').style.width = `${Math.round((frac || 0) * 100)}%`;
  $('#loadText').textContent = text || '';
}
function hideLoading() { $('#loading').classList.add('hidden'); }

async function loadMap(game, name) {
  const r = await fetch(`/api/map/${encodeURIComponent(game)}/${encodeURIComponent(name)}`);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'map not found'); }
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x504d5347) throw new Error('bad map data');
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  const body = (8 + jl + 3) & ~3;
  const B = (n, T) => { const [o, l] = meta.buffers[n]; return new T(buf, body + o, l / T.BYTES_PER_ELEMENT); };
  const M = { meta, planes: B('planes', Float32Array), nodes: B('nodes', Int32Array), leaves: B('leaves', Int32Array) };

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const attr = (loc, data, size) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attr(0, B('positions', Float32Array), 3);
  attr(1, B('uvs', Float32Array), 2);
  attr(2, B('luvs', Float32Array), 2);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, B('indices', Uint32Array), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  M.vao = vao;

  M.tex = meta.textures.map(t => t.data >= 0 ? makeTex(t.w, t.h, B('tex' + t.data, Uint8Array), false) : null);
  const lm = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lm);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, meta.atlas[0], meta.atlas[1], 0, gl.RGB, gl.UNSIGNED_BYTE, B('lightmap', Uint8Array));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  M.lm = lm;
  // split each model's draws into opaque / alpha-tested / water
  for (const m of meta.models) {
    m.opaque = []; m.alpha = []; m.water = [];
    for (const d of m.draws) {
      const t = meta.textures[d[0]];
      (t.water ? m.water : t.alpha ? m.alpha : m.opaque).push(d);
    }
  }
  return M;
}

async function openDemo(id) {
  try {
    $('#picker').classList.add('hidden');
    showLoading('Decoding demo…', 0, 'The first time a demo is opened it is decoded and cached; long demos take a little while.');
    for (;;) {
      const r = await fetchJSON(`/api/demo/${id}/open`);
      if (r.state === 'ready') break;
      if (r.state === 'error') throw new Error(r.error);
      showLoading('Decoding demo…', r.progress * 0.9, `${Math.round(r.progress * 100)}%`);
      await sleep(350);
    }
    const meta = await fetchJSON(`/api/demo/${id}/meta`);
    const buf = await (await fetch(`/api/demo/${id}/data`)).arrayBuffer();
    S.D = buildData(meta, buf);
    S.meta = meta;
    S.id = id;
    S.maps = {};
    S.mapErrors = {};
    for (const name of [...new Set(meta.levels.map(l => l.map))]) {
      showLoading(`Loading map ${name}…`, 0.95, '');
      try { S.maps[name] = await loadMap(meta.game, name); } catch (e) { S.maps[name] = null; S.mapErrors[name] = e.message; }
    }
    S.map = mapForFrame(0);
    await preloadModels();
    const fx = FX.build(meta, S.D);
    GameAudio.setGame(meta.game);
    GameAudio.preload([...fx.sounds]);
    preloadObjectModels();
    S.audioT = null;
    hideLoading();
    startDemo();
    try { history.replaceState(null, '', '#demo=' + id); } catch (e) { /* ignore */ }
  } catch (e) {
    hideLoading();
    alert('Could not open the demo:\n' + e.message);
    showPicker();
  }
}

function buildData(meta, buf) {
  const L = meta.buffers;
  const F = n => new Float32Array(buf, L[n][0], L[n][1] / 4);
  const U = n => new Uint32Array(buf, L[n][0], L[n][1] / 4);
  const D = { n: meta.frames, times: F('times'), pos: {}, info: {}, anim: {}, gait: {}, slots: meta.slots, objs: F('objs') };
  for (const s of meta.slots) { D.pos[s] = F('pos' + s); D.info[s] = U('info' + s); D.anim[s] = L['anim' + s] ? U('anim' + s) : null; }
  D.objByEnt = new Map();
  const tmp = new Map();
  for (let r = 0, n = D.objs.length / OBJ_STRIDE; r < n; r++) {
    const e = D.objs[r * OBJ_STRIDE + 1];
    let a = tmp.get(e); if (!a) tmp.set(e, a = []);
    a.push(r);
  }
  for (const [e, a] of tmp) D.objByEnt.set(e, Int32Array.from(a));
  D.byEnt = {};
  for (const p of meta.players) (D.byEnt[p.ent] ||= []).push(p);
  for (const k in D.byEnt) D.byEnt[k].sort((a, b) => a.first - b.first);
  // shots: weapon events that are a weapon going off (not pumps, reloads...); traceShots: the ones whose damage is a trace
  // from the eye (bullets, melee) and so hits the hitboxes, with the trace's length
  D.shotsBy = new Map();
  D.traceShots = [];
  D.traceBy = new Map();
  for (const [t, e, idx] of meta.shots) {
    const name = (meta.events && meta.events[idx]) || '';
    if (name && EV_NOT_FIRE.test(name)) continue;
    let a = D.shotsBy.get(e); if (!a) D.shotsBy.set(e, a = []); a.push(t);
    if (!name || EV_PROJECTILE.test(name)) continue;
    let b = D.traceBy.get(e); if (!b) D.traceBy.set(e, b = []); b.push(D.traceShots.length);
    D.traceShots.push({ t, s: e, range: EV_MELEE.test(name) ? 64 : 8192, weapon: name.replace(/^.*\/|\.sc$/g, '') });
  }
  D.buf = buf;
  return D;
}

// ------------------------------------------------------------------ demo queries
function frameAt(t) {
  const T = S.D.times, n = S.D.n;
  if (!n) return [0, 0];
  if (t <= T[0]) return [0, 0];
  if (t >= T[n - 1]) return [n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const dt = T[lo + 1] - T[lo];
  return [lo, dt > 0 ? (t - T[lo]) / dt : 0];
}

function playerState(s, i, f) {
  const D = S.D, P = D.pos[s], I = D.info[s];
  if (!I) return null;                       // a slot that never shows up as a player (e.g. a corpse's renderamt)
  const a = I[i];
  if (!(a & PF_PRESENT)) return null;
  let x = P[i * 5], y = P[i * 5 + 1], z = P[i * 5 + 2], pitch = P[i * 5 + 3], yaw = P[i * 5 + 4];
  if (f > 0 && i + 1 < D.n && (I[i + 1] & PF_PRESENT)) {
    const j = (i + 1) * 5, x2 = P[j], y2 = P[j + 1], z2 = P[j + 2];
    if (Math.abs(x2 - x) + Math.abs(y2 - y) + Math.abs(z2 - z) < 300) {
      x = lerp(x, x2, f); y = lerp(y, y2, f); z = lerp(z, z2, f);
      pitch = lerp(pitch, P[j + 3], f); yaw = lerpAngle(yaw, P[j + 4], f);
    }
  }
  const flags = a & 31;
  return { s, x, y, z, pitch, yaw, flags, team: (a >> 5) & 7, cls: (a >> 8) & 15, wm: (a >> 12) & 1023, seq: (a >> 22) & 255,
    ducked: !!(flags & PF_DUCKED), dead: !!(flags & PF_DEAD), hidden: !!(flags & (PF_NODRAW | PF_OBSERVER)) };
}
function alive(p) { return p && !p.dead && !p.hidden; }
function eyeOf(p) { return [p.x, p.y, p.z + (p.dead ? -8 : p.ducked ? 12 : 28)]; }
function chestOf(p) { return [p.x, p.y, p.z + (p.ducked ? 4 : 10)]; }
function headOf(p) { return [p.x, p.y, p.z + (p.ducked ? 13 : 27)]; }
function feetOf(p) { return [p.x, p.y, p.z + (p.ducked ? -10 : -24)]; }

function who(ent, t) {
  const list = S.D.byEnt[ent];
  if (!list) return null;
  let best = list[0];
  for (const p of list) if (p.first <= t + 0.5) best = p;
  return best;
}
/** Health and armor of slot s at time t: { hp, ap }, or null when the demo doesn't have them. The game sends them only
    to the player they belong to, so a client demo has the recording player's, and an HLTV demo has everyone's only
    when the server ran the hltv_vitals plugin (meta.vitals: { "<slot>": { health: [[t, hp]], armor: [[t, ap]] } }). */
function vitalsAt(s, t) {
  const V = S.meta && S.meta.vitals && S.meta.vitals[s];
  if (!V) return null;
  const last = L => {
    let lo = 0, hi = L.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (L[m][0] <= t) lo = m + 1; else hi = m; }
    return lo ? L[lo - 1][1] : null;
  };
  const hp = last(V.health), ap = last(V.armor || []);
  return hp == null && ap == null ? null : { hp: hp ?? 0, ap: ap ?? 0 };
}
function nameOf(ent, t) { const p = who(ent, t); return p ? p.name : (ent === 0 ? 'world' : `#${ent}`); }
function victimName(k) { return k[2] > S.meta.maxclients ? `a ${k[3]}` : nameOf(k[2], k[0]); }
function className(c) { return (S.meta.classes && S.meta.classes[c]) || ''; }
function teamName(n) { return (S.meta.teams && S.meta.teams[n]) || (n ? `Team ${n}` : ''); }
function enemies(a, b) { return a.s !== b.s && (!a.team || !b.team || a.team !== b.team); }
function weaponName(wm) {
  const m = levelForFrame(S.fi).models[wm] || '';
  if (!m.endsWith('.mdl')) return '';
  return m.replace(/^.*\//, '').replace(/\.mdl$/, '').replace(/^[pv]_(tfc_)?/, '');
}

function playersAt(i, f) {
  const out = [];
  for (const s of S.D.slots) { const p = playerState(s, i, f); if (p) out.push(p); }
  return out;
}

/** The level (map) a frame belongs to: client demos can span map changes, HLTV demos are one map each. */
function levelForFrame(i) {
  const L = S.meta.levels;
  for (let k = L.length - 1; k > 0; k--) if (L[k].frame <= i) return L[k];
  return L[0];
}
function mapForFrame(i) { return S.maps[levelForFrame(i).map] || null; }

function rowFrame(r) { return S.D.objs[r * OBJ_STRIDE]; }
function lastRow(rows, i) {
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rowFrame(rows[m]) <= i) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
}
function objectsAt(i, f) {
  const D = S.D, O = D.objs, out = [], models = levelForFrame(i).models;
  for (const [ent, rows] of D.objByEnt) {
    const k = lastRow(rows, i);
    if (k < 0) continue;
    const o = rows[k] * OBJ_STRIDE;
    const mi = O[o + 2];
    if (mi < 0) continue;
    let x = O[o + 3], y = O[o + 4], z = O[o + 5], a0 = O[o + 6], a1 = O[o + 7], a2 = O[o + 8];
    const fl = O[o + 9], fx = (fl >> 4) & 255;
    // the client never interpolates corpses (StudioDrawModel turns m_fDoInterp off for kRenderFxDeadPlayer)
    if (f > 0 && fx !== FX_DEAD_PLAYER && k + 1 < rows.length && rowFrame(rows[k + 1]) === i + 1) {
      const q = rows[k + 1] * OBJ_STRIDE;
      if (O[q + 2] === mi) {
        x = lerp(x, O[q + 3], f); y = lerp(y, O[q + 4], f); z = lerp(z, O[q + 5], f);
        a0 = lerpAngle(a0, O[q + 6], f); a1 = lerpAngle(a1, O[q + 7], f); a2 = lerpAngle(a2, O[q + 8], f);
      }
    }
    // MOVETYPE_FOLLOW (a carried flag): the client moves it to its aiment's origin (CL_MoveAiments; the angles stay the
    // ones the server copied from the aiment) and a studio model is merged onto that entity's skeleton
    const aiment = O[o + 21] === MOVETYPE_FOLLOW ? O[o + 22] : 0;
    if (aiment > 0 && aiment <= S.meta.maxclients) {
      const p = playerState(aiment, i, f);
      if (!p || p.hidden) continue;
      x = p.x; y = p.y; z = p.z;
    }
    const rgb = O[o + 23];
    out.push({ ent, mi, model: models[mi] || '', o: [x, y, z], a: [a0, a1, a2], nodraw: (fl & 1) === 1, rmode: (fl >> 1) & 7,
      fx, amt: O[o + 10], team: O[o + 11], body: O[o + 12], skin: O[o + 13], solid: O[o + 14], seq: O[o + 15], frame: O[o + 16],
      ctl: [O[o + 17], O[o + 18], 127, 127], framerate: O[o + 19], colormap: O[o + 20], since: S.D.times[rowFrame(rows[k])],
      aiment, color: [(rgb & 255) / 255, ((rgb >> 8) & 255) / 255, ((rgb >> 16) & 255) / 255] });
  }
  return out;
}

// ------------------------------------------------------------------ line of sight (hull 0)
function traceTree(M, node, p1, p2, f1, f2) {
  const N = M.nodes, P = M.planes;
  while (node >= 0) {
    const pl = N[node * 3] * 4;
    const nx = P[pl], ny = P[pl + 1], nz = P[pl + 2], d = P[pl + 3];
    const t1 = nx * p1[0] + ny * p1[1] + nz * p1[2] - d;
    const t2 = nx * p2[0] + ny * p2[1] + nz * p2[2] - d;
    if (t1 >= 0 && t2 >= 0) { node = N[node * 3 + 1]; continue; }
    if (t1 < 0 && t2 < 0) { node = N[node * 3 + 2]; continue; }
    const side = t1 < 0 ? 1 : 0;
    const frac = t1 / (t1 - t2);
    const mid = [p1[0] + (p2[0] - p1[0]) * frac, p1[1] + (p2[1] - p1[1]) * frac, p1[2] + (p2[2] - p1[2]) * frac];
    const fm = f1 + (f2 - f1) * frac;
    const r = traceTree(M, N[node * 3 + 1 + side], p1, mid, f1, fm);
    if (r >= 0) return r;
    return traceTree(M, N[node * 3 + 2 - side], mid, p2, fm, f2);
  }
  const c = M.leaves[-node - 1];
  return (c === CONTENTS_SOLID || c === CONTENTS_SKY) ? f1 : -1;
}

// solid brush entities (doors, walls) at a frame, cached per frame
let blockCache = { fi: -1, list: [] };
function blockersAt(i) {
  if (blockCache.fi === i) return blockCache.list;
  const list = [];
  const M = mapForFrame(i);
  if (M) {
    for (const o of objectsAt(i, 0)) {
      if (o.model[0] !== '*' || o.nodraw || o.solid !== 4) continue;
      if (o.rmode !== 0) continue;        // glass, grates and fences (alpha-tested '{' textures) can be seen through
      const m = M.meta.models[parseInt(o.model.slice(1))];
      if (!m) continue;
      list.push({ m, o: o.o, a: o.a, rot: Math.abs(o.a[0]) + Math.abs(o.a[1]) + Math.abs(o.a[2]) > 0.01 });
    }
  }
  blockCache = { fi: i, list };
  return list;
}
function toEntity(b, p) {
  let v = sub(p, b.o);
  if (!b.rot) return v;
  // inverse of Rz(yaw) Ry(-pitch) Rx(roll)
  const inv = M4.mul(M4.mul(M4.rotX(-b.a[2]), M4.rotY(b.a[0])), M4.rotZ(-b.a[1]));
  return [inv[0] * v[0] + inv[4] * v[1] + inv[8] * v[2], inv[1] * v[0] + inv[5] * v[1] + inv[9] * v[2], inv[2] * v[0] + inv[6] * v[1] + inv[10] * v[2]];
}
/** Fraction (0..1) along p1->p2 where the first solid is hit, or -1 when clear. */
function traceLine(p1, p2, i) {
  const M = mapForFrame(i);
  if (!M) return -1;
  let best = traceTree(M, M.meta.models[0].headnode, p1, p2, 0, 1);
  const lo = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.min(p1[2], p2[2])];
  const hi = [Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1]), Math.max(p1[2], p2[2])];
  for (const b of blockersAt(i)) {
    const r = b.rot ? 9999 : 0;
    const mn = b.m.mins, mx = b.m.maxs;
    if (hi[0] < mn[0] + b.o[0] - r || lo[0] > mx[0] + b.o[0] + r || hi[1] < mn[1] + b.o[1] - r || lo[1] > mx[1] + b.o[1] + r ||
        hi[2] < mn[2] + b.o[2] - r || lo[2] > mx[2] + b.o[2] + r) continue;
    const f = traceTree(M, b.m.headnode, toEntity(b, p1), toEntity(b, p2), 0, 1);
    if (f >= 0 && (best < 0 || f < best)) best = f;
  }
  return best;
}
function canSee(eye, target, i) {
  for (const p of [chestOf(target), headOf(target), feetOf(target)]) {
    const f = traceLine(eye, p, i);
    if (f < 0 || f > 0.995) return true;
  }
  return false;
}

// ------------------------------------------------------------------ camera
function selectedState(players) { return players.find(p => p.s === S.sel) || null; }

function cameraFor(players) {
  const pov = selectedState(players);
  if (S.mode === 'eye' && pov && !pov.hidden) {
    return { pos: eyeOf(pov), pitch: pov.pitch, yaw: pov.yaw, pov };
  }
  if ((S.mode === 'chase' || S.mode === 'eye') && pov) {
    const o = S.orbit;
    const yaw = o.manual ? o.yaw : pov.yaw;
    const target = [pov.x, pov.y, pov.z + (pov.ducked ? 10 : 22)];
    let pos = sub(target, mulv(forward(o.pitch, yaw), o.dist));
    const f = traceLine(target, pos, S.fi);
    if (f >= 0) pos = addv(target, mulv(sub(pos, target), Math.max(0.05, f - 8 / o.dist)));
    return { pos, pitch: o.pitch, yaw, pov: null };
  }
  if (S.mode === 'top') return { pos: [S.top.x, S.top.y, S.top.h], pitch: 89.9, yaw: 90, pov: null };
  return { pos: S.cam.pos.slice(), pitch: S.cam.pitch, yaw: S.cam.yaw, pov: null, fov: S.cam.fov || 90 };
}

// ------------------------------------------------------------------ render
let lastCam = null;
function render() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rs = S.renderSize;                    // video export: render at the video's size
  const w = rs ? rs[0] : Math.max(1, Math.round(canvas.clientWidth * dpr)), h = rs ? rs[1] : Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.32, 0.4, 0.5, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!S.D) return;

  const [i, f] = frameAt(S.t);
  S.fi = i;
  S.map = mapForFrame(i);
  noteLevel(levelForFrame(i));
  const players = playersAt(i, f);
  const cam = Editor.camera() || cameraFor(players);
  lastCam = cam;
  // picture in picture: the edit's inset while previewing or exporting, else the one picked in the viewer
  const pipSpec = Editor.active() ? Editor.pip() : (rs ? null : S.pip);
  const pipCam = pipSpec ? pipCamera(pipSpec, players, cam) : null;
  const P = M4.persp(fovY(cam.fov), w / h, 4, 16384);
  const VP = M4.mul(P, M4.view(cam.pos, cam.pitch, cam.yaw));
  S.lastVP = VP;
  const objs = objectsAt(i, f);
  const poses = posePlayers(players, i, f, objs, pipCam);
  const aimInfo = drawScene(VP, cam, players, poses, objs, i, w / h, poses.view);
  S.pipRect = null; S.pipShown = null;
  if (pipCam) {
    const lay = Editor.active() ? Editor.pipLayout() : { corner: prefs.pipCorner, size: prefs.pipSize };
    const r = pipRect(w, h, lay.corner, lay.size);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
    gl.viewport(r.x, r.y, r.w, r.h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const VP2 = M4.mul(M4.persp(fovY(pipCam.fov), r.w / r.h, 4, 16384), M4.view(pipCam.pos, pipCam.pitch, pipCam.yaw));
    lastCam = pipCam;                         // the line shader pulls lines toward lastCam
    drawScene(VP2, pipCam, players, poses, objs, i, r.w / r.h, poses.pipView);
    lastCam = cam;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    S.pipRect = r;
    S.pipShown = { s: pipCam.subject, mode: pipSpec.mode || 'eye', target: !!pipSpec.target, label: pipSpec.label || '' };
  }
  if (rs) return;                             // exporting: the video's overlays are drawn by the editor
  drawLabels(VP, players, cam, aimInfo, w / dpr, h / dpr);
  updatePov(players, cam, aimInfo);
  updateFeeds();
  updatePipBox(h, dpr);
}
/** One camera's picture: world, objects, players (X-ray first, against the map's depth only, so players never glow
    through themselves or each other), translucent surfaces, effects, hitboxes, aim lines and the first-person weapon.
    Returns who each player's crosshair is on. */
function drawScene(VP, cam, players, poses, objs, i, aspect, view) {
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  const trans = [];
  if (S.map) drawWorld(VP, objs, trans);
  else drawGrid(VP, players);
  drawObjects(VP, objs, poses, cam);
  if (prefs.xray) drawXray(VP, players, cam, poses);
  drawPlayers(VP, players, cam, poses);
  if (S.map) drawTranslucent(VP, trans);
  FX.draw(VP, cam, objs);
  if (prefs.hitboxes) drawHitboxes(VP, players, cam, i);
  const aimInfo = drawLines(VP, players, cam, i);
  if (view) drawViewModel(view, cam, aspect);
  return aimInfo;
}

// ------------------------------------------------------------------ picture in picture
/** The enemy slot s's crosshair is on at time t (the closest to the aim line, within about 1.2 degrees), or 0. */
function aimTargetAt(s, t) {
  const [i, f] = frameAt(t);
  const p = playerState(s, i, f);
  if (!alive(p)) return 0;
  const e = eyeOf(p), dir = forward(p.pitch, p.yaw);
  let best = 0, bd = 1e9;
  for (const q of playersAt(i, f)) {
    if (!alive(q) || !enemies(p, q)) continue;
    const v = sub(chestOf(q), e), along = dot(v, dir);
    if (along < 32 || along > 4096) continue;
    const miss = vlen(sub(v, mulv(dir, along)));
    if (miss < Math.max(22, along * Math.tan(1.2 * DEG)) && miss < bd) { bd = miss; best = q.s; }
  }
  return best;
}
/** The same, held for a second after the crosshair leaves them, so an inset showing it doesn't flicker. */
function aimTargetHeld(s, t) {
  for (let k = 0; k <= 10; k++) { const q = aimTargetAt(s, t - k * 0.1); if (q) return q; }
  return 0;
}
/** The inset's camera: spec = { s, mode: 'eye' | 'chase' | 'top' } or { target: true, mode } (whoever the main player
    is aiming at). null when there's nobody to show. */
function pipCamera(spec, players, mainCam) {
  let s = spec.s;
  if (spec.target) {
    const main = mainCam.pov || selectedState(players);
    s = main ? aimTargetHeld(main.s, S.t) : 0;
  }
  if (!s) return null;
  const p = players.find(q => q.s === s);
  if (!p || p.hidden) return null;
  const mode = spec.mode || 'eye';
  let cam;
  if (mode === 'eye') cam = { pos: eyeOf(p), pitch: p.pitch, yaw: p.yaw, pov: p, fov: 90 };
  else if (mode === 'top') cam = { pos: [p.x, p.y, p.z + 900], pitch: 89.9, yaw: 90, pov: null, fov: 90 };
  else {
    const target = [p.x, p.y, p.z + (p.ducked ? 10 : 22)], dist = 130, pitch = 15;
    let pos = sub(target, mulv(forward(pitch, p.yaw), dist));
    const fr = traceLine(target, pos, S.fi);
    if (fr >= 0) pos = addv(target, mulv(sub(pos, target), Math.max(0.05, fr - 8 / dist)));
    cam = { pos, pitch, yaw: p.yaw, pov: null, fov: 90 };
  }
  cam.subject = s;
  return cam;
}
/** The inset's rectangle in GL pixels (y from the bottom), the main picture's shape, `size` of its width. */
function pipRect(w, h, corner, size) {
  const pw = Math.max(64, Math.round(w * (size || 0.3))), ph = Math.round(pw * h / w), m = Math.round(Math.min(w, h) * 0.02);
  const c = corner || 'br';
  return { x: c.includes('l') ? m : w - pw - m, y: c.includes('t') ? h - ph - m : m, w: pw, h: ph };
}
/** The inset's frame on the page: who it shows, and its buttons. */
function updatePipBox(h, dpr) {
  const el = $('#pip');
  const r = S.pipRect, sh = S.pipShown;
  if (!r || !sh) {
    el.classList.add('hidden');
    if (S.pip && S.pip.target) {                        // nobody to show: say why, in the same corner
      el.classList.remove('hidden'); el.classList.add('empty');
      const er = pipRect(canvas.width, canvas.height, prefs.pipCorner, prefs.pipSize);
      Object.assign(el.style, { left: er.x / dpr + 'px', top: (canvas.height - er.y - er.h) / dpr + 'px', width: er.w / dpr + 'px', height: '' });
      el.querySelector('.nm').textContent = 'Target: nobody in the crosshair';
      el.dataset.mode = S.pip.mode || 'eye';
      el.classList.add('target');
    }
    return;
  }
  el.classList.remove('hidden', 'empty');
  Object.assign(el.style, { left: r.x / dpr + 'px', top: (h - r.y - r.h) / dpr + 'px', width: r.w / dpr + 'px', height: r.h / dpr + 'px' });
  const name = nameOf(sh.s, S.t), mode = { eye: 'eyes', chase: 'follow', top: 'top-down' }[sh.mode] || '';
  const txt = `${sh.target ? 'Target: ' : ''}${name} · ${mode}`;
  const nm = el.querySelector('.nm');
  if (nm.textContent !== txt) nm.textContent = txt;
  el.dataset.mode = sh.mode;
  el.classList.toggle('target', sh.target);
}
/** Live picture in picture: spec (see pipCamera) or null to close it. */
function setPip(spec) {
  S.pip = spec;
  if (spec) S.lastPip = spec;
}
/** The inset's player becomes the main one, and the main one goes into the inset. */
function swapPip() {
  const sh = S.pipShown;
  if (!sh || !sh.s) return;
  const prev = S.sel, mode = S.mode === 'eye' || S.mode === 'chase' ? S.mode : 'eye';
  setPip({ s: prev, mode: sh.mode });
  selectPlayer(sh.s, mode);
}
/** HL's fov (horizontal at 4:3, 90 by default) as the vertical field of view the projection takes. */
function fovY(fov) { return fov && fov !== 90 ? 2 * Math.atan(Math.tan(fov * DEG / 2) * 0.75) : VIEW_FOVY; }

function useWorld(VP) {
  gl.useProgram(PW.p);
  gl.uniformMatrix4fv(PW.u.uVP, false, VP);
  gl.uniform1i(PW.u.uTex, 0);
  gl.uniform1i(PW.u.uLM, 1);
  gl.uniform1f(PW.u.uBright, prefs.bright || 1);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, S.map.lm);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindVertexArray(S.map.vao);
}
function drawRanges(ranges, model, alpha, alphaTest, full) {
  gl.uniformMatrix4fv(PW.u.uModel, false, model);
  gl.uniform1f(PW.u.uAlpha, alpha);
  gl.uniform1f(PW.u.uAlphaTest, alphaTest ? 1 : 0);
  gl.uniform1f(PW.u.uFull, full ? 1 : 0);
  for (const [tex, first, count] of ranges) {
    gl.bindTexture(gl.TEXTURE_2D, S.map.tex[tex] || checkerTex);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
  }
}
function drawWorld(VP, objs, trans) {
  useWorld(VP);
  const I = M4.ident(), world = S.map.meta.models[0];
  drawRanges(world.opaque, I, 1, false, false);
  drawRanges(world.alpha, I, 1, true, false);
  trans.push({ ranges: world.water, model: I, alpha: 0.55, full: false });
  for (const o of objs) {
    if (o.model[0] !== '*' || o.nodraw) continue;
    const m = S.map.meta.models[parseInt(o.model.slice(1))];
    if (!m) continue;
    const mat = M4.entity(o.o, o.a);
    const r = o.rmode;
    if (r === 0 || r === 4) {
      drawRanges(m.opaque, mat, 1, r === 4, false);
      drawRanges(m.alpha, mat, 1, true, false);
      if (m.water.length) trans.push({ ranges: m.water, model: mat, alpha: 0.55, full: false });
    } else if (o.amt > 0) {
      trans.push({ ranges: m.opaque.concat(m.alpha), model: mat, alpha: Math.min(1, o.amt / 255), full: r === 5, add: r === 5 });
    }
  }
}
function drawTranslucent(VP, trans) {
  if (!trans.length) return;
  useWorld(VP);
  gl.enable(gl.BLEND);
  gl.depthMask(false);
  for (const tr of trans) {
    gl.blendFunc(gl.SRC_ALPHA, tr.add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    drawRanges(tr.ranges, tr.model, tr.alpha, false, tr.full);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

function useFlat(VP) { gl.useProgram(PF.p); gl.uniformMatrix4fv(PF.u.uVP, false, VP); }
function drawMesh(mesh, model, color, shade = 1) {
  gl.uniformMatrix4fv(PF.u.uModel, false, model);
  gl.uniform4fv(PF.u.uColor, color);
  gl.uniform1f(PF.u.uShade, shade);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}
function playerMatrix(p) {
  let m = M4.mul(M4.translate(p.x, p.y, p.z), M4.rotZ(p.yaw));
  if (p.dead) m = M4.mul(M4.mul(M4.translate(p.x, p.y, p.z - 30), M4.rotZ(p.yaw)), M4.rotY(-90));
  else if (p.ducked) m = M4.mul(m, M4.scale(1, 1, 0.5));
  return m;
}
function gunMatrix(p) {
  const e = eyeOf(p);
  return M4.mul(M4.mul(M4.translate(e[0], e[1], e[2] - 5), M4.rotZ(p.yaw)), M4.rotY(p.pitch));
}
function modelLight() { const b = prefs.bright || 1; return { ambient: 0.58 * b, shade: 0.42 * b }; }
function drawPlayers(VP, players, cam, poses) {
  const shown = players.filter(p => !p.hidden && !(cam.pov && cam.pov.s === p.s));
  const corpses = poses.corpses || [];
  if (poses.size || corpses.some(c => c.M)) {
    Studio.begin(VP, cam.pos, cam.yaw, modelLight());
    for (const p of shown) {
      const ps = poses.get(p.s);
      if (!ps) continue;
      Studio.draw(ps.M, ps.row, ps);
      if (ps.W) Studio.draw(ps.W, ps.wrow, ps);
    }
    for (const c of corpses) if (c.M) Studio.draw(c.M, c.row, c);
  }
  useFlat(VP);
  for (const c of corpses) {
    if (!c.M) drawMesh(meshes.body, playerMatrix({ x: c.o[0], y: c.o[1], z: c.o[2], yaw: c.yaw, dead: true }), [0.35, 0.35, 0.37, 1]);
  }
  for (const p of shown) {
    if (!poses.has(p.s)) {
      // mannequin when the model is missing
      if (p.dead) drawMesh(meshes.body, playerMatrix(p), [0.35, 0.35, 0.37, 1]);
      else {
        const c = TEAM_RGB[p.team] || TEAM_RGB[0];
        drawMesh(meshes.body, playerMatrix(p), [c[0], c[1], c[2], 1]);
        drawMesh(meshes.gun, gunMatrix(p), [0.12, 0.12, 0.13, 1]);
      }
    }
    if (p.s === S.sel && !p.dead && !S.renderSize) {        // the selection ring is page UI, not part of a video
      drawMesh(meshes.ring, M4.translate(p.x, p.y, p.z - (p.ducked ? 18 : 36) + 0.6), [0.94, 0.63, 0.19, 1], 0);
    }
  }
}
function drawXray(VP, players, cam, poses) {
  // only the parts hidden behind something: depth test GREATER against what is already drawn
  const shown = players.filter(p => !p.hidden && !p.dead && !(cam.pov && cam.pov.s === p.s));
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  gl.depthFunc(gl.GREATER);
  if (poses.size) {
    Studio.begin(VP, cam.pos, cam.yaw, modelLight());
    for (const p of shown) {
      const ps = poses.get(p.s);
      if (!ps) continue;
      const c = TEAM_RGB[p.team] || TEAM_RGB[0];
      Studio.draw(ps.M, ps.row, { flat: [c[0], c[1], c[2], 0.7] });
      if (ps.W) Studio.draw(ps.W, ps.wrow, { flat: [1, 1, 1, 0.5] });
    }
  }
  useFlat(VP);
  for (const p of shown) {
    if (poses.has(p.s)) continue;
    const c = TEAM_RGB[p.team] || TEAM_RGB[0];
    drawMesh(meshes.body, playerMatrix(p), [c[0], c[1], c[2], 0.7], 0);
    drawMesh(meshes.gun, gunMatrix(p), [1, 1, 1, 0.5], 0);
  }
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ player models (web/studio.js)
// TFC's client draws the model of the entity's playerclass (a spy: the class of their disguise, read from the
// userinfo model), coloured by the userinfo topcolor / bottomcolor (StudioModelRenderer.cpp, _TFC).
const TFC_CLASS_MODELS = [null, 'scout', 'sniper', 'soldier', 'demo', 'medic', 'hvyweapon', 'pyro', 'spy', 'engineer', 'scout', 'civilian'];
const TFC_TEAM_HUE = { 1: 150, 2: 250, 3: 45, 4: 100 };
const PC_SPY = 8;
function isTFC() { return /^tfc/i.test((S.meta && S.meta.game) || ''); }
function playerModelPath(name) { const n = String(name).replace(/^.*[\\/]/, ''); return `models/player/${n}/${n}.mdl`; }
/** The userinfo look ([time, model, topcolor, bottomcolor]) a player had at time t. */
function lookAt(pl, t) {
  const L = pl && pl.looks;
  if (!L || !L.length) return null;
  let best = L[0];
  for (const l of L) { if (l[0] <= t + 0.01) best = l; else break; }
  return best;
}
/** What the game draws for player state p: { path, top, bottom, disguise (class number, 0 = none) }. */
function playerLook(p) {
  const look = lookAt(who(p.s, S.t), S.t);
  let top = look ? look[2] : 0, bottom = look ? look[3] : 0, path, disguise = 0;
  if (isTFC()) {
    if (!look) { top = TFC_TEAM_HUE[p.team] || 0; bottom = Math.max(0, top - 10); }
    let cls = p.cls;
    if (cls === PC_SPY) {
      const k = look ? TFC_CLASS_MODELS.indexOf(String(look[1]).toLowerCase()) : -1;
      cls = k > 0 ? k : 1;
      if (cls !== PC_SPY) disguise = cls;
    }
    path = playerModelPath(TFC_CLASS_MODELS[cls] || 'scout');
  } else {
    path = look && look[1] ? playerModelPath(look[1]) : 'models/player.mdl';
  }
  return { path, top: Math.min(360, Math.max(0, top)), bottom: Math.min(360, Math.max(0, bottom)), disguise };
}

/** StudioEstimateGait + the turning in StudioProcessGait, run over the whole track once: where the legs face and how
    far they have walked (signed: backwards when facing away), per frame. */
function gaitTrack(s) {
  const D = S.D;
  if (D.gait[s]) return D.gait[s];
  const n = D.n, P = D.pos[s], I = D.info[s], T = D.times;
  const G = D.gait[s] = { yaw: new Float32Array(n), dist: new Float64Array(n) };
  let gy = 0, dist = 0, px = 0, py = 0, pz = 0, have = false;
  for (let i = 0; i < n; i++) {
    if (!(I[i] & PF_PRESENT)) { have = false; G.yaw[i] = gy; G.dist[i] = dist; continue; }
    const o = i * 5, x = P[o], y = P[o + 1], z = P[o + 2], yaw = P[o + 4];
    if (!have) { have = true; gy = yaw; px = x; py = y; pz = z; }
    else {
      const dt = Math.min(1, Math.max(0, T[i] - T[i - 1]));
      if (dt > 0) {
        let ex = x - px, ey = y - py;
        const ez = z - pz;
        px = x; py = y; pz = z;
        let mv = Math.hypot(ex, ey, ez);
        if (mv / dt < 5 || mv > 300) { mv = 0; ex = 0; ey = 0; }      // standing (or a teleport)
        if (ex === 0 && ey === 0) {
          let d = yaw - gy;
          d -= Math.trunc(d / 360) * 360;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          d *= dt < 0.25 ? dt * 4 : dt;
          gy += d;
          gy -= Math.trunc(gy / 360) * 360;
          mv = 0;
        } else gy = Math.atan2(ey, ex) / DEG;
        let fy = yaw - gy;
        fy -= Math.trunc(fy / 360) * 360;
        if (fy < -180) fy += 360;
        if (fy > 180) fy -= 360;
        if (fy > 120) { gy -= 180; mv = -mv; } else if (fy < -120) { gy += 180; mv = -mv; }
        dist += mv;
      }
    }
    G.yaw[i] = gy; G.dist[i] = dist;
  }
  return G;
}

/** StudioSetupBones' 0.2 s blend out of the previous sequence, when the sequence changed just before frame i. */
function prevSequence(s, i, seq) {
  const D = S.D, I = D.info[s], T = D.times, An = D.anim[s];
  let k = i;
  while (k > 0 && T[i] - T[k] < 0.2 && (I[k - 1] & PF_PRESENT) && ((I[k - 1] >> 22) & 255) === seq) k--;
  if (k <= 0 || !(I[k - 1] & PF_PRESENT) || ((I[k - 1] >> 22) & 255) === seq) return null;
  const changed = T[k] - (An ? (An[k] >>> 24) / 100 : 0);
  const w = 1 - (S.t - changed) / 0.2;
  if (w <= 0) return null;
  const a = An ? An[k - 1] : 0;
  return { seq: (I[k - 1] >> 22) & 255, frameByte: (a >> 8) & 255, framerate: An ? (((a >> 16) & 255) << 24 >> 24) / 16 : 1,
    elapsed: T[k] - T[k - 1] + (a >>> 24) / 100, s: Math.min(1, w) };
}

const poseStore = new Map();
/** Poses every visible player whose model is loaded: slot -> { M, W, pose, top, bottom, disguise }, and the corpses
    among objs (.corpses, see poseCorpses). */
function posePlayers(players, i, f, objs, pipCam) {
  const out = new Map();
  if (!Studio.available()) { out.corpses = poseCorpses(objs, i); return out; }
  const D = S.D, game = S.meta.game, models = levelForFrame(i).models;
  Studio.beginBones();
  for (const p of players) {
    if (p.hidden) continue;
    const look = playerLook(p);
    let M = Studio.get(game, look.path);
    if (!M && !isTFC() && Studio.status(game, look.path) === 'missing') M = Studio.get(game, 'models/player.mdl');
    if (!M) continue;
    let pose = poseStore.get(p.s);
    if (!pose) poseStore.set(p.s, pose = Studio.newPose());
    const A = D.anim[p.s] ? D.anim[p.s][i] : 0;
    const G = gaitTrack(p.s);
    let gy = G.yaw[i], gd = G.dist[i];
    if (f > 0 && i + 1 < D.n && (D.info[p.s][i + 1] & PF_PRESENT)) { gy = lerpAngle(gy, G.yaw[i + 1], f); gd = lerp(gd, G.dist[i + 1], f); }
    Studio.posePlayer(M, {
      origin: [p.x, p.y, p.z], viewPitch: p.pitch, viewYaw: p.yaw, seq: p.seq,
      frameByte: (A >> 8) & 255, framerate: D.anim[p.s] ? (((A >> 16) & 255) << 24 >> 24) / 16 : 1,
      elapsed: Math.max(0, S.t - D.times[i]) + (A >>> 24) / 100,
      gait: A & 255, gaitYaw: gy, gaitDist: gd, time: S.t, prev: prevSequence(p.s, i, p.seq),
    }, pose);
    let W = null, wrow = -1;
    const wpath = p.wm ? models[p.wm] || '' : '';
    if (/\.mdl$/i.test(wpath)) {
      W = Studio.get(game, wpath);
      if (W) { Studio.poseMerged(W, M, pose, pose.weapon); wrow = Studio.addBones(pose.weapon, W.nb); }
    }
    const row = Studio.addBones(pose.bones, M.nb);
    if (row < 0) continue;
    out.set(p.s, { M, W: wrow >= 0 ? W : null, row, wrow, pose, top: look.top, bottom: look.bottom, disguise: look.disguise });
  }
  out.corpses = poseCorpses(objs, i);
  out.objs = poseObjects(objs, i, out);
  out.view = poseViewModel(lastCam, 'view');
  out.pipView = pipCam ? poseViewModel(pipCam, 'pipview') : null;
  Studio.flushBones();
  return out;
}

/** The latest state of slot s at or before frame i (a corpse's player may be gone, or between lives). */
function lastPlayerState(s, i) {
  const I = S.D.info[s];
  if (!I) return null;
  for (let k = Math.min(i, S.D.n - 1); k >= 0; k--) if (I[k] & PF_PRESENT) return playerState(s, k, 0);
  return null;
}
/** Corpses (bodyque, kRenderFxDeadPlayer) as StudioDrawModel draws them: the player in slot renderamt with that
    player's current model and colours, posed at the corpse's own origin, angles, sequence and frame, no gait, no
    weapon. Returns [{ M (null: no model), row, top, bottom, o, yaw }]. */
function poseCorpses(objs, i) {
  const out = [];
  const game = S.meta.game, mc = S.meta.maxclients;
  for (const o of objs) {
    if (o.fx !== FX_DEAD_PLAYER || o.nodraw) continue;
    const s = o.amt;
    if (s <= 0 || s > mc) continue;
    const p = playerState(s, i, 0) || lastPlayerState(s, i);
    const look = playerLook(p || { s, team: o.team, cls: 0 });
    let M = Studio.available() ? Studio.get(game, look.path) : null;
    if (!M && !isTFC() && Studio.status(game, look.path) === 'missing') M = Studio.get(game, 'models/player.mdl');
    const c = { M: null, row: -1, top: look.top, bottom: look.bottom, o: o.o, yaw: o.a[1] };
    out.push(c);
    if (!M) continue;
    let pose = poseStore.get('c' + o.ent);
    if (!pose) poseStore.set('c' + o.ent, pose = Studio.newPose());
    const pitch = ((o.a[0] % 360) + 540) % 360 - 180;
    Studio.posePlayer(M, {
      origin: o.o, viewPitch: -pitch * 3, viewYaw: o.a[1], roll: o.a[2], seq: o.seq,
      frameByte: o.frame, framerate: 0, elapsed: 0, gait: 0, gaitYaw: 0, gaitDist: 0, time: S.t, prev: null,
    }, pose);
    const row = Studio.addBones(pose.bones, M.nb);
    if (row >= 0) { c.M = M; c.row = row; }
  }
  return out;
}

// ------------------------------------------------------------------ hitboxes (the server's view of the players)
/** The model the server has for slot s at frame i (entity_state modelindex; TFC: scout.mdl for every class). */
function serverModelPath(s, i) {
  const L = S.meta.pmodels && S.meta.pmodels[s];
  if (!L || !L.length) return null;
  let mi = L[0][1];
  for (const [fr, m] of L) { if (fr <= i) mi = m; else break; }
  const p = levelForFrame(i).models[mi];
  return p && /\.mdl$/i.test(p) ? p : null;
}
const serverStore = new Map();
/** Player state p (at frame i) posed as the server poses it for shots: { M, bones }, or null without its model. */
function serverPose(p, i, key) {
  const path = serverModelPath(p.s, i);
  const M = path ? Studio.get(S.meta.game, path) : null;
  if (!M || !M.meta.hitboxes || !M.meta.hitboxes.length) return null;
  let bones = serverStore.get(key);
  if (!bones) serverStore.set(key, bones = new Float32Array(128 * 12));
  const A = S.D.anim[p.s] ? S.D.anim[p.s][i] : 0;
  Studio.poseServer(M, { origin: [p.x, p.y, p.z], angles: [-p.pitch / 3, p.yaw, 0], seq: p.seq, frameByte: (A >> 8) & 255 }, bones);
  return { M, bones };
}

// ------------------------------------------------------------------ lag compensation
// A human's shot is tested against where the other players were on that player's screen: before running their
// command, SV_SetupMove (ReHLDS sv_user.cpp) moves every other player's origin back by the shooter's latency
// (sv_maxunlag caps it at 0.5 s) plus their interpolation (at most 0.1 s, the usual setting), interpolated between the
// frames around that moment. Only the origin moves: pose and angles stay as they are now. Anyone who died, teleported
// (over 128 units on an axis in one frame) or was not in the game in that window stays where they are. Bots get no
// rewind. Measured on 1,193 kills from a public server's HLTV: humans' kill shots go through the victim's boxes 38% of the time
// without this, 74% with it.
const UNLAG_INTERP = 0.1;
function isBot(pl) { return !pl || pl.bot || (!pl.sid64 && !(pl.ping > 0)); }
/** The shooter's scoreboard ping (ms) at time t, from the svc_pings samples. */
function pingAt(pl, t) {
  const L = pl.pings;
  if (!L || !L.length) return pl.ping || 0;
  let lo = 0, hi = L.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (L[m][0] <= t) lo = m + 1; else hi = m; }
  return L[Math.max(0, lo - 1)][1];
}
/** Seconds the server moves the other players back for a shot by slot s at time t (0 for bots, or with the Lag comp
    toggle off). */
function unlagFor(s, t) {
  if (!prefs.unlag) return 0;
  const pl = who(s, t);
  if (isBot(pl)) return 0;
  return Math.min(pingAt(pl, t) / 1000, 0.5) + UNLAG_INTERP;
}
/** The frames a rewind of rw seconds from time tNow spans: { i: now, j + f: the moment tested }, or null for none. */
function unlagWindow(tNow, rw) {
  if (!(rw > 0)) return null;
  const [i] = frameAt(tNow), [j, f] = frameAt(tNow - rw);
  return { i, j, f };
}
/** Per slot, for each frame: the last frame up to it where the player was absent or dead, and the last frame they
    arrived at with a jump of over 128 units on an axis (a teleport to SV_SetupMove). */
function unlagIndex(s) {
  const D = S.D, cache = D.unlagIdx ||= new Map();
  let x = cache.get(s);
  if (x) return x;
  const P = D.pos[s], I = D.info[s], n = D.n, bad = new Int32Array(n), jump = new Int32Array(n);
  let lb = -1, lj = -1;
  for (let k = 0; k < n; k++) {
    if (!(I[k] & PF_PRESENT) || (I[k] & PF_DEAD)) lb = k;
    else if (k > 0 && (Math.abs(P[k * 5] - P[k * 5 - 5]) > 128 || Math.abs(P[k * 5 + 1] - P[k * 5 - 4]) > 128 ||
      Math.abs(P[k * 5 + 2] - P[k * 5 - 3]) > 128)) lj = k;
    bad[k] = lb; jump[k] = lj;
  }
  cache.set(s, x = { bad, jump });
  return x;
}
/** Origin [x, y, z] the server tests slot s at for a shot rewound over window w; null = where they are. */
function unlagAt(s, w) {
  const D = S.D, P = D.pos[s];
  if (!w || !P) return null;
  const x = unlagIndex(s);
  if (x.bad[w.i] >= w.j || x.jump[w.i] > w.j) return null;
  const o = w.j * 5, o2 = Math.min(w.j + 1, D.n - 1) * 5, f = w.f;
  return [lerp(P[o], P[o2], f), lerp(P[o + 1], P[o2 + 1], f), lerp(P[o + 2], P[o2 + 2], f)];
}
/** Player state q moved to where the server tests it for a shot rewound over window w (a copy), or q itself. */
function unlagStateW(q, w) {
  const o = unlagAt(q.s, w);
  return o ? { ...q, x: o[0], y: o[1], z: o[2] } : q;
}
function unlagState(q, tNow, rw) { return unlagStateW(q, unlagWindow(tNow, rw)); }

/** Indices of the trace shots (bullets, melee) fired in (t - window, t]. */
function recentTraceShots(t, window) {
  const T = S.D.traceShots, out = [];
  let lo = 0, hi = T.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T[m].t <= t) lo = m + 1; else hi = m; }
  for (let k = lo - 1; k >= 0 && T[k].t > t - window; k--) out.push(k);
  return out;
}
/** The latest trace shot by slot s in (t - window, t], or -1. */
function lastTraceShot(s, t, window) {
  const L = S.D.traceBy.get(s);
  if (!L) return -1;
  let lo = 0, hi = L.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S.D.traceShots[L[m]].t <= t) lo = m + 1; else hi = m; }
  return lo > 0 && S.D.traceShots[L[lo - 1]].t > t - window ? L[lo - 1] : -1;
}
const shotHitCache = new Map();
/** What shot k's aim ray (the centre of any spread) went through: the first hitbox of anyone, as the server tested
    them (lag-compensated for a human shooter, see unlagFor), before the first wall. The shot happened somewhere between
    the snapshot of the packet that carried its event and the one before (demos keep 20-64 a second), so the packet's
    snapshot is tried first, then the one before.
    { q: slot, box, group, enemy, dist, point, rewind } or { miss, point, rewind }; null when the shooter isn't in the game. */
function shotHit(k) {
  if (shotHitCache.has(k)) return shotHitCache.get(k);
  const sh = S.D.traceShots[k];
  const T = S.D.times;
  let lo = 0, hi = S.D.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] >= sh.t - 0.002) hi = m; else lo = m + 1; }
  let res = shotHitAt(sh, lo);
  if ((!res || res.miss) && lo > 0) res = shotHitAt(sh, lo - 1) || res;
  shotHitCache.set(k, res);
  return res;
}
function shotHitAt(sh, i) {
  const p = playerState(sh.s, i, 0);
  if (!alive(p)) return null;
  let res = null;
  const e = eyeOf(p), d = forward(p.pitch, p.yaw);
  const fr = traceLine(e, addv(e, mulv(d, sh.range)), i);
  let best = fr >= 0 ? sh.range * fr : sh.range;
  const rw = unlagFor(sh.s, S.D.times[i]);
  for (const s of S.D.slots) {
    if (s === p.s) continue;
    // a target this very shot killed is already dead (or gone) in that snapshot: take their pose from the one before,
    // at the spot they died if there is one
    let q = playerState(s, i, 0), qi = i;
    if (!alive(q)) {
      const prev = i > 0 ? playerState(s, i - 1, 0) : null;
      if (!alive(prev) || (q && q.hidden)) continue;
      if (q && q.dead) { prev.x = q.x; prev.y = q.y; prev.z = q.z; }
      q = prev; qi = i - 1;
    }
    q = unlagState(q, S.D.times[qi], rw);
    const v = sub([q.x, q.y, q.z], e), along = dot(v, d);
    if (along < -64 || along > best + 64 || vlen(sub(v, mulv(d, along))) > 64) continue;   // nowhere near the ray
    const sp = serverPose(q, qi, 'shot');
    if (!sp) continue;
    const H = sp.M.meta.hitboxes;
    for (let b = 0; b < H.length; b++) {
      const t = Studio.rayHitbox(H[b], sp.bones, e, d, best);
      if (t >= 0 && t < best) { best = t; res = { q: q.s, box: b, group: H[b].group, enemy: enemies(p, q), dist: t, at: [q.x, q.y, q.z], qi }; }
    }
  }
  if (!res) res = { miss: true };
  res.point = addv(e, mulv(d, best));
  res.rewind = rw;
  return res;
}

const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const cornerBuf = new Float64Array(24);
function pushBoxEdges(v, C, c, alpha) {
  for (const [a, b] of BOX_EDGES) {
    v.push(C[a * 3], C[a * 3 + 1], C[a * 3 + 2], c[0], c[1], c[2], alpha, C[b * 3], C[b * 3 + 1], C[b * 3 + 2], c[0], c[1], c[2], alpha);
  }
}
/** A unit cube (meshes.cube) onto hitbox h of bones, as a 4x4 for drawMesh. */
function hitboxMatrix(B, h) {
  const o = h.bone * 12;
  const m = new Float32Array([B[o], B[o + 4], B[o + 8], 0, B[o + 1], B[o + 5], B[o + 9], 0, B[o + 2], B[o + 6], B[o + 10], 0, B[o + 3], B[o + 7], B[o + 11], 1]);
  return M4.mul(m, M4.mul(M4.translate((h.min[0] + h.max[0]) / 2, (h.min[1] + h.max[1]) / 2, (h.min[2] + h.max[2]) / 2),
    M4.scale(h.max[0] - h.min[0], h.max[1] - h.min[1], h.max[2] - h.min[2])));
}
/** Wireframe hitboxes coloured by hit group (head filled), as the server poses the players; the 32x32x72 hull
    (x36 ducked) for a player whose model is missing. In Eyes view they are where the server tests that player's shots
    (lag compensation moves them back for a human). Boxes a shot just went through flash; a shot tested against boxes
    other than the drawn ones (another human's rewind) flashes the box it went through where it was tested. */
function drawHitboxes(VP, players, cam, i) {
  const rw = cam.pov ? unlagFor(cam.pov.s, S.t) : 0;
  const flash = new Map(), ghosts = [];
  for (const k of recentTraceShots(S.t, 0.35)) {
    const r = shotHit(k);
    if (!r || r.miss) continue;
    const sh = S.D.traceShots[k], a = 1 - (S.t - sh.t) / 0.35;
    const drawnThere = r.rewind > 0 ? !!(cam.pov && cam.pov.s === sh.s) : rw === 0;
    if (drawnThere) flash.set(`${r.q}:${r.box}`, Math.max(flash.get(`${r.q}:${r.box}`) || 0, a));
    else ghosts.push({ r, a });
  }
  const v = [], fills = [];
  for (const { r, a } of ghosts) {
    const st = playerState(r.q, r.qi, 0);
    if (!st) continue;
    st.x = r.at[0]; st.y = r.at[1]; st.z = r.at[2];
    const sp = serverPose(st, r.qi, 'ghost');
    if (!sp) continue;
    const h = sp.M.meta.hitboxes[r.box], c = hitgroup(h.group)[1];
    pushBoxEdges(v, Studio.hitboxCorners(h, sp.bones, cornerBuf), c, 0.9 * a);
    fills.push([hitboxMatrix(sp.bones, h), [c[0], c[1], c[2], 0.25 + 0.5 * a]]);
  }
  for (const p0 of players) {
    if (!alive(p0) || (cam.pov && cam.pov.s === p0.s)) continue;
    const p = rw > 0 ? unlagState(p0, S.t, rw) : p0;
    const sp = serverPose(p, i, p.s);
    if (!sp) {
      const hz = p.ducked ? 18 : 36;
      for (let k = 0; k < 8; k++) {
        cornerBuf[k * 3] = p.x + (k & 1 ? 16 : -16); cornerBuf[k * 3 + 1] = p.y + (k & 2 ? 16 : -16); cornerBuf[k * 3 + 2] = p.z + (k & 4 ? hz : -hz);
      }
      pushBoxEdges(v, cornerBuf, [0.85, 0.85, 0.9], 0.9);
      continue;
    }
    const H = sp.M.meta.hitboxes;
    for (let b = 0; b < H.length; b++) {
      const h = H[b], c = hitgroup(h.group)[1];
      pushBoxEdges(v, Studio.hitboxCorners(h, sp.bones, cornerBuf), c, 0.95);
      const fl = flash.get(`${p.s}:${b}`) || 0;
      if (h.group === 1 || fl > 0) fills.push([hitboxMatrix(sp.bones, h), [c[0], c[1], c[2], fl > 0 ? 0.3 + 0.5 * fl : 0.2]]);
    }
  }
  if (fills.length) {
    useFlat(VP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    if (prefs.xray) gl.disable(gl.DEPTH_TEST);
    for (const [m, c] of fills) drawMesh(meshes.cube, m, c, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  if (prefs.xray) drawLineVerts(VP, v, false, 0, 0.35);      // behind walls: dimmer
  drawLineVerts(VP, v, true, 24);
}

/** Per shooter, over the whole demo: trace shots, those whose aim went through an enemy's hitbox, and of those the
    head. Runs in slices so the page stays responsive; done(stats) at the end. */
function shotStats(done) {
  const D = S.D, T = D.traceShots, stats = {};
  let k = 0;
  (function slice() {
    if (S.D !== D) return;                                     // another demo was opened
    const until = performance.now() + 12;
    for (; k < T.length && performance.now() < until; k++) {
      const r = shotHit(k);
      if (!r) continue;
      const st = stats[T[k].s] ||= { shots: 0, hits: 0, head: 0 };
      st.shots++;
      if (!r.miss && r.enemy) { st.hits++; if (r.group === 1) st.head++; }
    }
    if (k < T.length) setTimeout(slice, 0); else done(stats);
  })();
}

/** Loads the models the demo needs before playback starts: player classes (and disguises) seen, weapons held. */
async function preloadModels() {
  if (!Studio.available()) return;
  const D = S.D, game = S.meta.game, paths = new Set(), wms = new Set();
  const tfc = isTFC();
  for (const s of D.slots) {
    const I = D.info[s];
    let lastC = -1, lastW = -1;
    for (let i = 0; i < D.n; i++) {
      const a = I[i];
      if (!(a & PF_PRESENT)) continue;
      const c = (a >> 8) & 15, w = (a >> 12) & 1023;
      if (c !== lastC) { lastC = c; if (tfc && c && c !== PC_SPY) paths.add(playerModelPath(TFC_CLASS_MODELS[c] || 'scout')); }
      if (w !== lastW) { lastW = w; if (w) wms.add(w); }
    }
  }
  for (const pl of S.meta.players) {
    for (const l of pl.looks || []) {
      if (!l[1]) continue;
      if (!tfc) paths.add(playerModelPath(l[1]));
      else if (TFC_CLASS_MODELS.includes(String(l[1]).toLowerCase())) paths.add(playerModelPath(l[1]));
    }
  }
  if (!tfc) paths.add('models/player.mdl');
  for (const lv of S.meta.levels) for (const w of wms) { const m = lv.models[w]; if (m && /\.mdl$/i.test(m)) paths.add(m); }
  // the server's player models, for the hitboxes
  for (const L of Object.values(S.meta.pmodels || {})) {
    for (const [, mi] of L) for (const lv of S.meta.levels) { const m = lv.models[mi]; if (m && /\.mdl$/i.test(m)) paths.add(m); }
  }
  const list = [...paths];
  let done = 0;
  showLoading('Loading player models…', 0.96, `0 / ${list.length}`);
  await Promise.all(list.map(p => Studio.load(game, p).then(() => { done++; showLoading('Loading player models…', 0.96 + 0.04 * done / list.length, `${done} / ${list.length}`); })));
}

/** Every studio-model object (rockets, grenades, sentries, dispensers, flags, packs...) as StudioDrawModel poses it. */
/** Studio-model entities posed for drawing. A MOVETYPE_FOLLOW entity (a carried flag) is merged onto its aiment's
    skeleton (players: their posed model in `players`, slot -> { M, pose }) the way StudioMergeBones does it. */
function poseObjects(objs, i, players) {
  const out = [];
  const game = S.meta.game;
  for (const o of objs) {
    if (o.nodraw || o.fx === FX_DEAD_PLAYER || !/\.mdl$/i.test(o.model) || /^models\/player/i.test(o.model)) continue;
    const M = Studio.get(game, o.model);
    if (!M) continue;
    let pose = poseStore.get('o' + o.ent);
    if (!pose) poseStore.set('o' + o.ent, pose = Studio.newPose());
    const anim = { seq: o.seq, frameByte: o.frame, framerate: o.framerate, elapsed: Math.max(0, S.t - o.since), origin: o.o, angles: o.a };
    const parent = o.aiment && players ? players.get(o.aiment) : null;
    if (parent) Studio.poseMerged(M, parent.M, parent.pose, pose.bones, anim);
    else Studio.poseEntity(M, { origin: o.o, angles: o.a, ctl: o.ctl, ...anim }, pose.bones);
    const row = Studio.addBones(pose.bones, M.nb);
    if (row < 0) continue;
    out.push({ M, row, skin: o.skin, body: o.body, ent: o.ent, top: o.colormap & 255, bottom: (o.colormap >> 8) & 255,
      aiment: o.aiment, shell: o.fx === FX_GLOW_SHELL ? { color: o.color, amt: o.amt, time: S.t } : null });
  }
  return out;
}
function preloadObjectModels() {
  if (!Studio.available()) return;
  const seen = new Set(), O = S.D.objs;
  for (let r = 0, n = O.length / OBJ_STRIDE; r < n; r++) {
    const mi = O[r * OBJ_STRIDE + 2];
    if (mi <= 0 || seen.has(mi)) continue;
    seen.add(mi);
    for (const lv of S.meta.levels) {
      const m = lv.models[mi];
      if (m && /\.mdl$/i.test(m) && !/^models\/player/i.test(m)) Studio.load(S.meta.game, m);
    }
  }
}

// first-person weapon (v_ model) of the player being watched through their eyes
const TFC_VIEWMODELS = { p_9mmhandgun: 'v_tfc_railgun', p_crowbar: 'v_tfc_crowbar', p_egon: 'v_flame', p_glauncher: 'v_tfgl',
  p_grenade: 'v_grenade', p_knife: 'v_tfc_knife', p_medkit: 'v_tfc_medkit', p_mini: 'v_tfac', p_nailgun: 'v_tfc_nailgun',
  p_srpg: 'v_tfc_rpg', p_rpg: 'v_tfc_rpg', p_shotgun: 'v_tfc_12gauge', p_smallshotgun: 'v_tfc_shotgun',
  p_snailgun: 'v_tfc_supernailgun', p_sniper: 'v_tfc_sniper', p_spanner: 'v_tfc_spanner', p_umbrella: 'v_umbrella',
  p_spygun: 'v_tfc_pistol' };
function viewModelPath(p) {
  const m = levelForFrame(S.fi).models[p.wm] || '';
  const b = m.replace(/^.*\//, '').replace(/\.mdl$/i, '').replace(/2$/, '').toLowerCase();
  if (!b) return null;
  if (isTFC() && TFC_VIEWMODELS[b]) return `models/${TFC_VIEWMODELS[b]}.mdl`;
  if (b.startsWith('p_')) return `models/v_${b.slice(2)}.mdl`;
  return null;
}
function lastShotBefore(s, t) {
  const a = S.D.shotsBy.get(s);
  if (!a || !a.length) return -1;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { best = a[m]; lo = m + 1; } else hi = m - 1; }
  return best;
}
function poseViewModel(cam = lastCam, key = 'view') {
  if (!cam || !cam.pov || cam.pov.dead || cam.pov.hidden) return null;
  const p = cam.pov, path = viewModelPath(p);
  if (!path) return null;
  const M = Studio.get(S.meta.game, path);
  if (!M) return null;
  if (M.shootSeq === undefined) {
    M.shootSeq = Studio.findSequence(M, /shoot|fire|attack|slash|swing|stab|hit|spin/i);
    M.idleSeq = Math.max(0, Studio.findSequence(M, /^idle/i));
  }
  let seq = M.idleSeq, elapsed = S.t;
  const ts = lastShotBefore(p.s, S.t);
  if (ts >= 0 && M.shootSeq >= 0) {
    const sq = M.seqs[M.shootSeq];
    if (S.t - ts < sq.frames / Math.max(1, sq.fps)) { seq = M.shootSeq; elapsed = S.t - ts; }
  }
  let pose = poseStore.get(key);
  if (!pose) poseStore.set(key, pose = Studio.newPose());
  // V_CalcGunAngle: the view model's pitch is the view's, negated (StudioSetUpTransform negates it back)
  Studio.poseEntity(M, { origin: eyeOf(p), angles: [-p.pitch, p.yaw, 0], seq, frameByte: 0, framerate: 1, elapsed }, pose.bones);
  const row = Studio.addBones(pose.bones, M.nb);
  return row < 0 ? null : { M, row };
}
function drawViewModel(v, cam, aspect) {
  gl.clear(gl.DEPTH_BUFFER_BIT);
  const VPv = M4.mul(M4.persp(VIEW_FOVY, aspect, 1, 1024), M4.view(cam.pos, cam.pitch, cam.yaw));
  Studio.begin(VPv, cam.pos, cam.yaw, modelLight());
  Studio.draw(v.M, v.row, {});
}

function objStyle(model) {
  const m = model.toLowerCase();
  if (m.endsWith('.spr') || m.includes('gib') || m === '') return null;
  if (/rocket|rpg|missile/.test(m)) return { size: [10, 4, 4], color: [1, 0.55, 0.15, 1] };
  if (/gren|pipe|caltrop|conc|nail|emp|napalm|mirv|flare|gas/.test(m)) return { size: [6, 6, 6], color: [0.95, 0.85, 0.2, 1] };
  if (/sentry|turret|base\.mdl/.test(m)) return { size: [26, 26, 32], color: [0.75, 0.45, 0.95, 1], label: 'sentry' };
  if (/dispenser/.test(m)) return { size: [24, 24, 36], color: [0.6, 0.6, 0.65, 1], label: 'dispenser' };
  if (/teleport/.test(m)) return { size: [30, 30, 8], color: [0.5, 0.85, 0.95, 1] };
  if (/flag|tfgoal|keycard|backpack|ball|bag|briefcase|cap/.test(m)) return { size: [14, 14, 30], color: null, label: 'item' };
  if (/player|corpse/.test(m)) return null;
  return { size: [8, 8, 8], color: [0.7, 0.7, 0.72, 1] };
}
function drawObjects(VP, objs, poses, cam) {
  const drawn = new Set();
  if (poses && poses.objs && poses.objs.length) {
    Studio.begin(VP, cam.pos, cam.yaw, modelLight());
    for (const ob of poses.objs) {
      drawn.add(ob.ent);
      if (cam.pov && ob.aiment === cam.pov.s) continue;      // the flag you carry isn't drawn around your own eyes
      Studio.draw(ob.M, ob.row, ob);
    }
  }
  useFlat(VP);
  for (const o of objs) {
    if (o.model[0] === '*' || o.nodraw || o.fx === FX_DEAD_PLAYER || drawn.has(o.ent)) continue;     // corpses: poseCorpses
    if (cam.pov && o.aiment === cam.pov.s) continue;
    const st = objStyle(o.model);
    if (!st) continue;
    const c = st.color || [...(TEAM_RGB[o.team] || [0.9, 0.9, 0.9]), 1];
    const m = M4.mul(M4.mul(M4.translate(o.o[0], o.o[1], o.o[2] + st.size[2] / 2 - (st.label ? 0 : st.size[2] / 2)), M4.rotZ(o.a[1])), M4.scale(...st.size));
    drawMesh(meshes.cube, m, c);
  }
}

function drawGrid(VP, players) {
  let z = 0, cx = 0, cy = 0, n = 0;
  for (const p of players) { z = Math.min(z, p.z - 36); cx += p.x; cy += p.y; n++; }
  if (n) { cx /= n; cy /= n; }
  const v = [];
  const R = 4096, step = 256, ox = Math.round(cx / step) * step, oy = Math.round(cy / step) * step;
  for (let k = -R; k <= R; k += step) {
    v.push(ox + k, oy - R, z, 1, 1, 1, 0.12, ox + k, oy + R, z, 1, 1, 1, 0.12);
    v.push(ox - R, oy + k, z, 1, 1, 1, 0.12, ox + R, oy + k, z, 1, 1, 1, 0.12);
  }
  drawLineVerts(VP, v, true);
}
function drawLineVerts(VP, v, depth, pull = 0, alpha = 1) {
  if (!v.length) return;
  gl.useProgram(PL.p);
  gl.uniformMatrix4fv(PL.u.uVP, false, VP);
  const cp = lastCam ? lastCam.pos : [0, 0, 0];
  gl.uniform3f(PL.u.uCam, cp[0], cp[1], cp[2]);
  gl.uniform1f(PL.u.uPull, pull);
  gl.uniform1f(PL.u.uAlpha, alpha);
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (!depth) gl.disable(gl.DEPTH_TEST);
  gl.drawArrays(gl.LINES, 0, v.length / 7);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
}
function pushLine(v, a, b, c, alpha) { v.push(a[0], a[1], a[2], c[0], c[1], c[2], alpha, b[0], b[1], b[2], c[0], c[1], c[2], alpha); }
function pushDashed(v, a, b, c, alpha, dash = 14) {
  const d = sub(b, a), L = vlen(d);
  if (L < 1) return;
  const u = mulv(d, 1 / L);
  for (let s = 0; s < L; s += dash * 2) pushLine(v, addv(a, mulv(u, s)), addv(a, mulv(u, Math.min(L, s + dash))), c, alpha);
}

/** Aim lines + shot tracers. Returns, per player slot, which enemy their aim passes (through a wall or not). */
function drawLines(VP, players, cam, i) {
  const out = {};
  const solid = [], through = [];
  const showAll = prefs.aim;
  for (const p of players) {
    if (!alive(p)) continue;
    const e = eyeOf(p), dir = forward(p.pitch, p.yaw);
    const far = addv(e, mulv(dir, 4096));
    const fr = traceLine(e, far, i);
    const hit = fr >= 0 ? addv(e, mulv(dir, 4096 * fr)) : far;
    const hitDist = fr >= 0 ? 4096 * fr : 4096;
    // which enemy sits on this line of fire?
    let tgt = null, best = 1e9;
    for (const q of players) {
      if (!alive(q) || !enemies(p, q)) continue;
      const c = chestOf(q), v = sub(c, e), along = dot(v, dir);
      if (along < 32 || along > 4096) continue;
      const miss = vlen(sub(v, mulv(dir, along)));
      if (miss < Math.max(22, along * Math.tan(1.2 * DEG)) && miss < best) { best = miss; tgt = { q, along, behindWall: along > hitDist + 8 }; }
    }
    out[p.s] = tgt;
    const shooting = (S.D.shotsBy.get(p.s) || []).some(t => t <= S.t && t > S.t - 0.12);
    const isPov = cam.pov && cam.pov.s === p.s;
    if (shooting && !isPov) {
      // with hitboxes on, a bullet's tracer ends in the box it went through, in that hit group's colour
      let end = hit, col = [1, 0.95, 0.5];
      const k = prefs.hitboxes ? lastTraceShot(p.s, S.t, 0.12) : -1;
      const r = k >= 0 ? shotHit(k) : null;
      if (r) { end = r.point; if (!r.miss) col = hitgroup(r.group)[1]; }
      pushLine(solid, e, end, col, 0.95);
    }
    if (!showAll || isPov) continue;
    const c = TEAM_RGB[p.team] || TEAM_RGB[0];
    pushLine(solid, e, hit, c, p.s === S.sel ? 0.95 : 0.55);
    if (prefs.xray) {
      const endDist = tgt && tgt.behindWall ? tgt.along + 40 : Math.min(4096, hitDist + 600);
      if (endDist > hitDist + 4) {
        const red = tgt && tgt.behindWall;
        pushDashed(through, hit, addv(e, mulv(dir, endDist)), red ? [1, 0.25, 0.2] : c, red ? 0.95 : 0.25);
      }
    }
  }
  drawLineVerts(VP, solid, true);
  drawLineVerts(VP, through, false);
  return out;
}

// ------------------------------------------------------------------ labels + HUD
const labelPool = [];
function drawLabels(VP, players, cam, aimInfo, w, h) {
  let used = 0;
  const targetedThroughWall = new Set();
  for (const k in aimInfo) { const t = aimInfo[k]; if (t && t.behindWall) targetedThroughWall.add(t.q.s); }
  if (prefs.names) {
    for (const p of players) {
      if (p.hidden || (cam.pov && cam.pov.s === p.s)) continue;
      const head = [p.x, p.y, p.z + (p.dead ? -20 : p.ducked ? 24 : 42)];
      const sp = project(VP, head, w, h);
      if (!sp) continue;
      const visible = traceLine(cam.pos, head, S.fi) < 0 || traceLine(cam.pos, chestOf(p), S.fi) < 0;
      if (!visible && !prefs.xray) continue;
      let el = labelPool[used];
      if (!el) { el = document.createElement('div'); el.className = 'lbl'; $('#labels').appendChild(el); labelPool.push(el); }
      used++;
      const pl = who(p.s, S.t);
      const c = TEAM_RGB[p.team] || TEAM_RGB[0];
      el.style.display = '';
      el.style.left = `${sp[0]}px`;
      el.style.top = `${sp[1]}px`;
      el.style.borderLeftColor = rgbCss(c);
      el.className = 'lbl' + (visible ? '' : ' hid') + (p.s === S.sel ? ' sel' : '') + (targetedThroughWall.has(p.s) ? ' tgt' : '');
      let cls = className(p.cls);
      if (p.cls === PC_SPY && isTFC()) { const d = playerLook(p).disguise; if (d) cls += ` as ${className(d)}`; }
      const dist = Math.round(vlen(sub(head, cam.pos)) / 16);
      const vit = p.dead ? null : vitalsAt(p.s, S.t);
      el.innerHTML = `${esc(pl ? pl.name : '#' + p.s)}<small>${p.dead ? 'dead' : esc(cls)}${cls && !p.dead ? ' · ' : ''}${p.dead ? '' : dist + ' ft'}${vit ? ` · ${vit.hp} hp ${vit.ap} ap` : ''}</small>`;
    }
  }
  // with hitboxes on: where each bullet of the last 0.6 s went, by hit group
  if (prefs.hitboxes) {
    for (const k of recentTraceShots(S.t, 0.6)) {
      const r = shotHit(k);
      if (!r || r.miss) continue;
      const sp = project(VP, r.point, w, h);
      if (!sp) continue;
      let el = labelPool[used];
      if (!el) { el = document.createElement('div'); el.className = 'lbl'; $('#labels').appendChild(el); labelPool.push(el); }
      used++;
      const [name, c] = hitgroup(r.group);
      el.style.display = '';
      el.style.left = `${sp[0]}px`;
      el.style.top = `${sp[1]}px`;
      el.style.borderLeftColor = rgbCss(c);
      el.className = 'lbl hitg' + (r.group === 1 ? ' head' : '');
      el.innerHTML = `${esc(name)}${r.enemy ? '' : '<small>teammate</small>'}`;
    }
  }
  for (let k = used; k < labelPool.length; k++) labelPool[k].style.display = 'none';
}

/** The POV line about the player's last bullet: what it went through, as the server had the players then. */
function lastShotLine(p) {
  const k = lastTraceShot(p.s, S.t, 2);
  if (k < 0) return '';
  const r = shotHit(k), sh = S.D.traceShots[k];
  if (!r) return '';
  const ago = `${(S.t - sh.t).toFixed(1)} s ago`;
  if (r.miss) return `<br><span class="muted">Last shot (${esc(sh.weapon)}, ${ago}): aim went through no hitbox</span>`;
  const [name] = hitgroup(r.group);
  return `<br>Last shot (${esc(sh.weapon)}, ${ago}): <span class="${r.group === 1 ? 'warn' : ''}">${esc(name)}</span> of ${esc(nameOf(r.q, sh.t))}` +
    `${r.enemy ? '' : ' (teammate)'}, ${Math.round(r.dist / 16)} ft`;
}

function updatePov(players, cam, aimInfo) {
  const el = $('#pov'), ch = $('#crosshair');
  if (!cam.pov) {
    ch.classList.add('hidden');
    const p = selectedState(players);
    if (S.mode === 'eye' && !p) { el.classList.remove('hidden'); el.innerHTML = `${esc(nameOf(S.sel, S.t))} is not in the game right now`; return; }
    if (S.mode === 'eye' && p && p.hidden) { el.classList.remove('hidden'); el.innerHTML = `${esc(nameOf(S.sel, S.t))} is spectating`; return; }
    el.classList.add('hidden');
    return;
  }
  const p = cam.pov;
  ch.classList.toggle('hidden', p.dead);
  el.classList.remove('hidden');
  const pl = who(p.s, S.t);
  const vis = [], hid = [];
  const e = eyeOf(p);
  for (const q of players) {
    if (!alive(q) || !enemies(p, q)) continue;
    (canSee(e, q, S.fi) ? vis : hid).push(q);
  }
  const t = aimInfo[p.s];
  let line = `<b>${esc(pl ? pl.name : '#' + p.s)}</b> · ${esc(className(p.cls) || '')} ${esc(teamName(p.team))}`;
  const vit = vitalsAt(p.s, S.t);
  if (vit) line += ` · <span class="vit">${vit.hp} health · ${vit.ap} armor</span>`;
  line += ` <span class="muted">· enemies in sight ${vis.length}, behind cover ${hid.length}</span>`;
  if (p.dead) line += ' · <span class="muted">dead</span>';
  else if (t && t.behindWall) line += `<br><span class="warn">Crosshair on ${esc(nameOf(t.q.s, S.t))}, who is behind a wall (${Math.round(t.along / 16)} ft)</span>`;
  else if (t) line += `<br>Aiming at ${esc(nameOf(t.q.s, S.t))} (${Math.round(t.along / 16)} ft, in sight)`;
  if (prefs.hitboxes && !p.dead) line += lastShotLine(p);
  if (prefs.hitboxes) {
    const rw = unlagFor(p.s, S.t);
    if (rw > 0) line += `<br><span class="muted">Hitboxes are ${Math.round(rw * 1000)} ms back (ping ${pingAt(pl, S.t)} ms + 100 ms), where the server checks this player's shots</span>`;
  }
  el.innerHTML = line;
}

function updateFeeds() {
  const kf = $('#killfeed'), cf = $('#chatfeed');
  const ks = S.meta.kills.filter(k => k[0] <= S.t && k[0] > S.t - 6).slice(-5);
  kf.innerHTML = ks.map(k => `<div>${esc(nameOf(k[1], k[0]))} <span class="muted">[${esc(k[3])}]</span> ${esc(victimName(k))}</div>`).join('');
  const cs = S.meta.chat.filter(c => c[0] <= S.t && c[0] > S.t - 10).slice(-5);
  cf.innerHTML = cs.map(c => `<div>${esc(c[2])}</div>`).join('');
}

// ------------------------------------------------------------------ side panels
function setTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'edit') Editor.panel();
  refreshPanels(true);
}
function curTab() { const b = document.querySelector('.tabs button.on'); return b ? b.dataset.tab : 'players'; }


function refreshPanels(force) {
  if (!S.D) return;
  const now = performance.now();
  if (!force && now - S.lastPanel < 250) return;
  S.lastPanel = now;
  const tab = curTab();
  if (tab === 'players') renderPlayers();
  else if (tab === 'kills' || tab === 'chat') markPast(tab);
  else if (tab === 'edit') Editor.tick();
}

// The Players tab is built once per demo and never re-sorted: one row per person (rejoins merged by SteamID), ordered
// by the team they spent most of the demo on, then name. Only the text and colours in a row change, so rows stay put
// under the pointer; a row flashes when that player gets a kill or dies. The selected player's buttons sit in a card
// pinned to the top of the tab, so selecting someone never changes the height of a row.
function buildPlayerList() {
  const D = S.D, box = $('#tab-players');
  const byId = new Map();
  for (const pl of S.meta.players) {
    if (pl.hltv) continue;
    const id = pl.sid64 ? 'sid:' + pl.sid64 : (pl.bot ? 'bot:' : 'name:') + pl.name;
    let r = byId.get(id);
    if (!r) byId.set(id, r = { recs: [], teamTime: {} });
    const next = (D.byEnt[pl.ent] || []).find(o => o.first > pl.first);
    r.recs.push({ pl, t0: pl.first - 0.5, t1: next ? next.first : Infinity });
  }
  const span = Math.max(1, D.times[D.n - 1] - D.times[0]);
  const step = Math.max(1, Math.round(D.n / span / 2));        // ~2 samples a second
  for (const r of byId.values()) {
    for (const rec of r.recs) {
      const I = D.info[rec.pl.ent];
      if (!I) continue;
      for (let i = frameAt(rec.t0)[0]; i < D.n && D.times[i] < rec.t1; i += step) {
        if (!(I[i] & PF_PRESENT)) continue;
        const tm = (I[i] >> 5) & 7;
        if (tm) r.teamTime[tm] = (r.teamTime[tm] || 0) + 1;
      }
    }
    const best = Object.entries(r.teamTime).sort((a, b) => b[1] - a[1])[0];
    r.team = best ? +best[0] : 0;
    r.name = r.recs[r.recs.length - 1].pl.name;
    r.k = r.d = 0;
    r.shown = {};
  }
  const rows = [...byId.values()].sort((a, b) => ((a.team || 9) - (b.team || 9)) || a.name.localeCompare(b.name));
  let html = `<div class="pcard"><div class="pc-top"><span class="dot"></span><span class="nm"></span></div>
    <div class="pc-acts"><button class="btn" data-act="eye" title="Through their eyes (1)">Eyes</button><button class="btn" data-act="chase" title="Follow them (2)">Follow</button>
    <button class="btn" data-act="pip" title="This player's eyes in a corner of the screen, picture in picture (J)">PiP</button>
    <button class="btn" data-act="copy" title="Copy name, SteamID and profile link">Copy ID</button><a class="btn" data-act="profile" target="_blank" rel="noopener">Steam profile</a></div></div>`;
  let section = null;
  rows.forEach((r, n) => {
    const sec = r.team ? teamName(r.team) : 'No team';
    if (sec !== section) { html += `<div class="section">${esc(sec)}</div>`; section = sec; }
    html += `<div class="prow" data-r="${n}"><span class="dot"></span><span class="nm">${esc(r.name)}</span><span class="kd"></span><span class="sub"></span></div>`;
  });
  if (!rows.length) html += '<p class="muted" style="padding:8px">No players.</p>';
  box.innerHTML = html;
  for (const r of rows) {
    r.el = box.querySelector(`.prow[data-r="${rows.indexOf(r)}"]`);
    r.dotEl = r.el.querySelector('.dot'); r.kdEl = r.el.querySelector('.kd'); r.subEl = r.el.querySelector('.sub');
  }
  const card = box.querySelector('.pcard');
  S.plist = { D, rows, t: -Infinity, card, cardDot: card.querySelector('.dot'), cardName: card.querySelector('.nm'),
    cardProfile: card.querySelector('[data-act="profile"]'), cardShown: {} };
}

/** The record (slot occupancy) a player row has at time t, and whether they are in the game in that slot right now. */
function rowNow(r, t, i) {
  let rec = null;
  for (const x of r.recs) if (t >= x.t0 && t < x.t1) rec = x;
  const p = rec && S.D.info[rec.pl.ent] ? playerState(rec.pl.ent, i, 0) : null;   // some never appear as entities
  return { rec, p };
}

function rowKD(r, t) {
  let k = 0, d = 0;
  for (const x of S.meta.kills) {
    if (x[0] > t) break;
    if (x[2] > S.meta.maxclients) continue;                 // a building was destroyed
    for (const rec of r.recs) {
      if (x[0] < rec.t0 || x[0] >= rec.t1) continue;
      const e = rec.pl.ent;
      if (x[1] === e && x[2] !== e) k++;
      if (x[2] === e) d++;
    }
  }
  return [k, d];
}

function setIf(r, key, v, apply) {
  if (r.shown[key] === v) return;
  r.shown[key] = v;
  apply(v);
}

function renderPlayers() {
  if (!S.plist || S.plist.D !== S.D) buildPlayerList();
  const L = S.plist, t = S.t, i = S.fi;
  // flash only while the demo plays forward, not when jumping or rewinding
  const live = S.playing && S.dir > 0 && t > L.t && t - L.t < 1 + S.speed;
  let selRow = null, selNow = null;
  for (const r of L.rows) {
    const now = rowNow(r, t, i), p = now.p;
    const ent = now.rec ? now.rec.pl.ent : -1;
    const isSel = !!p && ent === S.sel;
    if (isSel) { selRow = r; selNow = now; }
    const [k, d] = rowKD(r, t);
    if (live && k > r.k) flashRow(r.el, 'flash-kill');
    if (live && d > r.d) flashRow(r.el, 'flash-death');
    r.k = k; r.d = d;
    const pl = now.rec ? now.rec.pl : r.recs[r.recs.length - 1].pl;
    let state;
    if (p) {
      state = p.hidden ? 'spectating' : p.dead ? 'dead' : [className(p.cls), weaponName(p.wm)].filter(Boolean).join(' · ');
      const vit = !p.dead && !p.hidden ? vitalsAt(p.s, t) : null;
      if (vit) state += ` · ${vit.hp} hp · ${vit.ap} armor`;
    } else if (t < r.recs[0].t0) state = 'joins at ' + fmtTime(r.recs[0].pl.first - S.meta.start);
    else state = 'not in the game';
    const steam = pl.sid64 ? `<a href="https://steamcommunity.com/profiles/${esc(pl.sid64)}" target="_blank" rel="noopener">${esc(pl.steam)}</a>` : esc(pl.steam);
    setIf(r, 'dot', p ? rgbCss(TEAM_RGB[p.team] || TEAM_RGB[0]) : '#555', v => { r.dotEl.style.background = v; });
    setIf(r, 'kd', `${k}/${d}`, v => { r.kdEl.textContent = v; });
    setIf(r, 'sub', `${esc(state)} · ${steam}${pl.ping != null ? ' · ' + pl.ping + ' ms' : ''}`, v => { r.subEl.innerHTML = v; });
    setIf(r, 'gone', !p, v => r.el.classList.toggle('gone', v));
    setIf(r, 'dead', !!(p && (p.dead || p.hidden)), v => r.el.classList.toggle('dead', v));
    setIf(r, 'sel', isSel, v => r.el.classList.toggle('sel', v));
    r.el.title = p ? 'Click to watch, double-click for their eyes' : 'Not in the game at this moment: click to jump to when they are';
  }
  L.t = t;
  // pinned card for the selected player
  const c = L.cardShown, pl = selNow && selNow.rec.pl;
  const name = pl ? pl.name : 'Click a player to watch them';
  if (c.name !== name) { c.name = name; L.cardName.textContent = name; }
  const dot = selNow ? rgbCss(TEAM_RGB[selNow.p.team] || TEAM_RGB[0]) : 'transparent';
  if (c.dot !== dot) { c.dot = dot; L.cardDot.style.background = dot; }
  const prof = pl && pl.sid64 ? 'https://steamcommunity.com/profiles/' + pl.sid64 : '';
  if (c.prof !== prof) { c.prof = prof; L.cardProfile.classList.toggle('hidden', !prof); if (prof) L.cardProfile.href = prof; }
  const key = (pl ? 'p' : '') + S.mode;
  if (c.key !== key) {
    c.key = key;
    L.card.classList.toggle('empty', !pl);
    L.card.querySelectorAll('[data-act="eye"],[data-act="chase"]').forEach(b => b.classList.toggle('on', !!pl && b.dataset.act === S.mode));
  }
  L.selRow = selRow;
}

function flashRow(el, cls) {
  el.classList.remove('flash-kill', 'flash-death');
  void el.offsetWidth;                                       // restart the animation
  el.classList.add(cls);
}

/** Click on a player row: watch them, or jump to when they are in the game if they are not right now. */
function clickPlayerRow(r, mode) {
  const i = S.fi;
  let now = rowNow(r, S.t, i);
  if (!now.p) {
    // nearest moment this person is in the game: their next appearance, else the last moment before now
    const D = S.D;
    const step = Math.max(1, Math.round(D.n / Math.max(1, D.times[D.n - 1] - D.times[0]) / 4));
    let next = Infinity, prev = -Infinity;
    for (const rec of r.recs) {
      const I = D.info[rec.pl.ent];
      if (!I) continue;
      for (let j = frameAt(Math.max(rec.t0, S.meta.start))[0]; j < D.n && D.times[j] < rec.t1; j += step) {
        if (!(I[j] & PF_PRESENT)) continue;
        const tj = D.times[j];
        if (tj >= S.t) { next = Math.min(next, tj); break; }
        prev = Math.max(prev, tj);
      }
    }
    const target = next < Infinity ? next : prev;
    if (!isFinite(target)) return;
    seek(target);
    S.fi = frameAt(S.t)[0];
    now = rowNow(r, S.t, S.fi);
    if (!now.rec) return;
  }
  selectPlayer(now.rec.pl.ent, mode || null);
}

function renderKills() {
  const box = $('#tab-kills');
  const ks = S.meta.kills;
  if (!ks.length) { box.innerHTML = '<p class="muted" style="padding:8px">No kills in this demo.</p>'; return; }
  box.innerHTML = ks.map((k, n) => `<div class="ev" data-t="${k[0]}" data-k="${n}"><span class="t">${fmtTime(k[0] - S.meta.start)}</span>
    <span>${esc(nameOf(k[1], k[0]))} <span class="k">→</span> ${esc(victimName(k))} <span class="w">${esc(k[3])}</span></span></div>`).join('');
}
function renderChat() {
  const box = $('#tab-chat');
  const cs = S.meta.chat;
  box.innerHTML = cs.length ? cs.map(c => `<div class="ev" data-t="${c[0]}"><span class="t">${fmtTime(c[0] - S.meta.start)}</span><span>${esc(c[2])}</span></div>`).join('')
    : '<p class="muted" style="padding:8px">No chat in this demo.</p>';
}
function markPast(tab) {
  document.querySelectorAll(`#tab-${tab} .ev`).forEach(el => el.classList.toggle('past', +el.dataset.t < S.t - 0.5));
}

/** Lag compensation on or off: every shot is tested again, and the Review scan runs again. */
function setUnlag(on) {
  prefs.unlag = !!on;
  savePrefs();
  $('#optUnlag').checked = prefs.unlag;
  shotHitCache.clear();
  if (S.D) runAnalysis();
  const b = $('#banner');
  b.textContent = prefs.unlag ? 'Lag compensation on: humans\' shots are tested where the others were on their screen.'
    : 'Lag compensation off: shots are tested against where everyone is in the demo.';
  b.classList.remove('hidden');
  clearTimeout(setUnlag.timer);
  setUnlag.timer = setTimeout(() => b.classList.add('hidden'), 3500);
}

function selectPlayer(s, mode) {
  S.sel = s;
  if (mode) setMode(mode);
  S.orbit.manual = false;
  refreshPanels(true);
}

// ------------------------------------------------------------------ review (wallhack / aim analysis)
function runAnalysis() {
  const D = S.D, n = D.n;
  const box = $('#tab-sus');
  if (!Object.values(S.maps).some(Boolean)) { box.innerHTML = '<p class="sus-head">The review needs the map file to test line of sight, and it was not found.</p>'; return; }
  const dur = Math.max(1, D.times[n - 1] - D.times[0]);
  const step = Math.max(1, Math.round(n / dur / 10));        // ~10 samples per second
  const runs = new Map();
  const found = [];
  const stats = {};
  const snaps = [];
  const prev = {};
  let i = 0;
  S.analysis = { running: true, found, stats, progress: 0 };
  renderReview();

  function closeRun(key, r) {
    runs.delete(key);
    const len = r.t1 - r.t0;
    // a real wall track means the aim had to follow: the direction to the target swept well beyond the aim cone
    if (len < 0.45 || r.moved < 80 || r.sweep < Math.max(2.5, 3 * r.tol)) return;
    const fired = (D.shotsBy.get(r.p) || []).filter(t => t >= r.t0 - 0.05 && t <= r.t1 + 0.05).length;
    const kill = S.meta.kills.find(k => k[1] === r.p && k[2] === r.e && k[0] >= r.t0 && k[0] <= r.t1 + 3);
    const score = len * (fired ? 2 : 1) * (kill ? 1.5 : 1);
    found.push({ kind: 'track', p: r.p, e: r.e, t0: r.t0, t1: r.t1, moved: r.moved, sweep: r.sweep, fired, kill: !!kill, score });
  }

  function sample(fi) {
    if (!mapForFrame(fi)) return;
    const t = D.times[fi];
    const ps = playersAt(fi, 0).filter(alive);
    for (const p of ps) {
      const st = stats[p.s] ||= { alive: 0, hidden: 0 };
      st.alive += step / (n / dur);
      const e = eyeOf(p), dir = forward(p.pitch, p.yaw);
      // a human aims at where the enemies were on their screen: the lag-compensated spots their shots are tested at
      const w = unlagWindow(t, unlagFor(p.s, t));
      for (const q0 of ps) {
        if (!enemies(p, q0)) continue;
        const q = w ? unlagStateW(q0, w) : q0;
        const c = chestOf(q), v = sub(c, e), dist = vlen(v);
        if (dist < 64 || dist > 3500) continue;
        const cosang = dot(v, dir) / dist;
        const tol = Math.atan2(16, dist) + 0.75 * DEG;
        if (cosang < Math.cos(tol)) continue;
        if (canSee(e, q, fi)) continue;
        st.hidden += step / (n / dur);
        const key = p.s * 64 + q.s;
        const r = runs.get(key);
        const u = mulv(v, 1 / dist);
        if (r && fi - r.last <= step * 2) {
          r.moved += Math.hypot(q.x - r.qx, q.y - r.qy, q.z - r.qz);
          r.qx = q.x; r.qy = q.y; r.qz = q.z; r.last = fi; r.t1 = t;
          r.sweep = Math.max(r.sweep, Math.acos(Math.min(1, dot(u, r.u0))) / DEG);
        } else {
          if (r) closeRun(key, r);
          runs.set(key, { p: p.s, e: q.s, t0: t, t1: t, last: fi, moved: 0, qx: q.x, qy: q.y, qz: q.z, u0: u, sweep: 0, tol: tol / DEG });
        }
      }
    }
    for (const [key, r] of runs) if (fi - r.last > step * 2) closeRun(key, r);
  }

  // snaps: a very fast turn that ends with the crosshair on an enemy's head, then a shot
  function snapScan(s) {
    const P = D.pos[s], I = D.info[s], shots = D.shotsBy.get(s) || [];
    if (!shots.length) return;
    let si = 0;
    for (let fi = 1; fi < n; fi++) {
      const a = I[fi], b = I[fi - 1];
      if (!(a & PF_PRESENT) || !(b & PF_PRESENT) || (a & (PF_DEAD | PF_NODRAW | PF_OBSERVER))) continue;
      const dt = D.times[fi] - D.times[fi - 1];
      if (dt <= 0 || dt > 0.1) continue;
      const dy = Math.abs(((P[fi * 5 + 4] - P[(fi - 1) * 5 + 4]) % 360 + 540) % 360 - 180);
      const dp = Math.abs(P[fi * 5 + 3] - P[(fi - 1) * 5 + 3]);
      const speed = Math.hypot(dy, dp) / dt;
      if (speed < 1500 || Math.hypot(dy, dp) < 12) continue;
      const t = D.times[fi];
      while (si < shots.length && shots[si] < t - 0.02) si++;
      if (si >= shots.length || shots[si] > t + 0.15) continue;
      const p = playerState(s, fi, 0);
      const e = eyeOf(p), dir = forward(p.pitch, p.yaw);
      const w = unlagWindow(t, unlagFor(s, t));
      for (const q0 of playersAt(fi, 0)) {
        if (!alive(q0) || !enemies(p, q0)) continue;
        const q = w ? unlagStateW(q0, w) : q0;
        const hd = headOf(q), v = sub(hd, e), dist = vlen(v);
        if (dist < 100) continue;
        const ang = Math.acos(Math.min(1, dot(v, dir) / dist)) / DEG;
        if (ang < Math.max(0.8, Math.atan2(5, dist) / DEG)) {
          snaps.push({ kind: 'snap', p: s, e: q.s, t0: t - 0.2, t1: t, speed: Math.round(speed), turn: Math.round(Math.hypot(dy, dp)), score: 0.6 });
          break;
        }
      }
    }
  }

  const mine = S.analysis;
  function chunk() {
    if (S.analysis !== mine || S.D !== D) return;              // another demo (or a new scan) took over
    const until = performance.now() + 14;
    while (i < n && performance.now() < until) { sample(i); i += step; }
    S.analysis.progress = i / n;
    const bar = $('#susBar');
    if (bar) bar.style.width = `${Math.round(S.analysis.progress * 100)}%`;
    if (i < n) { setTimeout(chunk, 0); return; }
    for (const [key, r] of runs) closeRun(key, r);
    for (const s of D.slots) snapScan(s);
    found.push(...snaps);
    S.analysis.running = false;
    S.analysis.found = found;
    renderReview();
    drawTimeline();
    const A = S.analysis;
    shotStats(st => { if (S.analysis === A) { A.shots = st; renderReview(); } });
  }
  setTimeout(chunk, 0);
}

function renderReview() {
  const box = $('#tab-sus');
  const A = S.analysis;
  let html = `<div class="sus-head">Moments where a player's crosshair follows a <b>moving enemy behind a wall</b>, and very fast <b>snaps onto a head</b> right before a shot.
    Leads to watch, not proof: click one to watch it through their eyes with X-ray on.</div>`;
  if (!A || A.running) {
    html += `<div class="bar-mini"><div id="susBar" style="width:${Math.round((A?.progress || 0) * 100)}%"></div></div><p class="muted" style="padding:0 8px">Scanning the demo…</p>`;
  } else {
    const byP = new Map();
    for (const f of A.found) { let a = byP.get(f.p); if (!a) byP.set(f.p, a = []); a.push(f); }
    const order = [...byP.entries()].map(([s, list]) => ({ s, list, score: list.reduce((a, f) => a + f.score, 0) }))
      .sort((a, b) => b.score - a.score);
    if (!order.length) html += '<p class="muted" style="padding:0 8px">Nothing stood out in this demo.</p>';
    for (const o of order) {
      const pl = who(o.s, o.list[0].t0);
      const st = A.stats[o.s] || { alive: 1, hidden: 0 };
      const tracks = o.list.filter(f => f.kind === 'track'), snaps = o.list.filter(f => f.kind === 'snap');
      const team = S.D.info[o.s] ? (S.D.info[o.s].find(v => v & PF_PRESENT) >> 5) & 7 : 0;
      html += `<div class="sus-player"><div class="h"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${rgbCss(TEAM_RGB[team] || TEAM_RGB[0])}"></span>
        ${esc(pl ? pl.name : '#' + o.s)}<span class="score">${o.score.toFixed(1)}</span></div>
        <div class="meta">${esc(pl ? pl.steam : '')} · ${tracks.length} wall tracks, ${snaps.length} snaps · aim on hidden enemies ${(100 * st.hidden / Math.max(1, st.alive)).toFixed(1)}% of alive time</div>`;
      for (const f of o.list.sort((a, b) => a.t0 - b.t0).slice(0, 40)) {
        const what = f.kind === 'track'
          ? `followed ${esc(nameOf(f.e, f.t0))} through a wall for ${(f.t1 - f.t0).toFixed(1)} s (aim turned ${Math.round(f.sweep)}°)${f.fired ? `, fired ${f.fired}×` : ''}${f.kill ? ', then killed them' : ''}`
          : `snapped ${f.turn}° (${f.speed}°/s) onto ${esc(nameOf(f.e, f.t0))}'s head and fired`;
        html += `<div class="sus-item" data-t="${f.t0}" data-p="${f.p}"><span class="t">${fmtTime(f.t0 - S.meta.start)}</span><span>${what}</span></div>`;
      }
      html += '</div>';
    }
    if (A.shots) {
      // a head share only means something over enough hits: rank those, list the rest after without a percentage
      const MIN_HITS = 15;
      const all = Object.entries(A.shots).filter(([, st]) => st.shots >= 5).map(([s, st]) => ({ s: +s, ...st }));
      const rows = all.filter(r => r.hits >= MIN_HITS).sort((a, b) => b.head / b.hits - a.head / a.hits || b.hits - a.hits)
        .concat(all.filter(r => r.hits < MIN_HITS).sort((a, b) => b.hits - a.hits));
      if (rows.length) {
        html += `<div class="section">Bullets vs hitboxes</div><div class="sus-head">For each bullet or melee hit, whether the centre of the aim
          went through an enemy's hitbox (as the server tested them, with its lag compensation for human shooters; shotgun spread not counted), and how many of those were the head.
          A very high head share on many hits is worth a look in Eyes view with hitboxes on (K).
          Players with fewer than ${MIN_HITS} hits are listed last, without a percentage.</div>`;
        for (const r of rows) {
          const pl = who(r.s, S.meta.end);
          const pct = r.hits >= MIN_HITS ? Math.round(100 * r.head / r.hits) + '%' : '–';
          html += `<div class="sus-item" data-t="${S.D.traceShots[S.D.traceBy.get(r.s)[0]].t}" data-p="${r.s}"><span class="t">${pct}</span>
            <span>${esc(pl ? pl.name : '#' + r.s)}: ${r.shots} shots, ${r.hits} through an enemy, ${r.head} in the head</span></div>`;
        }
      }
    }
  }
  if (S.marks.length) {
    html += '<div class="section">Bookmarks</div>';
    for (const m of S.marks) html += `<div class="sus-item" data-t="${m.t}" data-p="${m.s}"><span class="t">${fmtTime(m.t - S.meta.start)}</span><span>${esc(m.label)}</span></div>`;
    html += '<div style="padding:6px 8px"><button class="btn" id="copyMarks">Copy bookmarks as text</button></div>';
  }
  box.innerHTML = html;
}

// ------------------------------------------------------------------ timeline
const tl = $('#tl');
function drawTimeline() {
  if (!S.D) return;
  const dpr = window.devicePixelRatio || 1;
  const w = tl.clientWidth, h = tl.clientHeight;
  if (tl.width !== Math.round(w * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
  const c = tl.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const t0 = S.meta.start, t1 = Math.max(S.meta.end, t0 + 0.01);
  const X = t => (t - t0) / (t1 - t0) * w;
  c.fillStyle = '#2a2f3a'; c.fillRect(0, h / 2 - 3, w, 6);
  c.fillStyle = '#5a6272'; c.fillRect(0, h / 2 - 3, X(S.t), 6);
  if (S.analysis && !S.analysis.running) {
    c.fillStyle = 'rgba(240,160,48,.9)';
    for (const f of S.analysis.found) c.fillRect(X(f.t0) - 1, 2, Math.max(2, X(f.t1) - X(f.t0)), 7);
  }
  c.fillStyle = 'rgba(240,82,82,.85)';
  for (const k of S.meta.kills) c.fillRect(X(k[0]) - 0.5, h - 10, 1.5, 8);
  c.fillStyle = '#fff';
  for (const m of S.marks) c.fillRect(X(m.t) - 1, 0, 2, h);
  Editor.drawTimeline(c, X, w, h);
  const x = X(S.t);
  c.fillStyle = '#f0a030';
  c.beginPath(); c.arc(x, h / 2, 6, 0, Math.PI * 2); c.fill();
}
function timeFromX(clientX) {
  const r = tl.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return S.meta.start + f * (S.meta.end - S.meta.start);
}
tl.addEventListener('mousedown', e => {
  if (!S.D) return;
  S.scrub = true; S.wasPlaying = S.playing; S.playing = false;
  seek(timeFromX(e.clientX));
});
window.addEventListener('mousemove', e => {
  if (S.scrub) seek(timeFromX(e.clientX));
  if (!S.D) return;
  const r = tl.getBoundingClientRect(), tip = $('#tlTip');
  if (e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4 && e.clientX >= r.left && e.clientX <= r.right) {
    const t = timeFromX(e.clientX);
    const k = S.meta.kills.find(k => Math.abs(k[0] - t) < (S.meta.end - S.meta.start) / r.width * 3);
    tip.textContent = fmtTime(t - S.meta.start) + (k ? `  ${nameOf(k[1], k[0])} → ${victimName(k)}` : '');
    tip.style.left = `${e.clientX - r.left}px`;
    tip.classList.remove('hidden');
  } else tip.classList.add('hidden');
});
window.addEventListener('mouseup', () => { if (S.scrub) { S.scrub = false; S.playing = S.wasPlaying; } });

function seek(t) {
  S.t = Math.min(S.meta.end, Math.max(S.meta.start, t));
}
function stepFrame(d) {
  S.playing = false;
  const [i] = frameAt(S.t + 1e-4);
  const j = Math.min(S.D.n - 1, Math.max(0, i + d));
  S.t = S.D.times[j];
}

// ------------------------------------------------------------------ controls
function setMode(m) {
  Editor.stopPreview();
  if (m === 'free' && lastCam) { S.cam.pos = lastCam.pos.slice(); S.cam.pitch = lastCam.pitch; S.cam.yaw = lastCam.yaw; S.cam.fov = lastCam.fov || 90; }
  if (m === 'top') {
    const p = S.D && selectedState(playersAt(S.fi, 0));
    if (p) { S.top.x = p.x; S.top.y = p.y; }
    else if (lastCam) { S.top.x = lastCam.pos[0]; S.top.y = lastCam.pos[1]; }
  }
  if (m === 'chase') { S.orbit.manual = false; }
  S.mode = m; prefs.mode = m; savePrefs();
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
}
function cyclePlayer(d) {
  const ps = playersAt(S.fi, 0).filter(p => !p.hidden && !(who(p.s, S.t)?.hltv)).map(p => p.s).sort((a, b) => a - b);
  if (!ps.length) return;
  const k = ps.indexOf(S.sel);
  selectPlayer(ps[((k < 0 ? 0 : k + d) % ps.length + ps.length) % ps.length]);
}
function setSpeed(v) {
  S.speed = v; prefs.speed = v; savePrefs();
  const sel = $('#speed');
  if ([...sel.options].some(o => +o.value === v)) sel.value = String(v);
}
function changeSpeed(d) {
  const opts = [...$('#speed').options].map(o => +o.value);
  let k = opts.indexOf(S.speed); if (k < 0) k = 3;
  setSpeed(opts[Math.min(opts.length - 1, Math.max(0, k + d))]);
}
function togglePlay() {
  if (!S.D) return;
  if (!S.playing && S.dir > 0 && S.t >= S.meta.end - 0.01) S.t = S.meta.start;
  if (!S.playing && S.dir < 0 && S.t <= S.meta.start + 0.01) S.t = S.meta.end;
  S.playing = !S.playing;
}
function addMark() {
  const pl = who(S.sel, S.t);
  const label = `${wallAt(S.t) || fmtTime(S.t - S.meta.start)} ${pl ? pl.name : ''} ${pl && pl.steam ? '(' + pl.steam + ')' : ''}`.trim();
  S.marks.push({ t: S.t, s: S.sel, label });
  try { localStorage.setItem('hltvviewer.marks.' + S.meta.file, JSON.stringify(S.marks)); } catch (e) { /* ignore */ }
  renderReview();
  drawTimeline();
}

function bindUI() {
  document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  const opt = (id, key) => { const el = $(id); el.checked = !!prefs[key]; el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); }); };
  const vol = $('#optVol'), mute = $('#btnMute');
  const applyVol = () => {
    GameAudio.setVolume(prefs.volume, prefs.muted);
    mute.textContent = prefs.muted || !prefs.volume ? '🔇' : '🔊';
    vol.value = String(prefs.volume);
  };
  vol.addEventListener('input', () => { prefs.volume = +vol.value; prefs.muted = false; savePrefs(); GameAudio.unlock(); applyVol(); });
  vol.addEventListener('change', () => vol.blur());
  mute.addEventListener('click', () => { prefs.muted = !prefs.muted; savePrefs(); GameAudio.unlock(); applyVol(); });
  applyVol();
  S.toggleMute = () => { prefs.muted = !prefs.muted; savePrefs(); applyVol(); };
  // browsers start audio only after the user does something on the page
  window.addEventListener('pointerdown', () => GameAudio.unlock(), { capture: true });
  window.addEventListener('keydown', () => GameAudio.unlock(), { capture: true });
  opt('#optXray', 'xray'); opt('#optAim', 'aim'); opt('#optNames', 'names'); opt('#optHit', 'hitboxes');
  const unlagBox = $('#optUnlag');
  unlagBox.checked = prefs.unlag !== false;
  unlagBox.addEventListener('change', () => { setUnlag(unlagBox.checked); unlagBox.blur(); });
  $('#btnOpen').addEventListener('click', showPicker);
  $('#pickClose').addEventListener('click', () => { if (S.D) $('#picker').classList.add('hidden'); });
  $('#pickRefresh').addEventListener('click', showPicker);
  $('#btnHelp').addEventListener('click', () => $('#help').classList.remove('hidden'));
  $('#helpClose').addEventListener('click', () => $('#help').classList.add('hidden'));
  $('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').classList.add('hidden'); });
  $('#bPlay').addEventListener('click', () => { S.dir = 1; togglePlay(); });
  $('#bRew').addEventListener('click', () => { if (S.dir > 0 || !S.playing) { S.dir = -1; S.playing = true; } else S.playing = false; });
  $('#bStart').addEventListener('click', () => seek(S.meta.start));
  $('#bBack').addEventListener('click', () => seek(S.t - 10));
  $('#bFwd').addEventListener('click', () => seek(S.t + 10));
  $('#bStepB').addEventListener('click', () => stepFrame(-1));
  $('#bStepF').addEventListener('click', () => stepFrame(1));
  $('#bMark').addEventListener('click', addMark);
  $('#speed').value = String(S.speed);
  $('#speed').addEventListener('change', e => { setSpeed(+e.target.value); e.target.blur(); });

  $('#tab-players').addEventListener('click', e => {
    if (!S.plist) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) {
      const sel = S.plist.selRow && rowNow(S.plist.selRow, S.t, S.fi).rec;
      if (!sel) return;
      if (act === 'copy') {
        const pl = sel.pl;
        navigator.clipboard?.writeText(`${pl.name}  ${pl.steam}${pl.sid64 ? '  https://steamcommunity.com/profiles/' + pl.sid64 : ''}`);
      } else if (act === 'eye' || act === 'chase') selectPlayer(sel.pl.ent, act);
      else if (act === 'pip') setPip(S.pip && !S.pip.target && S.pip.s === sel.pl.ent ? null : { s: sel.pl.ent, mode: (S.pip && S.pip.mode) || 'eye' });
      return;
    }
    if (e.target.tagName === 'A') return;
    const row = e.target.closest('.prow');
    if (row) clickPlayerRow(S.plist.rows[+row.dataset.r]);
  });
  $('#tab-players').addEventListener('dblclick', e => {
    const row = e.target.closest('.prow');
    if (row && S.plist && e.target.tagName !== 'A') clickPlayerRow(S.plist.rows[+row.dataset.r], 'eye');
  });
  const jump = (e, mode) => {
    const el = e.target.closest('[data-t]');
    if (!el) return;
    const t = +el.dataset.t;
    if (el.dataset.k !== undefined) {
      const k = S.meta.kills[+el.dataset.k];
      seek(t - 4); selectPlayer(k[1] > 0 && k[1] !== k[2] ? k[1] : k[2], 'eye');
    } else if (el.dataset.p !== undefined) {
      seek(t - 2); selectPlayer(+el.dataset.p, 'eye');
      if (!prefs.xray) { prefs.xray = true; $('#optXray').checked = true; savePrefs(); }
    } else seek(t - 2);
    S.playing = true; S.dir = 1;
  };
  $('#tab-kills').addEventListener('click', e => jump(e));
  $('#tab-chat').addEventListener('click', e => jump(e));
  $('#tab-sus').addEventListener('click', e => {
    if (e.target.id === 'copyMarks') {
      const txt = [`Demo ${S.meta.file} (map ${S.meta.map})`, ...S.marks.map(m => `${fmtTime(m.t - S.meta.start)} into the demo  ${m.label}`)].join('\n');
      navigator.clipboard?.writeText(txt);
      return;
    }
    jump(e);
  });

  // 3D view: drag to look / orbit / pan, wheel to zoom, click to select
  canvas.addEventListener('mousedown', e => {
    S.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    const d = S.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY; d.moved += Math.abs(dx) + Math.abs(dy);
    if (S.mode === 'free') { S.cam.yaw -= dx * 0.25; S.cam.pitch = Math.max(-89, Math.min(89, S.cam.pitch + dy * 0.25)); }
    else if (S.mode === 'chase' || S.mode === 'eye') {
      if (!S.orbit.manual && lastCam) { S.orbit.yaw = lastCam.yaw; }
      S.orbit.manual = true;
      S.orbit.yaw -= dx * 0.35; S.orbit.pitch = Math.max(-80, Math.min(89, S.orbit.pitch + dy * 0.3));
      if (S.mode === 'eye') setMode('chase');
    } else if (S.mode === 'top') { const k = S.top.h / 900; S.top.x -= dx * k; S.top.y += dy * k; }
  });
  window.addEventListener('mouseup', e => {
    const d = S.drag;
    S.drag = null;
    canvas.classList.remove('dragging');
    if (d && d.moved < 4 && e.target === canvas) pickAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0012);
    if (S.mode === 'chase' || S.mode === 'eye') { S.orbit.dist = Math.max(40, Math.min(3000, S.orbit.dist * k)); if (S.mode === 'eye') setMode('chase'); }
    else if (S.mode === 'top') S.top.h = Math.max(300, Math.min(12000, S.top.h * k));
    else S.cam.pos = addv(S.cam.pos, mulv(forward(S.cam.pitch, S.cam.yaw), -e.deltaY * 0.8));
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    S.keys[k.toLowerCase()] = true;
    if (k === 'Escape') { $('#help').classList.add('hidden'); if (S.D) $('#picker').classList.add('hidden'); return; }
    if (!S.D) return;
    let used = true;
    if (k === ' ') { S.dir = 1; togglePlay(); }
    else if (k === 'r' || k === 'R') { S.dir = -S.dir; if (!S.playing) S.playing = true; }
    else if (k === 'ArrowLeft') seek(S.t - (e.shiftKey ? 15 : 5));
    else if (k === 'ArrowRight') seek(S.t + (e.shiftKey ? 15 : 5));
    else if (k === ',') stepFrame(-1);
    else if (k === '.') stepFrame(1);
    else if (k === '[' || k === '-') changeSpeed(-1);
    else if (k === ']' || k === '=' || k === '+') changeSpeed(1);
    else if (k === 'Home') seek(S.meta.start);
    else if (k === 'End') seek(S.meta.end);
    else if (k === '1') setMode('eye');
    else if (k === '2') setMode('chase');
    else if (k === '3') setMode('free');
    else if (k === '4') setMode('top');
    else if (k === 'Tab') cyclePlayer(e.shiftKey ? -1 : 1);
    else if (k === 'x' || k === 'X') { prefs.xray = !prefs.xray; $('#optXray').checked = prefs.xray; savePrefs(); }
    else if (k === 'l' || k === 'L') { prefs.aim = !prefs.aim; $('#optAim').checked = prefs.aim; savePrefs(); }
    else if (k === 'n' || k === 'N') { prefs.names = !prefs.names; $('#optNames').checked = prefs.names; savePrefs(); }
    else if (k === 'm' || k === 'M') S.toggleMute();
    else if (k === 'k' || k === 'K') { prefs.hitboxes = !prefs.hitboxes; $('#optHit').checked = prefs.hitboxes; savePrefs(); }
    else if (k === 'u' || k === 'U') setUnlag(!prefs.unlag);
    else if (k === 'j' || k === 'J') setPip(S.pip ? null : (S.lastPip || { target: true, mode: 'eye' }));
    else if (k === 'h' || k === 'H' || k === '?') $('#help').classList.toggle('hidden');
    else if (k === 'b' || k === 'B') addMark();
    else if (k === '9' || k === '0') { if (S.mode === 'free') S.cam.fov = Math.max(10, Math.min(130, (S.cam.fov || 90) + (k === '9' ? 5 : -5))); }
    else if (Editor.key(k)) { /* edit keys: C, I, O, P */ }
    else if (k === 'PageDown') cyclePlayer(1);
    else if (k === 'PageUp') cyclePlayer(-1);
    else used = 'wasdqe'.includes(k.toLowerCase()) && S.mode === 'free';
    if (used) e.preventDefault();
  });
  window.addEventListener('keyup', e => { S.keys[e.key.toLowerCase()] = false; });
  $('#pip').addEventListener('click', e => {
    const b = e.target.closest('[data-pip]');
    if (!b) { swapPip(); return; }
    const a = b.dataset.pip, cur = S.pip || {};
    if (a === 'close') setPip(null);
    else if (a === 'swap') swapPip();
    else if (a === 'target') setPip(cur.target ? { s: (S.pipShown && S.pipShown.s) || S.sel, mode: cur.mode || 'eye' } : { target: true, mode: cur.mode || 'eye' });
    else if (a === 'corner') { const order = ['br', 'bl', 'tl', 'tr']; prefs.pipCorner = order[(order.indexOf(prefs.pipCorner) + 1) % 4]; savePrefs(); }
    else if (a === 'size') { const sizes = [0.22, 0.3, 0.4]; prefs.pipSize = sizes[(sizes.indexOf(prefs.pipSize) + 1) % sizes.length] || 0.3; savePrefs(); }
    else setPip({ ...cur, mode: a });
    e.stopPropagation();
  });
  window.addEventListener('blur', () => { S.keys = {}; });

  // drag & drop a demo file
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop').classList.remove('hidden'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('#drop').classList.add('hidden');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    try {
      showLoading('Uploading ' + f.name + '…', 0.02, '');
      const r = await fetchJSON('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
      openDemo(r.id);
    } catch (err) { hideLoading(); alert('Could not open that file: ' + err.message); }
  });
  window.addEventListener('resize', drawTimeline);
}

function pickAt(cx, cy) {
  if (!S.D || !lastCam) return;
  const r = canvas.getBoundingClientRect();
  const P = M4.persp(fovY(lastCam.fov), r.width / r.height, 4, 16384);
  const VP = M4.mul(P, M4.view(lastCam.pos, lastCam.pitch, lastCam.yaw));
  let best = null, bd = 40;
  for (const p of playersAt(S.fi, 0)) {
    if (p.hidden) continue;
    const sp = project(VP, [p.x, p.y, p.z + 10], r.width, r.height);
    if (!sp) continue;
    const d = Math.hypot(sp[0] - (cx - r.left), sp[1] - (cy - r.top));
    if (d < bd) { bd = d; best = p; }
  }
  if (best) selectPlayer(best.s);
}

function freeCamMove(dt) {
  if (S.mode !== 'free') return;
  const k = S.keys, sp = (k.shift ? 1400 : 500) * dt;
  const f = forward(S.cam.pitch, S.cam.yaw), y = S.cam.yaw * DEG, r = [Math.sin(y), -Math.cos(y), 0];
  let m = [0, 0, 0];
  if (k.w) m = addv(m, f);
  if (k.s) m = sub(m, f);
  if (k.d) m = addv(m, r);
  if (k.a) m = sub(m, r);
  if (k.e) m = addv(m, [0, 0, 1]);
  if (k.q) m = sub(m, [0, 0, 1]);
  S.cam.pos = addv(S.cam.pos, mulv(m, sp));
}

// ------------------------------------------------------------------ picker
async function showPicker() {
  $('#picker').classList.remove('hidden');
  const box = $('#pickList');
  box.innerHTML = '<p class="muted">Looking for demos…</p>';
  try {
    const r = await fetchJSON('/api/demos');
    if (!r.demos.length) { box.innerHTML = `<p class="muted">No demos found yet. Recordings will appear here (${esc(r.output_dir)}).</p>`; return; }
    let html = '', group = null;
    for (const d of r.demos) {
      if (d.folder !== group) { html += `<div class="pickgroup">${esc(d.folder)}</div>`; group = d.folder; }
      const date = new Date(d.mtime * 1000);
      html += `<div class="pick" data-id="${d.id}"><span class="f">${esc(d.name)}${d.recording ? '<span class="live">● recording</span>' : ''}</span>
        <span class="m">${esc(d.map)}</span><span class="d">${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0, 5)}</span>
        <span class="s">${(d.size / 1e6).toFixed(1)} MB</span>${d.players_txt ? `<a href="/api/demo/${d.id}/players" target="_blank" rel="noopener">players</a>` : '<span></span>'}</div>`;
    }
    box.innerHTML = html;
  } catch (e) { box.innerHTML = `<p class="muted">Could not list demos: ${esc(e.message)}</p>`; }
}
$('#pickList').addEventListener('click', e => {
  if (e.target.tagName === 'A') return;
  const row = e.target.closest('.pick');
  if (row) openDemo(row.dataset.id);
});

// ------------------------------------------------------------------ start a demo
function startDemo() {
  const m = S.meta;
  S.t = m.start;
  S.playing = false;
  S.dir = 1;
  S.analysis = null;
  blockCache = { fi: -1, list: [] };
  shotHitCache.clear();
  try { S.marks = JSON.parse(localStorage.getItem('hltvviewer.marks.' + m.file) || '[]'); } catch (e) { S.marks = []; }
  // first real player who is in the game early on
  let sel = 0;
  for (let fi = 0; fi < S.D.n && !sel; fi += Math.max(1, Math.floor(S.D.n / 200))) {
    for (const p of playersAt(fi, 0)) { const pl = who(p.s, S.D.times[fi]); if (alive(p) && pl && !pl.hltv) { sel = p.s; S.t = Math.max(m.start, S.D.times[fi]); break; } }
  }
  S.sel = sel || S.D.slots[0] || 0;
  const p0 = selectedState(playersAt(frameAt(S.t)[0], 0));
  if (p0) { S.cam.pos = [p0.x - 200, p0.y, p0.z + 80]; S.cam.yaw = 0; S.cam.pitch = 15; S.top.x = p0.x; S.top.y = p0.y; }
  else if (S.map) {
    const sp = S.map.meta.spawns[0] || [0, 0, 0];
    S.cam.pos = [sp[0], sp[1], sp[2] + 64];
  }
  setMode(S.mode || 'chase');
  S.shownLevel = null;
  const ban = $('#banner');
  const notes = [];
  const missing = Object.keys(S.mapErrors);
  if (missing.length) notes.push(`Map ${missing.join(', ')} not found in your Half-Life folders, so players are shown over a grid there.`);
  if (m.levels.length > 1) notes.push(`This demo goes through ${m.levels.length} maps: ${m.levels.map(l => l.map).join(' → ')}.`);
  if (!m.hltv) notes.push('Client demo: only what the recording player could see is in it (other players come and go).');
  if (m.warnings && m.warnings.length) notes.push(`${m.warnings.length} decode warning(s); parts of the demo may be missing.`);
  ban.innerHTML = notes.map(esc).join('<br>');
  ban.classList.toggle('hidden', !notes.length);
  if (notes.length) setTimeout(() => ban.classList.add('hidden'), 9000);
  renderKills(); renderChat(); refreshPanels(true);
  Editor.open(S.id);
  runAnalysis();
  drawTimeline();
  setTimeout(drawTimeline, 50);
}

function noteLevel(lv) {
  if (S.shownLevel === lv) return;
  S.shownLevel = lv;
  const m = S.meta;
  const host = m.server && m.server.hostname ? ` · ${m.server.hostname.replace(/(:\d+)+$/, '')}` : '';
  const many = m.levels.length > 1 ? ` (map ${m.levels.indexOf(lv) + 1} of ${m.levels.length})` : '';
  $('#demoTitle').textContent = `${m.file} · ${lv.map}${many}${host} · ${fmtTime(m.duration)}${m.hltv ? ' · HLTV' : ' · client demo'}${m.live ? ' · still recording' : ''}`;
  blockCache = { fi: -1, list: [] };
}

/** Starts the sounds due since the last frame while the demo plays forward at up to 2x; a jump restarts the ambience. */
function updateSound() {
  const rate = S.speed * (Editor.active() ? Editor.speedAt(S.t) : 1);
  const audible = S.playing && S.dir > 0 && !S.scrub && rate <= 2 && prefs.volume > 0 && !prefs.muted;
  if (audible && GameAudio.running()) {
    if (S.audioT == null || S.t < S.audioT || S.t - S.audioT > 0.75) {
      GameAudio.stopAll();
      FX.startStatics(S.t);
    } else {
      GameAudio.setRate(rate);
      FX.playSounds(S.audioT, S.t);
    }
    S.audioT = S.t;
  } else if (S.audioT != null) {
    GameAudio.stopAll();
    S.audioT = null;
  }
}

// ------------------------------------------------------------------ main loop
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (Editor.exporting()) { requestAnimationFrame(loop); return; }      // the export drives the clock and the renderer
  if (S.D) {
    if (S.playing && !S.scrub) {
      S.t += dt * S.speed * S.dir * (Editor.active() ? Editor.speedAt(S.t) : 1);
      Editor.afterAdvance();
      if (S.t >= S.meta.end) { S.t = S.meta.end; S.playing = false; }
      if (S.t <= S.meta.start) { S.t = S.meta.start; S.playing = false; }
    }
    freeCamMove(dt);
    updateSound();
    render();
    if (lastCam) { GameAudio.setListener(lastCam.pos, lastCam.yaw, lastCam.pov ? lastCam.pov.s : -1); GameAudio.update(); }
    drawTimeline();
    const span = S.meta.end - S.meta.start;
    const wall = wallAt(S.t);
    $('#clock').textContent = `${S.dir < 0 && S.playing ? '◀ ' : ''}${fmtTime(S.t - S.meta.start)} / ${fmtTime(span)}${wall ? '  ' + wall : ''}  ${S.speed}×`;
    $('#bPlay').textContent = S.playing && S.dir > 0 ? '❚❚' : '▶';
    $('#bRew').classList.toggle('on', S.playing && S.dir < 0);
    refreshPanels(false);
  } else render();
  requestAnimationFrame(loop);
}

(function main() {
  if (!gl) {
    document.body.innerHTML = '<p style="padding:20px">This browser has no WebGL2, which the viewer needs. Try a current Chrome, Edge or Firefox.</p>';
    return;
  }
  initGL();
  FX.init();
  bindUI();
  Editor.bind();
  setMode(S.mode);
  const m = /demo=([0-9a-f]+)/.exec(location.hash);
  if (m) openDemo(m[1]); else showPicker();
  requestAnimationFrame(loop);
})();
