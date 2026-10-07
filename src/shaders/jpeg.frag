// JPEG Decay
// Square blocks and color smear, like a bad late-90s download.

uniform float uJpegBlock;
uniform float uJpegSmear;
uniform float uJpegCrush;

void main() {
  vec3 clean = src(vUv);
  float blockAmt = clamp(uJpegBlock, 0.0, 1.0);
  float smearAmt = clamp(uJpegSmear, 0.0, 1.0);
  float crush = clamp(uJpegCrush, 0.0, 1.0);
  float hit = clamp((uTransient * 1.35 + uTreble * 0.65) * uReactivity, 0.0, 1.0);
  crush = clamp(crush + hit * 0.55, 0.0, 1.0);
  smearAmt = clamp(smearAmt + hit * 0.3, 0.0, 1.0);
  float mixAmt = clamp(blockAmt * 0.9 + smearAmt * 0.45 + crush * 0.7, 0.0, 1.0);
  if (mixAmt < 0.01) {
    gl_FragColor = vec4(clean, 1.0);
    return;
  }

  float block = max(1.0, mix(1.0, 36.0, blockAmt));
  vec2 pix = vUv * uResolution;
  vec2 id = floor(pix / block);
  vec2 inside = fract(pix / block);
  vec2 dragged = id + mix(inside, vec2(0.12, 0.2), smearAmt);
  vec3 lumaSample = src((id * block + inside * mix(1.0, 0.35, blockAmt)) / uResolution);
  vec3 chroma = src((dragged * block) / uResolution);
  float y = luma(lumaSample);
  vec3 col = chroma - luma(chroma) + y;
  float steps = mix(28.0, 4.0, crush);
  col = floor(col * steps + 0.5) / steps;
  gl_FragColor = vec4(mix(clean, col, mixAmt), 1.0);
}
