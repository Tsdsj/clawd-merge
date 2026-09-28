// Pixel-art Clawds, drawn from ASCII grids.
// Every level shares the same Clawd body (16×10 cells) and adds accessory layers
// on top. '.' is transparent, 'x' erases a base pixel.
// Coordinates are art cells: cell (x, y) covers [x, x+1] × [y, y+1]; the body
// centre (physics anchor) is at (ANCHOR_X, ANCHOR_Y).

export const PALETTE = {
  '#': '#D97757', // Clawd orange
  K: '#1B1A22', // eyes
  d: '#B5573A', // dark orange
  W: '#F6EFE6', // white
  R: '#E5484D', // red
  P: '#F59AB0', // blush
  G: '#A7ADC4', // steam
  N: '#24232D', // near black
  L: '#CFE8FF', // lens glint
  Y: '#F7C948', // gold
  y: '#D9A12B', // dark gold
  U: '#4D9DFF', // blue
  V: '#8A63E0', // purple
  v: '#5B3FB0', // dark purple
  C: '#A8672F', // cowboy brown
  c: '#6E4119', // dark brown
  S: '#4A5075', // ninja slate
  B: '#7A4A26', // wood
  // rainbow stripes
  1: '#FF5E5B',
  2: '#FF9F43',
  3: '#FFD84D',
  4: '#5BD17A',
  5: '#4DB2FF',
  6: '#A77BFF',
};

const BASE = [
  '..############..',
  '..############..',
  '..###K####K###..',
  '#####K####K#####',
  '################',
  '..############..',
  '..############..',
  '..############..',
  '...#.#....#.#...',
  '...#.#....#.#...',
];

export const ANCHOR_X = 8;
export const ANCHOR_Y = 5;
export const BODY_COLS = 16;

// Collision circles [x, y, r] in art cells, shared by every Clawd: four corners,
// two core circles and the two little arms.
const BASE_HITBOX = [
  [3, 3, 3],
  [13, 3, 3],
  [3, 7, 3],
  [13, 7, 3],
  [5.5, 5, 5],
  [10.5, 5, 5],
  [1, 4, 1.2],
  [15, 4, 1.2],
];

const BLUSH = { x: 3, y: 4, art: ['PP......PP'] };

