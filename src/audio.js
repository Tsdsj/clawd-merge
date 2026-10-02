// Chiptune-style blips via WebAudio. No audio files needed.
import { readPreference, writePreference } from './storage.js';

const KEY = 'clawd-merge:sound';
let ctx = null;
let enabled = readPreference(KEY) !== 'off';

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip(freq, { at = 0, dur = 0.08, type = 'square', vol = 0.05, to } = {}) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  get enabled() {
    return enabled;
  },
  toggle() {
    enabled = !enabled;
    writePreference(KEY, enabled ? 'on' : 'off');
    if (enabled) blip(660, { dur: 0.06 });
    return enabled;
  },
  // Must be called from a user gesture (iOS won't start audio otherwise).
  unlock() {
    audio();
  },
  drop() {
    blip(300, { dur: 0.07, to: 180, vol: 0.035 });
  },
  // Pitch climbs with the Clawd level and with the combo count.
  merge(level, combo = 1) {
    const f = 260 * Math.pow(2, (level - 2) / 5 + Math.min(combo - 1, 6) / 12);
    blip(f, { dur: 0.07 });
    blip(f * 1.5, { at: 0.06, dur: 0.1 });
  },
  rainbow() {
    [784, 988, 1175, 1568].forEach((f, i) => blip(f, { at: i * 0.04, dur: 0.08, type: 'triangle', vol: 0.05 }));
  },
  fever() {
    [392, 523, 659, 784, 1047, 1319].forEach((f, i) => blip(f, { at: i * 0.06, dur: 0.12, vol: 0.05 }));
  },
  claw() {
    blip(900, { dur: 0.05, to: 1400, vol: 0.05 });
    blip(500, { at: 0.06, dur: 0.12, to: 200, type: 'triangle', vol: 0.07 });
  },
  discover() {
    [659, 784, 988, 1319].forEach((f, i) => blip(f, { at: i * 0.1, dur: 0.16, type: 'triangle', vol: 0.07 }));
  },
  record() {
    [523, 523, 784, 1047].forEach((f, i) => blip(f, { at: i * 0.11, dur: 0.14, vol: 0.05 }));
  },
  jackpot() {
    [523, 659, 784, 1047].forEach((f, i) => blip(f, { at: i * 0.09, dur: 0.14 }));
  },
  over() {
    [392, 330, 262, 196].forEach((f, i) => blip(f, { at: i * 0.14, dur: 0.18, type: 'triangle', vol: 0.08 }));
  },
};
