// Global Media Library. Files live in the app-data folder (or, in the browser
// preview, in the IndexedDB cache). A project only keeps the names it pulls in.

import { IS_TAURI, invoke } from '../ipc.js';
import { isTauri } from '../output/OutputWindow.js';
import { queueAudioPrep, queueMediaPrep } from './mediaPrep.js';
import { frameIsBlank } from './thumbnail.js';
import { applyMediaSink } from '../audio/outputSink.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|wmv|flv)$/i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|flac|aiff|aif|m4a)$/i;
const SOURCE_KEY = 'vj.mediaSource';
const SCALE_KEY = 'vj.galleryScale';
const GALLERY_SCALES = ['small', 'medium', 'large'];
const SCALE_ALIAS = { compact: 'small', small: 'small', medium: 'medium', large: 'large' };
const SOURCE_EMPTY = {
  all: 'No media stored yet. Drop a video or image above.',
  video: 'No videos in the library yet.',
  image: 'No images in the library yet.',
  fetch: 'No fetched clips yet. Use Live Text-to-Visual to download a loop.',
  audio: 'No audio stored yet. Drop a track above, or download stock audio.',
  brand: 'No brand assets yet. Tick Brand asset, then add a file.',
};

function readSources() {
  try {
    const raw = JSON.parse(localStorage.getItem(SOURCE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function rememberMediaSource(name, source) {
  if (!name || (source !== 'fetch' && source !== 'user' && source !== 'audio')) return;
  const map = readSources();
  if (map[name] === source) return;
  map[name] = source;
  try { localStorage.setItem(SOURCE_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

function isAudioRow(row) {
  return AUDIO_EXT.test(row?.name || '') || AUDIO_EXT.test(row?.path || '');
}

function rowKind(row) {
  if (isAudioRow(row) || row.kind === 'audio') return 'audio';
  if (IMAGE_EXT.test(row?.name || '') || IMAGE_EXT.test(row?.path || '')) return 'image';
  return 'video';
}

function kindLabel(kind) {
  if (kind === 'audio') return 'Audio';
  if (kind === 'image') return 'Image';
  return 'Video';
}

export function bindGlobalLibrary({ library, inBin, onAdd, onDeleted, projectSnapshot, showToast, sourceDir, prepareDir, projectMediaDirs }) {
  const modal = document.getElementById('global-library');
  const grid = document.getElementById('prep-grid');
  const empty = document.getElementById('prep-gallery-empty');
  const drop = document.getElementById('global-drop');
  const send = document.getElementById('prep-send');
  const thumbs = new Map();
  const selected = new Set();
  const tagInput = document.getElementById('prep-tag-input');
  const tagAdd = document.getElementById('prep-tag-add');
  const tagFilters = document.getElementById('prep-tag-filters');
  let mediaTags = readMediaTags();
  let tagFilter = '';
  let sourceFilter = 'all';
  let query = '';
  let thumbObserver = null;
  const block = document.getElementById('global-delete');
  const preview = document.createElement('video');
  preview.className = 'gallery-preview';
  preview.muted = true;
  preview.loop = true;
  preview.playsInline = true;
  preview.preload = 'auto';
  applyMediaSink(preview);
  let previewUrl = '';
  let previewToken = 0;
  let thumbChain = Promise.resolve();
  let open = false;
  let pendingDelete = null;
  let latest = [];

  function close() {
    open = false;
    modal.hidden = true;
  }

  async function catalog() {
    const disk = [];
    if (IS_TAURI) {
      try {
        const beside = typeof projectMediaDirs === 'function' ? await projectMediaDirs() : [];
        const dirs = Array.isArray(beside) ? beside.filter(Boolean) : [];
        if (dirs.length) {
          const seenBeside = new Set();
          for (const dir of dirs) {
            const rows = await invoke('list_dir_media', { dir });
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
              const key = String(row?.name || '').toLowerCase();
              if (!key || seenBeside.has(key)) continue;
              seenBeside.add(key);
              disk.push(row);
            }
          }
        } else {
          const rows = await invoke('list_global_media', { saveDir: stockSaveDir() });
          if (Array.isArray(rows)) disk.push(...rows);
          const source = typeof sourceDir === 'function' ? await sourceDir() : '';
          if (source) {
            const prepared = await invoke('list_dir_media', { dir: source });
            if (Array.isArray(prepared)) disk.push(...prepared);
          }
        }
      } catch (err) {
        showToast?.(err?.message || 'Could not read Media Manager', true);
      }
    }
    const seen = new Set(disk.map((row) => row.name));
    const local = [];
    for (const name of library.names) {
      if (seen.has(name)) continue;
      const item = library.mediaItem(name);
      seen.add(name);
      local.push({
        name,
        path: '',
        thumbnail: item?.thumbnail || '',
        url: item?.url || '',
      });
    }
    const audio = [];
    try {
      const stored = await library.cache.entries('audio');
      for (const row of stored) {
        const name = row.file?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        audio.push({ name, path: '', thumbnail: '', kind: 'audio' });
      }
    } catch { /* the audio cache is optional */ }
    return [...disk, ...local, ...audio];
  }

  function rowSource(row) {
    if (isAudioRow(row) || row.kind === 'audio') return 'audio';
    const saved = readSources()[row.name];
    if (saved === 'fetch' || saved === 'audio') return saved;
    if (row.url) return 'fetch';
    return 'user';
  }

  function paintSend() {
    const waiting = [...selected].filter((name) => !inBin(name));
    if (send) {
      send.disabled = waiting.length === 0;
      send.textContent = waiting.length ? `Add ${waiting.length} to Project` : 'Add to Project';
    }
  }

  function toggleSelect(name) {
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    paint(latest);
  }

  function stopPreview() {
    previewToken += 1;
    preview.pause();
    preview.remove();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }
    preview.removeAttribute('src');
  }

  async function startPreview(card, row) {
    if (isAudioRow(row) || IMAGE_EXT.test(row.name) || IMAGE_EXT.test(row.path || '')) return;
    const token = ++previewToken;
    preview.pause();
    preview.remove();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }
    const src = await previewSrc(row);
    if (!src || token !== previewToken || !card.isConnected || !card.matches(':hover')) {
      if (previewUrl && token === previewToken) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
      return;
    }
    preview.src = src;
    card.append(preview);
    preview.play().catch(() => {});
  }

  async function previewSrc(row) {
    if (row.path && isTauri()) {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      return convertFileSrc(row.path);
    }
    const item = library.mediaItem?.(row.name);
    if (item?.url) return item.url;
    if (item?.file) {
      previewUrl = URL.createObjectURL(item.file);
      return previewUrl;
    }
    return '';
  }

  function rowVisible(row) {
    const branded = tagsFor(row.name).some((tag) => tag.toLowerCase() === 'brand');
    if (sourceFilter === 'brand' && !branded) return false;
    if (sourceFilter === 'fetch' && rowSource(row) !== 'fetch') return false;
    if ((sourceFilter === 'video' || sourceFilter === 'audio' || sourceFilter === 'image') && rowKind(row) !== sourceFilter) return false;
    if (tagFilter && !tagsFor(row.name).some((tag) => tag.toLowerCase() === tagFilter.toLowerCase())) return false;
    if (!query) return true;
    const hay = `${row.name} ${tagsFor(row.name).join(' ')} ${kindLabel(rowKind(row))}`.toLowerCase();
    return hay.includes(query);
  }

  function paint(rows) {
    latest = rows;
    const live = new Set(rows.map((row) => row.name));
    for (const name of [...selected]) if (!live.has(name)) selected.delete(name);
    const visible = rows.filter((row) => rowVisible(row));
    stopPreview();
    grid.innerHTML = '';
    if (empty) {
      empty.hidden = visible.length > 0;
      const noneOf = SOURCE_EMPTY[sourceFilter] || SOURCE_EMPTY.all;
      const filtered = query
        ? 'No clips match that search.'
        : (tagFilter ? `No clips tagged ${tagFilter}.` : noneOf);
      empty.textContent = rows.length && !visible.length ? filtered : noneOf;
    }
    for (const row of visible) {
      const card = document.createElement('div');
      const present = inBin(row.name);
      card.className = 'global-card';
      card.classList.toggle('in-bin', present);
      card.classList.toggle('is-selected', selected.has(row.name));
      card.tabIndex = 0;
      card.role = 'button';
      card.title = present ? `${row.name} is in this project` : `Select ${row.name}`;
      card.setAttribute('aria-pressed', selected.has(row.name) ? 'true' : 'false');
      const audio = isAudioRow(row) || row.kind === 'audio';
      const kind = rowKind(row);
      const img = document.createElement('img');
      img.className = 'global-thumb';
      img.alt = '';
      img.hidden = true;
      const cached = audio ? '' : (row.thumbnail || thumbs.get(row.path || row.name) || '');
      if (cached) img._thumb = cached;
      const label = document.createElement('span');
      label.className = 'global-name';
      label.textContent = present ? `${row.name} · in project` : row.name;
      const meta = document.createElement('i');
      meta.className = 'global-meta';
      const fetched = rowSource(row) === 'fetch';
      const branded = tagsFor(row.name).some((tag) => tag.toLowerCase() === 'brand');
      meta.textContent = branded ? 'Brand' : (fetched ? 'Fetched' : kindLabel(kind));
      meta.title = branded ? 'Brand asset' : (fetched && kind !== 'audio' ? `Fetched ${kindLabel(kind).toLowerCase()}` : kindLabel(kind));
      if (branded) card.classList.add('is-brand');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'global-delete';
      remove.textContent = '\u00d7';
      remove.title = `Delete ${row.name}`;
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestDelete(row);
      });
      const tagged = tagsFor(row.name);
      const tags = document.createElement('span');
      tags.className = 'global-tags';
      tags.textContent = tagged.join(' · ');
      tags.title = tagged.join(', ');
      if (!tagged.length) tags.hidden = true;
      card.dataset.name = row.name;
      card.dataset.path = row.path || '';
      if (audio) {
        card.classList.add('is-audio');
        const mark = document.createElement('i');
        mark.className = 'audio-mark';
        mark.textContent = '\u266A';
        mark.title = 'Audio';
        card.append(meta, mark, tags, label, remove);
      } else {
        card.append(meta, img, tags, label, remove);
      }
      card.addEventListener('click', () => toggleSelect(row.name));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') toggleSelect(row.name);
      });
      card.addEventListener('pointerenter', () => startPreview(card, row));
      card.addEventListener('pointerleave', () => {
        if (preview.parentElement === card) stopPreview();
      });
      grid.append(card);
      if (!audio) watchThumb(card);
    }
    paintSend();
    paintTagFilters();
  }

  function tagsFor(name) {
    return Array.isArray(mediaTags[name]) ? mediaTags[name] : [];
  }

  function writeMediaTags() {
    try {
      if (!Object.keys(mediaTags).length) localStorage.removeItem(MEDIA_TAG_KEY);
      else localStorage.setItem(MEDIA_TAG_KEY, JSON.stringify(mediaTags));
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('vj-media-tags'));
  }

  function knownTag(value) {
    const next = cleanTag(value);
    const key = next.toLowerCase();
    if (!key) return '';
    for (const list of Object.values(mediaTags)) {
      const found = list.find((tag) => tag.toLowerCase() === key);
      if (found) return found;
    }
    return next;
  }

  function collectedTags() {
    const seen = new Map();
    for (const row of latest) {
      for (const tag of tagsFor(row.name)) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()];
  }

  function paintTagFilters() {
    if (!tagFilters) return;
    const tags = collectedTags();
    if (tagFilter && !tags.some((tag) => tag.toLowerCase() === tagFilter.toLowerCase())) tagFilter = '';
    tagFilters.hidden = tags.length === 0;
    tagFilters.innerHTML = '';
    for (const tag of tags) {
      const on = tag.toLowerCase() === tagFilter.toLowerCase();
      const chip = document.createElement('div');
      chip.className = 'prep-tag';
      chip.classList.toggle('is-on', on);
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'prep-tag-name';
      name.textContent = tag;
      name.title = on ? `Showing ${tag}` : `Show clips tagged ${tag}`;
      name.addEventListener('click', () => {
        tagFilter = on ? '' : tag;
        paint(latest);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'prep-tag-x';
      remove.textContent = '\u00d7';
      remove.title = `Remove ${tag}`;
      remove.addEventListener('click', () => clearTag(tag));
      chip.append(name, remove);
      tagFilters.append(chip);
    }
  }

  function applyTag() {
    const tag = knownTag(tagInput?.value || '');
    if (!tag) return;
    if (!selected.size) {
      showToast?.('Select clips, then tag them');
      return;
    }
    const wantsBrand = tag.toLowerCase() === 'brand' || tag.toLowerCase() === 'logo';
    for (const name of selected) {
      const list = tagsFor(name).slice();
      if (!list.some((item) => item.toLowerCase() === tag.toLowerCase())) list.push(tag);
      if (wantsBrand && !list.some((item) => item.toLowerCase() === 'brand')) list.push('brand');
      mediaTags[name] = list.slice(0, 8);
    }
    writeMediaTags();
    if (wantsBrand) {
      for (const name of selected) {
        const row = latest.find((item) => item.name === name);
        window.dispatchEvent(new CustomEvent('vj-brand-ready', { detail: { name, path: row?.path || '' } }));
      }
    }
    if (tagInput) tagInput.value = '';
    if (tagAdd) tagAdd.disabled = true;
    paint(latest);
  }

  function clearTag(tag) {
    const key = tag.toLowerCase();
    for (const name of Object.keys(mediaTags)) {
      const list = tagsFor(name).filter((item) => item.toLowerCase() !== key);
      if (list.length) mediaTags[name] = list;
      else delete mediaTags[name];
    }
    if (tagFilter.toLowerCase() === key) tagFilter = '';
    writeMediaTags();
    paint(latest);
  }

  function watchThumb(card) {
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          thumbObserver.unobserve(entry.target);
          revealThumb(entry.target);
        }
      }, { root: grid.closest('.prep-gallery-scroll'), rootMargin: '240px 0px' });
    }
    thumbObserver.observe(card);
  }

  function revealThumb(card) {
    const img = card.querySelector('img.global-thumb');
    if (!img || img.dataset.ready === '1') return;
    if (img._thumb) {
      img.src = img._thumb;
      img.hidden = false;
      img.dataset.ready = '1';
      return;
    }
    const path = card.dataset.path || '';
    if (path) queueThumb({ path, name: card.dataset.name || '' }, img);
  }

  function queueThumb(row, img) {
    thumbChain = thumbChain.then(() => captureSquare(row.path).then((url) => {
      if (!url) return;
      thumbs.set(row.path, url);
      if (!img.isConnected) return;
      img.src = url;
      img.hidden = false;
      img.dataset.ready = '1';
    }).catch(() => {}));
  }

  async function render() {
    const rows = await catalog();
    paint(rows);
  }

  function sendSelected() {
    const picked = latest.filter((row) => selected.has(row.name) && !inBin(row.name));
    if (!picked.length) {
      showToast?.('Select clips that are not already in this project');
      return;
    }
    let sent = 0;
    for (const row of picked) {
      if (onAdd(row, { quiet: true })) sent += 1;
    }
    selected.clear();
    paint(latest);
    if (!sent) {
      showToast?.('Those clips are already in this project');
      return;
    }
    showToast?.(sent === 1 ? `Added ${picked[0].name} to the project` : `Added ${sent} clips to the project`);
  }

  function show() {
    open = true;
    modal.hidden = false;
    render();
  }

  function ingest(files, event, { play = false } = {}) {
    let queued = 0;
    for (const file of files) {
      const name = file.name || 'media';
      const video = file.type.startsWith('video/') || VIDEO_EXT.test(name);
      const image = file.type.startsWith('image/') || IMAGE_EXT.test(name);
      const audioFile = file.type.startsWith('audio/') || AUDIO_EXT.test(name);
      if (audioFile) {
        const path = pathFrom(file, event);
        if (isTauri()) {
          queueAudioPrep(name, path, path ? null : file, { play });
        } else {
          library.cacheAudio(file);
          rememberMediaSource(name, 'audio');
          window.dispatchEvent(new CustomEvent('vj-audio-ready', {
            detail: { name, file, play },
          }));
        }
        queued += 1;
        continue;
      }
      if (!video && !image) continue;
      rememberMediaSource(name, 'user');
      const path = pathFrom(file, event);
      if (isTauri() && video) {
        queueMediaPrep(name, path, path ? null : file, { brand: brandUpload() });
        queued += 1;
        continue;
      }
      if (isTauri() && image && path) {
        const asBrand = brandUpload();
        const prepared = typeof prepareDir === 'function' ? prepareDir() : (typeof sourceDir === 'function' ? sourceDir() : Promise.resolve(''));
        prepared.then((saveDir) => invoke('copy_into_global_media', { inputPath: path, saveDir: saveDir || '' }))
          .then((saved) => {
            const leaf = String(saved || path).split(/[\\/]/).pop() || name;
            if (asBrand) {
              addMediaTag(leaf, 'brand');
              window.dispatchEvent(new CustomEvent('vj-brand-ready', { detail: { name: leaf, path: saved || path } }));
            }
            window.dispatchEvent(new CustomEvent('vj-global-media'));
          })
          .catch((err) => showToast?.(err?.message || 'Could not save that image', true));
        queued += 1;
        continue;
      }
      library.add([file]);
      if (brandUpload()) {
        addMediaTag(name, 'brand');
        window.dispatchEvent(new CustomEvent('vj-brand-ready', { detail: { name, path: '' } }));
      }
      queued += 1;
    }
    if (queued && !isTauri()) render();
    return queued;
  }

  async function choose() {
    if (isTauri()) {
      const { open: pick } = await import('@tauri-apps/plugin-dialog');
      const picked = await pick({
        multiple: true,
        title: 'Media for Media Manager',
        filters: [{
          name: 'Media',
          extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'aiff', 'aif', 'm4a', 'ogg', 'flac'],
        }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      for (const path of paths) {
        const name = String(path).split(/[\\/]/).pop() || 'media';
        if (VIDEO_EXT.test(name) || IMAGE_EXT.test(name)) rememberMediaSource(name, 'user');
        if (AUDIO_EXT.test(name)) queueAudioPrep(name, path, null);
        else if (VIDEO_EXT.test(name)) queueMediaPrep(name, path, null, { brand: brandUpload() });
        else if (IMAGE_EXT.test(name)) {
        const saveDir = typeof prepareDir === 'function' ? await prepareDir() : (typeof sourceDir === 'function' ? await sourceDir() : '');
        const saved = await invoke('copy_into_global_media', { inputPath: path, saveDir: saveDir || '' });
        const leaf = String(saved || path).split(/[\\/]/).pop() || name;
        if (brandUpload()) {
          addMediaTag(leaf, 'brand');
          window.dispatchEvent(new CustomEvent('vj-brand-ready', { detail: { name: leaf, path: saved || path } }));
        }
        }
      }
      window.dispatchEvent(new CustomEvent('vj-global-media'));
      showToast?.('Saving to Media Manager');
      return;
    }
    document.getElementById('media-files').click();
  }

  document.getElementById('global-close').addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  function hideBlock() {
    pendingDelete = null;
    block.hidden = true;
  }

  function showBlock(row, uses) {
    const names = [...new Set(uses.map((item) => item.project).filter(Boolean))];
    const lead = names.length ? names.join(', ') : 'a saved project';
    document.getElementById('global-delete-lead').textContent = `Cannot delete: This file is currently used in ${lead}.`;
    const list = document.getElementById('global-delete-uses');
    list.innerHTML = '';
    for (const item of uses) {
      const li = document.createElement('li');
      const places = Array.isArray(item.places) && item.places.length ? item.places.join(', ') : 'Project Media';
      li.textContent = `${item.project}: ${places}`;
      list.append(li);
    }
    document.getElementById('global-delete-note').textContent = `Delete anyway and ${lead} will keep a missing file named ${row.name}.`;
    block.hidden = false;
  }

  async function finishDelete(row, uses) {
    thumbs.delete(row.path || row.name);
    const names = [...new Set((uses || []).map((item) => item.project).filter(Boolean))];
    if (names.length) showToast?.(`Deleted ${row.name}. Missing file in ${names.join(', ')}.`);
    else showToast?.(`Deleted ${row.name}`);
    await render();
  }

  async function requestDelete(row, force = false) {
    const snapshot = projectSnapshot?.() || { name: 'This project', path: '', document: '{}' };
    if (force) await onDeleted?.(row.name);
    let outcome;
    try {
      outcome = await checkDelete(row, snapshot, force);
    } catch (err) {
      showToast?.(err?.message || String(err) || 'Could not delete that file', true);
      return;
    }
    if (!outcome?.deleted) {
      const uses = outcome?.uses || [];
      if (!uses.length) {
        showToast?.('Could not delete that file', true);
        return;
      }
      pendingDelete = row;
      showBlock(row, uses);
      return;
    }
    hideBlock();
    if (!force) await onDeleted?.(row.name);
    await finishDelete(row, outcome.uses || []);
  }

  document.getElementById('global-delete-cancel').addEventListener('click', hideBlock);
  document.getElementById('global-delete-force').addEventListener('click', () => {
    if (pendingDelete) requestDelete(pendingDelete, true);
  });
  block.addEventListener('click', (event) => {
    if (event.target === block) hideBlock();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!block.hidden) {
      hideBlock();
      return;
    }
    if (open) close();
  });
  window.addEventListener('vj-global-media', () => render());
  window.addEventListener('vj-media-tags', () => {
    mediaTags = readMediaTags();
    paint(latest);
  });
  library.onChange(() => render());
  send?.addEventListener('click', sendSelected);
  tagInput?.addEventListener('input', () => {
    if (tagAdd) tagAdd.disabled = !cleanTag(tagInput.value);
  });
  tagInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyTag();
  });
  tagAdd?.addEventListener('click', applyTag);
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    drop.classList.remove('over');
    const count = ingest([...(event.dataTransfer?.files || [])], event);
    if (count && isTauri()) showToast?.('Saving to Media Manager');
  });
  drop.addEventListener('click', () => choose());
  document.getElementById('global-upload').addEventListener('click', (event) => {
    event.stopPropagation();
    choose();
  });

  render();
  const prep = document.getElementById('media-prep');
  function applyScale(scale) {
    const next = GALLERY_SCALES.includes(SCALE_ALIAS[scale]) ? SCALE_ALIAS[scale] : 'medium';
    prep?.setAttribute('data-scale', next);
    modal?.setAttribute('data-scale', next);
    for (const button of document.querySelectorAll('[data-gallery-scale]')) {
      const on = button.dataset.galleryScale === next;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    try { localStorage.setItem(SCALE_KEY, next); } catch { /* private mode */ }
  }
  let savedScale = 'medium';
  try { savedScale = localStorage.getItem(SCALE_KEY) || 'medium'; } catch { /* ignore */ }
  applyScale(savedScale);
  for (const button of document.querySelectorAll('[data-gallery-scale]')) {
    button.addEventListener('click', () => applyScale(button.dataset.galleryScale));
  }
  function applySource(source) {
    sourceFilter = SOURCE_EMPTY[source] ? source : 'all';
    for (const button of document.querySelectorAll('[data-gallery-source]')) {
      const on = button.dataset.gallerySource === sourceFilter;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (latest.length) paint(latest);
  }
  for (const button of document.querySelectorAll('[data-gallery-source]')) {
    button.addEventListener('click', () => applySource(button.dataset.gallerySource));
  }
  const search = document.getElementById('prep-search');
  search?.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    if (latest.length || query) paint(latest);
  });
  bindPrepSplit(prep);

  async function libraryAudio() {
    const rows = await catalog();
    return rows.filter((row) => isAudioRow(row) || row.kind === 'audio');
  }

  function showSource(source) {
    applySource(source);
    render();
  }

  return { open: show, refresh: render, ingest, close, libraryAudio, showSource };
}

