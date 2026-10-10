// Media Prep. The live desk hides while this queue is up. Transcoding runs
// in the desktop app: FFmpeg is a Tauri sidecar and writes H.264 into the
// permanent global library (app data / global_media).

import { IS_TAURI, invoke } from '../ipc.js';
import { isTauri } from '../output/OutputWindow.js';
import { addMediaTag, confirmDuplicateAdd, mediaLibraryHasName, rememberMediaSource } from './GlobalLibrary.js';

const DROP_VIDEO_AUDIO_KEY = 'vj.prep.dropVideoAudio';

/** Media Manager preference: strip audio from new video transcodes. Default on. */
export function dropVideoAudioPref() {
  try {
    const raw = localStorage.getItem(DROP_VIDEO_AUDIO_KEY);
    if (raw === null) return true;
    return raw !== '0';
  } catch {
    return true;
  }
}

export function setDropVideoAudioPref(on) {
  try { localStorage.setItem(DROP_VIDEO_AUDIO_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|wmv|flv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|flac|aiff|aif|m4a)$/i;
const jobs = new Map();
let listening = false;
let pumping = false;
const queue = [];

function isVideo(file) {
  return file.type.startsWith('video/') || VIDEO_EXT.test(file.name || '');
}

function isImage(file) {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name || '');
}

function isAudio(file) {
  return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name || '');
}

function pathFromFile(file, event) {
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

function paintJob(job, text, kind) {
  job.state.textContent = text;
  job.row.classList.toggle('busy', kind === 'busy');
  job.row.classList.toggle('done', kind === 'done');
  job.row.classList.toggle('failed', kind === 'failed');
  if (kind !== 'busy') job.row.classList.remove('busy');
}

function setPercent(job, percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  job.bar.style.width = `${clamped}%`;
  job.meter.setAttribute('aria-valuenow', String(Math.round(clamped)));
  job.row.classList.remove('busy');
}

function addJob(name, path, file, { brand = false, image = false } = {}) {
  const id = crypto.randomUUID();
  const row = document.createElement('li');
  row.className = 'prep-job';
  row.innerHTML = '<b></b><button type="button" class="prep-bypass">Bypass Transcode & Add Directly</button><span class="prep-state">Waiting</span><div class="prep-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>';
  row.querySelector('b').textContent = name;
  row.querySelector('b').title = path || name;
  const bypass = row.querySelector('.prep-bypass');
  const job = {
    id,
    name,
    path: path || '',
    file: file || null,
    row,
    state: row.querySelector('.prep-state'),
    bar: row.querySelector('.prep-bar i'),
    meter: row.querySelector('.prep-bar'),
    bypass,
    bypassed: false,
    settled: false,
    transcoding: false,
    brand: !!brand,
    image: !!image,
  };
  if (job.image) {
    bypass.hidden = true;
    bypass.disabled = true;
  }
  bypass.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    bypassDirect(job);
  });
  jobs.set(id, job);
  $('prep-queue').append(row);
  $('prep-empty').hidden = true;
  queue.push(job);
  return job;
}

function $(id) {
  return document.getElementById(id);
}

function onPrepEvent(payload) {
  const job = jobs.get(payload?.id);
  if (!job || job.bypassed || job.settled) return;
  if (payload.kind === 'log') {
    if (job && typeof payload?.percent === 'number') {
      setPercent(job, payload.percent);
      paintJob(job, `Transcoding ${Math.round(payload.percent)}%`, '');
    }
    return;
  }
  if (typeof payload.percent === 'number') setPercent(job, payload.percent);
  if (payload.kind === 'error') paintJob(job, payload.error || 'Transcode failed', 'failed');
  if (payload.kind === 'done') {
    job.settled = true;
    job.bypass.disabled = true;
    setPercent(job, 100);
  }
}

async function ensureListen() {
  if (listening || !isTauri()) return;
  listening = true;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('media-prep', (event) => onPrepEvent(event.payload));
}

const STAGE_CHUNK = 8 * 1024 * 1024;

