// MASTER COMPOSITOR
// Stacks layers A (bottom), B, C (top) over black. Each layer has its own transform,
// opacity, and blend mode. Layer alpha comes from the layer itself (3D layers are
// transparent around the geometry) and from the fit/letterbox mask.

varying vec2 vUv;

uniform sampler2D uLayer0;
uniform sampler2D uLayer1;
uniform sampler2D uLayer2;
uniform float uLayerAMix;
uniform float uLayerBMix;
uniform float uLayerCMix;
uniform float uLayerABlendMode;
uniform float uLayerBBlendMode;
uniform float uLayerCBlendMode;
uniform float uLayerAInvert;
uniform float uLayerBInvert;
uniform float uLayerCInvert;
uniform vec3 uXform0;     // scale, posX, posY
uniform vec3 uXform1;
uniform vec3 uXform2;
uniform vec3 uMask0;      // uvScale.xy, mask enabled
uniform vec3 uMask1;
uniform vec3 uMask2;

vec3 blendMode(vec3 base, vec3 top, float mode) {
  int m = int(mode + 0.5);
  if (m == 1) return base * top;                                   // multiply
  if (m == 2) return 1.0 - (1.0 - base) * (1.0 - top);             // screen
  if (m == 3) return min(base / max(1.0 - top, 1e-3), vec3(1.0));  // color dodge
  if (m == 4) return abs(base - top);                              // difference
  if (m == 5) return min(base + top, vec3(1.0));                   // add / linear dodge
  if (m == 6) return base + top - 2.0 * base * top;                // exclusion
  if (m == 7) {                                                    // overlay
    vec3 lo = 2.0 * base * top;
    vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - top);
    return mix(lo, hi, step(vec3(0.5), base));
  }
  return top;                                                      // normal (alpha over)
}

bool outside(vec2 p) {
  return p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0;
}

vec4 sampleLayer(sampler2D tex, vec3 xf, vec3 mask, vec2 uv) {
  vec2 p = (uv - 0.5 - xf.yz) / max(xf.x, 1e-3) + 0.5;
  if (outside(p)) return vec4(0.0);
  vec4 c = texture2D(tex, p);
  if (mask.z > 0.5 && outside((p - 0.5) * mask.xy + 0.5)) c.a = 0.0;
  return c;
}

vec3 layerOver(vec3 base, vec4 l, float blend, float opacity, float invert) {
  vec3 blended = blendMode(base, l.rgb, blend);
  if (invert > 0.5) blended = 1.0 - blended;
  return mix(base, blended, clamp(l.a, 0.0, 1.0) * opacity);
}

void main() {
  vec3 c = vec3(0.0);
  if (uLayerAMix > 0.0) c = layerOver(c, sampleLayer(uLayer0, uXform0, uMask0, vUv), uLayerABlendMode, uLayerAMix, uLayerAInvert);
  if (uLayerBMix > 0.0) c = layerOver(c, sampleLayer(uLayer1, uXform1, uMask1, vUv), uLayerBBlendMode, uLayerBMix, uLayerBInvert);
  if (uLayerCMix > 0.0) c = layerOver(c, sampleLayer(uLayer2, uXform2, uMask2, vUv), uLayerCBlendMode, uLayerCMix, uLayerCInvert);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