// `width` is the body width in world units (the board is 400 wide).
// `hitbox` adds circles for accessories so hats & props collide and never get
// pushed through the walls.
export const LEVELS = [
  { name: '小Clawd', width: 34, layers: [], hitbox: [] },
  {
    name: '爱心Clawd',
    width: 45,
    layers: [BLUSH, { x: 12, y: -5, art: ['WR.RR', 'RRRRR', '.RRR.', '..R..'] }],
    hitbox: [[14.5, -3, 2.3]],
  },
  {
    name: '咖啡Clawd',
    width: 58,
    layers: [
      {
        x: 15,
        y: -1,
        art: ['.G.G..', 'G.G...', '......', 'WWWW..', 'WddWWW', 'WWWW.W', 'WWWWWW', '.WW...'],
      },
    ],
    hitbox: [
      [17.8, 4.5, 2.9],
      [16.5, 0, 1.4],
    ],
  },
  {
    name: '眼镜Clawd',
    width: 72,
    layers: [
      {
        x: 0,
        y: 1,
        art: ['....NNN..NNN....', '..NN...NN...NN..', '...N...NN...N...', '....NNN..NNN....'],
      },
    ],
    hitbox: [],
  },
  {
    name: '墨镜Clawd',
    width: 88,
    layers: [
      {
        x: 0,
        y: 1,
        art: ['..NNNNNNNNNNNN..', '...NLNN..NLNN...', '...NNNN..NNNN...', '....NN....NN....'],
      },
    ],
    hitbox: [],
  },
  {
    name: '礼帽Clawd',
    width: 106,
    layers: [
      {
        x: 0,
        y: -6,
        art: [
          '.....NNNNNN.....',
          '.....NNNNNN.....',
          '.....NNNNNN.....',
          '.....RRRRRR.....',
          '.....NNNNNN.....',
          '..NNNNNNNNNNNN..',
        ],
      },
    ],
    hitbox: [
      [6.8, -3.6, 2.6],
      [9.2, -3.6, 2.6],
      [3, -0.5, 1.2],
      [13, -0.5, 1.2],
    ],
  },
  {
    name: '滑板Clawd',
    width: 126,
    layers: [
      { x: 0, y: -2, art: ['....UUUUUUUU....', 'UUUUUUUUUUUU....'] },
      { x: 0, y: 9, art: ['...x.x....x.x...'] },
      { x: -1, y: 8, art: ['V................V', 'VVVVVVVVVVVVVVVVVV', '..YY..........YY..'] },
    ],
    hitbox: [
      [5.5, -0.8, 2],
      [10, -0.8, 2],
      [1.5, -0.5, 1.3],
      [1, 9.3, 2.1],
      [15, 9.3, 2.1],
      [8, 8.5, 1.6],
    ],
  },
  {
    name: '牛仔Clawd',
    width: 148,
    layers: [
      {
        x: 0,
        y: -5,
        art: [
          '.....CC..CC.....',
          '....CCCCCCCC....',
          '....cccccccc....',
          'CC..CCCCCCCC..CC',
          '.CCCCCCCCCCCCCC.',
        ],
      },
      { x: 10, y: 5, art: ['.Y.', 'YYY', '.Y.'] },
    ],
    hitbox: [
      [6.8, -2.6, 2.5],
      [9.2, -2.6, 2.5],
      [1.6, -1.2, 1.6],
      [14.4, -1.2, 1.6],
    ],
  },
  {
    name: '忍者Clawd',
    width: 172,
    layers: [
      {
        x: -3,
        y: 0,
        art: [
          '.....SSSSSSSSSSSS..',
          '.RRRRRRRRRRRRRRRR..',
          'RR...S..........S..',
          'R....S..........S..',
          '.....SSSSSSSSSSSS..',
          '.....SSSSSSSSSSSS..',
        ],
      },
    ],
    hitbox: [
      [-1.2, 2.3, 1.9],
      [1, 1.5, 1.1],
    ],
  },
  {
    name: '魔法Clawd',
    width: 198,
    layers: [
      {
        x: 0,
        y: -9,
        art: [
          '.........V......',
          '........VV......',
          '.......VVV......',
          '......VVYVV.....',
          '......VVVVV.....',
          '.....VVVVVVV....',
          '.....VVVVVYV....',
          '....vvvvvvvvv...',
          '..VVVVVVVVVVVV..',
        ],
      },
      { x: 16, y: -1, art: ['...Y.', '..YYY', '..BY.', '.B...', 'B....'] },
    ],
    hitbox: [
      [8.5, -2.4, 3],
      [3.8, -0.6, 1.5],
      [12.8, -0.6, 1.5],
      [8.5, -6, 1.9],
      [9.5, -8.3, 1],
      [19.5, 0.5, 1.6],
      [17.2, 2.8, 1.1],
    ],
  },
  {
    name: '大Clawd',
    width: 228,
    layers: [
      BLUSH,
      {
        x: 0,
        y: -4,
        art: ['...Y...YY...Y...', '...YY.YYYY.YY...', '...YYYYYYYYYY...', '...yRyyUUyyRy...'],
      },
    ],
    hitbox: [
      [5.5, -1.8, 2.3],
      [10.5, -1.8, 2.3],
      [8, -2, 2.2],
      [3.8, -3.2, 1],
      [12.2, -3.2, 1],
    ],
  },
];

export const MAX_LEVEL = LEVELS.length;

// The rainbow Clawd is a wildcard: level 0. It upgrades whatever it touches.
export const RAINBOW = 0;
const RAINBOW_DEF = {
  name: '彩虹Clawd',
  width: 50,
  layers: [{ x: 0, y: -3, art: ['..L.........L...', '.LYL.......LYL..', '..L.........L...'] }],
  hitbox: [],
};
export const RAINBOW_FRAMES = 6;

export const defOf = (level) => (level === RAINBOW ? RAINBOW_DEF : LEVELS[level - 1]);

