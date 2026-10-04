// CLEAN
// The media as-is (with fit / fill and mirror), for layering untreated footage.

void main() {
  gl_FragColor = vec4(src(vUv), 1.0);
}
