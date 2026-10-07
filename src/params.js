import { ENGINE_HYDRA, ENGINE_LABELS, ENGINE_PARTICLES, ENGINES, PARTICLE_SOURCES } from './engines/constants.js';

// Every controllable value lives here. Each param can be driven by the UI, MIDI, and scenes.
// Layer params are stored per layer as "A.glitch", "B.glitch", ...; the part after the dot
// maps to a shader uniform on that layer (`u` + capitalised key).

export const LAYERS = ['A', 'B', 'C'];

export const MODES = ['glitch', 'dither', 'y2k', 'vhs', 'points', 'mesh', 'retro', 'clean', 'win98', 'ps1', 'ascii', 'eater', 'minidv', 'flash', 'starfield', 'metal', 'thermal', 'sort', 'jpeg', 'cd', 'bend', 'home', 'marquee', 'gif', 'cloud', 'brick', 'ink', 'fold', 'chomp'];
export const MODE_LABELS = [
  'Glitch', 'Pixel Art / Dither', 'Y2K / 2000s', 'VHS', '3D Point Cloud', '3D Spatial Mesh',
  '90s Retro Gaming', 'Clean (no FX)', 'Windows 98 Crash', 'PS1 / N64 CRT', 'ASCII / Pointillism',
  'Signal Eater', 'MiniDV', 'Flash MX', 'Starfield', 'Black Metallic Y2K', 'False-Color Thermal', 'Pixel Sort', 'JPEG Decay', 'CD Seek', 'Data Bend', 'Homepage', 'Marquee', 'Interlaced GIF', 'Digital Clouds', 'Nature Blocks', 'Ink', 'Fold', 'Chomp',
];
/** Removed looks. Their slots stay empty so every later shader keeps its saved number. */
export const RETIRED_SHADER_MODES = new Set([4, 5]);
export const CLEAN_SHADER_MODE = MODES.indexOf('clean');
export const SHADER_KEY_MODES = MODES.map((_, i) => i).filter((i) => !RETIRED_SHADER_MODES.has(i));
export const MODE_3D = new Set(['points', 'mesh']);

export function shaderMode(index) {
  const i = Math.round(Number(index));
  if (!Number.isFinite(i)) return 0;
  if (RETIRED_SHADER_MODES.has(i)) return CLEAN_SHADER_MODE;
  return Math.min(MODES.length - 1, Math.max(0, i));
}

export const BLEND_LABELS = [
  'Normal', 'Multiply', 'Screen', 'Color Dodge', 'Difference',
  'Add / Linear Dodge', 'Exclusion', 'Overlay',
];
/** Card menu order. The numbers are the stored blend indices. */
export const BLEND_MENU = [0, 5, 2, 1, 4, 6, 7, 3];
export const AUDIO_BINDS = ['All bands', 'Bass only', 'Mid only', 'Treble only', 'Off'];

export const GRID_SIZES = [128, 256, 512];

export const PLAY_MODE_LABELS = ['Loop', 'Play Once & Hold Last Frame', 'Bounce / Ping-Pong'];
export const ENTRY_STYLE_LABELS = ['Cut / Instant', 'Linear Fade', 'Zoom & Dissolve', 'Glitch Flash'];

export const GLOBAL_DEFS = [
  { id: 'master', label: 'Brightness', group: 'output', min: 0, max: 1, value: 1 },
  { id: 'audioGain', label: 'Audio Gain', group: 'output', min: 0, max: 4, value: 1 },

  { id: 'crtScan', label: 'Scanlines', group: 'crt', min: 0, max: 1, value: 0 },
  { id: 'crtBleed', label: 'Phosphor Bleed', group: 'crt', min: 0, max: 1, value: 0 },
  { id: 'crtBarrel', label: 'Barrel Distortion', group: 'crt', min: 0, max: 1, value: 0 },

  { id: 'gradeHue', label: 'Hue Shift', group: 'grade', min: 0, max: 1, value: 0 },
  { id: 'gradeSat', label: 'Saturation', group: 'grade', min: 0, max: 2, value: 1 },
  { id: 'gradeContrast', label: 'Contrast', group: 'grade', min: 0, max: 2, value: 1 },

  { id: 'strobe', label: 'Strobe Amount', group: 'strobe', min: 0, max: 1, value: 0 },
  { id: 'strobeSrc', label: 'Strobe Source', group: 'strobe', min: 0, max: 2, step: 1, value: 1,
    options: ['Manual', 'Beat Pulse', 'Drop Pulse'] },
  { id: 'strobePol', label: 'Strobe Color', group: 'strobe', min: 0, max: 1, step: 1, value: 0,
    options: ['White', 'Black'] },

  { id: 'chroma', label: 'RGB Separation', group: 'chroma', min: 0, max: 1, value: 0 },
];