async function stageFile(job, saveDir) {
  const file = job.file;
  const total = file.size;
  let path = '';
  try {
    for (let offset = 0; offset < total || offset === 0; offset += STAGE_CHUNK) {
      const end = Math.min(total, offset + STAGE_CHUNK);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      path = await invoke('stage_prep_bytes', chunk, {
        headers: {
          'x-filename': encodeURIComponent(job.name),
          'x-save-dir': encodeURIComponent(saveDir || ''),
          'x-append': offset > 0 ? '1' : '0',
        },
      });
      setPercent(job, total ? Math.round((end / total) * 100) : 100);
      paintJob(job, 'Copying…', '');
      if (total === 0) break;
    }
  } catch (err) {
    await invoke('stage_prep_discard', { filename: job.name, saveDir }).catch(() => {});
    throw err;
  }
  return path;
}

function noteGlobalSave(detail = {}) {
  const name = typeof detail?.name === 'string' ? detail.name : '';
  const source = detail.source === 'fetch' || detail.source === 'audio' ? detail.source : 'user';
  if (name) rememberMediaSource(name, source);
  window.dispatchEvent(new CustomEvent('vj-global-media', {
    detail: name ? { name, source, path: detail.path || '' } : {},
  }));
}

function noteBrandFile(name, path) {
  const leaf = String(name || '').split(/[\\/]/).pop();
  if (!leaf) return;
  addMediaTag(leaf, 'brand');
  window.dispatchEvent(new CustomEvent('vj-brand-ready', {
    detail: { name: leaf, path: path || '' },
  }));
}

function allowDuplicate(name) {
  if (!mediaLibraryHasName(name)) return true;
  return confirmDuplicateAdd(name);
}

let ensurePreparedDir = async () => '';

async function resolveSaveDir(ensureSaveDir) {
  const chosen = await ensureSaveDir();
  if (chosen) return chosen;
  if (IS_TAURI) {
    try {
      const dir = await invoke('global_media_dir');
      if (dir) return dir;
    } catch { /* the private folder is only a fallback when no project folder exists */ }
  }
  return '';
}

let libraryRef = null;
let prepShowToast = null;

function dropFromQueue(job) {
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
}

async function bypassDirect(job) {
  if (job.settled || job.bypassed) return;
  job.bypassed = true;
  dropFromQueue(job);
  job.bypass.disabled = true;
  paintJob(job, 'Adding…', 'busy');
  if (job.transcoding && IS_TAURI) {
    await invoke('transcode_cancel', { jobId: job.id }).catch(() => {});
  }
  try {
    if (job.path && IS_TAURI) {
      const saveDir = await ensurePreparedDir();
      const saved = await invoke('copy_into_global_media', { inputPath: job.path, saveDir });
      const leaf = String(saved).split(/[\\/]/).pop() || job.name;
      job.settled = true;
      setPercent(job, 100);
      paintJob(job, 'Saved to Media Manager', 'done');
      prepShowToast?.('Saved to Media Manager');
      noteGlobalSave({ name: leaf, path: saved, source: job.audio ? 'audio' : 'user' });
      if (job.brand && !job.audio) noteBrandFile(leaf, saved);
      if (job.audio) noteAudioReady(saved, job.play);
      return;
    }
    const file = job.file;
    if (job.audio && file) {
      await libraryRef.cacheAudio(file);
      rememberMediaSource(file.name, 'audio');
      job.settled = true;
      setPercent(job, 100);
      paintJob(job, 'Saved to Media Manager', 'done');
      prepShowToast?.(`Saved ${file.name} to Media Manager`);
      noteGlobalSave({ name: file.name, source: 'audio' });
      window.dispatchEvent(new CustomEvent('vj-audio-ready', {
        detail: { name: file.name, file, play: !!job.play },
      }));
      return;
    }
    if (!file) throw new Error('Drop the video again to add it without transcoding.');
    const added = libraryRef.add([file]);
    if (!added.length) throw new Error('That file is not a video the library can use.');
    job.settled = true;
    setPercent(job, 100);
    paintJob(job, 'Saved to Media Manager', 'done');
    prepShowToast?.(`Saved ${added[0]} to Media Manager`);
    noteGlobalSave({ name: added[0] });
    if (job.brand) noteBrandFile(added[0], '');
  } catch (err) {
    job.bypassed = false;
    job.bypass.disabled = false;
    paintJob(job, err?.message || 'Could not add the file', 'failed');
    prepShowToast?.('Could not add the file', true);
  }
}

