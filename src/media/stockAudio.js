// Stock audio search. Separate from the video fetch: Wikimedia Commons
// audio files only, each one a direct file an <audio> element can preview.

const AUDIO_MIME = /^(audio\/|application\/ogg|application\/flac)/i;
const AUDIO_EXT = /\.(ogg|oga|wav|wave|flac|mp3|aiff|aif)(\?|#|$)/i;

function directAudio(url, mime) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) return '';
  let host = '';
  try { host = new URL(link).hostname.toLowerCase(); } catch { return ''; }
  const allowed = host === 'upload.wikimedia.org' || host.endsWith('.wikimedia.org');
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
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchStockAudio(prompt) {
  const query = String(prompt || '').trim().slice(0, 80);
  if (!query) return [];
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `${query} filetype:audio`,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Object.values(data?.query?.pages || {});
  pages.sort((a, b) => (a.index || 0) - (b.index || 0));
  const hits = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    const url = directAudio(info?.url, info?.mime);
    if (!url) continue;
    const title = leafName(page.title);
    hits.push({
      id: String(page.pageid || title),
      title,
      url,
      mime: String(info?.mime || ''),
      duration: clock(info?.duration),
      bytes: Number(info?.size) || 0,
    });
  }
  return hits;
}
