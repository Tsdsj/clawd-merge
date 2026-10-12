// Chiptune-style blips via WebAudio. No audio files needed.
import { readPreference, writePreference } from './storage.js';

const KEY = 'clawd-merge:sound';
let ctx = null;
let enabled = readPreference(KEY) !== 'off';
const voices = new Set();

function track(ac, sources, gain) {
  const voice = {
    active: true,
    stop() {
      if (!voice.active) return;
      voice.active = false;
      voices.delete(voice);
      const now = ac.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0.0001, now, 0.008);
      for (const source of sources) source.stop(now + 0.04);
    },
  };
  let ended = 0;
  for (const source of sources) source.onended = () => {
    if (++ended === sources.length) { voice.active = false; voices.delete(voice); }
  };
  voices.add(voice);
  return voice;
}

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
  track(ac, [osc], gain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Short, deterministic high-passed grain gives ice a brittle attack without
// introducing asset downloads or consuming the gameplay random sequence.
function crackle(duration, volume) {
  const ac = audio();
  if (!ac) return;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * duration), ac.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 7391;
  for (let i=0; i<data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 0x80000000 - 1) * (0.35 + 0.65 * Math.abs(Math.sin(i / ac.sampleRate * 110)));
  }
  const source = ac.createBufferSource(); source.buffer = buffer;
  const filter = ac.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 1800;
  const gain = ac.createGain();
  const now = ac.currentTime;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter).connect(gain).connect(ac.destination);
  track(ac, [source], gain);
  source.start(now); source.stop(now + duration + 0.02);
}

export const sfx = {
  get enabled() {
    return enabled;
  },
  toggle() {
    enabled = !enabled;
    writePreference(KEY, enabled ? 'on' : 'off');
    if (!enabled) for (const voice of [...voices]) voice.stop();
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
  crown() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => blip(f, { at: i * 0.07, dur: 0.16, type: 'triangle', vol: 0.06 }));
  },
  sweep() {
    blip(880, { dur: 0.3, to: 110, type: 'sawtooth', vol: 0.06 });
    blip(440, { at: 0.1, dur: 0.25, to: 80, type: 'triangle', vol: 0.06 });
  },
  gold() {
    blip(880, { dur: 0.22, type: 'triangle', vol: 0.05 });
    blip(1760, { dur: 0.16, type: 'sine', vol: 0.035 });
    blip(2640, { at: 0.045, dur: 0.12, type: 'sine', vol: 0.025 });
  },
  magnet() {
    blip(165, { dur: 0.16, to: 330, type: 'triangle', vol: 0.035 });
  },
  startMagnet() {
    const ac = audio();
    if (!ac) return null;
    const now = ac.currentTime, gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.018, now + 0.07);
    gain.connect(ac.destination);
    // A two-hertz beat conveys a gently pulsing field at a low mix level.
    const sources = [110, 112].map(frequency => {
      const osc = ac.createOscillator(); osc.type = 'triangle';
      osc.frequency.value = frequency; osc.connect(gain); osc.start(now);
      return osc;
    });
    return track(ac, sources, gain);
  },
  magnetEnd(merged = false) {
    blip(330, { dur: 0.14, to: 110, type: 'triangle', vol: 0.025 });
    if (merged) blip(990, { dur: 0.09, type: 'sine', vol: 0.035 });
  },
  freeze() {
    crackle(0.2, 0.065);
    [1568, 1245, 988].forEach((f, i) => blip(f, { at: i * 0.045, dur: 0.12, type: 'sine', vol: 0.035 }));
  },
  thaw() {
    crackle(0.16, 0.045);
    blip(1175, { dur: 0.12, to: 1760, type: 'sine', vol: 0.025 });
  },
};
