// One undo step is one gesture: a slider drag, a shuffle, a scene launch.
// A drag stays pending until it is committed, so Undo can cancel it without
// throwing away the redo stack.

const LIMIT = 80;

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function fresh() {
  return { parts: new Map(), effects: [] };
}

function alive(bucket) {
  return !!bucket && (bucket.parts.size > 0 || bucket.effects.length > 0);
}

export function createParamHistory(apply, { onChange } = {}) {
  const undoStack = [];
  const redoStack = [];
  let pending = null;
  let group = null;
  let applying = false;
  let silence = 0;

  const emit = () => onChange?.();

  function absorb(bucket, id, from, to, applyPart) {
    const cur = bucket.parts.get(id);
    if (!cur) bucket.parts.set(id, { from, to, apply: applyPart });
    else cur.to = to;
    const row = bucket.parts.get(id);
    if (row && same(row.from, row.to)) bucket.parts.delete(id);
  }

  function freeze(bucket) {
    if (!alive(bucket)) return null;
    return {
      parts: [...bucket.parts.entries()].map(([id, row]) => ({ id, ...row })),
      effects: bucket.effects.slice(),
    };
  }

  function push(step) {
    if (!step) return;
    undoStack.push(step);
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
    emit();
  }

  function takePending() {
    const step = freeze(pending);
    pending = null;
    return step;
  }

  function applyStep(step, dir) {
    applying = true;
    try {
      if (dir === 'undo') {
        for (let i = step.effects.length - 1; i >= 0; i--) step.effects[i].undo();
        for (const part of step.parts) {
          if (part.apply) part.apply(part.from);
          else apply(part.id, part.from);
        }
      } else {
        for (const part of step.parts) {
          if (part.apply) part.apply(part.to);
          else apply(part.id, part.to);
        }
        for (const effect of step.effects) effect.redo();
      }
    } finally {
      applying = false;
    }
  }

  function write(id, from, to, kind, applyPart) {
    if (applying || silence || same(from, to)) return;
    const dest = group;
    if (dest) {
      absorb(dest, id, from, to, applyPart);
      return;
    }
    if (kind === 'drag') {
      if (alive(pending) && !pending.parts.has(id)) push(takePending());
      pending ||= fresh();
      absorb(pending, id, from, to, applyPart);
      emit();
      return;
    }
    if (pending?.parts.has(id)) {
      absorb(pending, id, from, to, applyPart);
      push(takePending());
      return;
    }
    if (alive(pending)) push(takePending());
    const bucket = fresh();
    absorb(bucket, id, from, to, applyPart);
    push(freeze(bucket));
  }

  return {
    get applying() { return applying; },
    get canUndo() { return undoStack.length > 0 || alive(pending); },
    get canRedo() { return redoStack.length > 0 && !alive(pending); },

    note(id, from, to, kind) {
      write(id, from, to, kind);
    },

    /** A non-parameter value. `applyPart` receives the from or to value. */
    edit(id, from, to, applyPart, kind = 'commit') {
      write(id, from, to, kind, applyPart);
    },

    effect(undo, redo) {
      if (applying || silence || typeof undo !== 'function' || typeof redo !== 'function') return;
      const item = { undo, redo };
      if (group) {
        group.effects.push(item);
        return;
      }
      if (alive(pending)) push(takePending());
      push({ parts: [], effects: [item] });
    },

    commit() {
      if (group || !alive(pending)) {
        pending = null;
        return;
      }
      push(takePending());
    },

    /** Fold every note, edit, and effect inside `fn` into one step. */
    group(fn) {
      if (group) return fn();
      this.commit();
      group = fresh();
      try {
        return fn();
      } finally {
        const step = freeze(group);
        group = null;
        if (step) push(step);
      }
    },

    /** Merge the last two steps when a click and its double-click are the same control. */
    coalesce(id) {
      if (undoStack.length < 2) return;
      const next = undoStack[undoStack.length - 1];
      const prev = undoStack[undoStack.length - 2];
      if (next.effects.length || prev.effects.length) return;
      if (next.parts.length !== 1 || prev.parts.length !== 1) return;
      if (next.parts[0].id !== id || prev.parts[0].id !== id) return;
      prev.parts[0].to = next.parts[0].to;
      undoStack.pop();
      if (same(prev.parts[0].from, prev.parts[0].to)) undoStack.pop();
      emit();
    },

    silence(fn) {
      silence += 1;
      try { return fn(); } finally { silence -= 1; }
    },

    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      pending = null;
      group = null;
      emit();
    },

    undo() {
      if (alive(pending)) {
        const step = takePending();
        if (step) applyStep(step, 'undo');
        emit();
        return;
      }
      const step = undoStack.pop();
      if (!step) {
        emit();
        return;
      }
      applyStep(step, 'undo');
      redoStack.push(step);
      if (redoStack.length > LIMIT) redoStack.shift();
      emit();
    },

    redo() {
      if (alive(pending)) return;
      const step = redoStack.pop();
      if (!step) {
        emit();
        return;
      }
      applyStep(step, 'redo');
      undoStack.push(step);
      if (undoStack.length > LIMIT) undoStack.shift();
      emit();
    },
  };
}
