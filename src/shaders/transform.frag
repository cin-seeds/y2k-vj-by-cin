// Stage 2. Places the source frame (scale, position, letterbox mask)
// before color and post effects sample it.
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec3 uXform; // scale, posX, posY
uniform vec3 uMask;  // uvScale.xy, mask enabled
uniform float uOpaqueBase;

bool outside(vec2 p) {
  return p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0;
}

void main() {
  vec2 p = (vUv - 0.5 - uXform.yz) / max(uXform.x, 1e-3) + 0.5;
  if (outside(p)) {
    gl_FragColor = uOpaqueBase > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
    return;
  }
  vec4 c = texture2D(uTex, p);
  if (uMask.z > 0.5 && outside((p - 0.5) * uMask.xy + 0.5)) {
    gl_FragColor = uOpaqueBase > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(c.rgb, 0.0);
    return;
  }
  gl_FragColor = c;
}