const PREP_SPLIT_KEY = 'vj.prepSplit';
const PREP_INGEST_MIN = 64;
const PREP_LIBRARY_MIN = 168;

function prepZoom() {
  const z = parseFloat(getComputedStyle(document.getElementById('app')).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function clampPrepIngest(prep, px) {
  const next = Number.isFinite(px) ? px : PREP_INGEST_MIN;
  const box = prep.getBoundingClientRect();
  if (box.height < 80) return Math.round(Math.max(PREP_INGEST_MIN, next));
  const zoom = prepZoom();
  const head = prep.querySelector('.prep-head')?.getBoundingClientRect().height || 0;
  const bar = prep.querySelector('.prep-split')?.getBoundingClientRect().height || 12;
  const room = (box.height - head - bar - PREP_LIBRARY_MIN) / zoom;
  const max = Math.max(PREP_INGEST_MIN, room);
  const min = Math.min(PREP_INGEST_MIN, max);
  return Math.round(Math.min(max, Math.max(min, next)));
}

function bindPrepSplit(prep) {
  const bar = document.getElementById('prep-split');
  const ingest = prep?.querySelector('.prep-ingest');
  if (!prep || !bar || !ingest) return;
  const apply = (px, save = false) => {
    const next = clampPrepIngest(prep, px);
    prep.style.setProperty('--prep-ingest', `${next}px`);
    bar.setAttribute('aria-valuenow', String(next));
    bar.setAttribute('aria-valuemax', String(clampPrepIngest(prep, 1e6)));
    if (!save) return;
    try { localStorage.setItem(PREP_SPLIT_KEY, String(next)); } catch { /* private mode */ }
  };
  const reset = () => {
    prep.style.removeProperty('--prep-ingest');
    bar.removeAttribute('aria-valuenow');
    try { localStorage.removeItem(PREP_SPLIT_KEY); } catch { /* private mode */ }
  };
  let saved = null;
  try { saved = Number(localStorage.getItem(PREP_SPLIT_KEY)); } catch { /* ignore */ }
  if (Number.isFinite(saved) && saved > 0) apply(saved);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      const raw = prep.style.getPropertyValue('--prep-ingest');
      if (!raw || pointer) return;
      apply(parseFloat(raw));
    });
    observer.observe(prep);
  }
  let pointer = 0;
  let start = 0;
  let origin = 0;
  let lastDown = 0;
  const onMove = (event) => {
    if (event.pointerId !== pointer) return;
    apply(origin + (event.clientY - start) / prepZoom());
  };
  const onUp = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = 0;
    bar.classList.remove('dragging');
    document.body.classList.remove('prep-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    apply(parseFloat(prep.style.getPropertyValue('--prep-ingest')), true);
  };
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const now = performance.now();
    if (now - lastDown < 400) {
      lastDown = 0;
      pointer = 0;
      reset();
      return;
    }
    lastDown = now;
    event.preventDefault();
    pointer = event.pointerId;
    start = event.clientY;
    origin = ingest.getBoundingClientRect().height / prepZoom();
    bar.classList.add('dragging');
    document.body.classList.add('prep-resizing');
    try { bar.setPointerCapture(event.pointerId); } catch { /* synthetic press */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  bar.addEventListener('dblclick', reset);
  bar.addEventListener('keydown', (event) => {
    const current = ingest.getBoundingClientRect().height / prepZoom();
    if (event.key === 'ArrowUp') apply(current - 16, true);
    else if (event.key === 'ArrowDown') apply(current + 16, true);
    else if (event.key === 'Home') apply(PREP_INGEST_MIN, true);
    else if (event.key === 'Enter' || event.key === ' ') reset();
    else return;
    event.preventDefault();
  });
}

