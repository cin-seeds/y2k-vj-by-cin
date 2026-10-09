/** Place a source box inside a destination using fill (cover), fit (contain), or original (1:1, scale down only). */
export function fittedBox(sw, sh, w, h, mode = 'fit') {
  if (!(sw > 0 && sh > 0 && w > 0 && h > 0)) return null;
  let scale;
  if (mode === 'fill') scale = Math.max(w / sw, h / sh);
  else if (mode === 'original') scale = Math.min(1, w / sw, h / sh);
  else scale = Math.min(w / sw, h / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  return {
    dx: Math.round((w - dw) / 2),
    dy: Math.round((h - dh) / 2),
    dw,
    dh,
  };
}
