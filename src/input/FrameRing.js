import * as THREE from 'three';
import vertexShader from '../shaders/fullscreen.vert?raw';
import copyFrag from '../shaders/copy.frag?raw';

// GPU ring of recent video frames. Forward play writes; bounce reads backward
// so we never seek H.264 in reverse.

const RT = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
};

export class FrameRing {
  constructor({ capacity = 72, maxSide = 720 } = {}) {
    this.capacity = capacity;
    this.maxSide = maxSide;
    this.slots = [];
    this.times = [];
    this.length = 0;
    this.cursor = 0;
    this.revTime = 0;
    this.w = 0;
    this.h = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null } },
        vertexShader,
        fragmentShader: copyFrag,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get newest() {
    if (!this.length) return null;
    return this.slots[(this.cursor - 1 + this.capacity) % this.capacity];
  }

  get oldestTime() {
    if (!this.length) return 0;
    const i = this.length === this.capacity ? this.cursor : 0;
    return this.times[i] ?? 0;
  }

  get newestTime() {
    if (!this.length) return 0;
    return this.times[(this.cursor - 1 + this.capacity) % this.capacity] ?? 0;
  }

  clear() {
    this.length = 0;
    this.cursor = 0;
    this.revTime = 0;
  }

  dispose() {
    for (const rt of this.slots) rt.dispose();
    this.slots = [];
    this.quad.material.dispose();
    this.quad.geometry.dispose();
  }

  #fit(vw, vh) {
    const s = Math.min(1, this.maxSide / Math.max(vw, vh, 1));
    return {
      w: Math.max(2, Math.round((vw * s) / 2) * 2),
      h: Math.max(2, Math.round((vh * s) / 2) * 2),
    };
  }

  #ensure(vw, vh) {
    const { w, h } = this.#fit(vw, vh);
    if (w === this.w && h === this.h && this.slots.length === this.capacity) return;
    if (this.slots.length !== this.capacity) {
      for (const rt of this.slots) rt.dispose();
      this.slots = Array.from({ length: this.capacity }, () => new THREE.WebGLRenderTarget(w, h, RT));
      this.times = new Array(this.capacity).fill(0);
    } else {
      for (const rt of this.slots) rt.setSize(w, h);
    }
    this.w = w;
    this.h = h;
    this.clear();
  }

  push(renderer, srcTex, videoTime, vw, vh) {
    if (!srcTex || !renderer) return;
    this.#ensure(vw, vh);
    const prev = renderer.getRenderTarget();
    this.quad.material.uniforms.uTex.value = srcTex;
    renderer.setRenderTarget(this.slots[this.cursor]);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    this.times[this.cursor] = videoTime;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }

  startReverse() {
    this.revTime = this.newestTime;
    return this.newest;
  }

  /** Walk backward through captured timestamps. Returns the RT to display, or null when done. */
  stepReverse(dt, rate = 1) {
    if (this.length < 2) return this.newest;
    this.revTime -= dt * rate;
    if (this.revTime <= this.oldestTime) return null;
    return this.#atTime(this.revTime);
  }

  #atTime(t) {
    let best = (this.cursor - 1 + this.capacity) % this.capacity;
    let bestD = Infinity;
    for (let n = 0; n < this.length; n++) {
      const i = (this.cursor - 1 - n + this.capacity) % this.capacity;
      const d = Math.abs(this.times[i] - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return this.slots[best];
  }
}
