// Chomp
// A yellow disc crosses the frame row by row. Picture it has passed goes black.

uniform float uChompSize;
uniform float uChompSpeed;
uniform float uChompMouth;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float rowCount = max(1.0, floor(mix(16.0, 4.0, clamp(uChompSize, 0.0, 1.0))));
  float rowH = 1.0 / rowCount;
  float radius = rowH * 0.46;
  float rate = mix(0.02, 0.22, clamp(uChompSpeed, 0.0, 1.0));
  float travel = fract(uTime * rate + kick * 0.7 / rowCount);

  float headRows = travel * rowCount;
  float headRow = floor(headRows);
  float headAlong = fract(headRows);
  float goingLeft = step(0.5, mod(headRow, 2.0));
  vec2 head = vec2(mix(headAlong, 1.0 - headAlong, goingLeft), 1.0 - (headRow + 0.5) * rowH);

  float yFromTop = 1.0 - vUv.y;
  float row = clamp(floor(yFromTop / rowH), 0.0, rowCount - 1.0);
  float rowLeft = step(0.5, mod(row, 2.0));
  float xAlong = mix(vUv.x, 1.0 - vUv.x, rowLeft);
  float along = (row + clamp(xAlong, 0.0, 1.0)) / rowCount;

  vec3 col = mix(src(vUv), vec3(0.0), step(along, travel));

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 d = (vUv - head) * vec2(aspect, 1.0);
  float inDisc = step(length(d), radius);
  float chatter = 0.5 + 0.5 * sin(uTime * 8.0);
  float open = clamp(uChompMouth, 0.0, 1.0) * chatter * (1.0 - kick);
  float facing = mix(0.0, PI, goingLeft);
  float ang = atan(d.y, d.x);
  float delta = abs(mod(ang - facing + PI, TAU) - PI);
  float inMouth = step(delta, open * 0.65);
  vec2 eye = d - vec2(mix(0.16, -0.16, goingLeft), 0.28) * radius;
  float inEye = step(length(eye), radius * 0.14);
  vec3 body = mix(vec3(1.0, 0.86, 0.08), vec3(0.04, 0.02, 0.06), inEye);
  col = mix(col, body, inDisc * (1.0 - inMouth));
  gl_FragColor = vec4(col, 1.0);
}