function stockSaveDir() {
  try { return localStorage.getItem('vj.stockDir')?.trim() || ''; } catch { return ''; }
}

const MEDIA_TAG_KEY = 'vj.mediaTags';

function cleanTag(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

export function mediaTagsFor(name) {
  const tags = readMediaTags()[name];
  return Array.isArray(tags) ? tags : [];
}

export function hasMediaTag(name, tag) {
  const key = cleanTag(tag).toLowerCase();
  if (!key) return false;
  return mediaTagsFor(name).some((item) => item.toLowerCase() === key);
}

export function addMediaTag(name, tag) {
  const key = String(name || '');
  const next = cleanTag(tag);
  if (!key || !next) return false;
  const all = readMediaTags();
  const list = Array.isArray(all[key]) ? all[key].slice() : [];
  if (list.some((item) => item.toLowerCase() === next.toLowerCase())) return true;
  list.push(next);
  all[key] = list.slice(0, 8);
  try {
    localStorage.setItem(MEDIA_TAG_KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  window.dispatchEvent(new CustomEvent('vj-media-tags'));
  return true;
}

function brandUpload() {
  return !!document.getElementById('prep-brand')?.checked;
}

function readMediaTags() {
  try {
    const raw = JSON.parse(localStorage.getItem(MEDIA_TAG_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [name, tags] of Object.entries(raw)) {
      const list = [];
      const seen = new Set();
      for (const tag of Array.isArray(tags) ? tags : []) {
        const next = cleanTag(tag);
        const key = next.toLowerCase();
        if (!next || seen.has(key)) continue;
        seen.add(key);
        list.push(next);
      }
      if (name && list.length) out[name] = list.slice(0, 8);
    }
    return out;
  } catch {
    return {};
  }
}

function pathFrom(file, event) {
  if (typeof file?.path === 'string' && file.path) return file.path;
  const uri = event?.dataTransfer?.getData?.('text/uri-list') || '';
  const line = uri.split(/\r?\n/).map((part) => part.trim()).find((part) => part.startsWith('file:'));
  if (!line) return '';
  try {
    const url = new URL(line);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
  } catch {
    return '';
  }
}

function paintCover(source, sw, sh) {
  const size = 80;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#070a14';
  ctx.fillRect(0, 0, size, size);
  if (sw > 0 && sh > 0) {
    const scale = Math.max(size / sw, size / sh);
    const w = sw * scale;
    const h = sh * scale;
    ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.7);
}

function waitMedia(el, event, ms) {
  if (event === 'loadeddata' && el.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('thumb'));
    }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('thumb')); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(event, onOk);
    el.addEventListener('error', onErr);
  });
}

