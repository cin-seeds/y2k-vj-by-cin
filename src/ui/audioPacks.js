// One Audio Reactivity window for the Still, Push, and Hit packs.
// Edits stay in the draft until Save. View all only reads the live desk.

import { LAYERS, MODE_LABELS, MODES, BLEND_LABELS, BLEND_MENU, RETIRED_SHADER_MODES, layerParam } from '../params.js';
import { MOD_ROUTES } from '../audio/ModMatrix.js';
import {
  PACK_SLOTS, BAND_LABELS, packHover, packSigns, deskSigns, signLines, packSuggestion, normalizePack, improvisePack,
} from '../audio/packs.js';

const MEASURES = [
  ['sub', 'Sub'],
  ['punch', 'Punch'],
  ['mid', 'Mids'],
  ['treble', 'High-Hats'],
  ['peakFlash', 'Peak'],
  ['beatPulse', 'Beat'],
];

const STROBE_SRC = ['Manual', 'Beat Pulse', 'Drop Pulse'];
const $ = (id) => document.getElementById(id);

let editor = null;
let repaint = () => {};
let refreshLive = () => {};

export function refreshAudioPacks() {
  repaint();
}

export function tickAudioPacks(audio) {
  if (!editor || editor.hidden) return;
  const values = audio?.values || {};
  for (const [key] of MEASURES) {
    const bar = editor.querySelector(`[data-measure="${key}"]`);
    if (!bar) continue;
    const level = Math.max(0, Math.min(1, Number(values[key]) || 0));
    bar.style.transform = `scaleX(${level})`;
  }
  refreshLive();
}

function option(value, label, selected) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  if (selected) el.selected = true;
  return el;
}

function blankSelect(selected) {
  return option('', '—', selected);
}

function numberInput(value, { min, max, step }) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  if (value != null && value !== '') input.value = String(value);
  return input;
}

function routeLabel(id) {
  return MOD_ROUTES.find((route) => route.id === id)?.label || id || 'None';
}

const SLOT_HELP = {
  still: {
    what: 'Still is the quiet audio mix on this button.',
    empty: 'If nothing is saved here, a long press builds a quiet mix and keeps it until you save one.',
  },
  push: {
    what: 'Push is the forward audio mix on this button.',
    empty: 'If nothing is saved here, a long press builds a forward mix and keeps it until you save one.',
  },
  hit: {
    what: 'Hit is the hard audio mix on this button.',
    empty: 'If nothing is saved here, a long press builds a hard mix and keeps it until you save one.',
  },
};

function slotHelp(id, ready) {
  const copy = SLOT_HELP[id] || SLOT_HELP.still;
  const lines = [
    copy.what,
    'Long press runs that wiring on the live picture.',
    'Double click opens the editor.',
  ];
  if (!ready) lines.push(copy.empty);
  return lines.join('\n');
}

function trimNum(value) {
  const n = Math.round(Number(value) * 1000) / 1000;
  return String(n);
}

