// Closing a dialog must not clear a manual or background pause.
export class PauseState {
  constructor(onChange = () => {}) {
    this.reasons = new Set();
    this.onChange = onChange;
  }
  get paused() { return this.reasons.size > 0; }
  has(reason) { return this.reasons.has(reason); }
  set(reason, active) {
    if (this.has(reason) === active) return;
    if (active) this.reasons.add(reason);
    else this.reasons.delete(reason);
    this.onChange();
  }
  resume() {
    this.reasons.delete('manual');
    this.reasons.delete('background');
    this.onChange();
  }
  clear() {
    this.reasons.clear();
    this.onChange();
  }
}
