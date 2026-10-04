// Shared by the point cloud and the extruded mesh.
// Samples the live texture and pushes each vertex along Z by its luminance.
// uBass scales the peak height; for points it also scales gl_PointSize.

uniform sampler2D uTex;
uniform vec2 uUvScale;
uniform vec2 uResolution;
uniform float uFit;
uniform float uMirror;
uniform float uHasInput;
uniform float uTime;
uniform float uBass;
uniform float uReactivity;
uniform float uPointExtrude;
uniform float uMeshExtrude;
uniform float uPointSize;
uniform float uIsPoint;
uniform float uAspect;

varying vec3 vColor;
varying vec2 vMapUv;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

vec2 mapUV(vec2 uvIn) {
  vec2 t = (uvIn - 0.5) * uUvScale + 0.5;
  if (uMirror > 0.5) t.x = 1.0 - t.x;
  return t;
}

float procedural(vec2 p) {
  return clamp(
    0.5
      + 0.32 * sin(p.x * 16.0 + uTime * 0.7) * cos(p.y * 12.0 - uTime * 0.5)
      + 0.18 * sin((p.x + p.y) * 34.0 + uTime * 1.3),
    0.0, 1.0);
}

void main() {
  vec2 t = mapUV(uv);
  float inside = step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);
  vec3 sampled = texture2D(uTex, clamp(t, 0.0, 1.0)).rgb;
  float lum;
  vec3 col;
  if (uHasInput > 0.5) {
    lum = luma(sampled) * inside;
    col = sampled * inside;
  } else {
    lum = procedural(uv);
    col = mix(vec3(0.05, 0.15, 0.35), vec3(0.15, 0.95, 1.0), lum);
    col += vec3(1.0, 0.25, 0.55) * smoothstep(0.65, 1.0, lum);
  }

  float amp = mix(uMeshExtrude, uPointExtrude, uIsPoint);
  float peak = amp * (0.22 + 0.78 * clamp(uBass * uReactivity, 0.0, 1.5));
  vec3 pos = position;
  pos.z += lum * peak;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  mat4 proj = projectionMatrix;
  if (uIsPoint > 0.5) proj[0][0] = proj[1][1] / max(uAspect, 0.0001);
  gl_Position = proj * mv;
  gl_PointSize = uPointSize
    * (1.0 + uBass * uReactivity * 2.0)
    * (uResolution.y / 700.0)
    * (1.7 / max(0.45, -mv.z));

  vColor = col;
  vMapUv = t;
}
