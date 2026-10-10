// Bottom dock: scene launcher pads + beat timeline.
//   pads:   click = launch (crossfade), shift-click = MIDI learn, right-click = menu,
//           drag within the list to reorder (ids stay put), or onto the timeline for a cue
//   track:  click = seek, drag a cue to move it, double-click / right-click a cue to delete

import { beginDrag, endDrag, endDragSoon, isOurDrag, readDrag } from './dragPayload.js';
import { PAD_COLORS } from '../scenes/SceneManager.js';

const BANK_SIZE = 8;
const BANK_KEY = 'vj.sceneBank';

const $ = (id) => document.getElementById(id);

export class SceneBar {
  constructor({ scenes, timeline, midi, onLaunch, onSave, onExport, onSaveNew, onImport, onPickProject, onNew, onTap, clipLayer, hasMedia, onDropFiles, groupEdit }) {
    this.scenes = scenes;
    this.timeline = timeline;
    this.midi = midi;
    this.onLaunch = onLaunch;
    this.groupEdit = groupEdit || ((fn) => fn());
    this.onTap = onTap;
    this.clipLayer = clipLayer || (() => 'A');
    this.hasMedia = hasMedia || (() => true);
    this.onDropFiles = onDropFiles || null;
    this.padEls = new Map();

    this.padsEl = $('scene-pads');
    this.bank = Math.max(0, Number(localStorage.getItem(BANK_KEY)) || 0);
    this.trackEl = $('tl-track');
    this.cuesEl = $('tl-cues');
    this.headEl = $('tl-head');
    this.dropEl = $('tl-drop');
    this.labelsEl = $('tl-labels');
    this.menuEl = $('scene-menu');

    $('scene-save').addEventListener('click', () => {
      onSave($('scene-name').value);
      $('scene-name').value = '';
    });
    $('scene-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('scene-save').click();
    });
    this.#bindFileMenu(onExport, onSaveNew, onImport, onNew, onPickProject);
    $('scenes-import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) onImport(f);
    });

    this.#bindTransport();
    this.#bindTrack();
    this.#bindMenu();
    this.#bindPadReorder();
    this.#watchPadSpace();

    scenes.onChange(() => {
      this.#clampBank();
      // Launch only flips activeId — do not wipe buttons under the pointer.
      if (this.#sceneListKey() === this._sceneListKey && this.padEls.size) {
        this.#syncPadChrome();
        this.renderCues();
        return;
      }
      this.renderPads();
      this.renderCues();
    });
    timeline.onChange(() => this.renderTimeline());
    this.renderPads();
    this.renderTimeline();
  }

  get bankSize() {
    return BANK_SIZE;
  }

  #clampBank() {
    const count = Math.max(1, Math.ceil(this.scenes.scenes.length / BANK_SIZE));
    if (this.bank > count - 1) this.bank = count - 1;
  }

  setBank(index) {
    this.#clampBank();
    const count = Math.max(1, Math.ceil(this.scenes.scenes.length / BANK_SIZE));
    this.bank = Math.min(count - 1, Math.max(0, index));
    try { localStorage.setItem(BANK_KEY, String(this.bank)); } catch { /* ignore */ }
    this.renderPads();
  }

  #bindFileMenu(onExport, onSaveNew, onImport, onNew, onPickProject) {
    const btn = $('file-menu-btn');
    const menu = $('file-menu');
    const place = () => {
      const rect = btn.getBoundingClientRect();
      menu.style.left = `${Math.round(rect.left)}px`;
      menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    };
    const close = () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden) {
        close();
        return;
      }
      $('screen-menu').hidden = true;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      place();
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    $('scenes-export').addEventListener('click', () => {
      close();
      onExport();
    });
    $('scenes-save-new')?.addEventListener('click', () => {
      close();
      onSaveNew?.();
    });
    $('scenes-import').addEventListener('click', () => {
      close();
      Promise.resolve(onPickProject?.()).then((handled) => {
        if (!handled) $('scenes-import-file').click();
      });
    });
    $('scenes-new')?.addEventListener('click', () => {
      close();
      onNew?.();
    });
    document.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  // ------------------------------------------------------------- pads
  // Adaptive CSS grid: columns from width, rows from height (preview split).
  // Fill the visible N×M first; extra scenes add rows and the grid scrolls.
  #sceneListKey() {
    return this.scenes.scenes.map((s) => s.id).join('\0');
  }

  /** Public: MIDI learn / mapping chrome without wiping pad buttons mid-click. */
  refreshPadChrome() {
    this.#syncPadChrome();
  }

  /** Update labels/colors/active without destroying pad buttons (keeps click handlers). */
  #syncPadChrome() {
    const scenes = this.scenes.scenes;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const pad = this.padEls.get(s.id);
      if (!pad) {
        this.renderPads();
        return;
      }
      pad.style.setProperty('--c', s.color);
      pad.dataset.index = String(i);
      const num = pad.querySelector('i');
      if (num) num.textContent = String(i + 1);
      const label = pad.querySelector('span');
      if (label) label.textContent = s.name;
      const map = this.midi.mappingFor(`scene:${s.id}`);
      pad.classList.toggle('mapped', !!map);
      pad.classList.toggle('armed', this.midi.learnTarget === `scene:${s.id}`);
      pad.classList.toggle('midi-hot', this.midi.learnTarget === `scene:${s.id}`);
    }
    this.updateActive();
  }

  /** Flush a rebuild deferred while a pad was pressed / dragging. */
  #flushPadRender() {
    if (!this._padNeedsRender || this._padArmed || this._padDragged) return;
    this._padNeedsRender = false;
    this.renderPads();
  }

  #watchPadSpace() {
    this._slotCount = 0;
    this._layoutKey = '';
    this._padSceneN = -1;
    this._padSyncTimer = 0;
    this._lastRowH = -1;
    const applyCss = (cols, rowH) => {
      this.padsEl.style.setProperty('--scene-cols', String(cols));
      if (Math.abs(rowH - this._lastRowH) >= 2) {
        this._lastRowH = rowH;
        this.padsEl.style.setProperty('--scene-row-h', `${rowH}px`);
      }
    };
    const syncNow = () => {
      // Never wipe pads under an active press / HTML5 drag.
      if (this._padArmed || this._padDragged) {
        this._padNeedsRender = true;
        return;
      }
      const { cols, rows, rowH } = this.#gridMetrics();
      const key = `${cols}x${rows}`;
      const next = this.#slotCount();
      const sceneN = this.scenes.scenes.length;
      if (key === this._layoutKey && next === this._slotCount && sceneN === this._padSceneN) {
        applyCss(cols, rowH);
        return;
      }
      this.renderPads();
    };
    const sync = () => {
      if (this._padSyncTimer) clearTimeout(this._padSyncTimer);
      this._padSyncTimer = setTimeout(() => {
        this._padSyncTimer = 0;
        syncNow();
      }, 150);
    };
    if (typeof ResizeObserver === 'function' && this.padsEl) {
      this._padObserver = new ResizeObserver(sync);
      // Observe parents only — watching padsEl itself re-fires when --scene-row-h changes.
      for (const node of [this.padsEl.parentElement, document.querySelector('.center'), document.querySelector('.workspace-pane')]) {
        if (node) this._padObserver.observe(node);
      }
    }
    window.addEventListener('resize', sync);
    requestAnimationFrame(() => requestAnimationFrame(syncNow));
    setTimeout(syncNow, 120);
  }

  #gridMetrics() {
    const el = this.padsEl;
    const gap = 8;
    const minCol = 120;
    const minRow = 64;
    const w = el?.clientWidth || 0;
    const h = el?.clientHeight || 0;
    const cols = Math.max(1, Math.floor((w + gap) / (minCol + gap)));
    const rows = Math.max(1, h > 0 ? Math.floor((h + gap) / (minRow + gap)) : 1);
    const rowH = h > 0
      ? Math.max(48, Math.floor((h - (rows - 1) * gap) / rows))
      : minRow;
    return { cols, rows, gap, rowH };
  }

  #slotCount() {
    const { cols, rows } = this.#gridMetrics();
    const visible = cols * rows;
    const needed = this.scenes.scenes.length + 1;
    return Math.max(visible, needed);
  }

  renderPads() {
    // Never replace buttons under an active press / HTML5 drag (click would die).
    if (this._padArmed || this._padDragged) {
      this._padNeedsRender = true;
      return;
    }
    this._padNeedsRender = false;
    const scrollX = this.padsEl.scrollLeft;
    const scrollY = this.padsEl.scrollTop;
    this.padsEl.innerHTML = '';
    this.padEls.clear();
    const scenes = this.scenes.scenes;
    const { cols, rows, rowH } = this.#gridMetrics();
    const cells = this.#slotCount();
    this._slotCount = cells;
    this._layoutKey = `${cols}x${rows}`;
    this._padSceneN = scenes.length;
    this._sceneListKey = this.#sceneListKey();
    this._lastRowH = rowH;
    this.padsEl.style.setProperty('--scene-cols', String(cols));
    this.padsEl.style.setProperty('--scene-row-h', `${rowH}px`);
    for (let i = 0; i < cells; i++) {
      const scene = scenes[i];
      this.padsEl.append(scene ? this.#pad(scene, i) : this.#emptyCell());
    }
    this.padsEl.scrollLeft = scrollX;
    this.padsEl.scrollTop = scrollY;
    this.updateActive();
  }

  #emptyCell() {
    const cell = document.createElement('div');
    cell.className = 'pad-empty';
    cell.title = 'Empty';
    cell.addEventListener('contextmenu', (e) => e.preventDefault());
    return cell;
  }

  #pad(s, index) {
    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'pad';
    pad.draggable = true;
    pad.setAttribute('draggable', 'true');
    pad.style.setProperty('--c', s.color);
    pad.innerHTML = `<i>${index + 1}</i><span></span><b class="pad-progress"></b>`;
    pad.querySelector('span').textContent = s.name;
    // Learn stays on scene id so it tracks this scene when the list is reordered.
    pad.dataset.midi = `scene:${s.id}`;
    const map = this.midi.mappingFor(`scene:${s.id}`);
    pad.title = `${s.name}\nClick: launch \u00b7 Drag to reorder (drop marker) or onto the timeline \u00b7 Right-click: menu` +
      (map ? `\nMIDI: ${map}` : '\nShift-click, or MIDI Learn, to bind a pad');
    pad.classList.toggle('mapped', !!map);
    pad.classList.toggle('armed', this.midi.learnTarget === `scene:${s.id}`);
    pad.classList.toggle('midi-hot', this.midi.learnTarget === `scene:${s.id}`);
    pad.dataset.sceneId = s.id;
    pad.dataset.index = String(index);

    // Cancel HTML5 drag until the pointer actually moved — Mac WKWebView otherwise
    // starts a drag on micro-jitter and suppresses the click that should launch.
    const DRAG_PX = 6;
    let downX = 0;
    let downY = 0;
    let dragging = false;
    let launched = false;

    const launch = (shift) => {
      if (dragging || launched) return;
      launched = true;
      if (shift) this.midi.learn(`scene:${s.id}`);
      else this.onLaunch(s.id);
    };

    pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downX = e.clientX;
      downY = e.clientY;
      dragging = false;
      launched = false;
      this._padArmed = s.id;
      this._padDragged = false;
      this._padDragMoved = false;
    });
    pad.addEventListener('pointerup', (e) => {
      if (this._padArmed !== s.id) return;
      this._padArmed = null;
      if (dragging || this._padDragMoved) {
        this.#flushPadRender();
        return;
      }
      // Fallback when WKWebView suppresses click after a cancelled micro-drag.
      const shift = e.shiftKey;
      setTimeout(() => {
        if (!launched && !dragging && !this._padDragMoved) launch(shift);
        this.#flushPadRender();
      }, 0);
    });
    pad.addEventListener('pointercancel', () => {
      if (this._padArmed === s.id) this._padArmed = null;
      this.#flushPadRender();
    });
    pad.addEventListener('click', (e) => {
      if (dragging || this._padDragMoved) return;
      launch(e.shiftKey);
    });
    pad.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.#openMenu(s.id, e.clientX, e.clientY);
    });
    pad.addEventListener('dragstart', (e) => {
      const x = e.clientX || downX;
      const y = e.clientY || downY;
      if (Math.hypot(x - downX, y - downY) < DRAG_PX) {
        // Let the subsequent click launch; do not start a DnD gesture.
        e.preventDefault();
        dragging = false;
        this._padDragged = false;
        this._padDragMoved = false;
        return;
      }
      dragging = true;
      this._padDragged = true;
      this._padDragMoved = true;
      const itemData = { id: s.id, name: s.name, source: 'scene', color: s.color };
      beginDrag(e, itemData);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        type: 'SCENE_OR_CLIP',
        id: itemData.id,
        name: itemData.name,
        data: itemData,
      }));
      document.body.classList.add('dragging-scene');
      pad.classList.add('is-dragging');
    });
    pad.addEventListener('dragend', () => {
      document.body.classList.remove('dragging-scene');
      pad.classList.remove('is-dragging');
      this.#clearPadDropMarks();
      endDragSoon();
      this._padArmed = null;
      dragging = false;
      setTimeout(() => {
        this._padDragged = false;
        this._padDragMoved = false;
        this.#flushPadRender();
      }, 0);
    });
    this.padEls.set(s.id, pad);
    return pad;
  }

  #isSceneDrag(payload) {
    if (!payload?.id) return false;
    if (payload.data?.source === 'scene') return true;
    return !!this.scenes.get(payload.id);
  }

  #bindPadReorder() {
    const el = this.padsEl;
    if (!el) return;
    let insertAt = -1;
    const mark = (index) => {
      const sceneCount = this.scenes.scenes.length;
      insertAt = Math.min(Math.max(0, index), sceneCount);
      this.#clearPadDropMarks();
      const cells = [...el.children];
      if (!cells.length) return;
      if (insertAt >= sceneCount) {
        const last = cells[Math.min(sceneCount, cells.length) - 1] || cells[cells.length - 1];
        last?.classList.add(insertAt > 0 ? 'drop-after' : 'drop-before');
        return;
      }
      cells[insertAt]?.classList.add('drop-before');
    };
    const allow = (e) => {
      const payload = window.__vjDragPayload;
      if (!this.#isSceneDrag(payload)) return false;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      return true;
    };
    el.addEventListener('dragenter', (e) => { allow(e); });
    el.addEventListener('dragover', (e) => {
      if (!allow(e)) return;
      mark(this.#padInsertIndex(e));
    });
    el.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      this.#clearPadDropMarks();
      insertAt = -1;
    });
    el.addEventListener('drop', (e) => {
      const payload = readDrag(e);
      if (!this.#isSceneDrag(payload)) return;
      e.preventDefault();
      e.stopPropagation();
      const at = insertAt >= 0 ? insertAt : this.#padInsertIndex(e);
      this.#clearPadDropMarks();
      insertAt = -1;
      this.groupEdit(() => this.scenes.move(payload.id, at));
    });
  }

  /** Insert index into the scene array (0 … length), not the empty filler cells. */
  #padInsertIndex(e) {
    const cells = [...this.padsEl.children];
    const sceneCount = this.scenes.scenes.length;
    if (!cells.length) return 0;
    const x = e.clientX;
    const y = e.clientY;

    for (let i = 0; i < cells.length; i++) {
      const rect = cells[i].getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) continue;
      if (x < rect.left || x > rect.right) continue;
      if (cells[i].classList.contains('pad-empty')) return Math.min(i, sceneCount);
      return x < rect.left + rect.width / 2 ? i : Math.min(i + 1, sceneCount);
    }

    // Gaps: nearest cell by 2D distance among scene slots (+ one empty end).
    let best = sceneCount;
    let bestDist = Infinity;
    const limit = Math.min(cells.length, sceneCount + 1);
    for (let i = 0; i < limit; i++) {
      const rect = cells[i].getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = (x - cx) ** 2 + (y - cy) ** 2;
      if (dist >= bestDist) continue;
      bestDist = dist;
      best = x < cx ? i : i + 1;
    }
    return Math.min(Math.max(0, best), sceneCount);
  }

  #clearPadDropMarks() {
    for (const node of this.padsEl.querySelectorAll('.drop-before, .drop-after')) {
      node.classList.remove('drop-before', 'drop-after');
    }
  }

  updateActive() {
    for (const [id, pad] of this.padEls) {
      const active = id === this.scenes.activeId;
      pad.classList.toggle('active', active);
      const p = active && this.scenes.transition ? this.scenes.progress : active ? 1 : 0;
      pad.style.setProperty('--p', p);
    }
  }

  // ------------------------------------------------------------- pad menu
  #bindMenu() {
    const colors = document.createElement('div');
    colors.className = 'scene-colors';
    colors.setAttribute('role', 'group');
    colors.setAttribute('aria-label', 'Scene color');
    for (const color of PAD_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.dataset.action = 'color';
      swatch.dataset.color = color;
      swatch.title = 'Scene color';
      swatch.style.setProperty('--swatch', color);
      swatch.setAttribute('aria-label', 'Scene color');
      colors.append(swatch);
    }
    this.menuEl.insertBefore(colors, this.menuEl.querySelector('[data-action="delete"]'));
    this.menuEl.addEventListener('click', (e) => {
      const hit = e.target.closest('[data-action]');
      const action = hit?.dataset.action;
      const id = this.menuEl.dataset.scene;
      if (!action || !id) return;
      const scene = this.scenes.get(id);
      this.#closeMenu();
      if (!scene) return;
      if (action === 'launch-cut') this.onLaunch(id, 0);
      else if (action === 'rename') {
        const name = prompt('Scene name', scene.name);
        if (name) this.scenes.rename(id, name);
      } else if (action === 'update') this.scenes.overwrite(id);
      else if (action === 'move-left' || action === 'move-right') {
        const i = this.scenes.scenes.findIndex((row) => row.id === id);
        if (i < 0) return;
        if (action === 'move-left' && i > 0) this.groupEdit(() => this.scenes.move(id, i - 1));
        if (action === 'move-right' && i < this.scenes.scenes.length - 1) {
          this.groupEdit(() => this.scenes.move(id, i + 2));
        }
      } else if (action === 'midi') this.midi.learn(`scene:${id}`);
      else if (action === 'color') this.scenes.setColor(id, hit.dataset.color);
      else if (action === 'delete' && confirm(`Delete "${scene.name}"? Its timeline cues are removed too.`)) {
        this.groupEdit(() => {
          this.midi.clear(`scene:${id}`);
          this.timeline.removeScene(id);
          this.scenes.remove(id);
        });
      }
    });
    window.addEventListener('pointerdown', (e) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(e.target)) this.#closeMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#closeMenu();
    });
  }

  /** Shared with Perform APC pads (same scene list / menu). */
  openPadMenu(id, x, y) {
    this.#openMenu(id, x, y);
  }

  #openMenu(id, x, y) {
    this.menuEl.dataset.scene = id;
    const current = this.scenes.get(id)?.color;
    const index = this.scenes.scenes.findIndex((row) => row.id === id);
    const last = this.scenes.scenes.length - 1;
    for (const swatch of this.menuEl.querySelectorAll('.scene-colors button')) {
      const on = swatch.dataset.color === current;
      swatch.classList.toggle('is-on', on);
      swatch.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const left = this.menuEl.querySelector('[data-action="move-left"]');
    const right = this.menuEl.querySelector('[data-action="move-right"]');
    if (left) left.disabled = index <= 0;
    if (right) right.disabled = index < 0 || index >= last;
    this.menuEl.hidden = false;
    const r = this.menuEl.getBoundingClientRect();
    this.menuEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    this.menuEl.style.top = `${Math.max(8, y - r.height)}px`;
  }

  #closeMenu() {
    this.menuEl.hidden = true;
  }

  // ------------------------------------------------------------- transport
  #bindTransport() {
    const tl = this.timeline;
    $('tl-loop').addEventListener('click', () => tl.set('loop', !tl.loop));
    $('tl-bars').addEventListener('change', (e) => tl.set('bars', e.target.value));
    $('tl-fade-sec').addEventListener('input', (e) => tl.set('fadeSec', e.target.value, { history: 'drag' }));
    $('tl-fade-sec').addEventListener('change', () => tl.historyCommit?.());
    $('tl-style').addEventListener('change', (e) => tl.set('fadeStyle', e.target.value));
  }

  renderTimeline() {
    const tl = this.timeline;
    $('tl-loop').classList.toggle('on', tl.loop);
    if (document.activeElement !== $('tl-bars')) $('tl-bars').value = tl.bars;
    if (document.activeElement !== $('tl-fade-sec')) $('tl-fade-sec').value = String(tl.fadeSec);
    $('tl-fade-readout').textContent = `${tl.fadeSec.toFixed(1)}s`;
    $('tl-style').value = String(tl.fadeStyle);

    this.trackEl.style.setProperty('--bars', tl.bars);
    this.trackEl.style.setProperty('--beats', tl.lengthBeats);
    this.renderLabels();
    this.renderCues();
    this.updatePlayhead();
  }

  /** Bar numbers follow the zoom. Wide bars also show the beats inside each bar. */
  renderLabels() {
    const tl = this.timeline;
    const bars = Math.max(1, tl.bars);
    const width = this.trackEl.getBoundingClientRect().width || this.trackEl.clientWidth || 1;
    const px = width / bars;
    this.labelsEl.innerHTML = '';
    const add = (barIndex, text, beat) => {
      const s = document.createElement('span');
      s.textContent = text;
      if (beat) s.className = 'tl-beat';
      s.style.left = `${(barIndex / bars) * 100}%`;
      this.labelsEl.append(s);
    };
    if (px >= 120) {
      for (let b = 0; b < bars; b++) {
        add(b, String(b + 1), false);
        for (let beat = 1; beat < 4; beat++) {
          const mark = document.createElement('span');
          mark.className = 'tl-beat';
          mark.textContent = `${b + 1}.${beat + 1}`;
          mark.style.left = `${((b + beat / 4) / bars) * 100}%`;
          this.labelsEl.append(mark);
        }
      }
      return;
    }
    let every = 1;
    while (every * px < 40 && every < bars) every *= 2;
    for (let b = 0; b < bars; b += every) add(b, String(b + 1), false);
    if ((bars - 1) % every !== 0) add(bars - 1, String(bars), false);
  }

  renderCues() {
    const tl = this.timeline;
    const len = tl.lengthBeats;
    const sorted = [...tl.cues].sort((a, b) => a.beat - b.beat);
    this.cuesEl.innerHTML = '';
    sorted.forEach((cue, i) => {
      const scene = cue.kind === 'clip' ? null : this.scenes.get(cue.sceneId);
      const end = i + 1 < sorted.length ? sorted[i + 1].beat : len;
      const el = document.createElement('div');
      el.className = 'cue';
      el.dataset.id = cue.id;
      el.style.left = `${(cue.beat / len) * 100}%`;
      el.style.width = `${((end - cue.beat) / len) * 100}%`;
      const clip = cue.kind === 'clip';
      const label = clip ? (cue.mediaName || 'Clip') : (scene ? scene.name : '(deleted scene)');
      el.style.setProperty('--c', clip ? '#00ffff' : (scene?.color || '#666'));
      el.classList.toggle('clip', clip);
      el.classList.toggle('orphan', clip ? !this.hasMedia(cue.mediaName) : !scene);
      el.innerHTML = '<span></span>';
      el.querySelector('span').textContent = label;
      const place = `bar ${Math.floor(cue.beat / 4) + 1}, beat ${(cue.beat % 4) + 1}`;
      el.title = clip
        ? `${label} on layer ${cue.layerId || 'A'} @ ${place}\nDrag to move \u00b7 Double-click or right-click to remove`
        : `${scene?.name ?? 'Deleted scene'} @ ${place}\nDrag to move \u00b7 Double-click or right-click to remove`;
      this.cuesEl.append(el);
    });
  }

  updatePlayhead() {
    const tl = this.timeline;
    const len = tl.lengthBeats || 1;
    const frac = Math.min(1, Math.max(0, tl.beat / len));
    const width = this.trackEl?.clientWidth || 0;
    const px = width * frac;
    if (this.headPx !== px) {
      this.headPx = px;
      this.headEl.style.left = `${px}px`;
      this.headEl.style.right = 'auto';
      const fill = $('tl-progress');
      if (fill) {
        fill.style.left = '0';
        fill.style.right = 'auto';
        fill.style.width = `${px}px`;
      }
    }
    const b = Math.min(tl.beat, tl.lengthBeats - 0.0001);
    const label = `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}`;
    if (this.headLabel !== label) {
      this.headLabel = label;
      $('tl-pos').textContent = label;
    }
  }

  // ------------------------------------------------------------- track
  #beatAt(clientX, round = Math.floor) {
    const r = this.trackEl.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.min(this.timeline.lengthBeats - 1, round(t * this.timeline.lengthBeats));
  }

  #bindTrack() {
    const track = this.trackEl;
    let depth = 0;

    const clearHot = () => {
      depth = 0;
      track.classList.remove('drop-hot');
      this.dropEl.hidden = true;
    };

    const fileDrag = (e) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      if (typeof types.contains === 'function') return types.contains('Files');
      return [...types].includes('Files');
    };
    const allowDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    // Capture so WebView2 sees preventDefault before a child can stop the event.
    // OS file drops stay on these DOM events. Tauri's tauri://drag-drop listener
    // only runs while dragDropEnabled is true, and that flag replaces WebView2's
    // handler (the Windows block cursor). It is left off; Finder/desktop files
    // arrive here as dataTransfer.files.
    track.addEventListener('dragenter', (e) => {
      allowDrop(e);
      if (!isOurDrag(e) && !fileDrag(e)) return;
      depth += 1;
      track.classList.add('drop-hot');
    }, true);
    track.addEventListener('dragover', (e) => {
      allowDrop(e);
      if (!isOurDrag(e) && !fileDrag(e)) return;
      track.classList.add('drop-hot');
      this.#showDrop(this.#beatAt(e.clientX));
    }, true);
    track.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isOurDrag(e) && !fileDrag(e) && !track.classList.contains('drop-hot')) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 && !track.contains(e.relatedTarget)) clearHot();
    });
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      try {
        this.#onDrop(e, 'timeline');
      } catch (err) {
        console.error('Timeline drop failed', err);
      }
    });
    document.addEventListener('dragend', clearHot);

    // Cue drag (pointer events) and click-to-seek.
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const cueEl = e.target.closest('.cue');
      if (!cueEl) {
        this.timeline.seek(this.#beatAt(e.clientX, Math.round));
        return;
      }
      const id = cueEl.dataset.id;
      const startX = e.clientX;
      let moved = false;
      track.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (moved) {
          const b = this.#beatAt(ev.clientX);
          this.#showDrop(b);
          this.timeline.moveCue(id, b, { history: 'drag' });
        }
      };
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        this.dropEl.hidden = true;
        if (moved) this.timeline.historyCommit?.();
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
    });

    track.addEventListener('dblclick', (e) => {
      const cueEl = e.target.closest('.cue');
      if (cueEl) this.timeline.removeCue(cueEl.dataset.id);
    });
    track.addEventListener('contextmenu', (e) => {
      const cueEl = e.target.closest('.cue');
      if (!cueEl) return;
      e.preventDefault();
      this.timeline.removeCue(cueEl.dataset.id);
    });
  }

  #onDrop(event, trackId) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.trackEl.classList.remove('drop-hot');
    this.dropEl.hidden = true;
    document.body.classList.remove('dragging-scene');
    const beat = this.#beatAt(event.clientX);
    const dropped = [...(event.dataTransfer?.files || [])];
    let plain = '';
    try {
      plain = event.dataTransfer?.getData('text/plain') || '';
    } catch (err) {
      console.error('Timeline drop payload', err);
    }
    const payload = readDrag(event);
    try {
      if (dropped.length && this.onDropFiles) {
        const names = this.onDropFiles(dropped) || [];
        const layerId = trackId === 'B' || trackId === 'C' || trackId === 'A' ? trackId : this.clipLayer();
        this.timeline.batch(() => {
          names.forEach((name, index) => {
            this.timeline.addClip(beat + index, {
              mediaId: name,
              mediaName: name,
              layerId,
            });
          });
        });
        return;
      }
      if (payload?.data?.source === 'clip') {
        const layerId = trackId === 'B' || trackId === 'C' || trackId === 'A' ? trackId : this.clipLayer();
        this.timeline.addClip(beat, {
          mediaId: payload.id,
          mediaName: payload.name,
          layerId,
        });
        return;
      }
      let sceneId = payload?.data?.source === 'scene' ? payload.id : '';
      if (!sceneId && plain && !plain.startsWith('{') && !plain.startsWith('[')) sceneId = plain;
      if (sceneId) this.timeline.addCue(beat, sceneId);
    } catch (err) {
      console.error('Timeline drop failed', err);
    } finally {
      endDrag();
    }
  }

  #showDrop(beat) {
    this.dropEl.hidden = false;
    this.dropEl.style.left = `${(beat / this.timeline.lengthBeats) * 100}%`;
    this.dropEl.style.width = `${100 / this.timeline.lengthBeats}%`;
  }
}
