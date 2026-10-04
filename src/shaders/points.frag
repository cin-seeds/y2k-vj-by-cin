varying vec3 vColor;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = dot(p, p);
  if (d > 0.25) discard;
  float edge = smoothstep(0.25, 0.05, d);
  gl_FragColor = vec4(vColor, edge);
}
