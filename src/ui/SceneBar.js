// Bottom dock: scene launcher pads + beat timeline.
//   pads:   click = launch (crossfade), shift-click = MIDI learn, right-click = menu,
//           drag onto the timeline to create a cue
//   track:  click = seek, drag a cue to move it, double-click / right-click a cue to delete

import { beginDrag, endDrag, isOurDrag, readDrag } from './dragPayload.js';

const BANK_SIZE = 8;
const BANK_KEY = 'vj.sceneBank';

const $ = (id) => document.getElementById(id);

export class SceneBar {
  constructor({ scenes, timeline, midi, onLaunch, onSave, onExport, onSaveNew, onImport, onNew, onTap, clipLayer, hasMedia, onDropFiles }) {
    this.scenes = scenes;
    this.timeline = timeline;
    this.midi = midi;
    this.onLaunch = onLaunch;
    this.onTap = onTap;
    this.clipLayer = clipLayer || (() => 'A');
    this.hasMedia = hasMedia || (() => true);
    this.onDropFiles = onDropFiles || null;
    this.padEls = new Map();

    this.padsEl = $('scene-pads');
    this.banksEl = $('scene-banks');
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
    this.#bindFileMenu(onExport, onSaveNew, onImport, onNew);
    $('scenes-import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) onImport(f);
    });

    this.#bindTransport();
    this.#bindTrack();
    this.#bindMenu();

