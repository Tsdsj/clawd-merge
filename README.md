# 合成大Clawd · clawd-merge

A "合成大西瓜"-style merge game starring Claude's orange pixel crab, Clawd. Zero dependencies: native ES modules + Canvas + a small hand-written physics engine, deployable directly to GitHub Pages.

## Running locally

```bash
npm start
```

Open http://localhost:5173 . Phones on the same Wi-Fi can use the Network address printed in the terminal. Needs Node 18+, no `npm install`.
Append `?debug` to the URL to see every Clawd's collision circles.

## How to play

- **Phone**: press and drag to aim, release to drop. Landscape is supported too
- **Desktop**: aim with the mouse, click to drop; or ← / → (A / D) to move, Space / ↓ to drop, C for the claw, R to restart
- Two Clawds of the same level merge into the next level when they touch; if the pile stays above the red dashed line for 2.5 s, the game ends

The 11 Clawds: 小 → 爱心 → 咖啡 → 眼镜 → 墨镜 → 礼帽 → 滑板 → 牛仔 → 忍者 → 魔法 → 大Clawd

### Extra mechanics

| Mechanic | Description |
| --- | --- |
| Combo | Chained merges add +25% each, up to ×2 |
| Fever mode | Merging fills the meter along the top of the board; when full, you get 8 s of double score |
| Rainbow Clawd | Rare drop, a wildcard: whatever it touches goes up one level |
| Claw | The first time in a game you create each Clawd of level 7 or higher, you get one claw (max 3); tap the button, then tap a Clawd to remove it |
| Collection | Clawds you've never created show as silhouettes; the first time you create one, an unlock card pops up |

Scoring: merging two level-k Clawds gives 2^k points, so high-level merges (which need planning) are worth far more than random low-level cascades.
Balance was tuned with simulated players: a bot that always clicks the same spot averages ~6.7k, while a lookahead bot averages ~18k.

## Deploying (GitHub Pages)

The repo root is the site itself; in the repo's Settings → Pages, choose `Deploy from a branch` → `main` / `(root)`.

## Code structure

| File | Contents |
| --- | --- |
| `src/physics.js` | Rigid-body physics: compound-circle bodies, sequential-impulse solver (warm starting), position correction, island sleeping |
| `src/crabs.js` | ASCII pixel art for every Clawd, hitboxes, palette, sprite cache |
| `src/game.js` | Game logic and rules (`RULES`), combo / fever / rainbow / claw, effects and rendering |
| `src/main.js` | Page layout, touch / mouse / keyboard input, main loop |
| `src/audio.js` | WebAudio chiptune sound effects |
| `scripts/make-icons.mjs` | Generates the home-screen PNG icons (zero dependencies) |
| `serve.mjs` | Local static server |