async function runImageJob(job, ensureStockDir, showToast) {
  if (job.bypassed || job.settled) return;
  job.bypass.disabled = true;
  paintJob(job, 'Saving…', 'busy');
  try {
    if (IS_TAURI) {
      const saveDir = await resolveSaveDir(ensureStockDir);
      let inputPath = job.path;
      if (!inputPath) {
        if (!job.file) throw new Error('That image has no file path.');
        paintJob(job, 'Copying…', 'busy');
        inputPath = await stageFile(job, saveDir);
      }
      if (job.bypassed) return;
      const output = await invoke('copy_into_global_media', { inputPath, saveDir: saveDir || '' });
      job.settled = true;
      setPercent(job, 100);
      const leaf = String(output).split(/[\\/]/).pop() || job.name;
      paintJob(job, `Saved ${leaf}`, 'done');
      showToast(`Saved ${leaf} to Media Manager`);
      noteGlobalSave({ name: leaf, path: output });
      if (job.brand) noteBrandFile(leaf, output);
      return;
    }
    if (!job.file || !libraryRef) throw new Error('That image could not be added.');
    const added = libraryRef.add([job.file]);
    if (!added.length) throw new Error('That image could not be added.');
    job.settled = true;
    setPercent(job, 100);
    paintJob(job, 'Saved to Media Manager', 'done');
    showToast(`Saved ${added[0]} to Media Manager`);
    noteGlobalSave({ name: added[0] });
    if (job.brand) noteBrandFile(added[0], '');
  } catch (err) {
    if (job.bypassed) return;
    job.bypass.disabled = false;
    paintJob(job, err?.message || 'Could not add the image', 'failed');
    showToast(err?.message || 'Could not add the image', true);
  }
}

async function runJob(job, ensureStockDir, showToast) {
  if (job.bypassed || job.settled) return;
  if (job.image) {
    await runImageJob(job, ensureStockDir, showToast);
    return;
  }
  if (!IS_TAURI) {
    console.warn('transcode_media needs the desktop app.');
    paintJob(job, 'Open the desktop app to transcode.', '');
    return;
  }
  try {
    await ensureListen();
    if (job.bypassed) return;
    const saveDir = await resolveSaveDir(ensureStockDir);
    let inputPath = job.path;
    if (!inputPath) {
      if (!job.file) throw new Error('That video has no file path.');
      paintJob(job, 'Copying…', 'busy');
      inputPath = await stageFile(job, saveDir);
    }
    if (job.bypassed) return;
    paintJob(job, 'Transcoding', 'busy');
    job.transcoding = true;
    let output;
    try {
      output = job.audio
        ? await invoke('transcode_audio', { jobId: job.id, inputPath, saveDir })
        : await invoke('transcode_media', {
          jobId: job.id,
          inputPath,
          saveDir,
          keyint: 1,
          dropAudio: dropVideoAudioPref(),
        });
    } finally {
      job.transcoding = false;
    }
    if (job.bypassed) return;
    job.settled = true;
    job.bypass.disabled = true;
    setPercent(job, 100);
    const leaf = String(output).split(/[\\/]/).pop() || job.name;
    paintJob(job, `Saved ${leaf}`, 'done');
    showToast(`Saved ${leaf} to Media Manager`);
    noteGlobalSave({ name: leaf, path: output, source: job.audio ? 'audio' : 'user' });
    if (job.audio) noteAudioReady(output, job.play, leaf);
    else if (job.brand) noteBrandFile(leaf, output);
  } catch (err) {
    if (job.bypassed) return;
    const message = err?.message || String(err) || 'Transcode failed';
    paintJob(job, message, 'failed');
    showToast('Transcode failed', true);
    if (job.audio && job.play) {
      window.dispatchEvent(new CustomEvent('vj-audio-ready', {
        detail: { error: message, play: true },
      }));
    }
  }
}

function noteAudioReady(path, play, name) {
  const leaf = name || String(path || '').split(/[\\/]/).pop() || '';
  window.dispatchEvent(new CustomEvent('vj-audio-ready', {
    detail: { path: path || '', name: leaf, play: !!play },
  }));
}