export function mountAudioPacks({ project, params, launch, sceneNames, clipNames, desk }) {
  const list = $('pack-list');
  if (!list || list.dataset.ready === '1') return;
  list.dataset.ready = '1';

  const drafts = new Map();
  const loose = new Map();
  const undoDrafts = new Map();
  const PACK_HOLD_MS = 500;
  const packScopes = new Map(PACK_SLOTS.map((slot) => [slot.id, 'active']));
  let tab = 'still';
  let scope = 'active';
  let pendingFix = null;
  let liveKey = '';

  editor = document.createElement('div');
  editor.id = 'pack-editor';
  editor.className = 'map-modal';
  editor.hidden = true;
  editor.innerHTML = `
    <div class="map-card pack-card" role="dialog" aria-labelledby="pack-editor-title">
      <header class="map-head">
        <h2 id="pack-editor-title">Audio Reactivity Info Board</h2>
        <button type="button" data-act="close">Close</button>
      </header>
      <div class="pack-tabs" role="tablist">
        <button type="button" data-tab="still" role="tab">Still</button>
        <button type="button" data-tab="push" role="tab">Push</button>
        <button type="button" data-tab="hit" role="tab">Hit</button>
        <button type="button" data-tab="view" role="tab">View all</button>
        <div class="pack-filter pack-tab-filter" role="group" aria-label="Pack wires">
          <button type="button" data-pack-scope="active">Active</button>
          <button type="button" data-pack-scope="all">All</button>
        </div>
      </div>
      <div class="pack-meter" aria-hidden="true"></div>
      <div class="pack-body"></div>
      <footer class="pack-footer">
        <p class="pack-clear" hidden>The picture is clear.</p>
        <ul class="pack-signs"></ul>
        <div class="pack-suggest" hidden>
          <p class="pack-suggest-text"></p>
          <button type="button" data-act="apply">Apply</button>
          <button type="button" data-act="undo-apply" hidden>Undo</button>
        </div>
      </footer>
    </div>`;
  document.body.append(editor);

  const meter = editor.querySelector('.pack-meter');
  for (const [key, label] of MEASURES) {
    const cell = document.createElement('span');
    cell.className = 'pack-measure';
    const bar = document.createElement('i');
    bar.dataset.measure = key;
    const name = document.createElement('b');
    name.textContent = label;
    cell.append(bar, name);
    meter.append(cell);
  }

  const body = editor.querySelector('.pack-body');

  function packs() {
    return Array.isArray(project.packs) ? project.packs : [];
  }

  function storedPack(slot) {
    return packs().find((pack) => pack.assign === slot) || null;
  }

  function indicatedPack(slot) {
    return storedPack(slot) || loose.get(slot) || null;
  }

  function draftPack(slot) {
    if (!drafts.has(slot)) {
      const stored = storedPack(slot) || loose.get(slot);
      if (stored) drafts.set(slot, structuredClone(stored));
    }
    return drafts.get(slot) || null;
  }

  function paintButtons() {
    for (const slot of PACK_SLOTS) {
      const btn = $(`pack-${slot.id}`);
      if (!btn) continue;
      btn.removeAttribute('title');
      btn.dataset.help = slotHelp(slot.id, !!(storedPack(slot.id) || loose.get(slot.id)));
    }
  }

  function paintList() {
    list.replaceChildren();
    packs().forEach((pack) => {
      const row = document.createElement('div');
      row.className = 'pack-row';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'pack-open';
      open.textContent = pack.name;
      open.title = packHover(pack);
      open.addEventListener('click', () => {
        if (PACK_SLOTS.some((slot) => slot.id === pack.assign)) openPack(pack.assign);
      });
      row.append(open);
      list.append(row);
    });
  }

  function paint() {
    paintList();
    paintButtons();
  }

  function paintFooter(signs, pack) {
    const lines = signLines(signs);
    const clear = lines.length === 1 && lines[0] === 'The picture is clear.';
    const note = editor.querySelector('.pack-clear');
    const box = editor.querySelector('.pack-signs');
    const suggest = editor.querySelector('.pack-suggest');
    note.hidden = !clear;
    box.hidden = clear;
    box.replaceChildren();
    pendingFix = null;
    if (!clear) {
      for (const line of lines) {
        const item = document.createElement('li');
        const kind = line.split(':')[0];
        if (['Clash', 'Over', 'Destroy', 'Silent'].includes(kind)) item.dataset.kind = kind;
        item.textContent = line;
        box.append(item);
      }
    }
    const idea = !clear && pack && tab !== 'view' ? packSuggestion(pack, signs) : null;
    const canUndo = tab !== 'view' && undoDrafts.has(tab);
    pendingFix = idea;
    suggest.hidden = !idea && !canUndo;
    const wording = suggest.querySelector('.pack-suggest-text');
    wording.hidden = !idea;
    wording.textContent = idea?.text || '';
    suggest.querySelector('[data-act="apply"]').hidden = !idea;
    suggest.querySelector('[data-act="undo-apply"]').hidden = !canUndo;
  }

  function paintPackFooter(slot) {
    const pack = draftPack(slot);
    paintFooter(pack ? packSigns(pack, params) : [], pack);
  }

  const GRID_COLS = [
    ['mode', 'Look', false],
    ['opacity', 'Resting opacity', false],
    ['blend', 'Blend', false],
    ['band', 'Band', true],
    ['reactivity', 'Reactivity', true],
    ['beat', 'Beat Sync', true],
    ['route', 'Opacity measure', true],
    ['depth', 'Depth', true],
    ['gate', 'Gate', true],
    ['clip', 'Clip', false],
  ];

  function layerConnected(spec) {
    if (!spec) return false;
    const listening = 'band' in spec && spec.band !== 4 && (spec.reactivity ?? 0) > 0;
    const beat = (spec.beat ?? 0) > 0;
    const route = spec.opacityRoute && spec.opacityRoute.route !== 'none' && spec.opacityRoute.depth !== 0;
    return listening || beat || route;
  }

  function strobeConnected(grade) {
    const amount = grade?.strobe ?? 0;
    const src = grade?.strobeSrc ?? 0;
    return amount > 0 && (src === 1 || src === 2);
  }

  function activeColumns(pack) {
    const cols = new Set();
    for (const id of LAYERS) {
      const spec = pack[id];
      if (!layerConnected(spec)) continue;
      if ('band' in spec && spec.band !== 4 && (spec.reactivity ?? 0) > 0) {
        cols.add('band');
        cols.add('reactivity');
      }
      if ((spec.beat ?? 0) > 0) cols.add('beat');
      if (spec.opacityRoute && spec.opacityRoute.route !== 'none' && spec.opacityRoute.depth !== 0) {
        cols.add('route');
        cols.add('depth');
        cols.add('gate');
      }
    }
    return cols;
  }

  function cell(col, control) {
    const wrap = document.createElement('div');
    wrap.className = 'pack-cell';
    wrap.dataset.col = col;
    wrap.append(control);
    return wrap;
  }

  function layerCells(layer, spec) {
    const mode = document.createElement('select');
    mode.dataset.field = `mode:${layer}`;
    MODES.forEach((id, index) => {
      if (RETIRED_SHADER_MODES.has(index) && id !== spec.mode) return;
      mode.append(option(id, MODE_LABELS[index], id === spec.mode));
    });

    const opacity = numberInput('opacity' in spec ? spec.opacity : '', { min: 0, max: 1, step: 0.01 });
    opacity.dataset.field = `num:${layer}:opacity`;

    const blend = document.createElement('select');
    blend.dataset.field = `pick:${layer}:blend`;
    blend.append(blankSelect(!('blend' in spec)));
    for (const index of BLEND_MENU) {
      blend.append(option(String(index), BLEND_LABELS[index], spec.blend === index));
    }

    const band = document.createElement('select');
    band.dataset.field = `pick:${layer}:band`;
    band.append(blankSelect(!('band' in spec)));
    BAND_LABELS.forEach((label, index) => {
      band.append(option(String(index), label, spec.band === index));
    });

    const reactivity = numberInput('reactivity' in spec ? spec.reactivity : '', { min: 0, max: 2, step: 0.01 });
    reactivity.dataset.field = `num:${layer}:reactivity`;

    const beat = numberInput('beat' in spec ? spec.beat : '', { min: 0, max: 1, step: 0.01 });
    beat.dataset.field = `num:${layer}:beat`;

    const route = document.createElement('select');
    route.dataset.field = `route:${layer}`;
    const currentRoute = spec.opacityRoute?.route || '';
    route.append(blankSelect(!currentRoute));
    for (const item of MOD_ROUTES) {
      if (item.id === 'none') continue;
      route.append(option(item.id, item.label, item.id === currentRoute));
    }

    const depth = numberInput(spec.opacityRoute ? spec.opacityRoute.depth : '', { min: -1, max: 1, step: 0.01 });
    depth.dataset.field = `depth:${layer}`;

    const gate = numberInput(spec.opacityRoute ? spec.opacityRoute.gate : '', { min: 0, max: 1, step: 0.01 });
    gate.dataset.field = `gate:${layer}`;

    const clip = document.createElement('input');
    clip.type = 'text';
    clip.value = spec.clip || '';
    clip.dataset.field = `clip:${layer}`;
    clip.setAttribute('list', 'pack-clip-names');
    clip.spellcheck = false;
    clip.autocomplete = 'off';

    return {
      mode, opacity, blend, band, reactivity, beat, route, depth, gate, clip,
    };
  }

  function paintPackScope(pack) {
    const showing = packScopes.get(tab) || 'active';
    const filter = editor.querySelector('.pack-tab-filter');
    filter.hidden = tab === 'view';
    for (const btn of filter.querySelectorAll('[data-pack-scope]')) {
      btn.setAttribute('aria-pressed', btn.dataset.packScope === showing ? 'true' : 'false');
    }
    const grid = body.querySelector('.pack-grid');
    if (!grid || !pack) return;
    const active = showing === 'active';
    const cols = activeColumns(pack);
    const layersOn = LAYERS.filter((id) => !active || layerConnected(pack[id]));
    const visibleCount = GRID_COLS.filter(([id, , sound]) => !active || (sound && cols.has(id))).length;
    grid.style.gridTemplateColumns = visibleCount
      ? `32px repeat(${visibleCount}, minmax(0, 1fr))`
      : '32px';
    for (const node of grid.querySelectorAll('[data-col]')) {
      const sound = GRID_COLS.find((col) => col[0] === node.dataset.col)?.[2];
      node.hidden = active && (!sound || !cols.has(node.dataset.col));
    }
    for (const row of grid.querySelectorAll('[data-layer]')) {
      row.hidden = active && !layersOn.includes(row.dataset.layer);
    }
    const empty = body.querySelector('.pack-grid-empty');
    if (empty) empty.hidden = !active || layersOn.length > 0;
    const strobe = body.querySelector('.pack-strobe');
    if (strobe) strobe.hidden = active && !strobeConnected(pack.grade);
  }

  function buildPack(slot) {
    body.replaceChildren();
    const pack = draftPack(slot);
    if (!pack) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No pack is stored for this button.';
      body.append(empty);
      paintFooter([], null);
      paintPackScope(null);
      return;
    }

    const clips = document.createElement('datalist');
    clips.id = 'pack-clip-names';
    clips.replaceChildren(...clipNames().map((name) => option(name, name)));

    const grid = document.createElement('div');
    grid.className = 'pack-grid';
    grid.append(document.createElement('span'));
    for (const [id, label] of GRID_COLS) {
      const head = document.createElement('span');
      head.className = 'pack-col';
      head.dataset.col = id;
      head.textContent = label;
      grid.append(head);
    }
    for (const id of LAYERS) {
      const spec = pack[id] || {};
      const name = document.createElement('span');
      name.className = 'pack-layer-name';
      name.dataset.layer = id;
      name.textContent = id;
      grid.append(name);
      const controls = layerCells(id, spec);
      for (const [col] of GRID_COLS) {
        const node = cell(col, controls[col]);
        node.dataset.layer = id;
        grid.append(node);
      }
    }

    const empty = document.createElement('p');
    empty.className = 'pack-grid-empty hint';
    empty.hidden = true;
    empty.textContent = 'No sound connections on this pack.';

    const strobe = document.createElement('div');
    strobe.className = 'pack-strobe';
    const strobeName = document.createElement('span');
    strobeName.textContent = 'Strobe';
    const amount = numberInput(pack.grade?.strobe ?? 0, { min: 0, max: 1, step: 0.01 });
    amount.dataset.field = 'strobe';
    amount.setAttribute('aria-label', 'Strobe amount');
    const source = document.createElement('select');
    source.dataset.field = 'strobeSrc';
    source.setAttribute('aria-label', 'Strobe source');
    const src = pack.grade?.strobeSrc ?? 0;
    STROBE_SRC.forEach((label, index) => source.append(option(String(index), label, index === src)));
    strobe.append(strobeName, amount, source);

    const actions = document.createElement('div');
    actions.className = 'pack-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.act = 'save';
    save.textContent = 'Save';
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.dataset.act = 'revert';
    revert.textContent = 'Back to last save';
    const fire = document.createElement('button');
    fire.type = 'button';
    fire.dataset.act = 'launch';
    fire.textContent = 'Launch';
    fire.title = 'Send the saved pack to the desk. Edits stay in this window until Save.';
    actions.append(save, revert, fire);
    body.append(clips, grid, empty, strobe, actions);
    paintPackScope(pack);
    paintPackFooter(slot);
  }

  function applyField(pack, input) {
    const key = input.dataset.field || '';
    const text = input.value;
    const empty = text.trim() === '';
    const num = empty ? null : Number(text);
    if (key === 'scene') {
      pack.scene = text;
      return;
    }
    if (key === 'strobe' || key === 'strobeSrc') {
      pack.grade = { ...(pack.grade || {}) };
      if (key === 'strobe') pack.grade.strobe = num == null || Number.isNaN(num) ? 0 : num;
      else pack.grade.strobeSrc = empty ? 0 : Number(text);
      return;
    }
    const [kind, layer, rest] = key.split(':');
    const spec = pack[layer];
    if (!spec) return;
    if (kind === 'mode') {
      if (spec.mode === text) return;
      spec.mode = text;
      return;
    }
    if (kind === 'num') {
      if (num == null || Number.isNaN(num)) delete spec[rest];
      else spec[rest] = num;
      return;
    }
    if (kind === 'pick') {
      if (empty) delete spec[rest];
      else spec[rest] = Number(text);
      return;
    }
    if (kind === 'clip') {
      spec.clip = text;
      return;
    }
    if (kind === 'route') {
      if (empty) {
        spec.opacityRoute = null;
        return;
      }
      const depth = Number(body.querySelector(`[data-field="depth:${layer}"]`)?.value);
      const gate = Number(body.querySelector(`[data-field="gate:${layer}"]`)?.value);
      spec.opacityRoute = {
        key: 'opacity',
        route: text,
        depth: Number.isFinite(depth) ? depth : (spec.opacityRoute?.depth ?? 0.5),
        gate: Number.isFinite(gate) ? gate : (spec.opacityRoute?.gate ?? 0),
      };
      return;
    }
    if (kind === 'depth' || kind === 'gate') {
      if (!spec.opacityRoute || num == null || Number.isNaN(num)) return;
      spec.opacityRoute[kind] = num;
    }
  }

  function deskWires() {
    const live = desk?.() || {};
    const layers = live.layers || [];
    const mods = live.mods;
    const liveParams = live.params || params;
    const rows = [];
    for (const layer of layers) {
      const band = layer.get('audioBind') | 0;
      const reactivity = Number(layer.get('reactivity')) || 0;
      const beat = Number(layer.get('beatSync')) || 0;
      const listening = band !== 4 && reactivity > 0;
      const look = MODE_LABELS[MODES.indexOf(layer.mode)] || layer.mode;
      rows.push({
        group: `Layer ${layer.id} · ${look}`,
        text: `Band ${BAND_LABELS[band] || 'Off'}`,
        on: listening,
      });
      rows.push({
        group: `Layer ${layer.id} · ${look}`,
        text: `Reactivity ${trimNum(reactivity)}`,
        on: listening,
      });
      rows.push({
        group: `Layer ${layer.id} · ${look}`,
        text: `Beat Sync ${trimNum(beat)}`,
        on: beat > 0,
      });
      const opacityRoute = mods?.get(layerParam(layer.id, 'opacity')) || { route: 'none', depth: 0, gate: 0 };
      const opacityOn = !!(opacityRoute.route && opacityRoute.route !== 'none' && opacityRoute.depth !== 0);
      rows.push({
        group: `Layer ${layer.id} · ${look}`,
        text: opacityOn
          ? `Opacity ${routeLabel(opacityRoute.route)} · depth ${trimNum(opacityRoute.depth)} · gate ${trimNum(opacityRoute.gate)}`
          : 'Opacity measure None',
        on: opacityOn,
      });
      if (!mods?.lanes) continue;
      for (const [id, lane] of mods.lanes) {
        const def = liveParams.defs?.get(id);
        if (def?.layer !== layer.id || def.key === 'opacity') continue;
        const label = def.friendlyLabel || def.label || def.key;
        const routed = lane.route && lane.route !== 'none';
        rows.push({
          group: `Layer ${layer.id} · ${look}`,
          text: routed
            ? `${label} ${routeLabel(lane.route)} · depth ${trimNum(lane.depth)} · gate ${trimNum(lane.gate)}`
            : `${label} None`,
          on: false,
        });
      }
    }
    if (mods?.lanes) {
      for (const [id, lane] of mods.lanes) {
        const def = liveParams.defs?.get(id);
        if (!def || def.layer || id === 'strobe') continue;
        const label = def.friendlyLabel || def.label || def.key || id;
        const routed = lane.route && lane.route !== 'none';
        rows.push({
          group: 'Composition',
          text: routed
            ? `${label} ${routeLabel(lane.route)} · depth ${trimNum(lane.depth)} · gate ${trimNum(lane.gate)}`
            : `${label} None`,
          on: false,
        });
      }
    }
    const strobe = Number(liveParams.get('strobe')) || 0;
    const srcIndex = liveParams.get('strobeSrc') | 0;
    const src = STROBE_SRC[srcIndex] || 'Manual';
    rows.push({
      group: 'Composition',
      text: strobe > 0 ? `Strobe ${Math.round(strobe * 100)}% on ${src}` : 'Strobe off',
      on: strobe > 0 && (srcIndex === 1 || srcIndex === 2),
    });
    return rows;
  }

  function buildView() {
    body.replaceChildren();
    const filter = document.createElement('div');
    filter.className = 'pack-filter';
    for (const [id, label] of [['active', 'Active'], ['all', 'All']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.scope = id;
      btn.textContent = label;
      btn.setAttribute('aria-pressed', scope === id ? 'true' : 'false');
      filter.append(btn);
    }
    const wires = document.createElement('ul');
    wires.className = 'pack-wires';
    const rows = deskWires().filter((row) => scope === 'all' || row.on);
    let group = '';
    for (const row of rows) {
      if (row.group !== group) {
        group = row.group;
        const head = document.createElement('li');
        head.className = 'pack-wire-head';
        head.textContent = group;
        wires.append(head);
      }
      const item = document.createElement('li');
      item.className = row.on ? 'pack-wire' : 'pack-wire is-off';
      item.textContent = row.text;
      wires.append(item);
    }
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'pack-wire is-off';
      empty.textContent = 'No wires are on.';
      wires.append(empty);
    }
    body.append(filter, wires);
    const live = desk?.() || {};
    paintFooter(deskSigns({
      params: live.params || params,
      mods: live.mods,
      layers: live.layers || [],
      audible: live.audible,
    }), null);
  }

  function markTabs() {
    for (const btn of editor.querySelectorAll('[data-tab]')) {
      const on = btn.dataset.tab === tab;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
    }
  }

  function showTab(next) {
    tab = next;
    liveKey = '';
    markTabs();
    if (tab === 'view') {
      editor.querySelector('.pack-tab-filter').hidden = true;
      buildView();
    } else buildPack(tab);
  }

  function openPack(slot) {
    if (!PACK_SLOTS.some((item) => item.id === slot)) return;
    if (!storedPack(slot) && !loose.has(slot)) loose.set(slot, improvisePack(slot));
    const wasHidden = editor.hidden;
    editor.hidden = false;
    if (wasHidden || tab !== slot) showTab(slot);
    else markTabs();
    paintButtons();
  }

  function closeEditor() {
    editor.hidden = true;
  }

  function saveDraft() {
    const stored = storedPack(tab);
    const draft = draftPack(tab);
    if (!draft || tab === 'view') return;
    const label = PACK_SLOTS.find((slot) => slot.id === tab)?.label || draft.name;
    const saved = normalizePack({
      ...draft,
      id: stored?.id || draft.id,
      assign: tab,
      name: stored?.name || label,
    });
    const next = stored
      ? packs().map((pack) => (pack.id === stored.id ? saved : pack))
      : packs().concat(saved);
    loose.delete(tab);
    project.setPacks(next);
    undoDrafts.delete(tab);
    drafts.set(tab, structuredClone(storedPack(tab)));
    paint();
    buildPack(tab);
  }

  function revertDraft() {
    const stored = storedPack(tab);
    if (!stored || tab === 'view') return;
    undoDrafts.delete(tab);
    drafts.set(tab, structuredClone(stored));
    buildPack(tab);
  }

  function applySuggestion() {
    const draft = draftPack(tab);
    if (!draft || !pendingFix || tab === 'view') return;
    undoDrafts.set(tab, structuredClone(draft));
    pendingFix.apply(draft);
    buildPack(tab);
  }

  function undoSuggestion() {
    const previous = undoDrafts.get(tab);
    if (!previous || tab === 'view') return;
    drafts.set(tab, previous);
    undoDrafts.delete(tab);
    buildPack(tab);
  }

  body.addEventListener('input', (event) => {
    const pack = draftPack(tab);
    const input = event.target;
    if (!pack || tab === 'view' || !input?.dataset?.field) return;
    applyField(pack, input);
    paintPackFooter(tab);
  });
  body.addEventListener('change', (event) => {
    const pack = draftPack(tab);
    const input = event.target;
    if (!pack || tab === 'view' || !input?.dataset?.field) return;
    applyField(pack, input);
    paintPackFooter(tab);
    paintPackScope(pack);
  });

  editor.addEventListener('click', (event) => {
    if (event.target === editor) {
      closeEditor();
      return;
    }
    const nextTab = event.target.closest?.('[data-tab]')?.dataset.tab;
    if (nextTab) {
      showTab(nextTab);
      return;
    }
    const packScope = event.target.closest?.('[data-pack-scope]')?.dataset.packScope;
    if (packScope && tab !== 'view') {
      packScopes.set(tab, packScope);
      paintPackScope(draftPack(tab));
      return;
    }
    const nextScope = event.target.closest?.('[data-scope]')?.dataset.scope;
    if (nextScope) {
      scope = nextScope;
      liveKey = '';
      buildView();
      return;
    }
    const act = event.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'close') closeEditor();
    if (act === 'save') saveDraft();
    if (act === 'revert') revertDraft();
    if (act === 'apply') applySuggestion();
    if (act === 'undo-apply') undoSuggestion();
    if (act === 'launch' && tab !== 'view') {
      const pack = indicatedPack(tab);
      if (pack) launch(tab, pack);
    }
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditor();
  });

  function runPack(slot) {
    let pack = storedPack(slot);
    if (!pack) {
      if (!loose.has(slot)) loose.set(slot, improvisePack(slot));
      pack = loose.get(slot);
    }
    if (pack) launch(slot, pack);
    paint();
  }

  for (const slot of PACK_SLOTS) {
    const btn = $(`pack-${slot.id}`);
    if (!btn) continue;
    let timer = 0;
    let held = false;
    const clearHold = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      btn.classList.remove('is-holding');
    };
    btn.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      held = false;
      clearHold();
      btn.classList.add('is-holding');
      try { btn.setPointerCapture(event.pointerId); } catch { /* synthetic press */ }
      timer = window.setTimeout(() => {
        timer = 0;
        held = true;
        btn.classList.remove('is-holding');
        runPack(slot.id);
      }, PACK_HOLD_MS);
    });
    btn.addEventListener('pointerup', () => {
      if (timer) clearHold();
    });
    btn.addEventListener('pointercancel', () => {
      held = false;
      clearHold();
    });
    btn.addEventListener('dblclick', (event) => {
      event.preventDefault();
      held = true;
      clearHold();
      openPack(slot.id);
    });
    btn.addEventListener('click', (event) => {
      if (!held) return;
      event.preventDefault();
      held = false;
    });
  }

  refreshLive = () => {
    if (editor.hidden || tab !== 'view') return;
    const rows = deskWires();
    const live = desk?.() || {};
    const lines = signLines(deskSigns({
      params: live.params || params,
      mods: live.mods,
      layers: live.layers || [],
      audible: live.audible,
    }));
    const key = `${scope}|${rows.map((row) => `${row.on ? 1 : 0}:${row.text}`).join('|')}|${lines.join('|')}`;
    if (key === liveKey) return;
    liveKey = key;
    buildView();
  };

  repaint = () => {
    paint();
    if (!editor.hidden && tab !== 'view') {
      const stored = storedPack(tab);
      const draft = drafts.get(tab);
      if (stored && draft && stored.id === draft.id) return;
      drafts.delete(tab);
      buildPack(tab);
    }
  };
  paint();
}
