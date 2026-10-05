// Toggleable overlay: either live numeric parameters or the active shader source
// annotated with live uniform values.

import { dpiState } from './dpiScale.js';

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const bar = (v, n = 16) => {
  const f = Math.round(Math.min(1, Math.max(0, v)) * n);
  return '\u2588'.repeat(f) + '\u2591'.repeat(n - f);
};

const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));

export const HUD_COLORS = {
  green: ['#7dffb0', '#39ff88'],
  amber: ['#ffbf47', '#ff9a1f'],
  cyan: ['#7af7ff', '#00e5ff'],
  white: ['#f4f7ff', '#ffffff'],
};

export const HUD_FONT = 'Consolas, "Courier New", "Fira Code", "JetBrains Mono", monospace';

export const HUD_PRESETS = [
  { id: 'ascii', label: 'ASCII', mode: 'matrix', glyph: 'ascii' },
  { id: 'logs', label: 'Terminal Logs', mode: 'scan', glyph: 'ascii' },
  { id: 'matrix', label: 'Kinetic Matrix', mode: 'matrix', glyph: 'matrix' },
  { id: 'diag', label: 'Live Diagnostics', mode: 'diag', glyph: 'ascii' },
  { id: 'audio', label: 'Audio Reactive Data', mode: 'audio', glyph: 'ramp' },
];

export const HUD_BOX_DEFAULT = { x: 0.02, y: 0.03, w: 0.4, h: 0.62 };

const clamp01 = (n, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
};

/** Position and size as fractions of the frame. The same numbers drive every screen. */
export function clampHudBox(raw) {
  let w = clamp01(raw?.w, HUD_BOX_DEFAULT.w);
  let h = clamp01(raw?.h, HUD_BOX_DEFAULT.h);
  w = Math.min(1, Math.max(0.12, w));
  h = Math.min(1, Math.max(0.12, h));
  const x = Math.min(1 - w, clamp01(raw?.x, HUD_BOX_DEFAULT.x));
  const y = Math.min(1 - h, clamp01(raw?.y, HUD_BOX_DEFAULT.y));
  return { x, y, w, h };
}

