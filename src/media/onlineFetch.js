// Stock video search. Every source returns the same clip shape, and every
// videoUrl is a direct MP4 or WebM file the WebGL texture path can upload.

import { IS_TAURI, invoke } from '../ipc.js';

const DIRECT = /\.(mp4|webm)(\?|#|$)/i;
const ARCHIVE_SOFT_CAP = 80 * 1024 * 1024;

function directVideo(url) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) return '';
  if (/\/wiki\/|\/details\/|\/search\b/i.test(link)) return '';
  if (!DIRECT.test(link) || /\.(ogv|ogg|ogx)(\?|#|$)/i.test(link)) return '';
  return link;
}

function poster(url) {
  if (typeof url !== 'string' || !url) return '';
  if (DIRECT.test(url) || /\.(ogv|ogg)(\?|#|$)/i.test(url)) return '';
  return url;
}

function clipOf({ id, title, thumbnail, videoUrl, source, alts }) {
  const url = directVideo(videoUrl);
  if (!url || !id) return null;
  const extra = [];
  for (const alt of alts || []) {
    const next = directVideo(alt);
    if (next && next !== url && !extra.includes(next)) extra.push(next);
  }
  return {
    id: String(id),
    title: String(title || id).replace(/^File:/, ''),
    thumbnail: poster(thumbnail),
    videoUrl: url,
    source,
    alts: extra,
  };
}

const APP_UA = 'Y2KVJ/2.0 (https://github.com/cin-seeds/y2k-vj-by-cin; stock-video)';

function desktopSearch() {
  return IS_TAURI && (/Mac/i.test(navigator.userAgent || '') || /Mac/i.test(navigator.platform || ''));
}

async function getJson(url, ms = 12000) {
  if (desktopSearch()) {
    const text = await invoke('fetch_stock_json', { url });
    if (!text) throw new Error('Search failed');
    return JSON.parse(text);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = { Accept: 'application/json' };
    if (/wikimedia\.org/i.test(url)) headers['Api-User-Agent'] = APP_UA;
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function commonsFileUrl(info) {
  const raw = String(info?.url || info?.iurl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === 'upload.wikimedia.org' || host.endsWith('.wikimedia.org')) {
      return `${parsed.origin}${parsed.pathname}`;
    }
  } catch { /* keep the address imageinfo returned */ }
  return raw;
}

function commonsClip(page) {
  const info = page?.imageinfo?.[0];
  const mime = String(info?.mime || '');
  const kind = String(info?.mediatype || '').toUpperCase();
  if (mime && mime !== 'video/mp4' && mime !== 'video/webm') return null;
  if (kind && kind !== 'VIDEO') return null;
  return clipOf({
    id: page.pageid || page.title,
    title: page.title,
    thumbnail: info?.thumburl,
    videoUrl: commonsFileUrl(info),
    source: 'wikimedia',
  });
}

async function attachCommonsFiles(pages) {
  const missing = pages.filter((page) => page?.title && !page?.imageinfo?.[0]?.url && !page?.imageinfo?.[0]?.iurl);
  if (!missing.length) return;
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    titles: missing.slice(0, 15).map((page) => page.title).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|mime|thumburl|size|mediatype',
    iiurlwidth: '320',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const byTitle = new Map();
  for (const page of Object.values(data?.query?.pages || {})) {
    if (page?.title && page.imageinfo) byTitle.set(page.title, page.imageinfo);
  }
  for (const page of missing) {
    const info = byTitle.get(page.title);
    if (info) page.imageinfo = info;
  }
}

async function fetchWikimedia(prompt) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `${prompt} filetype:video`,
    gsrnamespace: '6',
    gsrlimit: '15',
    prop: 'imageinfo',
    iiprop: 'url|mime|thumburl|size|mediatype',
    iiurlwidth: '320',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Object.values(data?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  await attachCommonsFiles(pages);
  const clips = [];
  for (const page of pages) {
    const clip = commonsClip(page);
    if (clip) clips.push(clip);
    if (clips.length >= 8) break;
  }
  return clips;
}

function archiveFileUrl(identifier, filename) {
  const id = encodeURIComponent(identifier);
  const file = String(filename).split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://archive.org/download/${id}/${file}`;
}

function archiveMp4(files) {
  const wanted = (files || []).filter((file) => {
    const format = String(file?.format || '');
    const name = String(file?.name || '');
    const formatOk = /h\.264/i.test(format) || /512Kb MPEG4/i.test(format);
    return formatOk && /\.(mp4|webm)$/i.test(name);
  });
  wanted.sort((a, b) => (Number(a.size) || Number.MAX_SAFE_INTEGER) - (Number(b.size) || Number.MAX_SAFE_INTEGER));
  const compact = wanted.find((file) => {
    const size = Number(file.size);
    return Number.isFinite(size) && size > 0 && size <= ARCHIVE_SOFT_CAP;
  });
  return compact || wanted[0] || null;
}

async function archiveClip(doc) {
  const identifier = String(doc?.identifier || '');
  if (!identifier) return null;
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  const file = archiveMp4(meta?.files);
  if (!file) return null;
  return clipOf({
    id: identifier,
    title: doc.title || meta?.metadata?.title || identifier,
    thumbnail: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    videoUrl: archiveFileUrl(identifier, file.name),
    source: 'archive',
  });
}

function archiveTokens(prompt) {
  return String(prompt || '')
    .replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1)
    .slice(0, 6);
}

function archiveQuery(prompt, mediatype) {
  const tokens = archiveTokens(prompt);
  const fields = (tokens.length ? tokens : ['video']).map((token) => (
    `(title:${token} OR subject:${token} OR description:${token})`
  )).join(' AND ');
  const type = mediatype === 'audio' ? 'audio' : 'movies';
  const format = type === 'audio' ? '' : ' AND (format:"h.264" OR format:"512Kb MPEG4")';
  return `${fields} AND mediatype:(${type})${format}`;
}

async function fetchArchive(prompt) {
  const params = new URLSearchParams({
    q: archiveQuery(prompt, 'movies'),
    output: 'json',
    rows: '8',
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('sort[]', '-downloads');
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  const settled = await Promise.allSettled(docs.map((doc) => archiveClip(doc)));
  return settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
}

function mixSources(clips) {
  const buckets = new Map();
  for (const clip of clips) {
    const list = buckets.get(clip.source) || [];
    list.push(clip);
    buckets.set(clip.source, list);
  }
  const lists = [...buckets.values()];
  const mixed = [];
  let more = true;
  while (more) {
    more = false;
    for (const list of lists) {
      if (!list.length) continue;
      mixed.push(list.shift());
      more = true;
    }
  }
  return mixed;
}

/**
 * @param {string} source all | wikimedia | archive
 * @param {string} prompt
 * @returns {Promise<Array<{ id: string, title: string, thumbnail: string, videoUrl: string, source: string }>>}
 */
export async function fetchVideoLoop(source, prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Type a prompt first.');
  const which = source || 'all';
  const jobs = [];
  if (which === 'all' || which === 'wikimedia') jobs.push(fetchWikimedia(text));
  if (which === 'all' || which === 'archive') jobs.push(fetchArchive(text));
  const settled = await Promise.allSettled(jobs);
  const seen = new Set();
  const clips = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
    for (const clip of result.value) {
      if (!clip?.videoUrl || seen.has(clip.videoUrl)) continue;
      seen.add(clip.videoUrl);
      clips.push(clip);
    }
  }
  if (!clips.length) {
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed && settled.every((result) => result.status === 'rejected')) {
      throw new Error(failed.reason?.message || 'No playable video for that search.');
    }
    throw new Error('No playable video for that search.');
  }
  return mixSources(clips);
}