// group: 'mix' = compositor strip, 'layer' = placement (always in the layer editor),
// 'video' / 'image' = source controls for that media kind,
// 'fx' = the shader picker, a mode id = that look's own knobs,
// 'look' + modes = one stored knob shared by several shaders.
export const LAYER_DEFS = [
  { id: 'engine', label: 'Engine Type', group: 'head', min: 0, max: ENGINES.length - 1, step: 1, value: 0,
    options: ENGINES.map((id) => ENGINE_LABELS[id]) },

  { id: 'opacity', label: 'Opacity', group: 'mix', min: 0, max: 1, value: 1 },
  { id: 'blend', label: 'Blend', group: 'mix', min: 0, max: BLEND_LABELS.length - 1, step: 1, value: 0, options: BLEND_LABELS },
  { id: 'blendInvert', label: 'Invert Blend', group: 'mix', min: 0, max: 1, step: 1, value: 0, options: ['Off', 'On'] },

  { id: 'playMode', label: 'Playback', group: 'video', min: 0, max: 2, step: 1, value: 0,
    options: PLAY_MODE_LABELS },
  { id: 'loopXfade', label: 'Loop Crossfade', group: 'video', min: 0, max: 1, step: 1, value: 0,
    options: ['Off', 'On'] },
  { id: 'loopXfadeDur', label: 'Loop Crossfade Time', group: 'video', min: 0.1, max: 2, value: 0.4 },

  { id: 'entryStyle', label: 'Image Entry Style', group: 'image', min: 0, max: 3, step: 1, value: 1,
    options: ENTRY_STYLE_LABELS },
  { id: 'entryDur', label: 'Entry Duration', group: 'image', min: 0.1, max: 5, step: 0.01, value: 0.6 },

  { id: 'mode', label: 'Shader', group: 'fx', min: 0, max: MODES.length - 1, step: 1, value: 0,
    options: MODE_LABELS },
  { id: 'scale', label: 'Scale', group: 'layer', min: 0.1, max: 3, value: 1 },
  { id: 'posX', label: 'Position X', group: 'layer', min: -1, max: 1, value: 0 },
  { id: 'posY', label: 'Position Y', group: 'layer', min: -1, max: 1, value: 0 },
  { id: 'reactivity', label: 'Audio Reactivity', group: 'layer', min: 0, max: 2, value: 1 },
  { id: 'audioBind', label: 'Audio Binding', group: 'layer', min: 0, max: 4, step: 1, value: 0,
    options: AUDIO_BINDS },
  { id: 'beatSync', label: 'Beat Sync (BPM)', group: 'layer', min: 0, max: 1, value: 0 },
  { id: 'glitch', label: 'Glitch Intensity', group: 'look', modes: ['glitch', 'y2k', 'dither', 'metal'], min: 0, max: 1, value: 0.5 },
  { id: 'feedback', label: 'Feedback / Mosh', group: 'look', modes: ['glitch', 'y2k', 'metal'], min: 0, max: 0.98, value: 0.6 },

  { id: 'pSource', label: 'Particle Texture Source', group: 'particles', min: 0, max: PARTICLE_SOURCES.length - 1, step: 1, value: 0,
    options: PARTICLE_SOURCES, uniform: false,
    title: 'Current Layer Video samples this layer’s clip. Layer A/B Buffer samples that layer’s rendered picture, so a layer above can tear it apart. Procedural Noise Grid ignores video.' },
  { id: 'pCount', label: 'Particle Count', group: 'particles', min: 5000, max: 50000, step: 1000, value: 20000,
    uniform: false },
  { id: 'pSize', label: 'Point Size', group: 'particles', min: 1, max: 20, step: 0.5, value: 8,
    title: 'Soft-circle point size in pixels, at rest. Points closer to the camera grow slightly.' },
  { id: 'pDepth', label: 'Z-Displacement Depth', group: 'particles', min: 0, max: 2, value: 0.85,
    title: 'How far bright pixels push toward the camera. 0 keeps the cloud flat.' },
  { id: 'pTurbulence', label: 'Turbulence Field / Noise Scale', group: 'particles', min: 0, max: 3, value: 1 },
  { id: 'pSpeed', label: 'Velocity / Speed', group: 'particles', min: 0, max: 3, value: 1,
    title: 'How fast particles drift, and how hard a kick throws them before they spring back to their pixel.' },
  { id: 'pColor', label: 'Color Blend Mode', group: 'particles', min: 0, max: 1, step: 1, value: 0,
    options: ['Direct Video Color', 'Audio-Reactive Color Tint'], uniform: false },

  { id: 'hDecay', label: 'Feedback Decay', group: 'hydra', min: 0, max: 1, value: 0.72,
    title: 'Trail persistence. Higher keeps more of the previous frame. The trail is then composited with this layer’s blend mode and opacity.' },
  { id: 'hRot', label: 'Rotation Speed', group: 'hydra', min: 0, max: 2, value: 0.4 },
  { id: 'hZoom', label: 'Zoom / Scale Bleed', group: 'hydra', min: 0, max: 1, value: 0.25 },
  { id: 'hHue', label: 'Color Phase Shift', group: 'hydra', min: 0, max: 1, value: 0 },

  { id: 'pixelSize', label: 'Pixel Size', group: 'dither', min: 1, max: 48, step: 1, value: 6 },
  { id: 'palette', label: 'Palette', group: 'dither', min: 0, max: 4, step: 1, value: 0,
    options: ['PS1 15-bit', 'Game Boy', 'CGA', 'Win95 16', '1-bit'] },
  { id: 'colorDepth', label: 'Color Levels', group: 'dither', min: 2, max: 32, step: 1, value: 32 },
  { id: 'dither', label: 'Dither Amount', group: 'dither', min: 0, max: 1.5, value: 1 },
  { id: 'jitter', label: 'PS1 Wobble', group: 'dither', min: 0, max: 1, value: 0.3 },

  { id: 'edgeGlow', label: 'Edge Glow', group: 'y2k', min: 0, max: 3, value: 1.2 },
  { id: 'clouds', label: 'Clouds', group: 'y2k', min: 0, max: 1, value: 0.6 },
  { id: 'hueShift', label: 'Hue Shift', group: 'y2k', min: 0, max: 1, value: 0 },

  { id: 'tracking', label: 'Tracking Noise', group: 'vhs', min: 0, max: 1, value: 0.55 },
  { id: 'tapeJitter', label: 'Tape Jitter', group: 'vhs', min: 0, max: 1, value: 0.4 },
  { id: 'smear', label: 'Color Smear', group: 'vhs', min: 0, max: 1, value: 0.6 },
  { id: 'scanlines', label: 'Scanline Density', group: 'vhs', min: 0, max: 1, value: 0.7 },

  { id: 'pointExtrude', label: 'Extrude Height', group: 'points', min: 0, max: 3, value: 1.25 },
  { id: 'pointSize', label: 'Point Size', group: 'points', min: 0.5, max: 16, value: 3.5 },
  { id: 'cloudGrid', label: 'Grid', group: 'points', min: 0, max: 2, step: 1, value: 1,
    options: ['128', '256', '512'], uniform: false },

  { id: 'meshExtrude', label: 'Extrude Depth', group: 'mesh', min: 0, max: 3, value: 1 },
  { id: 'meshGrid', label: 'Grid', group: 'mesh', min: 0, max: 2, step: 1, value: 1,
    options: ['128', '256', '512'], uniform: false },

  { id: 'winTrail', label: 'Window Trail', group: 'win98', min: 0, max: 1, value: 0.8,
    title: 'How hard moving picture leaves frozen copies. Higher holds the staggered windows longer.' },
  { id: 'winStagger', label: 'Drag Stagger', group: 'win98', min: 2, max: 80, step: 1, value: 28,
    title: 'Pixel gap between each frozen copy, like a window dragged with redraw broken.' },
  { id: 'winDither', label: 'Bayer Dither', group: 'win98', min: 0, max: 2, value: 1.15,
    title: 'Ordered dither into the 256-color palette. Zero is flat banding.' },

  { id: 'psAffine', label: 'Affine Warp', group: 'ps1', min: 0, max: 1, value: 0.6,
    title: 'Perspective-incorrect texture shear inside each low-res polygon.' },
  { id: 'psWobble', label: 'Vertex Snap', group: 'ps1', min: 0, max: 1, value: 0.45,
    title: 'Whole-texel jitter, the way a 32-bit console swims when geometry is under load.' },
  { id: 'psCrt', label: 'CRT Mask', group: 'ps1', min: 0, max: 1, value: 0.9,
    title: 'Barrel curve, scanlines, and the RGB phosphor grille.' },

  { id: 'asciiSize', label: 'Brush / Character Size', group: 'ascii', min: 4, max: 48, step: 1, value: 14 },
  { id: 'asciiQuant', label: 'Color Quantization', group: 'ascii', min: 2, max: 16, step: 1, value: 5,
    title: 'How many levels each channel keeps. Lower looks more like a 16-color terminal.' },
  { id: 'asciiStyle', label: 'Stroke Style', group: 'ascii', min: 0, max: 1, step: 1, value: 0,
    options: ['ASCII Terminal', 'Painterly Blobs'] },

  { id: 'snapSize', label: 'Pixel Snap', group: 'retro', min: 1, max: 24, step: 1, value: 4 },
  { id: 'retroDither', label: 'Bayer Dither', group: 'retro', min: 0, max: 1.5, value: 0.85 },
  { id: 'affine', label: 'Affine Warp', group: 'retro', min: 0, max: 1, value: 0.45 },
  { id: 'wobble', label: 'Vertex Wobble', group: 'retro', min: 0, max: 1, value: 0.35 },

  { id: 'bite', label: 'Bite', group: 'eater', min: 0, max: 1, value: 0.45 },
  { id: 'chew', label: 'Chew', group: 'eater', min: 0, max: 1, value: 0.35 },
  { id: 'threshold', label: 'Threshold', group: 'eater', min: 0, max: 1, value: 0.4 },
  { id: 'leftovers', label: 'Leftovers', group: 'eater', min: 0, max: 1, value: 0.5 },

  { id: 'interlace', label: 'Interlace', group: 'minidv', min: 0, max: 1, value: 0.7 },
  { id: 'datestamp', label: 'Date Stamp', group: 'minidv', min: 0, max: 1, value: 0.8 },
  { id: 'nightshot', label: 'Nightshot', group: 'minidv', min: 0, max: 1, value: 0 },
  { id: 'crop', label: 'Frame Crop', group: 'minidv', min: 0, max: 1, value: 0.35 },

  { id: 'blob', label: 'Blob', group: 'flash', min: 0, max: 1, value: 0.55 },
  { id: 'outline', label: 'Outline', group: 'flash', min: 0, max: 1, value: 0.7 },
  { id: 'flatColor', label: 'Flat Color', group: 'flash', min: 0, max: 1, value: 0.45 },
  { id: 'tween', label: 'Tween', group: 'flash', min: 0, max: 1, value: 0.3 },

  { id: 'warp', label: 'Warp', group: 'starfield', min: 0, max: 1, value: 0.4 },
  { id: 'porthole', label: 'Porthole', group: 'starfield', min: 0, max: 1, value: 0.65 },
  { id: 'grid', label: 'Vector Grid', group: 'starfield', min: 0, max: 1, value: 0.35 },
  { id: 'flash', label: 'Hyperspace', group: 'starfield', min: 0, max: 1, value: 0.5 },

  { id: 'heat', label: 'Contrast', group: 'thermal', min: 0, max: 2, value: 1,
    title: 'Spreads the thermal grade around mid gray. 1 keeps the video’s brightness before the palette.' },

  { id: 'sortGate', label: 'Threshold', group: 'sort', min: 0, max: 1, value: 0.55,
    title: 'How bright a pixel must be before it streaks up the frame.' },
  { id: 'sortLen', label: 'Length', group: 'sort', min: 0, max: 1, value: 0.4,
    title: 'How far those pixels streak upward. Low falls back to the picture. A kick or snare throws the streak farther.' },
  { id: 'sortFall', label: 'Falloff', group: 'sort', min: 0, max: 1, value: 0.45,
    title: 'How quickly the streak fades as it rises.' },

  { id: 'jpegBlock', label: 'Block', group: 'jpeg', min: 0, max: 1, value: 0.45,
    title: 'Size of the square blocks. Low keeps the picture.' },
  { id: 'jpegSmear', label: 'Smear', group: 'jpeg', min: 0, max: 1, value: 0.55,
    title: 'How far color smears inside each block.' },
  { id: 'jpegCrush', label: 'Damage', group: 'jpeg', min: 0, max: 1, value: 0.4,
    title: 'How hard the blocks quantize. A transient or the hats raise it for a moment.' },

  { id: 'cdRing', label: 'Rings', group: 'cd', min: 0, max: 1, value: 0.55,
    title: 'How strongly the concentric grooves sit on the picture.' },
  { id: 'cdSeek', label: 'Seek', group: 'cd', min: 0, max: 1, value: 0.4,
    title: 'How far the picture stutters sideways. A kick triggers a harder seek.' },
  { id: 'cdRate', label: 'Rate', group: 'cd', min: 0, max: 1, value: 0.35,
    title: 'How often the disc loses its place. A kick chatters the seek.' },

  { id: 'bendAmt', label: 'Bend', group: 'bend', min: 0, max: 1, value: 0.45,
    title: 'How far the bottom of the frame slides. The top stays put. A kick adds one extra shove.' },
  { id: 'bendCurve', label: 'Curve', group: 'bend', min: 0, max: 1, value: 0.35,
    title: 'How quickly the slide grows toward the bottom. Low is a straight shear.' },
  { id: 'bendLean', label: 'Lean', group: 'bend', min: 0, max: 1, value: 1,
    title: 'Which way the rows slide. Left at 0, right at 1.' },

  { id: 'homeTile', label: 'Tile', group: 'home', min: 0, max: 1, value: 0.35,
    title: 'Size of the repeating wallpaper. A kick punches it larger for a moment, then it falls back.' },
  { id: 'homeMix', label: 'Frame', group: 'home', min: 0, max: 1, value: 0.65,
    title: 'Moves from tiled wallpaper to the framed photo sitting on that page.' },
  { id: 'homeBevel', label: 'Bevel', group: 'home', min: 0, max: 1, value: 0.7,
    title: 'Depth of the beveled frame around the photo.' },

  { id: 'marqueeBand', label: 'Band', group: 'marquee', min: 0, max: 1, value: 0.78,
    title: 'Where the crawling band sits. The rest of the frame holds.' },
  { id: 'marqueeSize', label: 'Height', group: 'marquee', min: 0, max: 1, value: 0.28,
    title: 'How tall the crawling band is. Zero leaves the frame still.' },
  { id: 'marqueeSpeed', label: 'Speed', group: 'marquee', min: 0, max: 1, value: 0.45,
    title: 'How fast the band scrolls and loops. A kick shoves the scroll.' },

  { id: 'gifLoad', label: 'Load', group: 'gif', min: 0, max: 1, value: 0.35,
    title: 'How much of the picture has arrived. A kick finishes it, then it falls back toward the coarse pass.' },
  { id: 'gifGap', label: 'Gap', group: 'gif', min: 0, max: 1, value: 0.65,
    title: 'How many rows the first pass skips. The missing rows fill in as Load rises.' },
  { id: 'gifEase', label: 'Ease', group: 'gif', min: 0, max: 1, value: 0.4,
    title: 'How long the coarse pass holds before the later rows arrive.' },

  { id: 'cloudCover', label: 'Cover', group: 'cloud', min: 0, max: 1, value: 0.45,
    title: 'How much of the frame is cloud. Bass swells the cover. Zero leaves the picture.' },
  { id: 'cloudDrift', label: 'Drift', group: 'cloud', min: 0, max: 1, value: 0.4,
    title: 'How fast the puffs travel. A kick pushes them, then they fall back.' },
  { id: 'cloudBand', label: 'Bands', group: 'cloud', min: 0, max: 1, value: 0.55,
    title: 'How many shade steps the puffs keep. Low is chunkier.' },

  { id: 'brickSize', label: 'Size', group: 'brick', min: 0, max: 1, value: 0.42,
    title: 'How big each brick is. A kick nudges the size for a moment, then it falls back.' },
  { id: 'brickStud', label: 'Studs', group: 'brick', min: 0, max: 1, value: 0.75,
    title: 'How strong the stud on each brick is. Zero leaves the faces bare.' },
  { id: 'brickTint', label: 'Tint', group: 'brick', min: 0, max: 1, value: 0.8,
    title: 'How far each brick is pushed toward grass, leaf, lime, moss, and soil.' },

  { id: 'inkLife', label: 'Life', group: 'ink', min: 0, max: 1, value: 0.72,
    title: 'How long the stirred picture stays. Zero shows the live frame.' },
  { id: 'inkStir', label: 'Stir', group: 'ink', min: 0, max: 1, value: 0.45,
    title: 'How hard the ink moves. A kick throws a short, harder stir.' },
  { id: 'inkCurl', label: 'Curl', group: 'ink', min: 0, max: 1, value: 0.4,
    title: 'How tight the swirls are. The curl follows the picture’s brightness.' },

  { id: 'foldDepth', label: 'Depth', group: 'fold', min: 0, max: 1, value: 0.45,
    title: 'How deep the picture folds into itself. Bass deepens it. Zero leaves the frame.' },
  { id: 'foldScale', label: 'Scale', group: 'fold', min: 0, max: 1, value: 0.4,
    title: 'Size of the sheets. A kick snaps them tighter for a moment.' },
  { id: 'foldSheets', label: 'Sheets', group: 'fold', min: 0, max: 1, value: 0.7,
    title: 'How many reads of this frame meet in one pixel.' },

  { id: 'chompSize', label: 'Size', group: 'chomp', min: 0, max: 1, value: 0.35,
    title: 'How big the disc is. Larger discs take fewer rows to cross the frame.' },
  { id: 'chompSpeed', label: 'Speed', group: 'chomp', min: 0, max: 1, value: 0.4,
    title: 'How fast the disc crosses. A kick advances it one bite.' },
  { id: 'chompMouth', label: 'Mouth', group: 'chomp', min: 0, max: 1, value: 0.75,
    title: 'How wide the mouth opens between bites. A kick closes it.' },
];