/** Draw the overlay into a frame using the normalized box. */
export function paintHudText(ctx, frameW, frameH, overlay, type) {
  const chrome = overlay?.chrome || {};
  const box = clampHudBox(chrome.box);
  const x = box.x * frameW;
  const y = box.y * frameH;
  const bw = Math.max(1, box.w * frameW);
  const bh = Math.max(1, box.h * frameH);
  const fontSize = Math.max(1, type.fontSize);
  const lineH = Math.max(1, type.lineH);
  const color = (HUD_COLORS[chrome.color] || HUD_COLORS.green)[0];
  const pad = Math.max(4, fontSize * 0.45);
  const maxLines = Math.max(1, Math.floor((bh - pad) / lineH));
  const lines = (overlay.lines || []).slice(0, maxLines);
  const bg = chrome.automask ? 0 : Math.min(0.9, Math.max(0, Number(chrome.bg) || 0));
  const mix = Math.min(1, Math.max(0, Number(chrome.mix) ?? 0.92));
  ctx.save();
  ctx.globalAlpha = mix;
  ctx.beginPath();
  ctx.rect(x, y, bw, bh);
  ctx.clip();
  ctx.fillStyle = `rgba(4, 10, 8, ${bg})`;
  ctx.fillRect(x, y, bw, bh);
  ctx.font = `${fontSize}px ${type.fontFamily || HUD_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  lines.forEach((line, i) => {
    const ly = y + pad * 0.35 + i * lineH;
    if (ly > y + bh - 2) return;
    ctx.fillText(line, x + pad * 0.55, ly, Math.max(8, bw - pad));
  });
  ctx.restore();
}

const RAMP = ' .:-=+*#%@';
const MATRIX = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ';

export function hudStyleVars(style, scale = 1, pixelLeading = false) {
  const [fg, glow] = HUD_COLORS[style.color] || HUD_COLORS.green;
  const base = Number(style.size) || 16;
  const leading = Number(style.leading) || 1.45;
  const fontPx = Math.max(1, base * (scale || 1));
  return {
    '--hud-font': style.font || HUD_FONT,
    '--hud-size': `${fontPx}px`,
    '--hud-mix': String(style.mix),
    '--hud-bg': style.automask ? '0' : String(style.bg),
    '--hud-fg': fg,
    '--hud-glow': glow,
    '--hud-leading': pixelLeading ? `${(fontPx * leading).toFixed(2)}px` : String(leading),
  };
}

const GLSL_TY = new Set('void float int bool vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 mat2 mat3 mat4 sampler2D'.split(' '));
const GLSL_KW = new Set('if else for while do return break continue discard struct const uniform varying attribute in out inout true false'.split(' '));
const GLSL_FN = new Set('main clamp floor fract sin cos tan asin acos atan mix step smoothstep abs min max mod pow sqrt exp log dot cross normalize length texture2D texture sign radians degrees distance reflect refract src luma hash11 hash12 hash13 mirrorRepeat hueShift blendMode'.split(' '));

function highlightGlslLine(line, values) {
  const re = /\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:\d+\.\d*|\.\d+|\d+)\b|\b[A-Za-z_]\w*\b/g;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(re)) {
    out += escapeHtml(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('//')) out += `<span class="cmt">${escapeHtml(tok)}</span>`;
    else if (tok.startsWith('"') || tok.startsWith("'")) out += `<span class="str">${escapeHtml(tok)}</span>`;
    else if (tok[0] === '.' || (tok[0] >= '0' && tok[0] <= '9')) out += `<span class="num">${tok}</span>`;
    else if (GLSL_TY.has(tok) || GLSL_KW.has(tok)) out += `<span class="kw">${tok}</span>`;
    else if (GLSL_FN.has(tok)) out += `<span class="fn">${tok}</span>`;
    else if (/^u[A-Z]/.test(tok)) {
      const live = typeof values?.[tok] === 'number';
      out += `<span class="u">${tok}</span>${live ? `<i class="v" data-u="${tok}"></i>` : ''}`;
    } else out += `<span class="id">${tok}</span>`;
    last = m.index + tok.length;
  }
  return out + escapeHtml(line.slice(last));
}

export function highlightGlsl(source, values) {
  return source.replace(/\r\n/g, '\n').split('\n').map((line, i) => {
    const ln = `<span class="ln">${String(i + 1).padStart(3, ' ')}</span> `;
    return ln + highlightGlslLine(line, values);
  }).join('\n');
}

export class Hud {
  constructor(el) {
    this.el = el;
    this.visible = false;
    this.view = 'glsl';
    this.display = 'glsl';
    this.liveId = '';
    this.shaderName = '';
    this.lastUpdate = 0;
    this.scroll = 0;
    this.htmlSerial = 0;
    this.valueNodes = [];
    this.glyph = 'ascii';
    this.chrome = {
      glyph: 'ascii', color: 'green', size: 16, mix: 0.92, bg: 0.72, automask: false, leading: 1.45, font: HUD_FONT,
      box: { ...HUD_BOX_DEFAULT },
    };
    this.plain = '';
    el.hidden = true;
    this.applyChrome(this.chrome);
  }

  applyChrome(style) {
    this.chrome = { ...this.chrome, ...style };
    if (style.box) this.chrome.box = clampHudBox(style.box);
    this.glyph = this.chrome.glyph;
    const scale = dpiState.auto ? dpiState.previewScale : 1;
    const vars = hudStyleVars(this.chrome, scale, dpiState.auto);
    for (const [k, v] of Object.entries(vars)) this.el.style.setProperty(k, v);
  }

  #paintValue(n, v) {
    if (typeof v === 'string') {
      n.textContent = ` ${v}`;
      return;
    }
    if (typeof v !== 'number') return;
    const text = v.toFixed(3);
    if (this.glyph === 'ramp') {
      const idx = Math.min(RAMP.length - 1, Math.round(Math.min(1, Math.abs(v)) * (RAMP.length - 1)));
      n.textContent = ` ${RAMP[idx]} ${text}`;
    } else if (this.glyph === 'matrix') {
      const idx = Math.abs(Math.floor(v * 97 + performance.now() / 50)) % MATRIX.length;
      n.textContent = ` ${MATRIX[idx]} ${text}`;
    } else {
      n.textContent = ` ${text}`;
    }
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.el.hidden = !this.visible;
  }

  setDisplay(mode) {
    const allowed = mode === 'glsl' || mode === 'matrix' || mode === 'formula' || mode === 'scan'
      || mode === 'diag' || mode === 'audio';
    this.display = allowed ? mode : 'scan';
    this.view = this.display;
    this.liveId = '';
    this.scanHtml = '';
    this.#applyMode(this.display);
  }

  #applyMode(mode) {
    this.view = mode;
    this.el.classList.add('code');
    this.el.classList.remove('mode-glsl', 'mode-matrix', 'mode-formula', 'mode-scan', 'mode-diag', 'mode-audio');
    this.el.classList.add(`mode-${mode}`);
  }

  /** Scrolling scanner. Newest line types in at the bottom and older lines move up. */
  showScan(model) {
    this.#applyMode('scan');
    const body = model.lines.map((line) => {
      const cls = line.alert ? 'scan-line alert' : 'scan-line';
      return `<div class="${cls}" style="opacity:${line.opacity.toFixed(2)}">${escapeHtml(line.text)}</div>`;
    }).join('');
    const caret = model.cursor ? '\u2588' : '_';
    const html = `${body}<div class="scan-foot"><i class="scan-bar"></i><span class="caret">${caret}</span></div>`;
    if (html !== this.scanHtml) {
      this.scanHtml = html;
      this.el.innerHTML = html;
      this.htmlSerial++;
      this.#rememberText();
      this.#pinEnd();
    }
  }

  #rememberText() {
    this.plain = (this.el.textContent || '').replace(/\u00a0/g, ' ');
  }

  /** Pin the newest line. scrollIntoView avoids fractional scrollTop drift. */
  #pinEnd() {
    const tail = this.el.lastElementChild;
    if (tail) tail.scrollIntoView({ block: 'end', inline: 'nearest' });
  }

  /** Full fragment source with syntax colors and live uniform numbers. */
  showGlsl({ id, title, source, values }) {
    this.#applyMode('glsl');
    if (id !== this.liveId) {
      this.liveId = id;
      this.shaderName = title;
      this.shaderSource = source;
      this.el.innerHTML = `<b>// ${escapeHtml(title)}</b>\n\n${highlightGlsl(source, values)}`;
      this.valueNodes = [...this.el.querySelectorAll('i.v')];
      this.htmlSerial++;
      this.#rememberText();
    }
    for (const n of this.valueNodes) {
      const v = values[n.dataset.u];
      if (typeof v === 'number') n.textContent = ` ${v.toFixed(3)}`;
    }
    this.#rememberText();
  }

  /** Live formula overlay. Rebuilds the text only when the engine or layer changes. */
  showLive(model, mode = 'matrix') {
    this.#applyMode(mode);
    if (model.id !== this.liveId) {
      this.liveId = model.id;
      const body = escapeHtml(model.source).replace(
        /\b(u[A-Z]\w*)\b/g,
        '<span class="u">$1</span><i class="v" data-u="$1"></i>',
      );
      const seen = new Set(model.source.match(/\bu[A-Z]\w*\b/g) || []);
      const extra = mode === 'formula'
        ? ''
        : Object.keys(model.values)
          .filter((k) => !seen.has(k) && typeof model.values[k] === 'number')
          .map((k) => `${k.padEnd(14)} <i class="v" data-u="${k}"></i>`)
          .join('\n');
      this.el.innerHTML = `<b>// ${escapeHtml(model.title)}</b>\n\n${body}${extra ? `\n\n${extra}` : ''}`;
      this.valueNodes = [...this.el.querySelectorAll('i.v')];
      this.htmlSerial++;
    }
    for (const n of this.valueNodes) this.#paintValue(n, model.values[n.dataset.u]);
    this.#rememberText();
  }

  /** Band meters for the audio-reactive preset. */
  showAudio(state) {
    this.#applyMode('audio');
    const a = state.audio || {};
    const row = (name, v) => `${name.padEnd(7)}${bar(v || 0)} ${fmt(v || 0)}`;
    const lines = [
      '<b>AUDIO // REACTIVE</b>',
      row('SUB', a.sub),
      row('BASS', a.bass),
      row('MID', a.mid),
      row('TREBLE', a.treble),
      row('KICK', a.kick),
      row('SNARE', a.snare),
      row('NRG', a.songEnergy),
      row('DROP', a.dropPulse),
      '',
      `${(state.fps || 0).toFixed(0)} fps`,
    ];
    const html = lines.join('\n');
    if (html !== this.scanHtml) {
      this.scanHtml = html;
      this.el.innerHTML = html;
      this.htmlSerial++;
    }
    this.#rememberText();
  }

  setShader(name, source) {
    this.shaderName = name;
    this.shaderSource = source;
    this.#renderShader();
  }

  #renderShader() {
    if (this.view !== 'shader' || !this.shaderSource) return;
    const lines = this.shaderSource.split('\n');
    const html = lines
      .map((line, i) => {
        const body = escapeHtml(line).replace(
          /\b(u[A-Z]\w*)\b/g,
          '<span class="u">$1</span><i class="v" data-u="$1"></i>',
        );
        return `<span class="ln">${String(i + 1).padStart(3, ' ')}</span> ${body}`;
      })
      .join('\n');
    this.el.innerHTML = `<b>// ${this.shaderName}.frag</b>\n\n${html}`;
    this.valueNodes = [...this.el.querySelectorAll('i.v')];
    this.scroll = 0;
    this.htmlSerial++;
    this.#rememberText();
  }

  /** state: { title, layers: [line], uniforms: {name: value}, fps, audio, midi, recording, timeline } */
  update(state, now) {
    if (!this.visible) return;

    if (this.view === 'shader') {
      // Live values are cheap to refresh; auto-scroll for the "live code" look.
      for (const n of this.valueNodes) {
        const v = state.uniforms[n.dataset.u];
        n.textContent = typeof v === 'number' ? `[${v.toFixed(2)}]` : '';
      }
      return;
    }

    if (now - this.lastUpdate < 1 / 15) return;
    this.lastUpdate = now;

    const a = state.audio;
    const lines = [
      `<b>Y2K VJ // ${escapeHtml(state.title)}</b>   ${state.fps.toFixed(0)} fps   ${state.resolution}`,
      state.recording ? `<span class="rec">\u25CF REC ${state.recording}</span>` : '',
      `TIMELINE ${escapeHtml(state.timeline || '')}`,
      '',
      ...(state.layers || []).map(escapeHtml),
      '',
      `BASS   ${bar(a.bass)} ${fmt(a.bass)}`,
      `MID    ${bar(a.mid)} ${fmt(a.mid)}`,
      `TREBLE ${bar(a.treble)} ${fmt(a.treble)}`,
      `KICK   ${bar(a.kick)} ${fmt(a.kick)}`,
      `CLOCK  ${bar(state.clock?.pulse ?? 0)} ${escapeHtml(state.clock?.text ?? '')}`,
      '',
      ...Object.entries(state.uniforms)
        .filter(([k]) => !['uBass', 'uMid', 'uTreble', 'uKick', 'uBeat'].includes(k))
        .map(([k, v]) => `${k.padEnd(13)} ${fmt(v)}`),
      '',
      `MIDI   ${escapeHtml(state.midi || '--')}`,
    ];
    this.el.innerHTML = lines.join('\n');
    this.htmlSerial++;
    this.#rememberText();
    this.#pinEnd();
  }

  /** Plain lines of the visible overlay, for the recording composite. */
  recordOverlay() {
    if (!this.visible) return null;
    const lines = (this.plain || this.el.textContent || '').replace(/\u00a0/g, ' ').split('\n');
    return { lines, chrome: this.chrome };
  }
  capture() {
    const values = this.visible
      ? Object.fromEntries(this.valueNodes.map((n) => [n.dataset.u, n.textContent]))
      : null;
    return {
      visible: this.visible,
      view: this.view,
      html: this.visible ? this.el.innerHTML : '',
      htmlSerial: this.htmlSerial,
      values,
      scroll: Math.round(this.el.scrollTop),
      style: this.chrome,
    };
  }
}
