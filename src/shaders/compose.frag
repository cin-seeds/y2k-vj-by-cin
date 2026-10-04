// Composition pass. Samples the mixed A/B/C frame and applies the master stack:
// barrel + chromatic split, phosphor bleed, color grade, scanlines, strobe,
// then the momentary invert/flash and master brightness.
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uMaster;
uniform float uFlash;
uniform float uInvert;
uniform float uHue;
uniform float uSat;
uniform float uContrast;
uniform float uScan;
uniform float uBleed;
uniform float uBarrel;
uniform float uStrobe;
uniform float uStrobeBlack;
uniform float uChroma;

vec3 hueShift(vec3 c, float a) {
  vec3 k = vec3(0.57735);
  float cs = cos(a);
  float sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}

vec2 barrelUv(vec2 uv) {
  vec2 p = uv - 0.5;
  float r2 = dot(p, p);
  return p * (1.0 + uBarrel * 0.22 * r2) + 0.5;
}

void main() {
  vec2 uv = barrelUv(vUv);
  vec2 dir = (uv - 0.5) * uChroma * 0.045;
  vec3 col;
  col.r = texture2D(uTex, clamp(uv + dir, 0.0, 1.0)).r;
  col.g = texture2D(uTex, clamp(uv, 0.0, 1.0)).g;
  col.b = texture2D(uTex, clamp(uv - dir, 0.0, 1.0)).b;

  vec2 px = vec2(1.5 / max(uResolution.x, 1.0), 0.0);
  vec3 side = texture2D(uTex, clamp(uv + px, 0.0, 1.0)).rgb
            + texture2D(uTex, clamp(uv - px, 0.0, 1.0)).rgb;
  col = mix(col, (col + side) * 0.333, clamp(uBleed, 0.0, 1.0));

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col = hueShift(col, uHue * 6.2831853);

  float line = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159);
  col *= 1.0 - uScan * 0.45 * line;

  vec3 flashCol = uStrobeBlack > 0.5 ? vec3(0.0) : vec3(1.0);
  col = mix(col, flashCol, clamp(uStrobe, 0.0, 1.0));
  col = mix(col, 1.0 - col, clamp(uInvert, 0.0, 1.0));
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * uMaster, 1.0);
}