    scenes.onChange(() => {
      this.#clampBank();
      this.renderBanks();
      this.renderPads();
      this.renderCues();
    });
    timeline.onChange(() => this.renderTimeline());
    this.renderBanks();
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
    this.renderBanks();
    this.renderPads();
  }

  renderBanks() {
    this.#clampBank();
    const count = Math.max(1, Math.ceil(this.scenes.scenes.length / BANK_SIZE));
    this.banksEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Bank ${i + 1}`;
      b.classList.toggle('on', i === this.bank);
      b.title = `Scenes ${i * BANK_SIZE + 1}–${i * BANK_SIZE + BANK_SIZE}`;
      b.addEventListener('click', () => this.setBank(i));
      this.banksEl.append(b);
    }
  }

  #bindFileMenu(onExport, onSaveNew, onImport, onNew) {
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
      $('scenes-import-file').click();
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
  renderPads() {
    this.padsEl.innerHTML = '';
    this.padEls.clear();
    const start = this.bank * BANK_SIZE;
    const page = this.scenes.scenes.slice(start, start + BANK_SIZE);
    if (!this.scenes.scenes.length) {
      const empty = document.createElement('span');
      empty.className = 'pads-empty';
      empty.textContent = 'No scenes yet. Set up your layers, then save the current state as a scene.';
      this.padsEl.append(empty);
      return;
    }
    if (!page.length) {
      const empty = document.createElement('span');
      empty.className = 'pads-empty';
      empty.textContent = 'This bank is empty.';
      this.padsEl.append(empty);
      return;
    }
    page.forEach((s, i) => {
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = 'pad';
      pad.draggable = true;
      pad.setAttribute('draggable', 'true');
      pad.style.setProperty('--c', s.color);
      pad.innerHTML = `<i>${i + 1}</i><span></span><b class="pad-progress"></b>`;
      pad.querySelector('span').textContent = s.name;
      pad.dataset.midi = `scene:${s.id}`;
      const map = this.midi.mappingFor(`scene:${s.id}`);
      pad.title = `${s.name}\nBank ${this.bank + 1} · slot ${i + 1}\nClick: launch \u00b7 Drag to timeline \u00b7 Right-click: menu` +
        (map ? `\nMIDI: ${map}` : '\nShift-click, or MIDI Learn, to bind a pad');
      pad.classList.toggle('mapped', !!map);
      pad.classList.toggle('armed', this.midi.learnTarget === `scene:${s.id}`);
      pad.classList.toggle('midi-hot', this.midi.learnTarget === `scene:${s.id}`);

      pad.addEventListener('click', (e) => {
        if (e.shiftKey) this.midi.learn(`scene:${s.id}`);
        else this.onLaunch(s.id);
      });
      pad.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.#openMenu(s.id, e.clientX, e.clientY);
      });
      pad.addEventListener('dragstart', (e) => {
        const item = { id: s.id, name: s.name, source: 'scene', color: s.color };
        beginDrag(e, item);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.setData('application/json', JSON.stringify({ sceneId: s.id }));
        document.body.classList.add('dragging-scene');
      });
      pad.addEventListener('dragend', () => {
        document.body.classList.remove('dragging-scene');
        endDrag();
      });
      this.padsEl.append(pad);
      this.padEls.set(s.id, pad);
    });
    this.updateActive();
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
    this.menuEl.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
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
      else if (action === 'midi') this.midi.learn(`scene:${id}`);
      else if (action === 'delete' && confirm(`Delete "${scene.name}"? Its timeline cues are removed too.`)) {
        this.midi.clear(`scene:${id}`);
        this.timeline.removeScene(id);
        this.scenes.remove(id);
      }
    });
    window.addEventListener('pointerdown', (e) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(e.target)) this.#closeMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#closeMenu();
    });
  }

  #openMenu(id, x, y) {
    this.menuEl.dataset.scene = id;
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
    $('tl-play').addEventListener('click', () => tl.toggle());
    $('tl-stop').addEventListener('click', () => tl.stop());
    $('tl-loop').addEventListener('click', () => tl.set('loop', !tl.loop));
    $('tl-bpm').addEventListener('change', (e) => tl.set('bpm', e.target.value));
    $('tl-bars').addEventListener('change', (e) => tl.set('bars', e.target.value));
    $('tl-fade-sec').addEventListener('input', (e) => tl.set('fadeSec', e.target.value));
    $('tl-style').addEventListener('change', (e) => tl.set('fadeStyle', e.target.value));
    $('tl-tap').addEventListener('click', () => this.onTap());
  }

  renderTimeline() {
    const tl = this.timeline;
    $('tl-play').innerHTML = tl.playing ? '&#x275A;&#x275A;' : '&#x25B6;';
    $('tl-play').classList.toggle('on', tl.playing);
    $('tl-loop').classList.toggle('on', tl.loop);
    if (document.activeElement !== $('tl-bpm')) $('tl-bpm').value = tl.bpm;
    if (document.activeElement !== $('tl-bars')) $('tl-bars').value = tl.bars;
    if (document.activeElement !== $('tl-fade-sec')) $('tl-fade-sec').value = String(tl.fadeSec);
    $('tl-fade-readout').textContent = `${tl.fadeSec.toFixed(1)}s`;
    $('tl-style').value = String(tl.fadeStyle);

    this.trackEl.style.setProperty('--bars', tl.bars);
    this.trackEl.style.setProperty('--beats', tl.lengthBeats);
    const every = tl.bars > 32 ? 8 : tl.bars > 16 ? 4 : tl.bars > 8 ? 2 : 1;
    this.labelsEl.innerHTML = '';
    for (let b = 0; b < tl.bars; b += every) {
      const s = document.createElement('span');
      s.textContent = b + 1;
      s.style.left = `${(b / tl.bars) * 100}%`;
      this.labelsEl.append(s);
    }
    this.renderCues();
    this.updatePlayhead();
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
    const left = (tl.beat / tl.lengthBeats) * 100;
    if (this.headPct !== left) {
      this.headPct = left;
      this.headEl.style.left = `${left}%`;
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
    track.addEventListener('dragenter', (e) => {
      allowDrop(e);
      if (!isOurDrag(e) && !fileDrag(e)) return;
      depth += 1;
      track.classList.add('drop-hot');
    });
    track.addEventListener('dragover', (e) => {
      allowDrop(e);
      if (!isOurDrag(e) && !fileDrag(e)) return;
      track.classList.add('drop-hot');
      this.#showDrop(this.#beatAt(e.clientX));
    });
    track.addEventListener('dragleave', (e) => {
      allowDrop(e);
      if (!isOurDrag(e) && !fileDrag(e) && !track.classList.contains('drop-hot')) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 && !track.contains(e.relatedTarget)) clearHot();
    });
    track.addEventListener('drop', (e) => {
      allowDrop(e);
      this.#onDrop(e, 'timeline');
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
          this.timeline.moveCue(id, b);
        }
      };
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        this.dropEl.hidden = true;
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
    const payload = readDrag(event);
    let sceneId = '';
    try {
      sceneId = event.dataTransfer.getData('text/plain') || JSON.parse(event.dataTransfer.getData('application/json') || '{}').sceneId;
    } catch { sceneId = ''; }
    endDrag();
    if (dropped.length && this.onDropFiles) {
      const names = this.onDropFiles(dropped) || [];
      const layerId = trackId === 'B' || trackId === 'C' || trackId === 'A' ? trackId : this.clipLayer();
      names.forEach((name, index) => {
        this.timeline.addClip(beat + index, {
          mediaId: name,
          mediaName: name,
          layerId,
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
    if (typeof sceneId === 'string' && sceneId.startsWith('{')) sceneId = '';
    if (sceneId) this.timeline.addCue(beat, sceneId);
  }

  #showDrop(beat) {
    this.dropEl.hidden = false;
    this.dropEl.style.left = `${(beat / this.timeline.lengthBeats) * 100}%`;
    this.dropEl.style.width = `${100 / this.timeline.lengthBeats}%`;
  }
}
