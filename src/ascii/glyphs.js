import * as THREE from 'three';

// Must match ATLAS / CELL_ASPECT in ascii.frag.
const ATLAS_COLS = 16;
const ATLAS_ROWS = 6;
const CELL_H = 64;
const CELL_W = Math.round(CELL_H * 0.6);
const FONT = `bold ${Math.round(CELL_H * 0.8)}px Consolas, Menlo, "Courier New", monospace`;
const CODE_COLS = 160;

/**
 * Renders printable ASCII into an atlas, ordered from least to most ink,
 * so a brightness value maps directly onto a glyph slot.
 */
export function createGlyphAtlas() {
  const chars = [];
  for (let c = 32; c < 127; c++) chars.push(String.fromCharCode(c));

  const probe = document.createElement('canvas');
  probe.width = CELL_W;
  probe.height = CELL_H;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  const setupText = (ctx) => {
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
  };
  const drawGlyph = (ctx, ch, x, y) => ctx.fillText(ch, x + CELL_W / 2, y + CELL_H / 2);
  setupText(pctx);

  const coverage = new Map();
  for (const ch of chars) {
    pctx.clearRect(0, 0, CELL_W, CELL_H);
    drawGlyph(pctx, ch, 0, 0);
    const px = pctx.getImageData(0, 0, CELL_W, CELL_H).data;
    let sum = 0;
    for (let i = 3; i < px.length; i += 4) sum += px[i];
    coverage.set(ch, sum);
  }
  const sorted = [...chars].sort((a, b) => coverage.get(a) - coverage.get(b));

  const atlas = document.createElement('canvas');
  atlas.width = CELL_W * ATLAS_COLS;
  atlas.height = CELL_H * ATLAS_ROWS;
  const actx = atlas.getContext('2d');
  actx.fillStyle = '#000';
  actx.fillRect(0, 0, atlas.width, atlas.height);
  setupText(actx);

  const slotOf = new Map();
  sorted.forEach((ch, i) => {
    slotOf.set(ch, i);
    drawGlyph(actx, ch, (i % ATLAS_COLS) * CELL_W, Math.floor(i / ATLAS_COLS) * CELL_H);
  });

  const texture = new THREE.CanvasTexture(atlas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  return { texture, count: sorted.length, slotOf };
}

/** Packs source text (whitespace collapsed) into a grid texture of glyph slots. */
export function createCodeTexture(source, slotOf) {
  const text = source.replace(/\s+/g, ' ').trim() + ' ';
  const rows = Math.ceil(text.length / CODE_COLS);
  const fallback = slotOf.get('?');
  const data = new Uint8Array(CODE_COLS * rows).fill(slotOf.get(' '));
  for (let i = 0; i < text.length; i++) data[i] = slotOf.get(text[i]) ?? fallback;

  const texture = new THREE.DataTexture(data, CODE_COLS, rows, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, size: new THREE.Vector2(CODE_COLS, rows) };
}