// Collision circles in world units relative to the body centre.
export function hitboxOf(level) {
  const def = defOf(level);
  const cell = def.width / BODY_COLS;
  return [...BASE_HITBOX, ...def.hitbox].map(([x, y, r]) => ({
    x: (x - ANCHOR_X) * cell,
    y: (y - ANCHOR_Y) * cell,
    r: r * cell,
  }));
}

function compose(level, blink, frame) {
  const cells = new Map();
  const put = (x, y, ch) => {
    if (ch === '.') return;
    const key = `${x},${y}`;
    if (ch === 'x') cells.delete(key);
    else cells.set(key, { x, y, ch });
  };
  BASE.forEach((row, y) => {
    [...row].forEach((x, i) => {
      let ch = x;
      if (blink && y === 2 && ch === 'K') ch = '#';
      if (level === RAINBOW && ch === '#') ch = String(((y + frame) % RAINBOW_FRAMES) + 1);
      put(i, y, ch);
    });
  });
  for (const layer of defOf(level).layers) {
    layer.art.forEach((row, y) => {
      [...row].forEach((ch, x) => put(layer.x + x, layer.y + y, ch));
    });
  }

  const list = [...cells.values()];
  const xs = list.map((c) => c.x);
  const ys = list.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    cells: list,
    minX,
    minY,
    cols: Math.max(...xs) - minX + 1,
    rows: Math.max(...ys) - minY + 1,
  };
}

const layoutCache = new Map();
function getLayout(level, blink, frame = 0) {
  const key = `${level}:${blink ? 1 : 0}:${frame}`;
  if (!layoutCache.has(key)) layoutCache.set(key, compose(level, blink, frame));
  return layoutCache.get(key);
}

const spriteCache = new Map();

export function clearSpriteCache() {
  spriteCache.clear();
}

// Renders a Clawd with `cellPx` device pixels per art cell (cached).
// `silhouette` paints every pixel one flat colour (locked collection entries).
export function getSprite(level, cellPx, { blink = false, frame = 0, silhouette = false } = {}) {
  const px = Math.max(1, Math.round(cellPx));
  const key = `${level}:${px}:${blink ? 1 : 0}:${frame}:${silhouette ? 1 : 0}`;
  let sprite = spriteCache.get(key);
  if (!sprite) {
    const layout = getLayout(level, blink, frame);
    const canvas = document.createElement('canvas');
    canvas.width = layout.cols * px;
    canvas.height = layout.rows * px;
    const ctx = canvas.getContext('2d');
    for (const { x, y, ch } of layout.cells) {
      ctx.fillStyle = silhouette ? '#3A3B55' : PALETTE[ch];
      ctx.fillRect((x - layout.minX) * px, (y - layout.minY) * px, px, px);
    }
    sprite = { canvas, minX: layout.minX, minY: layout.minY, cols: layout.cols, rows: layout.rows };
    spriteCache.set(key, sprite);
  }
  return sprite;
}

// Draws a Clawd centred and bottom-aligned inside a small canvas ("next" box).
export function drawCrabIcon(canvas, level, cssW, cssH, dpr) {
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const layout = getLayout(level, false);
  const px = Math.max(1, Math.floor(Math.min(canvas.width / layout.cols, canvas.height / layout.rows)));
  const sprite = getSprite(level, px);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    sprite.canvas,
    Math.floor((canvas.width - sprite.canvas.width) / 2),
    canvas.height - sprite.canvas.height,
  );
}

// Legend icons share one cell size so the Clawds compare fairly (hats stick out).
export function drawLegendIcon(canvas, level, dpr, locked = false) {
  const px = Math.max(1, Math.round(1.3 * dpr));
  const sprite = getSprite(level, px, { silhouette: locked });
  canvas.width = sprite.canvas.width;
  canvas.height = sprite.canvas.height;
  canvas.style.width = `${sprite.canvas.width / dpr}px`;
  canvas.style.height = `${sprite.canvas.height / dpr}px`;
  canvas.getContext('2d').drawImage(sprite.canvas, 0, 0);
}
