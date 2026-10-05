// Draws the drifting brand mark into a recording or master-output frame.
// The desk preview stays a DOM element. This is only the 2D copy.

const MARK_SHADE = [
  [-1, '#fff'],
  [1, '#067'],
  [2, '#045'],
  [3, '#034'],
  [4, '#023'],
  [5, '#012'],
  [6, '#000'],
];
const EM_SHADE = [
  [-1, '#fff'],
  [1, '#a03078'],
  [2, '#701050'],
  [3, '#480830'],
  [4, '#280418'],
  [5, '#100208'],
  [6, '#000'],
];

export function screenShadow(shade, steps) {
  const layers = shadeLayers(shade, steps);
  if (!layers.length) return 'none';
  return layers.map((layer) => `${layer.x}px ${layer.y}px 0 ${layer.color}`).join(', ');
}

export const SCREEN_MARK_SHADE = MARK_SHADE;
export const SCREEN_EM_SHADE = EM_SHADE;

function shadeLayers(shade, steps) {
  const level = Math.min(8, Math.max(0, shade | 0));
  if (level <= 0) return [];
  const count = Math.max(1, Math.round((level / 8) * steps.length));
  const gain = level / 8;
  return steps.slice(0, count).map(([d, color]) => ({
    x: Math.round(d * gain * 100) / 100,
    y: Math.round(d * gain * 100) / 100,
    color,
  }));
}

function bounce(span, dist) {
  if (span < 1) return 0;
  const travel = dist % (span * 2);
  return travel <= span ? travel : span * 2 - travel;
}

function drift(areaW, areaH, mw, mh, nowMs) {
  const spanX = Math.max(0, Math.min(areaW * 0.62, areaW - mw - 16));
  const spanY = Math.max(0, Math.min(areaH * 0.28, areaH - mh - 16));
  const speed = Math.max(20, areaW * 0.04);
  const dist = (nowMs / 1000) * speed;
  return {
    x: (areaW - mw - spanX) / 2 + bounce(spanX, dist),
    y: (areaH - mh - spanY) / 2 + bounce(spanY, dist * 0.62),
  };
}

function pieceWidth(ctx, text, credit) {
  if (credit || !text.includes('//')) return ctx.measureText(text).width;
  return text.split('//').reduce((sum, part, i, all) => {
    const slash = i < all.length - 1 ? ctx.measureText('//').width : 0;
    return sum + ctx.measureText(part).width + slash;
  }, 0);
}

function drawPiece(ctx, text, x, y, color, shade, em) {
  const layers = shadeLayers(shade, em ? EM_SHADE : MARK_SHADE);
  for (const layer of layers) {
    ctx.fillStyle = layer.color;
    ctx.fillText(text, x + layer.x, y + layer.y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawLine(ctx, line, x, y, color, shade) {
  if (line.credit || !line.text.includes('//')) {
    drawPiece(ctx, line.text, x, y, color, shade, false);
    return;
  }
  let cursor = x;
  const parts = line.text.split('//');
  parts.forEach((part, i) => {
    if (part) {
      drawPiece(ctx, part, cursor, y, color, shade, false);
      cursor += ctx.measureText(part).width;
    }
    if (i < parts.length - 1) {
      drawPiece(ctx, '//', cursor, y, '#ff8ae4', shade, true);
      cursor += ctx.measureText('//').width;
    }
  });
}

/**
 * Paint the screensaver into the frame.
 * A letterboxed picture leaves a black margin, and the mark drifts there.
 * A picture that fills the frame keeps the same relative place as the preview.
 */
export function paintScreensaver(ctx, frameW, frameH, picture, spec) {
  const lines = (spec?.lines || []).filter((line) => line && typeof line.text === 'string');
  if (!lines.length || frameW < 2 || frameH < 2) return;
  const box = picture?.dw > 2 && picture?.dh > 2
    ? picture
    : { dx: 0, dy: 0, dw: frameW, dh: frameH };
  const base = Math.min(28, Math.max(16, box.dw / 32));
  const fontPx = Math.max(8, Math.round(base * (Number(spec.scale) || 100) / 100));
  ctx.save();
  ctx.font = `800 ${fontPx}px ${spec.fontFamily || 'monospace'}`;
  ctx.textBaseline = 'top';
  const lineH = Math.round(fontPx * 1.2);
  const gap = 3;
  const background = Math.min(1, Math.max(0, Number(spec.background) || 0));
  const showBox = background > 0;
  const padX = showBox ? Math.max(10, Math.round(fontPx * 0.7)) : 0;
  const padTop = showBox ? Math.max(6, Math.round(fontPx * 0.36)) : 0;
  const padBottom = showBox ? Math.max(8, Math.round(fontPx * 0.55)) : 0;
  const widest = Math.max(1, ...lines.map((line) => pieceWidth(ctx, line.text, line.credit)));
  let mw = widest + padX * 2;
  let mh = padTop + padBottom + lines.length * lineH + Math.max(0, lines.length - 1) * gap;

  const marginX = Math.max(0, box.dx);
  const marginY = Math.max(0, box.dy);
  const sideBar = marginX >= 4 && marginX >= marginY;
  const letterBar = marginY >= 4 && marginY > marginX;
  let fieldX = box.dx;
  let fieldY = box.dy;
  let fieldW = box.dw;
  let fieldH = box.dh;
  if (sideBar) {
    fieldX = 0;
    fieldY = 0;
    fieldW = marginX;
    fieldH = frameH;
  } else if (letterBar) {
    fieldX = 0;
    fieldY = 0;
    fieldW = frameW;
    fieldH = marginY;
  }

  const fitW = Math.max(1, fieldW - 16);
  const fitH = Math.max(1, fieldH - 16);
  let drawScale = 1;
  if ((mw > fitW || mh > fitH) && mw > 0 && mh > 0) {
    drawScale = Math.min(fitW / mw, fitH / mh);
  }
  const dw = mw * drawScale;
  const dh = mh * drawScale;
  const pose = drift(fieldW, fieldH, dw, dh, Number(spec.nowMs) || 0);
  ctx.translate(fieldX + pose.x, fieldY + pose.y);
  ctx.scale(drawScale, drawScale);
  if (showBox) {
    ctx.fillStyle = `rgba(0, 0, 0, ${background})`;
    ctx.fillRect(0, 0, mw, mh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#d8ffff';
    ctx.beginPath();
    ctx.moveTo(1, mh - 1);
    ctx.lineTo(1, 1);
    ctx.lineTo(mw - 1, 1);
    ctx.stroke();
    ctx.strokeStyle = '#045868';
    ctx.beginPath();
    ctx.moveTo(mw - 1, 1);
    ctx.lineTo(mw - 1, mh - 1);
    ctx.lineTo(1, mh - 1);
    ctx.stroke();
  }
  const color = spec.color || '#f4ffff';
  const shade = spec.shade | 0;
  lines.forEach((line, i) => {
    const y = padTop + i * (lineH + gap);
    drawLine(ctx, line, padX, y, color, shade);
  });
  ctx.restore();
}