// Layers start as a usable stack: A visible, B and C ready but faded out.
// Audio defaults keep each layer on a different band so new projects stay readable.
const LAYER_OVERRIDES = {
  A: { opacity: 1, mode: 0, reactivity: 1, audioBind: 0, beatSync: 0 },
  B: { opacity: 0, mode: 2, blend: 2, reactivity: 0.6, audioBind: 3, beatSync: 0 },
  C: { opacity: 0, mode: 7, blend: 2, reactivity: 0.5, audioBind: 2, beatSync: 0 },
};

const NON_UNIFORM = new Set([
  'opacity', 'blend', 'blendInvert', 'mode', 'scale', 'posX', 'posY', 'audioBind', 'playMode', 'beatSync',
  'loopXfade', 'loopXfadeDur', 'entryStyle', 'entryDur', 'engine', 'pCount', 'pSource', 'pColor',
]);

export const uniformName = (key) => 'u' + key[0].toUpperCase() + key.slice(1);
export const layerParam = (layer, key) => `${layer}.${key}`;

const lookSection = (mode) => MODE_LABELS[MODES.indexOf(mode)];

export const CATEGORY_ORDER = [
  'Source & Playback',
  'Geometry & Scale',
  ...MODE_LABELS.filter((name, i) => name !== 'Clean (no FX)' && !RETIRED_SHADER_MODES.has(i)),
  ENGINE_LABELS[ENGINE_PARTICLES],
  ENGINE_LABELS[ENGINE_HYDRA],
  'Audio Reactivity',
  'Motion & Timing',
  'Distortion & Glitch',
  'Color & Texture',
  'Mix & Composite',
];

