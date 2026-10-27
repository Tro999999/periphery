// Periphery rendering engine.
// Reads frames from a <video>, builds a peripheral "extension" for left/right side screens
// (Infinity-by-Nine style): edge colour stretch + camera-pan advection + progressive blur,
// brightness falloff, temporal smoothing, scene-cut reset and dithering.
(function (g) {
  if (g.PeripheryEngine) return;

  const E_W = 256, E_H = 144;          // side buffer resolution (world space)
  const TH_W = 256, TH_H = 144;        // analysis thumbnail
  const PROFILE_H = 256;               // edge colour profile rows

  // ---------------------------------------------------------------- shaders
  const VS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
`;

  const FS_THUMB = HEAD + `
uniform sampler2D uVideo;
void main(){ fragColor = vec4(texture(uVideo, vUv).rgb, 1.0); }`;

  // Edge colour profile: weighted average of a thin band at the content edge, per row,
  // temporally smoothed.
  const FS_PROFILE = HEAD + `
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform vec4 uRect;
uniform float uSide;
uniform float uBand;
uniform float uLod;
uniform float uAlpha;
void main(){
  float y = vUv.y;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = (float(i) + 0.5) / 8.0;
    float xw = uSide < 0.0 ? t * uBand : 1.0 - t * uBand;
    vec2 uv = vec2(mix(uRect.x, uRect.z, xw), mix(uRect.y, uRect.w, y));
    float w = exp(-2.5 * t);
    acc += textureLod(uVideo, uv, uLod).rgb * w;
    ws += w;
  }
  vec3 c = acc / ws;
  vec3 prev = texture(uPrev, vec2(0.5, y)).rgb;
  fragColor = vec4(mix(prev, c, uAlpha), 1.0);
}`;

  // Pan buffer E: rgb = content that left the frame (advected outward with camera motion),
  // a = confidence, fading over time.
  const FS_ADVECT = HEAD + `
uniform sampler2D uVideo;
uniform sampler2D uPrevE;
uniform vec4 uRect;
uniform float uSide;
uniform float uDmax;
uniform vec2 uYRange;
uniform vec2 uVel;
uniform float uDecay;
uniform float uLod;
uniform float uReset;
void main(){
  if (uReset > 0.5) { fragColor = vec4(0.0); return; }
  float d = vUv.x * uDmax;
  float yw = mix(uYRange.x, uYRange.y, vUv.y);
  float sd = d - uSide * uVel.x;
  float sy = yw - uVel.y;
  vec4 E = vec4(0.0);
  if (sd < 0.0) {
    if (sy >= 0.0 && sy <= 1.0) {
      float u = 0.5 + uSide * (0.5 + sd);
      vec2 uv = vec2(mix(uRect.x, uRect.z, u), mix(uRect.y, uRect.w, sy));
      E = vec4(textureLod(uVideo, uv, uLod).rgb, 1.0);
    }
  } else if (sd <= uDmax && sy >= uYRange.x && sy <= uYRange.y) {
    E = texture(uPrevE, vec2(sd / uDmax, (sy - uYRange.x) / (uYRange.y - uYRange.x)));
  }
  fragColor = vec4(E.rgb, max(E.a * (1.0 - uDecay) - 0.002, 0.0));
}`;

  // Compose C: static edge extension whose vertical spread grows with distance
  // (a soft "light cone" instead of hard horizontal streaks), overlaid with the pan buffer.
  const FS_COMPOSE = HEAD + `
uniform sampler2D uE;
uniform sampler2D uP0;
uniform sampler2D uP1;
uniform sampler2D uP2;
uniform sampler2D uP3;
uniform vec2 uYRange;
uniform float uDmax;
uniform float uGap;
uniform float uDetail;
uniform float uSpread;
vec3 P0(float y){ return texture(uP0, vec2(0.5, clamp(y, 0.0, 1.0))).rgb; }
vec3 P1(float y){ return texture(uP1, vec2(0.5, clamp(y, 0.0, 1.0))).rgb; }
vec3 P2(float y){ return texture(uP2, vec2(0.5, clamp(y, 0.0, 1.0))).rgb; }
vec3 P3(float y){ return texture(uP3, vec2(0.5, clamp(y, 0.0, 1.0))).rgb; }
void main(){
  float yw = mix(uYRange.x, uYRange.y, vUv.y);
  float d = vUv.x * uDmax;
  float k = clamp((d - uGap * 0.5) / max(uDmax - uGap * 0.5, 1e-3), 0.0, 1.0);
  float lv = clamp(pow(k, 0.6) * 3.0 * uSpread, 0.0, 3.0);
  vec3 S;
  if (lv < 1.0) S = mix(P0(yw), P1(yw), lv);
  else if (lv < 2.0) S = mix(P1(yw), P2(yw), lv - 1.0);
  else S = mix(P2(yw), P3(yw), lv - 2.0);
  vec4 E = texture(uE, vUv);
  fragColor = vec4(mix(S, E.rgb, clamp(E.a, 0.0, 1.0) * uDetail), 1.0);
}`;

  const FS_COPY = HEAD + `
uniform sampler2D uSrc;
void main(){ fragColor = texture(uSrc, vUv); }`;

  const FS_BLUR = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
void main(){
  vec4 acc = vec4(0.0); float ws = 0.0;
  float r = ceil(uSigma * 3.0);
  for (int i = -12; i <= 12; i++) {
    float fi = float(i);
    if (abs(fi) > r) continue;
    float w = exp(-fi * fi / (2.0 * uSigma * uSigma));
    acc += texture(uSrc, vUv + uDir * fi) * w;
    ws += w;
  }
  fragColor = acc / ws;
}`;

  const FS_DISPLAY = HEAD + `
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform float uSide;
uniform float uDmax;
uniform float uGap;
uniform float uSpan;
uniform float uCy0;
uniform float uCh;
uniform float uBright;
uniform float uOuter;
uniform float uSat;
uniform float uBlur;
uniform float uVFade;
uniform float uTime;
uniform float uInner;
uniform float uIntensity;
uniform float uContrast;
uniform float uWarmth;
uniform float uGain;
uniform float uDither;

vec4 cubicW(float v){
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
vec3 bicubic(sampler2D tex, vec2 uv){
  vec2 ts = vec2(textureSize(tex, 0));
  vec2 inv = 1.0 / ts;
  uv = uv * ts - 0.5;
  vec2 f = fract(uv);
  uv -= f;
  vec4 xc = cubicW(f.x), yc = cubicW(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) * inv.xxyy;
  vec3 s0 = texture(tex, off.xz).rgb;
  vec3 s1 = texture(tex, off.yz).rgb;
  vec3 s2 = texture(tex, off.xw).rgb;
  vec3 s3 = texture(tex, off.yw).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
float hash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main(){
  float sy = 1.0 - vUv.y;
  float o = uSide < 0.0 ? 1.0 - vUv.x : vUv.x;   // 0 = next to main screen, 1 = outer edge
  float d = uGap + o * uSpan;
  vec2 euv = vec2(d / uDmax, sy);
  float yw = (sy - uCy0) / uCh;
  float outY = max(max(-yw, yw - 1.0), 0.0) * uCh;

  float t = uBlur * mix(uInner, 3.95, pow(o, 0.65)) + smoothstep(0.0, 0.12, outY) * 1.2;
  t = clamp(t, 0.0, 4.0);
  vec3 c;
  if (t < 1.0)      c = mix(texture(uL0, euv).rgb, bicubic(uL1, euv), t);
  else if (t < 2.0) c = mix(bicubic(uL1, euv), bicubic(uL2, euv), t - 1.0);
  else if (t < 3.0) c = mix(bicubic(uL2, euv), bicubic(uL3, euv), t - 2.0);
  else              c = mix(bicubic(uL3, euv), bicubic(uL4, euv), t - 3.0);

  // effect intensity: 0 = soft ambient glow only, 1 = normal, >1 = more pronounced detail
  if (uIntensity != 1.0) c = max(mix(bicubic(uL4, euv), c, uIntensity), 0.0);
  if (uContrast != 1.0) c = max((c - 0.2) * uContrast + 0.2, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  c *= vec3(1.0 + 0.12 * uWarmth, 1.0 + 0.015 * uWarmth, 1.0 - 0.14 * uWarmth);
  float fade = uBright * uGain * mix(1.0, uOuter, smoothstep(0.0, 1.0, o));
  fade *= 1.0 - uVFade * smoothstep(0.0, 0.22, outY);
  c *= fade;
  vec2 fc = gl_FragCoord.xy + fract(uTime * 0.618) * 97.0;
  c += uDither * (hash(fc) + hash(fc * 1.731 + 17.0) - 1.0) / 255.0;
  fragColor = vec4(c, 1.0);
}`;

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- GL helpers
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + log);
    }
    return s;
  }

  function program(gl, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    return { p, uniforms };
  }

  // ---------------------------------------------------------------- analysis
  class Analyzer {
    constructor() {
      this.luma = new Uint8Array(TH_W * TH_H);
      this.reset();
    }

    reset() {
      this.rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
      this.shrink = [0, 0, 0, 0];
      this.brightFrames = 0;
      this.prevCoarse = null;
      this.prevHist = null;
      this.prevProf = null;
      this.vel = { x: 0, y: 0 };
      this.avgScore = 0.08;
      this.lastScore = 0;
    }

    // returns { rect, vel, cut }
    analyze(px, sens = 1) {
      const W = TH_W, H = TH_H, L = this.luma;
      let sum = 0;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        const l = (px[j] * 54 + px[j + 1] * 183 + px[j + 2] * 19) >> 8;
        L[i] = l;
        sum += l;
      }
      const mean = sum / (W * H);

      // ---- letterbox / pillarbox detection (temporal)
      const T = 26;
      let top = -1, bottom = -1, left = -1, right = -1;
      const colCount = new Uint16Array(W);
      for (let y = 0; y < H; y++) {
        let c = 0;
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (L[row + x] > T) { c++; colCount[x]++; }
        }
        if (c > W * 0.22) { if (top < 0) top = y; bottom = y; }
      }
      for (let x = 0; x < W; x++) {
        if (colCount[x] > H * 0.22) { if (left < 0) left = x; right = x; }
      }
      const r = this.rect;
      let rectChanged = false;
      if (top >= 0 && left >= 0 && mean > 12) {
        this.brightFrames++;
        const det = [left / W, top / H, (right + 1) / W, (bottom + 1) / H];
        const cur = [r.x0, r.y0, r.x1, r.y1];
        const need = this.brightFrames < 40 ? 6 : 70;
        for (let e = 0; e < 4; e++) {
          const isMin = e < 2;
          const outside = isMin ? det[e] < cur[e] - 0.004 : det[e] > cur[e] + 0.004;
          const inside = isMin ? det[e] > cur[e] + 0.008 : det[e] < cur[e] - 0.008;
          if (outside) { cur[e] = det[e]; this.shrink[e] = 0; rectChanged = true; }
          else if (inside) {
            if (++this.shrink[e] > need) { cur[e] = det[e]; this.shrink[e] = 0; rectChanged = true; }
          } else this.shrink[e] = 0;
        }
        // sanity: keep at least 35% of frame in each dimension
        if (cur[2] - cur[0] > 0.35 && cur[3] - cur[1] > 0.35) {
          r.x0 = cur[0]; r.y0 = cur[1]; r.x1 = cur[2]; r.y1 = cur[3];
        }
      }

      // ---- scene cut: coarse grid + histogram inside the content area, adaptive threshold
      const CW = 32, CH = 18;
      const rx0 = Math.floor(r.x0 * W), rx1 = Math.max(rx0 + 1, Math.ceil(r.x1 * W));
      const ry0 = Math.floor(r.y0 * H), ry1 = Math.max(ry0 + 1, Math.ceil(r.y1 * H));
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const coarse = new Float32Array(CW * CH), cnt = new Float32Array(CW * CH);
      const hist = new Float32Array(32);
      for (let y = ry0; y < ry1; y++) {
        const cy = Math.min(CH - 1, Math.floor((y - ry0) * CH / rh));
        const row = y * W;
        for (let x = rx0; x < rx1; x++) {
          const cx = Math.min(CW - 1, Math.floor((x - rx0) * CW / rw));
          const l = L[row + x];
          coarse[cy * CW + cx] += l; cnt[cy * CW + cx]++;
          hist[l >> 3]++;
        }
      }
      for (let i = 0; i < coarse.length; i++) coarse[i] /= Math.max(1, cnt[i]);
      for (let i = 0; i < 32; i++) hist[i] /= rw * rh;
      let cut = false;
      if (!this.prevCoarse) {
        cut = true;
      } else if (!rectChanged) {
        let mad = 0;
        for (let i = 0; i < coarse.length; i++) mad += Math.abs(coarse[i] - this.prevCoarse[i]);
        mad /= coarse.length * 255;
        let hd = 0;
        for (let i = 0; i < 32; i++) hd += Math.abs(hist[i] - this.prevHist[i]);
        const score = mad * 4 + hd;
        cut = score > Math.max(0.6, this.avgScore * 5) / Math.max(0.2, sens);
        if (!cut) this.avgScore = this.avgScore * 0.9 + score * 0.1;
        this.lastScore = score;
      }
      this.prevCoarse = coarse;
      this.prevHist = hist;

      // ---- global motion (projection correlation)
      let mx = 0, my = 0, conf = false;
      const ix0 = Math.round((r.x0 + (r.x1 - r.x0) * 0.06) * W);
      const ix1 = Math.round((r.x1 - (r.x1 - r.x0) * 0.06) * W);
      const iy0 = Math.round((r.y0 + (r.y1 - r.y0) * 0.08) * H);
      const iy1 = Math.round((r.y1 - (r.y1 - r.y0) * 0.08) * H);
      const ymid = (iy0 + iy1) >> 1, xmid = (ix0 + ix1) >> 1;
      const nx = ix1 - ix0, ny = iy1 - iy0;
      const prof = {
        key: ix0 + ',' + ix1 + ',' + iy0 + ',' + iy1,
        cTop: new Float32Array(nx), cBot: new Float32Array(nx),
        rL: new Float32Array(ny), rR: new Float32Array(ny),
      };
      for (let y = iy0; y < iy1; y++) {
        const row = y * W;
        const isTop = y < ymid;
        for (let x = ix0; x < ix1; x++) {
          const l = L[row + x];
          if (isTop) prof.cTop[x - ix0] += l; else prof.cBot[x - ix0] += l;
          if (x < xmid) prof.rL[y - iy0] += l; else prof.rR[y - iy0] += l;
        }
      }
      const pp = this.prevProf;
      if (!cut && !rectChanged && pp && pp.key === prof.key && nx > 40 && ny > 20) {
        const a = bestShift(prof.cTop, pp.cTop, 12);
        const b = bestShift(prof.cBot, pp.cBot, 12);
        const c = bestShift(prof.rL, pp.rL, 8);
        const d = bestShift(prof.rR, pp.rR, 8);
        const okX = a.ok && b.ok && a.score > 0.9 && b.score > 0.9 && Math.abs(a.d - b.d) < 1.5;
        const okY = c.ok && d.ok && c.score > 0.9 && d.score > 0.9 && Math.abs(c.d - d.d) < 1.5;
        if (okX) mx = ((a.d + b.d) / 2) / ((r.x1 - r.x0) * W);
        if (okY) my = ((c.d + d.d) / 2) / ((r.y1 - r.y0) * H);
        conf = okX || okY;
      }
      this.prevProf = prof;

      const v = this.vel;
      if (cut) { v.x = 0; v.y = 0; }
      else if (conf) { v.x += (mx - v.x) * 0.6; v.y += (my - v.y) * 0.6; }
      else { v.x *= 0.4; v.y *= 0.4; }
      const dz = 0.0008;
      const vx = Math.abs(v.x) < dz ? 0 : Math.max(-0.06, Math.min(0.06, v.x));
      const vy = Math.abs(v.y) < dz ? 0 : Math.max(-0.06, Math.min(0.06, v.y));

      return { rect: r, vel: { x: vx, y: vy }, cut, mean };
    }
  }

  // Normalised cross-correlation of 1D profiles; cur[x] ≈ prev[x - d]
  function bestShift(cur, prev, maxD) {
    const n = cur.length;
    let mc = 0, mp = 0;
    for (let i = 0; i < n; i++) { mc += cur[i]; mp += prev[i]; }
    mc /= n; mp /= n;
    let vc = 0;
    for (let i = 0; i < n; i++) vc += (cur[i] - mc) ** 2;
    const std = Math.sqrt(vc / n);
    // reject flat (texture-less) profiles
    if (std < mc * 0.012 + 2) return { ok: false, d: 0, score: 0 };
    const scores = new Float32Array(2 * maxD + 1);
    let best = -2, bi = maxD;
    for (let d = -maxD; d <= maxD; d++) {
      const x0 = Math.max(0, d), x1 = Math.min(n, n + d);
      let num = 0, sc = 0, sp = 0;
      for (let x = x0; x < x1; x++) {
        const a = cur[x] - mc, b = prev[x - d] - mp;
        num += a * b; sc += a * a; sp += b * b;
      }
      const s = num / Math.sqrt(sc * sp + 1e-6);
      scores[d + maxD] = s;
      if (s > best) { best = s; bi = d + maxD; }
    }
    let dd = bi - maxD;
    if (bi > 0 && bi < 2 * maxD) {
      const s0 = scores[bi - 1], s1 = scores[bi], s2 = scores[bi + 1];
      const den = s0 - 2 * s1 + s2;
      if (Math.abs(den) > 1e-6) dd += Math.max(-0.5, Math.min(0.5, 0.5 * (s0 - s2) / den));
    }
    // edge of search window = unreliable
    const ok = bi > 0 && bi < 2 * maxD;
    return { ok, d: dd, score: best };
  }

  // ---------------------------------------------------------------- engine
  class PeripheryEngine {
    /**
     * @param {HTMLVideoElement} video
     * @param {{left?: HTMLCanvasElement, right?: HTMLCanvasElement}} canvases  canvases (may live in other windows)
     * @param {object} settings
     * @param {{aspect:number}} screenInfo  main screen aspect ratio
     */
    constructor(video, canvases, settings, screenInfo) {
      this.video = video;
      this.settings = Object.assign({}, settings);
      this.screenAspect = screenInfo && screenInfo.aspect ? screenInfo.aspect : 16 / 9;
      this.sides = [];
      for (const name of ['left', 'right']) {
        const cv = canvases[name];
        if (!cv) continue;
        this.sides.push({ name, sign: name === 'left' ? -1 : 1, canvas: cv, w: cv.width || 1, h: cv.height || 1 });
      }
      this.analyzer = new Analyzer();
      this.mode = 'webgl';
      this.newFrame = true;
      this.needReset = true;
      this.dirty = true;
      this.running = false;
      this.stats = { frames: 0, fpsT: performance.now(), fps: 0, vel: { x: 0, y: 0 }, aspect: 0, cuts: 0 };
      this._onSeek = () => { this.needReset = true; this.newFrame = true; };
      this._raf = this._raf.bind(this);
      this._initGL();
      this._bindVideo(video);
    }

    // ---------------- public API
    start() {
      if (this.running) return;
      this.running = true;
      this._rafId = requestAnimationFrame(this._raf);
    }

    stop() {
      this.running = false;
      this._destroyed = true;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._unbindVideo();
      try {
        const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (e) { /* ignore */ }
    }

    setVideo(video) {
      if (video === this.video) return;
      this._unbindVideo();
      this.video = video;
      this.analyzer.reset();
      this.needReset = true;
      if (this.mode === '2d' && this.gl) {
        // give WebGL another chance with the new video: swap the 2D canvases back out
        for (const s of this.sides) {
          if (!s.fallbackCanvas) continue;
          const c = s.canvas.ownerDocument.createElement('canvas');
          c.style.cssText = s.canvas.style.cssText;
          c.width = s.w; c.height = s.h;
          s.canvas.replaceWith(c);
          s.canvas = c;
          s.fallbackCanvas = null; s.ctx = null; s.ctxKind = null;
        }
        this.mode = 'webgl';
      }
      this._bindVideo(video);
    }

    updateSettings(s) {
      Object.assign(this.settings, s);
      this.dirty = true;
      // these change the side buffers themselves, not just the final shading
      const PROCESS = ['stretch', 'bezel', 'verticalOffset', 'spread', 'motion', 'persistence', 'responsiveness'];
      if (Object.keys(s).some((k) => PROCESS.includes(k))) this.reprocess = true;
    }

    resize(name, w, h) {
      const side = this.sides.find(s => s.name === name);
      if (!side) return;
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      if (side.w === w && side.h === h) return;
      side.w = w; side.h = h;
      side.canvas.width = w; side.canvas.height = h;
      this.dirty = true;
    }

    removeSide(name) {
      this.sides = this.sides.filter(s => s.name !== name);
    }

    getStatus() {
      return {
        mode: this.mode,
        fps: this.stats.fps,
        aspect: this.stats.aspect,
        vel: this.stats.vel,
        cuts: this.stats.cuts,
        sides: this.sides.map(s => s.name),
      };
    }

    // ---------------- video binding
    _bindVideo(v) {
      v.addEventListener('seeked', this._onSeek);
      v.addEventListener('loadeddata', this._onSeek);
      this._vfcActive = typeof v.requestVideoFrameCallback === 'function';
      if (this._vfcActive) {
        const cb = () => {
          if (this.video !== v || this._destroyed) return;
          this.newFrame = true;
          this._vfcHandle = v.requestVideoFrameCallback(cb);
        };
        this._vfcHandle = v.requestVideoFrameCallback(cb);
      }
      this._lastTime = -1;
    }

    _unbindVideo() {
      const v = this.video;
      if (!v) return;
      v.removeEventListener('seeked', this._onSeek);
      v.removeEventListener('loadeddata', this._onSeek);
      if (this._vfcActive && this._vfcHandle && v.cancelVideoFrameCallback) {
        v.cancelVideoFrameCallback(this._vfcHandle);
      }
    }

    // ---------------- GL setup
    _initGL() {
      this.out = new OffscreenCanvas(16, 16);
      const gl = this.out.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) { this.mode = '2d'; this.gl = null; return; }
      this.gl = gl;
      this.useFloat = !!gl.getExtension('EXT_color_buffer_float');
      this.progs = {
        thumb: program(gl, FS_THUMB),
        profile: program(gl, FS_PROFILE),
        advect: program(gl, FS_ADVECT),
        compose: program(gl, FS_COMPOSE),
        copy: program(gl, FS_COPY),
        blur: program(gl, FS_BLUR),
        display: program(gl, FS_DISPLAY),
      };
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      this.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.videoW = 0; this.videoH = 0;

      this.thumb = this._target(TH_W, TH_H, false);
      this.thumbPx = new Uint8Array(TH_W * TH_H * 4);

      for (const side of this.sides) this._initSide(side);

      this.out.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
      this.out.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        for (const s of this.sides) s.ctx = null;
        this._initGL();
        this.needReset = true;
      });
    }

    _initSide(side) {
      const f = this.useFloat;
      side.prof = [this._target(1, PROFILE_H, f), this._target(1, PROFILE_H, f)];
      side.P1 = this._target(1, PROFILE_H, f);
      side.P2 = this._target(1, PROFILE_H / 4, f); side.Q2 = this._target(1, PROFILE_H / 4, f);
      side.P3 = this._target(1, PROFILE_H / 16, f); side.Q3 = this._target(1, PROFILE_H / 16, f);
      side.E = [this._target(E_W, E_H, f), this._target(E_W, E_H, f)];
      side.C = this._target(E_W, E_H, f);
      side.L1 = this._target(E_W, E_H, f); side.T1 = this._target(E_W, E_H, f);
      side.L2 = this._target(E_W / 2, E_H / 2, f); side.T2 = this._target(E_W / 2, E_H / 2, f);
      side.L3 = this._target(E_W / 4, E_H / 4, f); side.T3 = this._target(E_W / 4, E_H / 4, f);
      side.L4 = this._target(E_W / 8, E_H / 8, f); side.T4 = this._target(E_W / 8, E_H / 8, f);
      side.pi = 0; side.ei = 0;
    }

    _target(w, h, float) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }

    _draw(prog, target, uniforms) {
      const gl = this.gl;
      gl.useProgram(prog.p);
      let unit = 0;
      for (const name in uniforms) {
        const u = prog.uniforms[name];
        if (!u) continue;
        const v = uniforms[name];
        switch (u.type) {
          case gl.SAMPLER_2D:
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, v);
            gl.uniform1i(u.loc, unit++);
            break;
          case gl.FLOAT: gl.uniform1f(u.loc, v); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
          default: gl.uniform1f(u.loc, v);
        }
      }
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, target.w, target.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.out.width, this.out.height);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---------------- frame loop
    _raf(now) {
      if (!this.running) return;
      this._rafId = requestAnimationFrame(this._raf);
      try {
        this._tick(now);
      } catch (e) {
        if (!this._errLogged) { console.warn('[Periphery]', e); this._errLogged = true; }
      }
    }

    _tick(now) {
      const v = this.video;
      if (!v || this.sides.length === 0) return;
      if (!this._vfcActive) {
        if (v.currentTime !== this._lastTime) { this._lastTime = v.currentTime; this.newFrame = true; }
      }
      if (v.readyState < 2 || !v.videoWidth) return;

      // keep side canvas sizes in sync with their on-screen size (x render scale)
      const scale = clamp(num(this.settings.renderScale, 1), 0.25, 1);
      for (const s of this.sides) {
        const win = s.canvas.ownerDocument && s.canvas.ownerDocument.defaultView;
        const cw = s.canvas.clientWidth, chh = s.canvas.clientHeight;
        if (win && cw && chh) {
          const dpr = win.devicePixelRatio || 1;
          this.resize(s.name, cw * dpr * scale, chh * dpr * scale);
        }
      }

      if (this.mode === 'webgl' && this.gl && !this.contextLost) {
        if (this.newFrame || this.reprocess) {
          // while paused, rebuild from the current frame so slider changes show up immediately
          if (!this.newFrame && v.paused) this.needReset = true;
          this.newFrame = false;
          this.reprocess = false;
          if (!this._upload()) return; // switched to 2d
          this._processFrame(now);
          this.dirty = true;
        }
        if (this.dirty) {
          this.dirty = false;
          for (const s of this.sides) this._present(s, now);
        }
      } else if (this.mode === '2d') {
        if (this.newFrame || this.dirty) {
          this.newFrame = false; this.dirty = false;
          for (const s of this.sides) this._render2D(s);
        }
      }

      this.stats.frames++;
      if (now - this.stats.fpsT > 1000) {
        this.stats.fps = Math.round(this.stats.frames * 1000 / (now - this.stats.fpsT));
        this.stats.frames = 0;
        this.stats.fpsT = now;
      }
    }

    _upload() {
      const gl = this.gl, v = this.video;
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      try {
        if (v.videoWidth !== this.videoW || v.videoHeight !== this.videoH) {
          while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
          if (gl.getError() !== gl.NO_ERROR) {
            // frame not decodable yet (or size changing); try again on the next frame
            this.videoW = 0; this.videoH = 0;
            this.newFrame = true;
            return false;
          }
          this.videoW = v.videoWidth; this.videoH = v.videoHeight;
          this.verifyUploads = 3;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
        }
      } catch (e) {
        if (e && e.name === 'SecurityError') {
          console.info('[Periphery] cross-origin video, using 2D fallback');
          this.mode = '2d';
          this.dirty = true;
          return false;
        }
        throw e;
      }
      gl.generateMipmap(gl.TEXTURE_2D);
      if (this.verifyUploads > 0) {
        // a video without a decoded frame yet uploads as an empty 0x0 texture without any error;
        // detect that and re-allocate on the next frame
        this.verifyUploads--;
        if (gl.getError() !== gl.NO_ERROR) {
          this.videoW = 0; this.videoH = 0;
          this.newFrame = true;
          return false;
        }
      }
      return true;
    }

    _geometry(side) {
      const r = this.analyzer.rect;
      const contentAspect = (this.videoW * (r.x1 - r.x0)) / Math.max(1, this.videoH * (r.y1 - r.y0));
      const A = this.screenAspect;
      let cw = 1, ch = 1;
      if (contentAspect >= A) ch = A / contentAspect; else cw = contentAspect / A;
      const cy0 = (1 - ch) / 2 + num(this.settings.verticalOffset, 0);
      const As = side.w / side.h;
      const st = this.settings;
      const spanPhys = (As / A) / cw;
      const span = spanPhys / Math.max(0.5, st.stretch);
      const gap = (st.bezel + (1 - cw) / 2) / cw;
      const dmax = gap + span;
      return { cw, ch, cy0, span, gap, dmax, yMin: -cy0 / ch, yMax: (1 - cy0) / ch, contentAspect };
    }

    _processFrame(now) {
      const gl = this.gl;
      // --- analysis thumbnail
      this._draw(this.progs.thumb, this.thumb, { uVideo: this.videoTex });
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumb.fb);
      gl.readPixels(0, 0, TH_W, TH_H, gl.RGBA, gl.UNSIGNED_BYTE, this.thumbPx);
      const a = this.analyzer.analyze(this.thumbPx, num(this.settings.cutSensitivity, 1));
      const reset = this.needReset || a.cut;
      if (a.cut) this.stats.cuts++;
      this.needReset = false;
      this.stats.vel = a.vel;

      const r = a.rect;
      const inset = 0.004;
      const rect = [r.x0 + inset, r.y0 + inset, r.x1 - inset, r.y1 - inset];
      const st = this.settings;
      const decay = 0.3 * Math.pow(0.03, Math.max(0, Math.min(1, st.persistence)));
      const vel = [a.vel.x * st.motion, a.vel.y * st.motion];
      const contentHpx = this.videoH * (rect[3] - rect[1]);
      const contentWpx = this.videoW * (rect[2] - rect[0]);
      const profLod = Math.max(0, Math.log2(contentHpx / PROFILE_H));

      for (const side of this.sides) {
        const geo = this._geometry(side);
        side.geo = geo;
        this.stats.aspect = geo.contentAspect;
        // profile (temporal smoothing; replace on reset)
        const pSrc = side.prof[side.pi], pDst = side.prof[1 - side.pi];
        this._draw(this.progs.profile, pDst, {
          uVideo: this.videoTex, uPrev: pSrc.tex, uRect: rect, uSide: side.sign,
          uBand: 0.03, uLod: profLod, uAlpha: reset ? 1.0 : clamp(num(st.responsiveness, 0.45), 0.05, 1),
        });
        side.pi = 1 - side.pi;
        const profTex = pDst.tex;

        // vertical spread levels of the edge profile (1D)
        this._draw(this.progs.blur, side.P1, { uSrc: profTex, uDir: [0, 1 / PROFILE_H], uSigma: 4 });
        this._draw(this.progs.copy, side.Q2, { uSrc: side.P1.tex });
        this._draw(this.progs.blur, side.P2, { uSrc: side.Q2.tex, uDir: [0, 4 / PROFILE_H], uSigma: 3 });
        this._draw(this.progs.copy, side.Q3, { uSrc: side.P2.tex });
        this._draw(this.progs.blur, side.P3, { uSrc: side.Q3.tex, uDir: [0, 16 / PROFILE_H], uSigma: 2.5 });

        // pan buffer advection
        const eSrc = side.E[side.ei], eDst = side.E[1 - side.ei];
        const texelPx = Math.max(geo.dmax / E_W * contentWpx, (geo.yMax - geo.yMin) / E_H * contentHpx);
        this._draw(this.progs.advect, eDst, {
          uVideo: this.videoTex, uPrevE: eSrc.tex, uRect: rect,
          uSide: side.sign, uDmax: geo.dmax, uYRange: [geo.yMin, geo.yMax],
          uVel: vel, uDecay: decay, uLod: Math.max(0, Math.log2(texelPx)),
          uReset: reset ? 1 : 0,
        });
        side.ei = 1 - side.ei;

        // compose
        this._draw(this.progs.compose, side.C, {
          uE: eDst.tex, uP0: profTex, uP1: side.P1.tex, uP2: side.P2.tex, uP3: side.P3.tex,
          uYRange: [geo.yMin, geo.yMax], uDmax: geo.dmax, uGap: geo.gap, uDetail: st.motion > 0 ? 1 : 0,
          uSpread: num(st.spread, 1),
        });
        // level 1: full res, light blur (C -> T1 -> L1)
        this._blur(side.C, side.T1, side.L1, 1.4);
        // level 2..4: downsample by 2 each time, then blur in place (T -> L -> T)
        this._draw(this.progs.copy, side.T2, { uSrc: side.C.tex });
        this._blur(side.T2, side.L2, side.T2, 2.4);
        this._draw(this.progs.copy, side.T3, { uSrc: side.T2.tex });
        this._blur(side.T3, side.L3, side.T3, 2.8);
        this._draw(this.progs.copy, side.T4, { uSrc: side.T3.tex });
        this._blur(side.T4, side.L4, side.T4, 2.6);
        side.lv = [side.C.tex, side.L1.tex, side.T2.tex, side.T3.tex, side.T4.tex];
      }
    }

    // separable gaussian: src -(horizontal)-> tmp -(vertical)-> dst
    _blur(src, tmp, dst, sigma) {
      this._draw(this.progs.blur, tmp, { uSrc: src.tex, uDir: [1 / src.w, 0], uSigma: sigma });
      this._draw(this.progs.blur, dst, { uSrc: tmp.tex, uDir: [0, 1 / src.h], uSigma: sigma });
    }

    _present(side, now) {
      if (!side.lv || !side.geo) return;
      const gl = this.gl;
      if (this.out.width !== side.w || this.out.height !== side.h) {
        this.out.width = side.w; this.out.height = side.h;
      }
      const geo = side.geo, st = this.settings;
      this._draw(this.progs.display, null, {
        uL0: side.lv[0], uL1: side.lv[1], uL2: side.lv[2], uL3: side.lv[3], uL4: side.lv[4],
        uSide: side.sign, uDmax: geo.dmax, uGap: geo.gap, uSpan: geo.span,
        uCy0: geo.cy0, uCh: geo.ch, uBright: st.brightness, uOuter: st.outerFade,
        uSat: st.saturation, uBlur: st.blur, uVFade: st.verticalFade, uTime: now / 1000,
        uInner: 2.6 * (1 - clamp(num(st.sharpness, 0.5), 0, 1)),
        uIntensity: num(st.intensity, 1), uContrast: num(st.contrast, 1), uWarmth: num(st.warmth, 0),
        uGain: side.sign < 0 ? num(st.leftGain, 1) : num(st.rightGain, 1),
        uDither: num(st.dither, 1),
      });
      const bmp = this.out.transferToImageBitmap();
      if (!side.ctx || side.ctxKind !== 'bitmap') {
        side.ctx = side.canvas.getContext('bitmaprenderer');
        side.ctxKind = 'bitmap';
      }
      if (side.ctx) side.ctx.transferFromImageBitmap(bmp);
      else bmp.close();
    }

    // ---------------- 2D fallback for cross-origin (tainted) video
    _render2D(side) {
      const v = this.video;
      if (!side.fallbackCanvas) {
        // bitmaprenderer and 2d can't share a canvas; swap in a fresh one
        const doc = side.canvas.ownerDocument;
        const c = doc.createElement('canvas');
        c.style.cssText = side.canvas.style.cssText || 'width:100%;height:100%;display:block';
        c.width = side.w; c.height = side.h;
        side.canvas.replaceWith(c);
        side.canvas = c;
        side.fallbackCanvas = c;
        side.ctx2 = c.getContext('2d');
        side.small = doc.createElement('canvas');
        side.small.width = 96; side.small.height = 54;
        side.sctx = side.small.getContext('2d');
      }
      const st = this.settings;
      const vw = v.videoWidth, vh = v.videoHeight;
      const A = this.screenAspect, ca = vw / vh;
      let ch = 1;
      if (ca >= A) ch = A / ca;
      const cy0 = (1 - ch) / 2;
      const s = side.sctx, sw = side.small.width, sh = side.small.height;
      s.filter = 'none';
      s.fillStyle = '#000';
      s.fillRect(0, 0, sw, sh);
      const band = Math.max(2, vw * 0.02);
      const sx = side.sign < 0 ? 0 : vw - band;
      s.imageSmoothingEnabled = true;
      s.drawImage(v, sx, 0, band, vh, 0, cy0 * sh, sw, ch * sh);
      // extend above/below band
      s.drawImage(side.small, 0, cy0 * sh, sw, 1, 0, 0, sw, cy0 * sh);
      s.drawImage(side.small, 0, (cy0 + ch) * sh - 1, sw, 1, 0, (cy0 + ch) * sh, sw, cy0 * sh + 1);
      const c = side.ctx2, w = side.canvas.width, h = side.canvas.height;
      c.filter = `blur(${Math.max(2, Math.round(w * 0.025 * st.blur * (1.5 - num(st.sharpness, 0.5))))}px) saturate(${st.saturation})`;
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(side.small, 0, 0, w, h);
      c.filter = 'none';
      const gr = c.createLinearGradient(side.sign < 0 ? w : 0, 0, side.sign < 0 ? 0 : w, 0);
      const b = clamp(st.brightness * (side.sign < 0 ? num(st.leftGain, 1) : num(st.rightGain, 1)), 0, 1);
      gr.addColorStop(0, `rgba(0,0,0,${1 - b})`);
      gr.addColorStop(1, `rgba(0,0,0,${1 - b * st.outerFade})`);
      c.fillStyle = gr;
      c.fillRect(0, 0, w, h);
    }
  }

  g.PeripheryEngine = PeripheryEngine;
  g.PeripheryAnalyzer = Analyzer;
})(globalThis);
