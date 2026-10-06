// Custom slider for a continuous parameter. A typed value is clamped to the
// parameter min and max and snapped to its step. Pointer capture keeps the
// drag alive when the cursor leaves the track.

import { formatBadge } from '../params.js';

const CAP = 1e6;

function formatNum(v) {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 4;
  const text = v.toFixed(digits).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

function snapToStep(v, step) {
  if (!Number.isFinite(v) || !step || step <= 0) return v;
  const digits = (String(step).split('.')[1] || '').length;
  return Number((Math.round(v / step) * step).toFixed(Math.min(8, digits)));
}

/** Typed numbers stay inside min/max and land on the parameter step. */
export function clampTyped(typed, min, max, step) {
  const n = parseFloat(typed);
  if (!Number.isFinite(n)) return null;
  const lo = Number(min);
  const hi = Number(max);
  let v = n;
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);
  v = snapToStep(v, Number(step));
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);
  return v;
}
function clamp01(t) {
  return Math.min(1, Math.max(0, t));
}

/**
 * @param {object} def nominal min, max, step, value
 * @param {{ get: () => number, set: (v: number, opts?: object) => void, onHold: (held: boolean) => void }} api
 */
export function createNumericSlider(def, api) {
  const root = document.createElement('div');
  root.className = 'num-slider';

  const track = document.createElement('div');
  track.className = 'num-track';
  track.title = 'Drag to set the base. The green bar is the live modulated value.';
  const pocket = document.createElement('div');
  pocket.className = 'num-pocket';
  pocket.hidden = true;
  const fill = document.createElement('div');
  fill.className = 'num-fill';
  const ghost = document.createElement('div');
  ghost.className = 'num-ghost';
  const thumb = document.createElement('div');
  thumb.className = 'num-thumb';
  const notch = document.createElement('div');
  notch.className = 'num-notch';
  notch.title = 'Zero-effect position. Double-click the track to snap here.';
  track.append(pocket, fill, ghost, notch, thumb);

  const readout = document.createElement('button');
  readout.type = 'button';
  readout.className = 'num-readout';
  readout.title = 'Click to type an exact value. Numbers past the usual range expand the track.';

  const editor = document.createElement('input');
  editor.type = 'number';
  editor.step = def.step ? String(def.step) : 'any';
  editor.min = String(def.min);
  editor.max = String(def.max);
  editor.inputMode = 'decimal';
  editor.className = 'num-editor';
  editor.autocomplete = 'off';
  editor.spellcheck = false;
  editor.hidden = true;

  root.append(track, readout, editor);

  const nominal = def.max - def.min || 1;
  let viewMin = def.min;
  let viewMax = def.max;
  let dragging = false;
  let editing = false;
  let painted = '';
  let pocketLo = 0;
  let pocketHi = 1;
  let pocketOn = false;
  let lastBase = api.get();
  let lastLive = lastBase;

  const domain = (base, live) => {
    let lo = def.min;
    let hi = def.max;
    for (const v of [base, live]) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo < def.min) lo -= nominal * 0.08;
    if (hi > def.max) hi += nominal * 0.08;
    if (!(hi > lo)) hi = lo + nominal;
    return [lo, hi];
  };

  const paint = (base, live = base) => {
    lastBase = base;
    lastLive = live;
    if (!dragging) [viewMin, viewMax] = domain(base, live);
    const key = `${base}|${live}|${viewMin}|${viewMax}|${editing ? 1 : 0}|${pocketOn ? 1 : 0}|${pocketLo}|${pocketHi}`;
    if (key === painted) return;
    painted = key;
    const span = viewMax - viewMin || 1;
    const b = clamp01((base - viewMin) / span);
    const l = clamp01((live - viewMin) / span);
    fill.style.width = `${b * 100}%`;
    const g0 = Math.min(b, l);
    const g1 = Math.max(b, l);
    ghost.style.left = `${g0 * 100}%`;
    ghost.style.width = `${(g1 - g0) * 100}%`;
    ghost.hidden = Math.abs(live - base) <= Math.max(span * 0.004, 1e-4);
    thumb.style.left = `${b * 100}%`;
    const neutral = def.neutralValue ?? def.defaultValue ?? def.value ?? 0;
    const n = (neutral - viewMin) / span;
    notch.hidden = n < -0.001 || n > 1.001;
    notch.style.left = `${clamp01(n) * 100}%`;
    const expanded = viewMin < def.min - 1e-8 || viewMax > def.max + 1e-8;
    root.classList.toggle('expanded', expanded);
    track.title = expanded
      ? `Expanded range ${formatNum(viewMin)} to ${formatNum(viewMax)}. Default is ${formatNum(def.min)} to ${formatNum(def.max)}.`
      : `Drag to set the base. Default range ${formatNum(def.min)} to ${formatNum(def.max)}.`;
    if (!editing) readout.textContent = formatBadge(def, live);
    pocket.hidden = !pocketOn;
    if (pocketOn) {
      const a = def.min + pocketLo * nominal;
      const b = def.min + pocketHi * nominal;
      const left = clamp01((Math.min(a, b) - viewMin) / span);
      const right = clamp01((Math.max(a, b) - viewMin) / span);
      pocket.style.left = `${left * 100}%`;
      pocket.style.width = `${Math.max(0, right - left) * 100}%`;
    }
  };

  const setPocket = (lo, hi, on) => {
    pocketLo = Math.min(1, Math.max(0, Number(lo) || 0));
    pocketHi = Math.min(1, Math.max(0, Number(hi) || 0));
    if (pocketHi < pocketLo) [pocketLo, pocketHi] = [pocketHi, pocketLo];
    pocketOn = !!on;
    painted = '';
    paint(lastBase, lastLive);
  };

  const valueFromPointer = (e) => {
    const rect = track.getBoundingClientRect();
    const t = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    let v = viewMin + clamp01(t) * (viewMax - viewMin);
    if (def.step) v = Math.round(v / def.step) * def.step;
    if (v > CAP) v = CAP;
    if (v < -CAP) v = -CAP;
    return v;
  };

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { track.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    api.onHold(false);
    api.onCommit?.();
    paint(api.get(), api.get());
  };
  const onMove = (e) => {
    if (!dragging) return;
    api.set(valueFromPointer(e), { history: 'drag' });
  };
  const onUp = (e) => endDrag(e);

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    root.classList.add('dragging');
    try { track.setPointerCapture(e.pointerId); } catch { /* no active pointer, still drag via window */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    api.onHold(true);
    api.set(valueFromPointer(e), { history: 'drag' });
  });
  track.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = false;
    root.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    api.onHold(false);
    if (api.onReset) api.onReset();
    else paint(api.get(), api.get());
  });

  let settled = true;
  const finishEdit = (commitValue) => {
    if (settled) return;
    settled = true;
    editing = false;
    editor.hidden = true;
    readout.hidden = false;
    const raw = editor.value.trim();
    if (commitValue && raw !== '') {
      const v = clampTyped(raw, def.min, def.max, def.step);
      if (v != null) api.set(v, { history: 'commit' });
    }
    paint(api.get(), api.get());
  };
  const openEditor = () => {
    if (editing) return;
    editing = true;
    settled = false;
    editor.hidden = false;
    readout.hidden = true;
    editor.value = formatNum(api.get());
    editor.focus();
    editor.select();
    requestAnimationFrame(() => {
      if (editing) editor.select();
    });
  };
  readout.addEventListener('click', openEditor);
  readout.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openEditor();
  });

  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEdit(true);
      editor.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishEdit(false);
      editor.blur();
    }
  });
  editor.addEventListener('blur', () => finishEdit(true));

  paint(api.get(), api.get());

  return {
    el: root,
    input: editor,
    paint,
    setPocket,
    get dragging() { return dragging; },
    get editing() { return editing; },
  };
}

