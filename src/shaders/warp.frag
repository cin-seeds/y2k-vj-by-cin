// Last pass of the master pipeline. Inverse-bilinear samples the graded mix
// through four corner pins, then cuts an output mask. Pixels outside the quad
// or the mask are black. Pins are in GL UV (y up): BL, BR, TR, TL.
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2 uBL;
uniform vec2 uBR;
uniform vec2 uTR;
uniform vec2 uTL;
uniform float uMask;
uniform float uIdentity;
uniform float uAspect;
uniform float uBezel;

float cross2(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

vec2 invBilinear(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 e;
  vec2 f;
  vec2 g;
  vec2 h;
  vec2 den;
  float k2;
  float k1;
  float k0;
  float w;
  float v;
  float v1;
  float v2;
  float u;
  e = b - a;
  f = d - a;
  g = a - b + c - d;
  h = p - a;
  k2 = cross2(g, f);
  k1 = cross2(e, f) + cross2(h, g);
  k0 = cross2(h, e);
  if (abs(k2) < 0.00001) {
    if (abs(k1) < 0.00001) return vec2(-1.0);
    v = -k0 / k1;
  } else {
    w = k1 * k1 - 4.0 * k2 * k0;
    if (w < 0.0) return vec2(-1.0);
    w = sqrt(w);
    v1 = (-k1 - w) / (2.0 * k2);
    v2 = (-k1 + w) / (2.0 * k2);
    if (v1 >= -0.001 && v1 <= 1.001) v = v1;
    else v = v2;
  }
  den = e + g * v;
  if (abs(den.x) < 0.00001 && abs(den.y) < 0.00001) return vec2(-1.0);
  if (abs(den.x) > abs(den.y)) u = (h.x - f.x * v) / den.x;
  else u = (h.y - f.y * v) / den.y;
  return vec2(u, v);
}

// 7x7 grid, 25 panels. Row 0 is the top of the picture. uBezel is the inset
// of each cell, 0..0.05, so a gap can show between physical LED modules.
float ledKeep(vec2 uv) {
  float cellX;
  float cellY;
  float col;
  float row;
  float fx;
  float fy;
  cellX = uv.x * 7.0;
  cellY = (1.0 - uv.y) * 7.0;
  if (cellX > 6.999) cellX = 6.999;
  if (cellY > 6.999) cellY = 6.999;
  col = floor(cellX);
  row = floor(cellY);
  if (abs(col - 3.0) + abs(row - 3.0) > 3.0) return 0.0;
  fx = cellX - col;
  fy = cellY - row;
  if (fx < uBezel || fy < uBezel || fx > 1.0 - uBezel || fy > 1.0 - uBezel) return 0.0;
  return 1.0;
}

float maskKeep(vec2 uv, float kind) {
  vec2 q;
  float halfW;
  if (kind < 0.5) return 1.0;
  q = (uv - 0.5) * 2.0;
  if (kind < 1.5) return dot(q, q) <= 1.0 ? 1.0 : 0.0;
  if (kind < 2.5) {
    halfW = (1.0 - uv.y) * 0.5;
    return abs(uv.x - 0.5) <= halfW ? 1.0 : 0.0;
  }
  if (kind < 3.5) return abs(q.x) + abs(q.y) <= 1.0 ? 1.0 : 0.0;
  if (kind < 4.5) {
    halfW = min(1.0, uAspect * 0.5625) * 0.5;
    return abs(uv.y - 0.5) <= halfW ? 1.0 : 0.0;
  }
  return ledKeep(uv);
}

void main() {
  vec2 st;
  if (uIdentity > 0.5) {
    gl_FragColor = texture2D(uTex, vUv);
    return;
  }
  st = invBilinear(vUv, uBL, uBR, uTR, uTL);
  if (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0 || maskKeep(st, uMask) < 0.5) {
    if (uMask > 4.5) gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    else gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  gl_FragColor = vec4(texture2D(uTex, st).rgb, 1.0);
}
