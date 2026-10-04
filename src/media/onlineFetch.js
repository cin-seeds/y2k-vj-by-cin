// Pexels video search. Only direct MP4 files, which the WebGL texture path can upload.

function slug(prompt) {
  const text = String(prompt || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (text || 'loop').slice(0, 42);
}

function httpMessage(status) {
  if (status === 401 || status === 403) return 'Pexels rejected the API key.';
  if (status === 429) return 'Pexels is rate limited. Try again in a moment.';
  return 'Pexels did not return a video.';
}

function soften(err) {
  const msg = String(err?.message || '');
  if (err?.name === 'AbortError' || /aborted/i.test(msg)) return new Error('Pexels took too long to answer.');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new Error('Could not reach Pexels.');
  return err instanceof Error ? err : new Error('Could not fetch a video loop.');
}

function pexelsKey() {
  const fromEnv = import.meta.env.VITE_PEXELS_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try {
    const stored = localStorage.getItem('vj.pexelsKey');
    if (stored?.trim()) return stored.trim();
  } catch { /* private mode */ }
  return '';
}

function isMp4(file) {
  const link = String(file?.link || '');
  return (file?.file_type === 'video/mp4' || /\.mp4(\?|#|$)/i.test(link)) && /\.mp4(\?|#|$)/i.test(link);
}

function pickMp4(files) {
  const mp4 = files.filter(isMp4);
  const friendly = mp4.filter((file) => {
    const w = Number(file.width) || 0;
    return w >= 640 && w <= 1920;
  });
  const pool = friendly.length ? friendly : mp4.filter((file) => (Number(file.width) || 0) <= 1920);
  const list = pool.length ? pool : mp4;
  list.sort((a, b) => Math.abs((Number(a.width) || 1280) - 1280) - Math.abs((Number(b.width) || 1280) - 1280));
  return list;
}

async function fetchPexels(prompt) {
  const key = pexelsKey();
  if (!key) throw new Error('Set VITE_PEXELS_API_KEY to fetch from Pexels.');
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(prompt)}&per_page=15`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let data;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Authorization: key } });
    if (!res.ok) throw new Error(httpMessage(res.status));
    data = await res.json();
  } catch (err) {
    throw soften(err);
  } finally {
    clearTimeout(timer);
  }
  const videos = Array.isArray(data?.videos) ? data.videos : [];
  for (const video of videos) {
    const files = pickMp4(video.video_files || []);
    const best = files[0];
    if (!best?.link) continue;
    return {
      name: `pexels-${video.id}-${slug(prompt)}.mp4`,
      url: best.link,
      thumbnail: typeof video.image === 'string' ? video.image : '',
      alts: files.slice(1, 4).map((file) => file.link),
    };
  }
  throw new Error('Pexels had no MP4 for that prompt.');
}

/** @returns {Promise<{ name: string, url: string, thumbnail: string, alts: string[] }>} */
export async function fetchVideoLoop(_source, prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Type a prompt first.');
  try {
    return await fetchPexels(text);
  } catch (err) {
    throw soften(err);
  }
}
