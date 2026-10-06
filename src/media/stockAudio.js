// Stock audio search. Wikimedia Commons and the Internet Archive, limited to
// files an <audio> element can preview: mp3, wav, flac, and ogg.

const AUDIO_MIME = /^(audio\/(mpeg|wav|x-wav|wave|flac|ogg|vorbis)|application\/ogg|application\/flac)/i;
const AUDIO_EXT = /\.(mp3|wav|wave|flac|ogg|oga)(\?|#|$)/i;
const AUDIO_FORMAT = /(mp3|flac|ogg|vorbis|wave|wav)/i;
const APP_UA = 'Y2KVJ/2.0 (https://github.com/cin-seeds/y2k-vj-by-cin; stock-audio)';
const WIKI_EXT = '(fileext:mp3 OR fileext:wav OR fileext:flac OR fileext:ogg)';

function directAudio(url, mime) {
  let link = String(url || '').trim();
  try {
    const parsed = new URL(link);
    const host = parsed.hostname.toLowerCase();
    if (host === 'upload.wikimedia.org' || host.endsWith('.wikimedia.org') || host === 'archive.org' || host.endsWith('.archive.org')) {
      link = `${parsed.origin}${parsed.pathname}`;
    }
  } catch { /* keep the address the search returned */ }
  if (!/^https?:\/\//i.test(link)) return '';
  let host = '';
  try { host = new URL(link).hostname.toLowerCase(); } catch { return ''; }
  const allowed = host === 'upload.wikimedia.org'
    || host.endsWith('.wikimedia.org')
    || host === 'archive.org'
    || host.endsWith('.archive.org')
    || host === 'freesound.org'
    || host.endsWith('.freesound.org');
  if (!allowed) return '';
  if (AUDIO_MIME.test(mime) || AUDIO_EXT.test(link)) return link;
  return '';
}

function clock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '';
  const whole = Math.round(n);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function leafName(title) {
  const raw = String(title || 'sample').replace(/^File:/, '');
  const clean = raw.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'sample').slice(0, 80);
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
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

async function searchWikimedia(query) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `${query} filetype:audio ${WIKI_EXT}`,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|mime|size|mediatype',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Object.values(data?.query?.pages || {});
  pages.sort((a, b) => (a.index || 0) - (b.index || 0));
  const hits = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    const kind = String(info?.mediatype || '').toUpperCase();
    if (kind && kind !== 'AUDIO') continue;
    const url = directAudio(info?.url || info?.iurl, info?.mime);
    if (!url) continue;
    const title = leafName(page.title);
    hits.push({
      id: `wiki:${page.pageid || title}`,
      title,
      url,
      mime: String(info?.mime || ''),
      duration: clock(info?.duration),
      source: 'wikimedia',
    });
  }
  return hits;
}

function archiveTokens(prompt) {
  return String(prompt || '')
    .replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1)
    .slice(0, 6);
}

function archiveAudioQuery(prompt) {
  const tokens = archiveTokens(prompt);
  const fields = (tokens.length ? tokens : ['audio']).map((token) => (
    `(title:${token} OR subject:${token} OR description:${token})`
  )).join(' AND ');
  const format = '(format:MP3 OR format:"VBR MP3" OR format:Flac OR format:"Ogg Vorbis" OR format:WAVE)';
  return `${fields} AND mediatype:(audio) AND ${format}`;
}

function archiveFileUrl(identifier, filename) {
  const id = encodeURIComponent(identifier);
  const file = String(filename).split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://archive.org/download/${id}/${file}`;
}

function archiveAudioFile(files) {
  const wanted = (files || []).filter((file) => {
    const name = String(file?.name || '');
    const format = String(file?.format || '');
    if (!AUDIO_EXT.test(name)) return false;
    return AUDIO_FORMAT.test(format) || /original/i.test(format) || AUDIO_EXT.test(name);
  });
  wanted.sort((a, b) => (Number(a.size) || Number.MAX_SAFE_INTEGER) - (Number(b.size) || Number.MAX_SAFE_INTEGER));
  return wanted[0] || null;
}

async function archiveHit(doc) {
  const identifier = String(doc?.identifier || '');
  if (!identifier) return null;
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  const file = archiveAudioFile(meta?.files);
  if (!file) return null;
  const url = directAudio(archiveFileUrl(identifier, file.name), file.format);
  if (!url) return null;
  const seconds = Number(file.length) || Number(meta?.metadata?.runtime);
  return {
    id: `archive:${identifier}`,
    title: leafName(doc.title || meta?.metadata?.title || identifier),
    url,
    mime: String(file.format || ''),
    duration: clock(seconds),
    source: 'archive',
  };
}

async function searchArchive(query) {
  const params = new URLSearchParams({
    q: archiveAudioQuery(query),
    output: 'json',
    rows: '8',
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('sort[]', '-downloads');
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  const settled = await Promise.allSettled(docs.map((doc) => archiveHit(doc)));
  return settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
}

/**
 * @param {string} prompt
 * @param {'all' | 'wikimedia' | 'archive'} [source]
 */
export async function searchStockAudio(prompt, source = 'all') {
  const query = String(prompt || '').trim().slice(0, 80);
  if (!query) return [];
  const which = source === 'wikimedia' || source === 'archive' ? source : 'all';
  const jobs = [];
  if (which === 'all' || which === 'wikimedia') jobs.push(searchWikimedia(query).catch(() => []));
  if (which === 'all' || which === 'archive') jobs.push(searchArchive(query).catch(() => []));
  const lists = await Promise.all(jobs);
  const seen = new Set();
  const hits = [];
  for (const list of lists) {
    for (const hit of list) {
      if (!hit?.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }
  return hits;
}