async function assetSrc(filePath) {
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const src = convertFileSrc(filePath);
  if (!src || /^file:/i.test(src)) throw new Error('thumb');
  return src;
}

async function blobUrlForAsset(filePath) {
  const src = await assetSrc(filePath);
  const res = await fetch(src);
  if (!res.ok) throw new Error('thumb');
  const blob = await res.blob();
  if (!blob.size) throw new Error('thumb');
  return URL.createObjectURL(blob);
}

function detachProbe(el) {
  try { el.pause(); } catch { /* already stopped */ }
  el.removeAttribute('src');
  el.src = '';
  try { el.load(); } catch { /* detached */ }
  el.remove();
}

async function captureImageElement(src) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('thumb'));
    img.src = src;
  });
  if ((img.naturalWidth | 0) < 2 || (img.naturalHeight | 0) < 2) throw new Error('thumb');
  return paintCover(img, img.naturalWidth, img.naturalHeight);
}

async function captureVideoElement(src) {
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;opacity:0.02;pointer-events:none';
  document.body.append(video);
  video.src = src;
  try {
    await waitMedia(video, 'loadeddata', 8000);
    try {
      await video.play();
      video.pause();
    } catch { /* a later seek can still present a frame */ }
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const later = dur > 0
      ? Math.min(Math.max(0.5, dur * 0.05), Math.max(0, dur - 0.04))
      : 0.5;
    const targets = [0];
    if (later > 0.03) targets.push(later);
    if (dur > later + 0.2) targets.push(Math.min(dur * 0.2, dur - 0.04));
    for (const target of targets) {
      if (target > 0.03) {
        const seeked = waitMedia(video, 'seeked', 2500).catch(() => {});
        try { video.currentTime = target; } catch { /* stay on the current frame */ }
        await seeked;
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const sw = video.videoWidth | 0;
      const sh = video.videoHeight | 0;
      if (sw < 2 || sh < 2) continue;
      let painted = '';
      try { painted = paintCover(video, sw, sh); }
      catch { continue; }
      if (!frameIsBlank(video, sw, sh)) return painted;
    }
    throw new Error('thumb');
  } finally {
    detachProbe(video);
  }
}

async function captureSquare(filePath) {
  let objectUrl = '';
  try {
    try { objectUrl = await blobUrlForAsset(filePath); }
    catch { objectUrl = ''; }
    const src = objectUrl || await assetSrc(filePath);
    if (IMAGE_EXT.test(filePath)) return await captureImageElement(src);
    return await captureVideoElement(src);
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function checkDelete(row, snapshot, force) {
  if (IS_TAURI && row.path) {
    return invoke('delete_global_media', {
      path: row.path,
      force,
      projects: [snapshot],
      saveDir: stockSaveDir(),
    });
  }
  let doc = {};
  try { doc = JSON.parse(snapshot.document || '{}'); } catch { doc = {}; }
  const uses = usesInDocument(doc, snapshot.name || 'This project', row);
  if (uses.length && !force) return { deleted: false, uses };
  return { deleted: true, uses };
}

function sameName(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  return a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

function samePath(left, right) {
  const norm = (value) => String(value || '').replace(/\\/g, '/').trim().replace(/\/+$/, '').toLowerCase();
  const a = norm(left);
  const b = norm(right);
  return a.length > 0 && a === b;
}

function keyName(key) {
  const text = String(key || '');
  const cut = text.lastIndexOf(':');
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function slotUses(slot, filePath, leaf) {
  if (!slot || typeof slot !== 'object') return false;
  const key = slot.key || '';
  const name = keyName(key);
  return sameName(name, leaf) || sameName(slot.label, leaf) || samePath(name, filePath) || samePath(key, filePath);
}

function usesInDocument(doc, projectName, row) {
  const leaf = row.name || '';
  const filePath = row.path || '';
  const places = [];
  const pool = Array.isArray(doc.mediaPool) ? doc.mediaPool : [];
  if (pool.some((item) => item && (sameName(item.name || item.id, leaf) || samePath(item.path, filePath) || samePath(item.name, filePath)))) {
    places.push('Project Media');
  }
  const scenes = Array.isArray(doc.scenes) ? doc.scenes : [];
  for (const scene of scenes) {
    const sceneName = scene?.name || 'Untitled scene';
    const media = scene?.media && typeof scene.media === 'object' ? scene.media : {};
    for (const [layer, slot] of Object.entries(media)) {
      if (slotUses(slot, filePath, leaf)) places.push(`Scene "${sceneName}" on layer ${layer}`);
    }
  }
  const cues = Array.isArray(doc.timeline) ? doc.timeline : [];
  for (const cue of cues) {
    const mediaName = cue?.mediaName || cue?.mediaId || '';
    if (sameName(mediaName, leaf) || samePath(mediaName, filePath)) {
      places.push(`Timeline clip on layer ${cue.layerId || 'A'}`);
    }
  }
  const live = doc.live?.media && typeof doc.live.media === 'object' ? doc.live.media : {};
  for (const [layer, slot] of Object.entries(live)) {
    if (slotUses(slot, filePath, leaf)) places.push(`Live layer ${layer}`);
  }
  const unique = [...new Set(places)];
  if (!unique.length) return [];
  return [{ project: projectName || 'This project', places: unique }];
}
