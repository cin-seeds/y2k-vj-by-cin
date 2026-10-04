// One point per video pixel. Home UV is the attribute; the sim texture holds
// where that point has drifted. Color and Z both come from uParticleTexture.

uniform sampler2D uState;
uniform sampler2D uParticleTexture;
uniform vec2 uUvScale;
uniform vec2 uResolution;
uniform float uFit;
uniform float uMirror;
uniform float uHasInput;
uniform float uTime;
uniform float uPointSize;
uniform float uDepth;
uniform float uPlane;
uniform float uCamZ;
uniform float uAspect;
uniform float uSubBass;
uniform float uPunch;

varying vec3 vColor;
varying float vLum;

vec2 mapUV(vec2 uvIn) {
  vec2 t = (uvIn - 0.5) * uUvScale + 0.5;
  if (uMirror > 0.5) t.x = 1.0 - t.x;
  return t;
}

vec3 procedural(vec2 p) {
  float n = fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  return 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + p.xyx * 1.7 + n + uTime * 0.05));
}

void main() {
  vec2 home = uv;
  vec2 pos = texture2D(uState, home).xy;

  vec3 rgb;
  if (uHasInput > 0.5) {
    vec2 t = mapUV(home);
    vec2 edge = step(vec2(0.0), t) * step(t, vec2(1.0));
    rgb = texture2D(uParticleTexture, clamp(t, 0.0, 1.0)).rgb;
    rgb *= mix(vec3(1.0), vec3(edge.x * edge.y), uFit);
  } else {
    rgb = procedural(home);
  }

  float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
  float depth = uDepth * (1.0 + uSubBass * 0.55) + uPunch * uDepth * 0.65;
  float z = min(lum * depth, 1.55);

  float aspect = max(uAspect, 0.0001);
  vec3 world = vec3((pos.x - 0.5) * aspect * uPlane, (pos.y - 0.5) * uPlane, z);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  mat4 proj = projectionMatrix;
  proj[0][0] = proj[1][1] / aspect;
  gl_Position = proj * mv;

  float dist = max(0.35, -mv.z);
  gl_PointSize = max(1.0, uPointSize * (0.72 + 0.56 * lum) * (uCamZ / dist));

  vColor = rgb;
  vLum = lum;
}
