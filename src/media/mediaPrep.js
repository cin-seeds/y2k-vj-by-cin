// Media Prep. The live desk hides while this queue is up. Transcoding runs
// in the desktop app: FFmpeg is a Tauri sidecar and writes H.264 into the
// permanent global library (app data / global_media).

import { isTauri } from '../output/OutputWindow.js';

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|wmv|flv)$/i;
const jobs = new Map();
let listening = false;
let pumping = false;
const queue = [];

function isVideo(file) {
  return file.type.startsWith('video/') || VIDEO_EXT.test(file.name || '');
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

function addJob(name, path, file) {
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
  };
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
  const { invoke } = await import('@tauri-apps/api/core');
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

function noteGlobalSave() {
  window.dispatchEvent(new CustomEvent('vj-global-media'));
}

async function importPrepared() {
  noteGlobalSave();
}

async function resolveSaveDir(ensureStockDir) {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const dir = await invoke('global_media_dir');
      if (dir) return dir;
    } catch { /* the stock folder is the fallback */ }
  }
  return ensureStockDir();
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
  if (job.transcoding && isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('transcode_cancel', { jobId: job.id }).catch(() => {});
  }
  try {
    if (job.path && isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('copy_into_global_media', { inputPath: job.path });
      job.settled = true;
      setPercent(job, 100);
      paintJob(job, 'Saved to Media Manager', 'done');
      prepShowToast?.('Saved to Media Manager');
      noteGlobalSave();
      return;
    }
    const file = job.file;
    if (!file) throw new Error('Drop the video again to add it without transcoding.');
    const added = libraryRef.add([file]);
    if (!added.length) throw new Error('That file is not a video the library can use.');
    job.settled = true;
    setPercent(job, 100);
    paintJob(job, 'Saved to Media Manager', 'done');
    prepShowToast?.(`Saved ${added[0]} to Media Manager`);
    noteGlobalSave();
  } catch (err) {
    job.bypassed = false;
    job.bypass.disabled = false;
    paintJob(job, err?.message || 'Could not add the file', 'failed');
    prepShowToast?.('Could not add the file', true);
  }
}

async function runJob(job, ensureStockDir, showToast) {
  if (job.bypassed || job.settled) return;
  if (!isTauri()) {
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
    const { invoke } = await import('@tauri-apps/api/core');
    job.transcoding = true;
    let output;
    try {
      output = await invoke('transcode_media', {
        jobId: job.id,
        inputPath,
        saveDir,
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
    try { await importPrepared(); } catch { /* the file is already in the global folder */ }
  } catch (err) {
    if (job.bypassed) return;
    paintJob(job, err?.message || String(err) || 'Transcode failed', 'failed');
    showToast('Transcode failed', true);
  }
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

function enqueue(name, path, file, ensureStockDir, showToast) {
  addJob(name, path, file);
  pump(ensureStockDir, showToast);
}

export function queueMediaPrep(name, path, file) {
  enqueue(name, path, file, async () => '', prepShowToast || (() => {}));
}

export function bindMediaPrep({ library, ensureStockDir, showToast }) {
  libraryRef = library;
  prepShowToast = showToast;
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
    const files = [...(event.dataTransfer?.files || [])].filter(isVideo);
    if (!files.length) {
      showToast('Drop a video file.', true);
      return;
    }
    for (const file of files) enqueue(file.name, pathFromFile(file, event), file, ensureStockDir, showToast);
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
      title: 'Videos to prepare',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg'] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const path of paths) {
      const name = String(path).split(/[\\/]/).pop() || 'video';
      if (!VIDEO_EXT.test(name)) continue;
      enqueue(name, path, null, ensureStockDir, showToast);
    }
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.mpg,.mpeg';
  input.multiple = true;
  input.addEventListener('change', () => {
    for (const file of input.files || []) {
      if (isVideo(file)) enqueue(file.name, '', file, ensureStockDir, showToast);
    }
  });
  input.click();
}