/** friendlyLabel, description, unit, category, neutralValue. defaultValue is the factory value. */
const PARAM_META = {
  master: { friendlyLabel: 'Output Brightness', description: 'Scales the brightness of the finished mix after every layer and master effect.', unit: '%', category: 'Mix & Composite', neutralValue: 1 },
  audioGain: { friendlyLabel: 'Analysis Gain', description: 'Raises or lowers the audio signal before the FFT. The speaker volume is separate.', unit: 'x', category: 'Audio Reactivity', neutralValue: 1 },
  crtScan: { friendlyLabel: 'Master Scanlines', description: 'Draws CRT scanlines across the whole mix so the layers read as one screen.', unit: '%', category: 'Distortion & Glitch', neutralValue: 0 },
  crtBleed: { friendlyLabel: 'Phosphor Bleed', description: 'Smears neighboring pixels sideways, like a CRT gun that cannot hold a sharp edge.', unit: '%', category: 'Color & Texture', neutralValue: 0 },
  crtBarrel: { friendlyLabel: 'Barrel Curve', description: 'Bends the mixed frame outward from the center, the curve of a glass tube.', unit: '%', category: 'Barrel', neutralValue: 0 },
  gradeHue: { friendlyLabel: 'Global Hue', description: 'Rotates the hue of the entire mix. A full slider travel is one turn around the color wheel.', unit: 'turn', category: 'Color & Texture', neutralValue: 0 },
  gradeSat: { friendlyLabel: 'Saturation', description: 'Pulls the mix toward gray or pushes the colors past their natural strength.', unit: 'x', category: 'Color & Texture', neutralValue: 1 },
  gradeContrast: { friendlyLabel: 'Contrast', description: 'Spreads or crushes the mix around mid-gray. 1x leaves the picture untouched.', unit: 'x', category: 'Color & Texture', neutralValue: 1 },
  strobe: { friendlyLabel: 'Strobe Amount', description: 'Flashes the whole mix hard to white or black. The source menu chooses manual, beat, or drop.', unit: '%', category: 'Motion & Timing', neutralValue: 0 },
  strobeSrc: { friendlyLabel: 'Strobe Source', description: 'Manual uses the amount as a steady flash. Beat and Drop multiply it by that pulse.', category: 'Motion & Timing', neutralValue: 1 },
  strobePol: { friendlyLabel: 'Strobe Color', description: 'Chooses whether the master strobe snaps to white or to black.', category: 'Motion & Timing', neutralValue: 0 },
  chroma: { friendlyLabel: 'Horiz. Chromatic Bleed', description: 'Displaces the red and blue channels outward from the screen center, like a misaligned CRT.', unit: '%', category: 'Distortion & Glitch', neutralValue: 0 },

  engine: { friendlyLabel: 'Engine', description: 'Picks how this layer builds its picture: a shader, a particle swarm, or a Hydra feedback loop.', category: 'Source & Playback', neutralValue: 0 },
  opacity: { friendlyLabel: 'Layer Mix', description: 'How strongly this layer is mixed into the picture underneath. 100% is fully present.', unit: '%', category: 'Mix & Composite', neutralValue: 1 },
  blend: { friendlyLabel: 'Blend Mode', description: 'How this layer combines with the picture under it.', category: 'Mix & Composite', neutralValue: 0 },
  blendInvert: { friendlyLabel: 'Invert Blend', description: 'Flips the blend result before it is mixed, so the composite comes through as its negative.', category: 'Mix & Composite', neutralValue: 0 },
  playMode: { friendlyLabel: 'Playback', description: 'Loop, play once and hold the last frame, or bounce back and forth.', category: 'Source & Playback', neutralValue: 0 },
  loopXfade: { friendlyLabel: 'Loop Crossfade', description: 'Blends the end of a clip into its start so the loop point does not cut.', category: 'Source & Playback', neutralValue: 0 },
  loopXfadeDur: { friendlyLabel: 'Loop Crossfade Time', description: 'How long the loop point takes to dissolve, in seconds.', unit: 's', category: 'Motion & Timing', neutralValue: 0.4 },
  entryStyle: { friendlyLabel: 'Image Entry', description: 'How a still image arrives: cut, fade, zoom dissolve, or a glitch flash.', category: 'Source & Playback', neutralValue: 0 },
  entryDur: { friendlyLabel: 'Entry Time', description: 'Length of the image entry animation, in seconds.', unit: 's', category: 'Source & Playback', neutralValue: 0.6 },
  mode: { friendlyLabel: 'Layer Shader', description: 'The look painted on this layer after the source and the transform. Clean is the picture with no extra effect.', category: 'Source & Playback', neutralValue: 7 },
  scale: { friendlyLabel: 'Zoom Scale', description: 'Enlarges or shrinks the layer around its center before color and post effects.', unit: 'x', category: 'Geometry & Scale', neutralValue: 1 },
  posX: { friendlyLabel: 'Position X', description: 'Slides the layer left or right. 0 is centered. The track is a fraction of the frame.', category: 'Geometry & Scale', neutralValue: 0 },
  posY: { friendlyLabel: 'Position Y', description: 'Slides the layer up or down. 0 is centered.', category: 'Geometry & Scale', neutralValue: 0 },
  reactivity: { friendlyLabel: 'Audio Reactivity', description: 'How strongly this layer’s shader listens to the audio bands. 0 ignores the sound.', unit: 'x', category: 'Audio Reactivity', neutralValue: 0 },
  audioBind: { friendlyLabel: 'Audio Band', description: 'Which part of the spectrum drives the shader: all bands, bass, mids, treble, or none.', category: 'Audio Reactivity', neutralValue: 4 },
  beatSync: { friendlyLabel: 'Beat Sync', description: 'Adds the tempo clock on top of the kick, so the picture pulses with the BPM.', unit: '%', category: 'Audio Reactivity', neutralValue: 0 },
  glitch: { friendlyLabel: 'Glitch Intensity', description: 'Tears scanlines, splits RGB, and drops blocks. Zero is a clean frame.', unit: '%', category: lookSection('glitch'), neutralValue: 0 },
  feedback: { friendlyLabel: 'Datamosh Feedback', description: 'Holds blocks of the previous frame and drags them. Zero stops the mosh.', unit: '%', category: lookSection('glitch'), neutralValue: 0 },
  pSource: { friendlyLabel: 'Particle Source', description: 'Which picture the swarm samples: this layer’s clip, layer A, layer B, or a noise grid.', category: 'Source & Playback', neutralValue: 0 },
  pCount: { friendlyLabel: 'Particle Count', description: 'How many points are in the swarm. Higher counts read the picture in finer detail.', unit: 'pts', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 20000 },
  pSize: { friendlyLabel: 'Point Size', description: 'Diameter of each particle, in pixels, before depth makes nearer points larger.', unit: 'px', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 8 },
  pDepth: { friendlyLabel: 'Z Depth', description: 'How far bright pixels push toward the camera. Zero keeps the swarm flat.', unit: 'x', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 0 },
  pTurbulence: { friendlyLabel: 'Turbulence', description: 'Scale of the noise field that shoves particles off their pixel.', unit: 'x', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 0 },
  pSpeed: { friendlyLabel: 'Swarm Speed', description: 'How fast particles drift, and how hard a kick throws them before they spring back.', unit: 'x', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 0 },
  pColor: { friendlyLabel: 'Particle Color', description: 'Direct video color, or a tint that shifts with the audio.', category: ENGINE_LABELS[ENGINE_PARTICLES], neutralValue: 0 },
  hDecay: { friendlyLabel: 'Trail Decay', description: 'How much of the previous Hydra frame survives. Lower decays the trail faster.', unit: '%', category: ENGINE_LABELS[ENGINE_HYDRA], neutralValue: 0 },
  hRot: { friendlyLabel: 'Feedback Rotation', description: 'Spins the Hydra feedback each frame. Zero holds the trail still.', unit: 'x', category: ENGINE_LABELS[ENGINE_HYDRA], neutralValue: 0 },
  hZoom: { friendlyLabel: 'Zoom Bleed', description: 'Scales the feedback inward so the trail blooms out of the center.', unit: '%', category: ENGINE_LABELS[ENGINE_HYDRA], neutralValue: 0 },
  hHue: { friendlyLabel: 'Trail Hue', description: 'Rotates the color of the Hydra trail each frame.', unit: 'turn', category: ENGINE_LABELS[ENGINE_HYDRA], neutralValue: 0 },
  pixelSize: { friendlyLabel: 'Pixel Size', description: 'Size of each dither cell, in pixels. Larger cells look more like a low-res console.', unit: 'px', category: lookSection('dither'), neutralValue: 1 },
  palette: { friendlyLabel: 'Palette', description: 'Snaps the picture to a fixed console palette: PS1, Game Boy, CGA, Windows 95, or 1-bit.', category: lookSection('dither'), neutralValue: 0 },
  colorDepth: { friendlyLabel: 'Color Levels', description: 'How many steps each channel keeps on the PS1 15-bit palette. Fewer levels band the picture harder.', category: lookSection('dither'), neutralValue: 32 },
  dither: { friendlyLabel: 'Dither Amount', description: 'Mixes ordered noise into the color steps so bands break into texture.', unit: '%', category: lookSection('dither'), neutralValue: 0 },
  jitter: { friendlyLabel: 'Vertex Wobble', description: 'Shakes the pixel grid the way a console swims when it is overloaded.', unit: '%', category: lookSection('dither'), neutralValue: 0 },
  edgeGlow: { friendlyLabel: 'Edge Glow', description: 'Lights the edges with an iridescent fringe. Zero removes the glow.', unit: 'x', category: lookSection('y2k'), neutralValue: 0 },
  clouds: { friendlyLabel: 'Sky Clouds', description: 'Mixes a procedural cloud field over the picture.', unit: '%', category: lookSection('y2k'), neutralValue: 0 },
  hueShift: { friendlyLabel: 'Hue Shift', description: 'Rotates this layer’s hue. One full travel is a complete turn of the color wheel.', unit: 'turn', category: lookSection('y2k'), neutralValue: 0 },
  tracking: { friendlyLabel: 'Tracking Noise', description: 'Drops VHS tracking snow across the frame.', unit: '%', category: lookSection('vhs'), neutralValue: 0 },
  tapeJitter: { friendlyLabel: 'Tape Jitter', description: 'Wiggles the frame sideways like a tape that cannot hold horizontal sync.', unit: '%', category: lookSection('vhs'), neutralValue: 0 },
  smear: { friendlyLabel: 'Color Smear', description: 'Bleeds chroma sideways, the way a worn VHS head smears color off the luma.', unit: '%', category: lookSection('vhs'), neutralValue: 0 },
  scanlines: { friendlyLabel: 'Scanline Density', description: 'Darkens every other line. Zero leaves the frame without a mask.', unit: '%', category: lookSection('vhs'), neutralValue: 0 },
  pointExtrude: { friendlyLabel: 'Extrude Height', description: 'Lifts bright pixels off the point-cloud plane.', unit: 'x', category: lookSection('points'), neutralValue: 0 },
  pointSize: { friendlyLabel: 'Cloud Point Size', description: 'Size of each point in the 3D cloud, in pixels.', unit: 'px', category: lookSection('points'), neutralValue: 3.5 },
  cloudGrid: { friendlyLabel: 'Cloud Grid', description: 'How many samples the point cloud takes across the picture.', category: lookSection('points'), neutralValue: 1 },
  meshExtrude: { friendlyLabel: 'Mesh Depth', description: 'Pushes the mesh out along brightness. Zero is a flat card.', unit: 'x', category: lookSection('mesh'), neutralValue: 0 },
  meshGrid: { friendlyLabel: 'Mesh Grid', description: 'Resolution of the displacement mesh.', category: lookSection('mesh'), neutralValue: 1 },
  winTrail: { friendlyLabel: 'Window Trail', description: 'Leaves frozen copies of the picture behind motion, like a window dragged with redraw broken.', unit: '%', category: lookSection('win98'), neutralValue: 0 },
  winStagger: { friendlyLabel: 'Drag Stagger', description: 'Pixel gap between each frozen window copy.', unit: 'px', category: lookSection('win98'), neutralValue: 2 },
  winDither: { friendlyLabel: 'Bayer Dither', description: 'Ordered dither into a 256-color desktop palette. Zero is flat banding.', unit: '%', category: lookSection('win98'), neutralValue: 0 },
  psAffine: { friendlyLabel: 'Affine Warp', description: 'Shears the texture inside coarse blocks, the way a PS1 polygon samples incorrectly.', unit: '%', category: lookSection('ps1'), neutralValue: 0 },
  psWobble: { friendlyLabel: 'Vertex Snap', description: 'Jitters the picture by whole texels, the swim of a console under load.', unit: '%', category: lookSection('ps1'), neutralValue: 0 },
  psCrt: { friendlyLabel: 'CRT Mask', description: 'Adds barrel curve, scanlines, and an RGB phosphor grille over the low-res frame.', unit: '%', category: lookSection('ps1'), neutralValue: 0 },
  asciiSize: { friendlyLabel: 'Character Size', description: 'Size of each ASCII cell or paint blob, in pixels.', unit: 'px', category: lookSection('ascii'), neutralValue: 8 },
  asciiQuant: { friendlyLabel: 'Color Quantization', description: 'How many levels each channel keeps. Lower looks more like a 16-color terminal.', category: lookSection('ascii'), neutralValue: 16 },
  asciiStyle: { friendlyLabel: 'Stroke Style', description: 'ASCII glyphs, or soft painterly blobs in the same grid.', category: lookSection('ascii'), neutralValue: 0 },
  snapSize: { friendlyLabel: 'Pixel Snap', description: 'Snaps the picture down to chunky pixels, in pixels.', unit: 'px', category: lookSection('retro'), neutralValue: 1 },
  retroDither: { friendlyLabel: 'Retro Dither', description: 'Bayer dither over the low-color retro look. Zero removes the pattern.', unit: '%', category: lookSection('retro'), neutralValue: 0 },
  affine: { friendlyLabel: 'Retro Affine Warp', description: 'Shears the retro frame the way an early 3D console warped a texture.', unit: '%', category: lookSection('retro'), neutralValue: 0 },
  wobble: { friendlyLabel: 'Retro Wobble', description: 'Shakes vertices on the retro frame. Zero holds the grid still.', unit: '%', category: lookSection('retro'), neutralValue: 0 },
  bite: { friendlyLabel: 'Bite', description: 'How much bass opens holes in the brighter parts of the picture.', unit: '%', category: lookSection('eater'), neutralValue: 0 },
  chew: { friendlyLabel: 'Chew', description: 'Pulls the picture toward a slow-moving point. A kick pulls harder.', unit: '%', category: lookSection('eater'), neutralValue: 0 },
  threshold: { friendlyLabel: 'Threshold', description: 'How bright a pixel must be before the bite can eat it.', unit: '%', category: lookSection('eater'), neutralValue: 0 },
  leftovers: { friendlyLabel: 'Leftovers', description: 'Mixes a dull copy of the previous frame into the eaten holes.', unit: '%', category: lookSection('eater'), neutralValue: 0 },
  interlace: { friendlyLabel: 'Interlace', description: 'Field comb between scanlines, like a MiniDV viewfinder. Zero is a progressive frame.', unit: '%', category: lookSection('minidv'), neutralValue: 0 },
  datestamp: { friendlyLabel: 'Date Stamp', description: 'Burns a date and running timecode into the corner.', unit: '%', category: lookSection('minidv'), neutralValue: 0 },
  nightshot: { friendlyLabel: 'Nightshot', description: 'Shifts the picture to the green of a camcorder night mode.', unit: '%', category: lookSection('minidv'), neutralValue: 0 },
  crop: { friendlyLabel: 'Frame Crop', description: 'Pulls the sides in toward a 4:3 viewfinder. Zero keeps the full frame.', unit: '%', category: lookSection('minidv'), neutralValue: 0 },
  blob: { friendlyLabel: 'Blob', description: 'Size of the morphing shape that holds the picture.', unit: '%', category: lookSection('flash'), neutralValue: 0 },
  outline: { friendlyLabel: 'Outline', description: 'Thickness of the stroke around the blob.', unit: '%', category: lookSection('flash'), neutralValue: 0 },
  flatColor: { friendlyLabel: 'Flat Color', description: 'Flattens the picture toward a few solid color steps.', unit: '%', category: lookSection('flash'), neutralValue: 0 },
  tween: { friendlyLabel: 'Tween', description: 'How far the blob morphs, and how fast that shape eases.', unit: '%', category: lookSection('flash'), neutralValue: 0 },
  warp: { friendlyLabel: 'Warp', description: 'Base speed of the star streaks. Bass and kicks push it faster.', unit: '%', category: lookSection('starfield'), neutralValue: 0 },
  porthole: { friendlyLabel: 'Porthole', description: 'Size of the round window that holds the live picture.', unit: '%', category: lookSection('starfield'), neutralValue: 0 },
  grid: { friendlyLabel: 'Vector Grid', description: 'Brightness of the flat floor grid under the window.', unit: '%', category: lookSection('starfield'), neutralValue: 0 },
  flash: { friendlyLabel: 'Hyperspace', description: 'How hard a kick whites out the streaks for a moment.', unit: '%', category: lookSection('starfield'), neutralValue: 0 },
  heat: { friendlyLabel: 'Thermal Contrast', description: 'Spreads or crushes the video around mid gray before it is painted in the thermal palette. 1x keeps the picture’s brightness.', unit: 'x', category: lookSection('thermal'), neutralValue: 1 },
  sortGate: { friendlyLabel: 'Sort Threshold', description: 'Pixels brighter than this streak up the frame. Dimmer pixels stay put.', unit: '%', category: lookSection('sort'), neutralValue: 0 },
  sortLen: { friendlyLabel: 'Sort Length', description: 'How far a bright pixel streaks upward. Zero falls back to the picture. A kick or snare throws that streak farther.', unit: '%', category: lookSection('sort'), neutralValue: 0 },
  sortFall: { friendlyLabel: 'Sort Falloff', description: 'How quickly the streak fades along its length. Higher dies off sooner.', unit: '%', category: lookSection('sort'), neutralValue: 0 },
  jpegBlock: { friendlyLabel: 'JPEG Block', description: 'Size of the square blocks, like a late-90s download. Zero keeps the picture.', unit: '%', category: lookSection('jpeg'), neutralValue: 0 },
  jpegSmear: { friendlyLabel: 'JPEG Smear', description: 'How far the color smears inside each block.', unit: '%', category: lookSection('jpeg'), neutralValue: 0 },
  jpegCrush: { friendlyLabel: 'JPEG Damage', description: 'How few color steps each block keeps. A transient or the hats raise the damage for a moment.', unit: '%', category: lookSection('jpeg'), neutralValue: 0 },
  cdRing: { friendlyLabel: 'CD Rings', description: 'Strength of the concentric grooves on the picture. Zero leaves the frame bare.', unit: '%', category: lookSection('cd'), neutralValue: 0 },
  cdSeek: { friendlyLabel: 'CD Seek', description: 'How far the picture stutters sideways, like a disc losing its place. A kick triggers a harder seek.', unit: '%', category: lookSection('cd'), neutralValue: 0 },
  cdRate: { friendlyLabel: 'CD Rate', description: 'How often the sideways seek hops. A kick makes those hops come faster.', unit: '%', category: lookSection('cd'), neutralValue: 0 },
  bendAmt: { friendlyLabel: 'Data Bend', description: 'How far each row slides sideways. The top stays put and the slide grows toward the bottom. A kick adds one extra shove.', unit: '%', category: lookSection('bend'), neutralValue: 0 },
  bendCurve: { friendlyLabel: 'Bend Curve', description: 'How quickly that slide grows down the frame. Low is a straight shear.', unit: '%', category: lookSection('bend'), neutralValue: 0 },
  bendLean: { friendlyLabel: 'Bend Lean', description: 'Which way the rows slide. The left end leans left, the right end leans right.', unit: '%', category: lookSection('bend'), neutralValue: 0.5 },
  homeTile: { friendlyLabel: 'Homepage Tile', description: 'Size of each repeated wallpaper tile. A kick punches the tiles larger, then they fall back.', unit: '%', category: lookSection('home'), neutralValue: 0 },
  homeMix: { friendlyLabel: 'Homepage Frame', description: 'Moves from the tiled wallpaper to one framed photo on that page.', unit: '%', category: lookSection('home'), neutralValue: 0 },
  homeBevel: { friendlyLabel: 'Homepage Bevel', description: 'Depth of the raised frame around the photo.', unit: '%', category: lookSection('home'), neutralValue: 0 },
  marqueeBand: { friendlyLabel: 'Marquee Band', description: 'Where the crawling strip sits on the frame. Everything outside it stays still.', unit: '%', category: lookSection('marquee'), neutralValue: 0.5 },
  marqueeSize: { friendlyLabel: 'Marquee Height', description: 'How tall the crawling band is. Zero leaves the picture still.', unit: '%', category: lookSection('marquee'), neutralValue: 0 },
  marqueeSpeed: { friendlyLabel: 'Marquee Speed', description: 'How fast the band scrolls sideways and loops. A kick shoves the scroll.', unit: '%', category: lookSection('marquee'), neutralValue: 0 },
  gifLoad: { friendlyLabel: 'GIF Load', description: 'How much of the interlaced picture has arrived. A kick finishes the load, then it falls back toward the coarse pass.', unit: '%', category: lookSection('gif'), neutralValue: 0 },
  gifGap: { friendlyLabel: 'GIF Gap', description: 'How many rows the first pass skips. Later rows fill in as the load rises.', unit: '%', category: lookSection('gif'), neutralValue: 0 },
  gifEase: { friendlyLabel: 'GIF Ease', description: 'How long the coarse pass holds before the missing rows arrive.', unit: '%', category: lookSection('gif'), neutralValue: 0 },
  cloudCover: { friendlyLabel: 'Cloud Cover', description: 'How much of the frame clots into puffs. Bass swells the cover. Zero leaves the picture.', unit: '%', category: lookSection('cloud'), neutralValue: 0 },
  cloudDrift: { friendlyLabel: 'Cloud Drift', description: 'How fast the puffs travel. A kick pushes them, then they settle back.', unit: '%', category: lookSection('cloud'), neutralValue: 0 },
  cloudBand: { friendlyLabel: 'Cloud Bands', description: 'How many shade steps the puffs keep. Fewer steps look more like a late-90s sky render.', unit: '%', category: lookSection('cloud'), neutralValue: 0 },
  brickSize: { friendlyLabel: 'Brick Size', description: 'How big each brick is. A kick nudges the size for a moment, then it falls back.', unit: '%', category: lookSection('brick'), neutralValue: 0 },
  brickStud: { friendlyLabel: 'Brick Studs', description: 'How strong the stud on each brick is. Zero leaves the faces bare.', unit: '%', category: lookSection('brick'), neutralValue: 0 },
  brickTint: { friendlyLabel: 'Brick Tint', description: 'How far each flat cell is pushed toward grass, leaf, lime, moss, and soil.', unit: '%', category: lookSection('brick'), neutralValue: 0 },
  inkLife: { friendlyLabel: 'Ink Life', description: 'How long the stirred picture stays. Zero shows the live frame.', unit: '%', category: lookSection('ink'), neutralValue: 0 },
  inkStir: { friendlyLabel: 'Ink Stir', description: 'How hard the ink moves along the picture’s brightness. A kick throws a short, harder stir.', unit: '%', category: lookSection('ink'), neutralValue: 0 },
  inkCurl: { friendlyLabel: 'Ink Curl', description: 'How tight the swirls are. The curl is taken from the picture’s own brightness.', unit: '%', category: lookSection('ink'), neutralValue: 0 },
  foldDepth: { friendlyLabel: 'Fold Depth', description: 'How far the picture folds into itself inside this frame. Bass deepens the fold. Zero leaves the picture.', unit: '%', category: lookSection('fold'), neutralValue: 0 },
  foldScale: { friendlyLabel: 'Fold Scale', description: 'Size of the sheets. A kick snaps them tighter for a moment, then they fall back.', unit: '%', category: lookSection('fold'), neutralValue: 0 },
  foldSheets: { friendlyLabel: 'Fold Sheets', description: 'How strongly several reads of the same frame meet in one pixel.', unit: '%', category: lookSection('fold'), neutralValue: 0 },
  chompSize: { friendlyLabel: 'Chomp Size', description: 'How big the disc is. Larger discs cross the frame in fewer rows.', unit: '%', category: lookSection('chomp'), neutralValue: 0 },
  chompSpeed: { friendlyLabel: 'Chomp Speed', description: 'How fast the disc travels. A kick advances it one bite.', unit: '%', category: lookSection('chomp'), neutralValue: 0 },
  chompMouth: { friendlyLabel: 'Chomp Mouth', description: 'How wide the mouth opens. A kick closes it for one bite.', unit: '%', category: lookSection('chomp'), neutralValue: 0 },
};

