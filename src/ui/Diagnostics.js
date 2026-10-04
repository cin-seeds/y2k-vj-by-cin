// Sidebar readout of the live routing matrix. A warning can jump to its slider.

import { diagnoseLoad, diagnoseReadable, diagnoseRouting } from '../mod/diagnose.js';

const flashes = new WeakMap();

/** Flash a control for two seconds. `level` is 'bad' (red) or 'warn' (yellow). */
export function flashControl(el, level = 'warn') {
  if (!el) return;
  el.classList.remove('diag-flash-bad', 'diag-flash-warn');
  void el.offsetWidth;
  const cls = level === 'bad' ? 'diag-flash-bad' : 'diag-flash-warn';
  el.classList.add(cls);
  clearTimeout(flashes.get(el));
  flashes.set(el, setTimeout(() => el.classList.remove(cls), 2000));
}

export class Diagnostics {
  constructor(root, onFix = () => {}) {
    this.root = root;
    this.onFix = onFix;
    this.routesEl = root.querySelector('#diag-routes');
    this.warnEl = root.querySelector('#diag-warn');
    this.loadEl = root.querySelector('#diag-load');
    this.readableEl = root.querySelector('#diag-readable');
    this.badge = root.querySelector('#diag-badge');
    this.nominal = root.querySelector('#diag-nominal');
    this.last = '';
  }

  /** Re-read the modulation math every frame. The list changes only when a warning appears or clears. */
  tick(ctx) {
    const routing = diagnoseRouting(ctx);
    const load = diagnoseLoad(ctx.layers, ctx.renderScale);
    const tips = this.readableEl ? diagnoseReadable(ctx) : [];
    const sig = JSON.stringify({
      routes: routing.routes.map((r) => r.text),
      warnings: routing.warnings.map((w) => `${w.id || ''}|${w.parameterTarget || ''}|${w.level}|${w.text}`),
      load: load.map((w) => `${w.parameterTarget || ''}|${w.level}|${w.text}`),
      tips: tips.map((t) => `${t.parameterTarget || ''}|${t.text}`),
    });
    if (sig === this.last) return;
    this.last = sig;
    this.#paint(routing.routes, routing.warnings, load, tips);
  }

  #paint(routes, warnings, load, tips = []) {
    this.#fill(this.routesEl, routes, 'All parameters manual');
    this.#fill(this.warnEl, warnings, 'No clipping or routing conflicts');
    this.#fill(this.loadEl, load, 'Engine load looks steady');
    if (this.readableEl) {
      this.#fill(this.readableEl, tips, 'Nothing is stacked. The shader is the only listen.');
    }
    // Tips stay out of the badge so soft stacking advice does not look like a fault.
    const alerts = warnings.length + load.length;
    const bad = warnings.some((w) => w.level === 'bad') || load.some((w) => w.level === 'bad');
    const clear = warnings.length === 0 && load.length === 0;
    this.badge.hidden = alerts === 0;
    this.badge.textContent = String(alerts);
    this.badge.classList.toggle('bad', bad);
    if (this.nominal) this.nominal.hidden = !clear;
  }

  #fill(list, items, empty) {
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'diag-empty';
      li.textContent = empty;
      list.append(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      const actionable = !!(item.parameterTarget || item.domId || item.layerId);
      const tone = item.level === 'bad' ? 'diag-bad' : item.level ? 'diag-warn' : '';
      if (actionable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `diag-jump${tone ? ` ${tone}` : ''}`;
        btn.textContent = item.text;
        btn.title = 'Show this control in the inspector';
        btn.addEventListener('click', () => this.onFix(item));
        li.append(btn);
      } else {
        if (tone) li.classList.add(tone);
        li.textContent = item.text;
      }
      list.append(li);
    }
  }
}
