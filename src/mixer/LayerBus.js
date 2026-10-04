// Live mute/solo. These never go into scenes or the timeline: a launched
// preset can raise a layer's opacity, but a live mute still silences it.

export class LayerBus {
  constructor(ids) {
    this.ids = ids;
    this.mute = Object.fromEntries(ids.map((id) => [id, false]));
    this.solo = Object.fromEntries(ids.map((id) => [id, false]));
    this.listeners = new Set();
  }

  toggleMute(id) {
    this.mute[id] = !this.mute[id];
    this.#emit();
  }

  toggleSolo(id) {
    this.solo[id] = !this.solo[id];
    this.#emit();
  }

  /** Trade mute and solo between two layers. Parameter values are swapped separately. */
  exchange(a, b) {
    [this.mute[a], this.mute[b]] = [this.mute[b], this.mute[a]];
    [this.solo[a], this.solo[b]] = [this.solo[b], this.solo[a]];
    this.#emit();
  }

  anySolo() {
    return this.ids.some((id) => this.solo[id]);
  }

  /**
   * Whether the compositor should mix this layer.
   * Any solo plays only the soloed layers. Mute is ignored while a solo is on.
   * With no solo, every layer that is not muted is mixed.
   */
  audible(id) {
    if (this.anySolo()) return !!this.solo[id];
    return !this.mute[id];
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }
}