async function pump(ensureStockDir, showToast) {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    await runJob(job, ensureStockDir, showToast);
  }
  pumping = false;
}

function enqueue(name, path, file, ensureStockDir, showToast, options = {}) {
  rememberMediaSource(name, 'user');
  addJob(name, path, file, options);
  pump(ensureStockDir, showToast);
}

function enqueueImage(name, path, file, ensureStockDir, showToast, options = {}) {
  enqueue(name, path, file, ensureStockDir, showToast, { ...options, image: true });
}

export function queueMediaPrep(name, path, file, options = {}) {
  enqueue(name, path, file, ensurePreparedDir, prepShowToast || (() => {}), options);
}

export function queueAudioPrep(name, path, file, { play = false } = {}) {
  rememberMediaSource(name, 'audio');
  if (!IS_TAURI) {
    if (!file) return;
    libraryRef?.cacheAudio(file);
    noteGlobalSave();
    window.dispatchEvent(new CustomEvent('vj-audio-ready', {
      detail: { name: file.name || name, file, play: !!play },
    }));
    return;
  }
  const job = addJob(name, path, file);
  job.audio = true;
  job.play = !!play;
  pump(ensurePreparedDir, prepShowToast || (() => {}));
}

export function bindMediaPrep({ library, ensureStockDir, showToast }) {
  libraryRef = library;
  prepShowToast = showToast;
  ensurePreparedDir = ensureStockDir;
  const zone = $('prep-drop');
  const allow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  zone.addEventListener('dragenter', (event) => {
    allow(event);
    zone.classList.add('over');
  });
  zone.addEventListener('dragover', (event) => {
    allow(event);
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (event) => {
    allow(event);
    zone.classList.remove('over');
    const files = [...(event.dataTransfer?.files || [])];
    const videos = files.filter(isVideo);
    const images = files.filter(isImage);
    const audio = files.filter(isAudio);
    if (!videos.length && !images.length && !audio.length) {
      showToast('Drop a video, image, or audio file.', true);
      return;
    }
    for (const file of videos) {
      if (!allowDuplicate(file.name)) continue;
      enqueue(file.name, pathFromFile(file, event), file, ensureStockDir, showToast);
    }
    for (const file of images) {
      if (!allowDuplicate(file.name)) continue;
      enqueueImage(file.name, pathFromFile(file, event), file, ensureStockDir, showToast);
    }
    for (const file of audio) {
      if (!allowDuplicate(file.name)) continue;
      queueAudioPrep(file.name, pathFromFile(file, event), file);
    }
  });
  zone.addEventListener('click', () => chooseFiles(ensureStockDir, showToast));
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseFiles(ensureStockDir, showToast);
    }
  });
}

async function chooseFiles(ensureStockDir, showToast) {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: true,
      title: 'Media to prepare',
      filters: [{
        name: 'Media',
        extensions: [
          'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg',
          'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif',
          'mp3', 'wav', 'aiff', 'aif', 'm4a', 'ogg', 'flac',
        ],
      }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const path of paths) {
      const name = String(path).split(/[\\/]/).pop() || 'media';
      if (!allowDuplicate(name)) continue;
      if (AUDIO_EXT.test(name)) queueAudioPrep(name, path, null);
      else if (IMAGE_EXT.test(name)) enqueueImage(name, path, null, ensureStockDir, showToast);
      else if (VIDEO_EXT.test(name)) enqueue(name, path, null, ensureStockDir, showToast);
    }
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,audio/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.mpg,.mpeg,.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.mp3,.wav,.aiff,.aif,.m4a,.ogg,.flac';
  input.multiple = true;
  input.addEventListener('change', () => {
    for (const file of input.files || []) {
      if (!allowDuplicate(file.name)) continue;
      if (isAudio(file)) queueAudioPrep(file.name, '', file);
      else if (isImage(file)) enqueueImage(file.name, '', file, ensureStockDir, showToast);
      else if (isVideo(file)) enqueue(file.name, '', file, ensureStockDir, showToast);
    }
  });
  input.click();
}
