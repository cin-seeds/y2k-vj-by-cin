// Stock video search. Every source returns the same clip shape, and every
// videoUrl is a direct MP4 or WebM file the WebGL texture path can upload.

const DIRECT = /\.(mp4|webm)(\?|#|$)/i;

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

async function getJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWikimedia(prompt) {
  try {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'search',
      gsrsearch: `${prompt} filetype:video`,
      gsrnamespace: '6',
      gsrlimit: '15',
      prop: 'imageinfo',
      iiprop: 'url|mime|thumburl',
      iiurlwidth: '320',
    });
    const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    const pages = Object.values(data?.query?.pages || {});
    const clips = [];
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      const mime = String(info?.mime || '');
      if (mime && mime !== 'video/mp4' && mime !== 'video/webm') continue;
      const clip = clipOf({
        id: page.pageid || page.title,
        title: page.title,
        thumbnail: info?.thumburl,
        videoUrl: info?.url,
        source: 'wikimedia',
      });
      if (clip) clips.push(clip);
      if (clips.length >= 8) break;
    }
    return clips;
  } catch {
    return [];
  }
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
  return wanted[0] || null;
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

async function fetchArchive(prompt) {
  try {
    const q = `${prompt} AND mediatype:movies AND (format:"h.264" OR format:"512Kb MPEG4")`;
    const params = new URLSearchParams({
      q,
      output: 'json',
      rows: '8',
    });
    params.append('fl[]', 'identifier');
    params.append('fl[]', 'title');
    const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
    const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
    const settled = await Promise.allSettled(docs.map((doc) => archiveClip(doc)));
    return settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
  } catch {
    return [];
  }
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
  if (!clips.length) throw new Error('No playable video for that search.');
  return mixSources(clips);
}
