import * as THREE from 'three';

// Printable ASCII, one glyph per cell. Slot (code - 32) is the atlas index.
const FIRST = 32;
const COUNT = 95;
const COLS = 16;
const ROWS = 6;
const CELL = 64;

const SOURCE_COLS = 256;
const SOURCE_ROWS = 48;
const STATUS_LEN = 64;

export class GlyphAtlas {
  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = COLS * CELL;
    canvas.height = ROWS * CELL;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(CELL * 0.72)}px Consolas, "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < COUNT; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      ctx.fillText(String.fromCharCode(FIRST + i), col * CELL + CELL / 2, row * CELL + CELL / 2 + 2);
    }
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.grid = new THREE.Vector2(COLS, ROWS);
  }
}

// The characters the overlay prints: a short live status line, then the active shader source.
export class SourceBuffer {
  constructor() {
    this.cols = SOURCE_COLS;
    this.rows = SOURCE_ROWS;
    this.data = new Uint8Array(SOURCE_COLS * SOURCE_ROWS * 4);
    this.length = 1;
    this.texture = new THREE.DataTexture(
      this.data,
      SOURCE_COLS,
      SOURCE_ROWS,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.resolution = new THREE.Vector2(SOURCE_COLS, SOURCE_ROWS);
    this.body = ' ';
  }

  setProgram(source) {
    const lines = source.split('\n').map((line) => line.replace(/[^\x20-\x7e]/g, '').slice(0, 72));
    this.body = lines.map((line) => line.padEnd(72, ' ')).join('');
    this.#write(this.status || '');
  }

  /** First STATUS_LEN slots, refreshed while the overlay is on. */
  setStatus(line) {
    this.status = line;
    const s = line.padEnd(STATUS_LEN, ' ').slice(0, STATUS_LEN);
    for (let i = 0; i < STATUS_LEN; i++) this.data[i * 4] = s.charCodeAt(i);
    this.texture.needsUpdate = true;
  }

  #write(status) {
    const head = status.padEnd(STATUS_LEN, ' ').slice(0, STATUS_LEN);
    const text = head + this.body;
    const n = Math.min(text.length, SOURCE_COLS * SOURCE_ROWS);
    this.data.fill(32);
    for (let i = 0; i < n; i++) this.data[i * 4] = text.charCodeAt(i);
    this.length = Math.max(n, 1);
    this.texture.needsUpdate = true;
  }
}
