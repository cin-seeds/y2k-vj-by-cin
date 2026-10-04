import * as THREE from 'three';
import fullscreenVert from '../shaders/fullscreen.vert?raw';
import simFrag from '../shaders/particleSim.frag?raw';
import particleVert from '../shaders/particle.vert?raw';
import particleFrag from '../shaders/particle.frag?raw';
import { particleGrid } from './constants.js';
import { particleDrive } from './drive.js';

export const PARTICLE_SOURCE = `// particleSim.frag\n${simFrag}\n\n// particle.vert\n${particleVert}\n\n// particle.frag\n${particleFrag}`;

const STATE_RT = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

function stateTarget(w, h) {
  return new THREE.WebGLRenderTarget(w, h, STATE_RT);
}

function pointGeometry(grid) {
  const uvs = new Float32Array(grid.count * 2);
  const positions = new Float32Array(grid.count * 3);
  let i = 0;
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      uvs[i * 2] = (x + 0.5) / grid.w;
      uvs[i * 2 + 1] = (y + 0.5) / grid.h;
      i++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

const CAM_FOV = 36;
const CAM_Z = 1 / Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2));
const PLANE = 2 * Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_Z * 0.92;

function simUniforms() {
  return {
    uState: { value: null },
    uTex: { value: null },
    uUvScale: { value: new THREE.Vector2(1, 1) },
    uFit: { value: 0 },
    uMirror: { value: 0 },
    uHasInput: { value: 0 },
    uSeed: { value: 0 },
    uTime: { value: 0 },
    uNoiseScale: { value: 2 },
    uFreq: { value: 0.2 },
    uFlow: { value: 0.4 },
    uBlow: { value: 0 },
    uSpring: { value: 0.02 },
    uDt: { value: 0.016 },
  };
}

export class ParticleFlow {
  constructor(count = 20000) {
    this.needsSeed = true;
    this.grid = particleGrid(count);
    this.stateA = stateTarget(this.grid.w, this.grid.h);
    this.stateB = stateTarget(this.grid.w, this.grid.h);

    this.simUniforms = simUniforms();
    this.simScene = new THREE.Scene();
    this.simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.simUniforms,
        vertexShader: fullscreenVert,
        fragmentShader: simFrag,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.simQuad.frustumCulled = false;
    this.simScene.add(this.simQuad);

    this.drawUniforms = {
      uState: { value: null },
      uParticleTexture: { value: null },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFit: { value: 0 },
      uMirror: { value: 0 },
      uHasInput: { value: 0 },
      uTime: { value: 0 },
      uPointSize: { value: 8 },
      uDepth: { value: 0.85 },
      uPlane: { value: PLANE },
      uCamZ: { value: CAM_Z },
      uAspect: { value: 1 },
      uSubBass: { value: 0 },
      uPunch: { value: 0 },
      uColorMode: { value: 0 },
    };
    this.points = new THREE.Points(
      pointGeometry(this.grid),
      new THREE.ShaderMaterial({
        uniforms: this.drawUniforms,
        vertexShader: particleVert,
        fragmentShader: particleFrag,
        transparent: true,
        depthTest: true,
        depthWrite: true,
        blending: THREE.NormalBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.pointScene = new THREE.Scene();
    this.pointScene.add(this.points);
    this.pointCam = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.05, 12);
    this.pointCam.position.set(0, 0, CAM_Z);
    this.pointCam.lookAt(0, 0, 0);
  }

  /** Resize the sim grid when Particle Count changes. Same dimensions are a no-op. */
  setCount(count) {
    const next = particleGrid(count);
    if (next.w === this.grid.w && next.h === this.grid.h) return;
    this.grid = next;
    this.stateA.setSize(next.w, next.h);
    this.stateB.setSize(next.w, next.h);
    this.points.geometry.dispose();
    this.points.geometry = pointGeometry(next);
    this.needsSeed = true;
  }

  /**
   * Simulate into the ping-pong state, then draw the point cloud into the target
   * already bound. `sample.tex` is uParticleTexture. fitted=true applies this
   * layer's fit/mirror; a layer buffer is sampled 1:1.
   */
  render(renderer, layerUniforms, dt, sample) {
    const dest = renderer.getRenderTarget();
    const drive = particleDrive(layerUniforms, dt, { colorMode: sample.colorMode });
    this.#copyInputs(layerUniforms, drive, sample);

    if (this.needsSeed) {
      this.#seed(renderer);
      this.needsSeed = false;
    }
    this.simUniforms.uSeed.value = 0;
    this.simUniforms.uState.value = this.stateA.texture;
    renderer.setRenderTarget(this.stateB);
    renderer.render(this.simScene, this.simCam);
    [this.stateA, this.stateB] = [this.stateB, this.stateA];

    const w = dest ? dest.width : renderer.domElement.width;
    const h = dest ? dest.height : renderer.domElement.height;
    const aspect = w / Math.max(h, 1);
    this.pointCam.aspect = aspect;
    this.pointCam.updateProjectionMatrix();
    this.drawUniforms.uAspect.value = aspect;
    this.drawUniforms.uResolution.value.set(w, h);
    this.drawUniforms.uState.value = this.stateA.texture;
    renderer.setRenderTarget(dest);
    renderer.render(this.pointScene, this.pointCam);
    return drive;
  }

  #copyInputs(layerUniforms, drive, sample) {
    const sim = this.simUniforms;
    const draw = this.drawUniforms;
    const identity = !sample.fitted;
    sim.uTex.value = sample.tex;
    draw.uParticleTexture.value = sample.tex;
    sim.uHasInput.value = draw.uHasInput.value = sample.hasInput;
    sim.uFit.value = draw.uFit.value = identity ? 0 : layerUniforms.uFit.value;
    sim.uMirror.value = draw.uMirror.value = identity ? 0 : layerUniforms.uMirror.value;
    if (identity) {
      sim.uUvScale.value.set(1, 1);
      draw.uUvScale.value.set(1, 1);
    } else {
      sim.uUvScale.value.copy(layerUniforms.uUvScale.value);
      draw.uUvScale.value.copy(layerUniforms.uUvScale.value);
    }
    sim.uTime.value = draw.uTime.value = drive.uTime;
    sim.uNoiseScale.value = drive.uNoiseScale;
    sim.uFreq.value = drive.uFreq;
    sim.uFlow.value = drive.uFlow;
    sim.uBlow.value = drive.uBlow;
    sim.uSpring.value = drive.uSpring;
    sim.uDt.value = drive.uDt;
    draw.uPointSize.value = drive.uPointSize;
    draw.uDepth.value = drive.uDepth;
    draw.uSubBass.value = drive.uSubBass;
    draw.uPunch.value = drive.uPunch;
    draw.uColorMode.value = drive.uColorMode;
  }

  #seed(renderer) {
    this.simUniforms.uSeed.value = 1;
    for (const rt of [this.stateA, this.stateB]) {
      renderer.setRenderTarget(rt);
      renderer.render(this.simScene, this.simCam);
    }
  }
}