export function neutralOf(def) {
  if (!def) return 0;
  return def.neutralValue ?? def.defaultValue ?? def.value ?? 0;
}

export function formatBadge(def, v) {
  if (!Number.isFinite(v)) return '';
  const unit = def?.unit || '';
  const trim = (n, digits) => {
    const text = n.toFixed(digits);
    const stripped = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
    return stripped === '-0' ? '0' : stripped;
  };
  if (unit === '%') {
    const pct = v * 100;
    const digits = Math.abs(pct) >= 10 ? 0 : 1;
    return `${trim(pct, digits)}%`;
  }
  if (unit === 'turn') return `${trim(v * 360, Math.abs(v * 360) >= 10 ? 0 : 1)}°`;
  if (unit === 'x') return `${trim(v, Math.abs(v) >= 10 ? 1 : 2)}x`;
  if (unit === 'px') return `${trim(v, def.step >= 1 ? 0 : 1)} px`;
  if (unit === 's') return `${trim(v, 2)} s`;
  if (unit === 'pts') return `${trim(v, 0)} pts`;
  if (unit === 'Hz') return `${trim(v, 2)} Hz`;
  if (unit === 'BPM') return `${trim(v, 0)} BPM`;
  return trim(v, Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3);
}

function decorate(d) {
  const meta = PARAM_META[d.id] || {};
  return {
    ...d,
    ...meta,
    friendlyLabel: meta.friendlyLabel || d.label,
    description: meta.description || d.title || '',
    unit: meta.unit || '',
    category: meta.category || 'Color & Texture',
    defaultValue: d.value,
    neutralValue: meta.neutralValue ?? d.value,
  };
}

