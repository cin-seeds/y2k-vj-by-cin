// Shared drag payload for scene pads and library cards. The timeline reads it
// on drop. A same-page copy is kept because some browsers hide custom data
// until the drop event.

export const DRAG_MIME = 'application/json';

export function beginDrag(event, item) {
  const payload = {
    type: 'SCENE_OR_CLIP',
    id: item.id,
    name: item.name,
    data: item,
  };
  const packed = JSON.stringify(payload);
  event.dataTransfer.setData(DRAG_MIME, packed);
  event.dataTransfer.setData('text/plain', packed);
  event.dataTransfer.effectAllowed = 'copy';
  window.__vjDragPayload = payload;

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = item.name || 'Clip';
  document.body.append(ghost);
  try { event.dataTransfer.setDragImage(ghost, 16, 16); } catch { /* the label still travels */ }
  window.__vjDragGhost = ghost;
}

export function endDrag() {
  window.__vjDragPayload = null;
  if (window.__vjDragGhost) {
    window.__vjDragGhost.remove();
    window.__vjDragGhost = null;
  }
}

function parsePayload(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.type === 'SCENE_OR_CLIP' && parsed.id) return parsed;
  } catch { /* not a payload */ }
  return null;
}

export function readDrag(event) {
  let raw = '';
  let plain = '';
  try { raw = event.dataTransfer?.getData(DRAG_MIME) || ''; } catch { raw = ''; }
  try { plain = event.dataTransfer?.getData('text/plain') || ''; } catch { plain = ''; }
  return parsePayload(raw) || parsePayload(plain) || (
    window.__vjDragPayload?.type === 'SCENE_OR_CLIP' ? window.__vjDragPayload : null
  );
}

export function isOurDrag(event) {
  if (window.__vjDragPayload?.type === 'SCENE_OR_CLIP') return true;
  const types = event.dataTransfer?.types;
  if (!types) return false;
  if (typeof types.includes === 'function') return types.includes(DRAG_MIME);
  if (typeof types.contains === 'function') return types.contains(DRAG_MIME);
  return [...types].includes(DRAG_MIME);
}
