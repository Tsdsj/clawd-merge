import { Game } from "../src/game.js";
import { sfx } from "../src/audio.js";
import {
  ComfortSettings,
  comfortDefaults,
  comfortEffects,
} from "../src/comfort.js";
import { createComfortUI } from "../src/comfort-ui.js";
for (const k of Object.keys(sfx))
  if (typeof sfx[k] === "function") sfx[k] = () => {};
const $ = (id) => document.getElementById(id);
let raw = null;
const media = new EventTarget();
media.matches = false;
const settings = new ComfortSettings({
  storage: {
    getItem: () => raw,
    setItem: (k, v) => {
      if ($("fail-write").checked) throw Error("fixture failure");
      raw = v;
    },
  },
  media,
  target: null,
});
const paint = () => {
  $("prefs").textContent = JSON.stringify(
    {
      status: settings.status,
      preferences: settings.prefs,
      effective: settings.effects,
      stored: raw,
    },
    null,
    2,
  );
  document.body.classList.toggle("comfort-reduced", settings.effects.reduced);
};
settings.subscribe(paint);
paint();
const ui = createComfortUI({ settings, onPause() {} });
$("open").onclick = () => ui.open({ mode: "daily", formal: true });
$("system-reduced").onchange = (e) => {
  media.matches = e.target.checked;
  media.dispatchEvent(new Event("change"));
};
$("run").onclick = async () => {
  $("run").disabled = true;
  $("result").textContent = "运行中…";
  const definition = {
    challengeId: "2026-10-03",
    rulesVersion: "daily-1",
    count: 100,
  };
  const effects = [
    comfortEffects({ ...comfortDefaults(), motion: "standard" }, false),
    comfortEffects({ ...comfortDefaults(), motion: "reduced" }, false),
  ];
  const games = ["normal", "reduced"].map((id, i) => {
    const g = new Game(
      $(id),
      {},
      { challenge: definition, seed: 12345, comfort: () => effects[i] },
    );
    g.resize(240, 384, 1);
    return g;
  });
  const samples = [[], []],
    peaks = [0, 0];
  try {
    for (let frame = 0; frame < 2400; frame++) {
      if (frame % 36 === 0)
        for (const g of games) {
          g.setAim(50 + ((frame / 36) % 5) * 75);
          g.requestDrop();
        }
      for (const i of frame % 2 ? [1, 0] : [0, 1]) {
        const at = performance.now();
        games[i].update(1 / 60);
        games[i].render();
        if (frame >= 60) samples[i].push(performance.now() - at);
        peaks[i] = Math.max(peaks[i], games[i].particles.length);
      }
      if (frame % 40 === 0) await new Promise(requestAnimationFrame);
    }
    const states = games.map((g) => g.snapshot());
    if (JSON.stringify(states[0]) !== JSON.stringify(states[1]))
      throw Error("Gameplay snapshot differs");
    if (peaks[0] === 0 || peaks[1] !== 0) throw Error("Particle gate failed");
    const measurements = samples.map((values, i) => {
      values.sort((a, b) => a - b);
      return {
        mode: i ? "reduced" : "standard",
        peakParticles: peaks[i],
        p95UpdateAndRenderMs: Number(
          values[Math.ceil(values.length * 0.95) - 1].toFixed(3),
        ),
      };
    });
    $("result").textContent = JSON.stringify(
      {
        status: "PASS",
        sameSnapshot: true,
        score: games[0].score,
        drops: games[0].drops,
        maxLevel: games[0].maxLevel,
        measurements,
        note: "本机合成负载验证，不代表真机性能或跨设备物理一致性。",
      },
      null,
      2,
    );
  } catch (e) {
    $("result").textContent = "FAIL: " + e.message;
    throw e;
  } finally {
    $("run").disabled = false;
  }
};