function buildDefs() {
  const defs = GLOBAL_DEFS.map((d) => decorate({ ...d, key: d.id, layer: null, uniform: false }));
  for (const L of LAYERS) {
    for (const d of LAYER_DEFS) {
      const value = LAYER_OVERRIDES[L][d.id] ?? d.value;
      const base = decorate({ ...d, value });
      defs.push({
        ...base,
        id: layerParam(L, d.id),
        key: d.id,
        layer: L,
        value,
        defaultValue: value,
        uniform: d.uniform ?? !NON_UNIFORM.has(d.id),
      });
    }
  }
  return defs;
}

export class ParamStore {
  constructor(defs = buildDefs()) {
    this.defs = new Map(defs.map((d) => [d.id, { step: 0, ...d }]));
    this.values = new Map(defs.map((d) => [d.id, d.key === 'mode' ? shaderMode(d.value) : d.value]));
    this.listeners = new Set();
  }

  get(id) {
    return this.values.get(id);
  }

  set(id, v, opts = {}) {
    const d = this.defs.get(id);
    if (!d || !Number.isFinite(v)) return;
    if (d.options) {
      v = Math.min(d.max, Math.max(d.min, Math.round(v)));
      if (d.key === 'mode') v = shaderMode(v);
    } else {
      const lo = Number.isFinite(d.min) ? d.min : -1e6;
      const hi = Number.isFinite(d.max) ? d.max : 1e6;
      v = Math.min(hi, Math.max(lo, v));
      if (d.step) {
        const digits = (String(d.step).split('.')[1] || '').length;
        v = Number((Math.round(v / d.step) * d.step).toFixed(Math.min(8, digits)));
        v = Math.min(hi, Math.max(lo, v));
      }
    }
    const prev = this.values.get(id);
    if (v === prev) return;
    this.values.set(id, v);
    if (opts.history && this.history && !this.history.applying) this.history.note(id, prev, v, opts.history);
    for (const fn of this.listeners) fn(id, v);
  }

  /** Set from a 0..1 controller value. */
  setNormalized(id, n) {
    const d = this.defs.get(id);
    if (d) this.set(id, d.min + n * (d.max - d.min));
  }

  /** Dropdown-style params switch instantly; everything else can be interpolated. */
  isDiscrete(id) {
    return !!this.defs.get(id)?.options;
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