/** Click or double-click a readout beside a native range to type its value. */
export function bindRangeReadout(output, range) {
  if (!output || !range || output.dataset.editable === '1') return;
  output.dataset.editable = '1';
  output.classList.add('editable-value');
  if (!output.title) output.title = 'Click to type an exact value';
  const open = (e) => {
    e?.preventDefault();
    if (range.disabled || output.dataset.editing === '1') return;
    output.dataset.editing = '1';
    const editor = document.createElement('input');
    editor.type = 'number';
    editor.className = 'num-editor inline-num';
    editor.step = range.step || 'any';
    editor.min = range.min;
    editor.max = range.max;
    editor.autocomplete = 'off';
    editor.value = String(parseFloat(range.value));
    output.hidden = true;
    output.insertAdjacentElement('afterend', editor);
    let cancel = false;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const v = clampTyped(editor.value, range.min, range.max, range.step);
        if (v != null) {
          range.value = String(v);
          range.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      editor.remove();
      output.hidden = false;
      output.dataset.editing = '0';
    };
    editor.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel = true;
        finish(false);
      }
    });
    editor.addEventListener('blur', () => finish(!cancel));
    editor.focus();
    editor.select();
    requestAnimationFrame(() => {
      if (!done) editor.select();
    });
  };
  output.addEventListener('click', open);
  output.addEventListener('dblclick', open);
}
