// The chosen output device. Empty string is the operating system default.
// AudioContext.setSinkId routes the mix. HTML media elements use the same id.

let sinkId = '';
const contexts = new Set();

export function currentAudioSink() {
  return sinkId;
}

export function applyMediaSink(el, deviceId = sinkId) {
  if (!el || typeof el.setSinkId !== 'function') return Promise.resolve();
  const next = deviceId || '';
  try {
    if (el.sinkId === next) return Promise.resolve();
  } catch { /* the property appears after the first successful call */ }
  return el.setSinkId(next).catch((err) => {
    console.warn('Could not route audio output', err);
  });
}

export function applyDocumentSink(doc, deviceId = sinkId) {
  if (!doc?.querySelectorAll) return Promise.resolve();
  const nodes = [...doc.querySelectorAll('audio, video')];
  return Promise.all(nodes.map((el) => applyMediaSink(el, deviceId)));
}

export function attachAudioContext(ctx) {
  if (ctx) contexts.add(ctx);
  return applyContextSink(ctx);
}

export async function setAudioSink(deviceId) {
  sinkId = deviceId || '';
  await Promise.all([...contexts].map((ctx) => applyContextSink(ctx)));
}

async function applyContextSink(ctx) {
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  try {
    if (ctx.sinkId === sinkId) return;
  } catch { /* read after the first route */ }
  try {
    await ctx.setSinkId(sinkId);
  } catch (err) {
    console.warn('Could not route the audio engine', err);
  }
}
