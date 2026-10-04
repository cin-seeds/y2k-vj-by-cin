// Video color on the displaced surface, with a cheap light so the relief reads.

varying vec3 vColor;
varying vec2 vMapUv;

uniform sampler2D uTex;
uniform float uHasInput;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec3 col = vColor;
  if (uHasInput > 0.5 && vMapUv.x >= 0.0 && vMapUv.x <= 1.0 && vMapUv.y >= 0.0 && vMapUv.y <= 1.0) {
    vec2 o = vec2(1.0 / 256.0, 0.0);
    float l = luma(texture2D(uTex, vMapUv).rgb);
    float lx = luma(texture2D(uTex, vMapUv + o).rgb) - l;
    float ly = luma(texture2D(uTex, vMapUv + o.yx).rgb) - l;
    vec3 n = normalize(vec3(-lx * 4.0, -ly * 4.0, 0.45));
    float shade = clamp(dot(n, normalize(vec3(0.25, 0.55, 0.8))), 0.0, 1.0);
    col = texture2D(uTex, clamp(vMapUv, 0.0, 1.0)).rgb * (0.5 + 0.75 * shade);
  }
  gl_FragColor = vec4(col, 1.0);
}
