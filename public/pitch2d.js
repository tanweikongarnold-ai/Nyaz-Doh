// Flat SVG pitch. Used when WebGL isn't available, or when the player picks 2D.
// Same interface as the 3D pitch: update({ match, youSlot, targets, markers, playback }).

const SVGNS = 'http://www.w3.org/2000/svg';
const CW = 64;
const LH = 110;
const PAD = 12;
const W = 13 * CW;
const H = 3 * LH + PAD * 2;
const px = (x) => x * CW + CW / 2;
const py = (y) => PAD + y * LH + LH / 2;
const initials = (name) => name.slice(0, 2).toUpperCase();

function sv(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// Where each member of a crowd sharing one cell stands, relative to the cell centre.
const CROWD = {
  1: [[0, 0]],
  2: [[-20, -16], [20, 16]],
  3: [[-22, -24], [22, -24], [0, 24]],
  4: [[-22, -24], [22, -24], [-22, 24], [22, 24]],
  5: [[-40, -24], [0, -24], [40, -24], [-22, 24], [22, 24]],
  6: [[-40, -24], [0, -24], [40, -24], [-40, 24], [0, 24], [40, 24]],
};

export function createPitch2D(container, handlers) {
  const svg = sv('svg', { class: 'pitch-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Pitch' });
  container.append(svg);
  // On a phone the whole pitch is drawn at under half size, so draw the players bigger.
  const smallScreen = window.matchMedia('(max-width: 760px)');
  let last = null;
  const onResize = () => last && update(last);
  smallScreen.addEventListener('change', onResize);

  const top = PAD;
  const bottom = H - PAD;
  for (let c = 0; c < 12; c++) svg.append(sv('rect', { x: px(c), y: top, width: CW, height: bottom - top, class: c % 2 ? 'stripe-a' : 'stripe-b' }));
  svg.append(
    sv('rect', { x: px(0), y: top, width: px(12) - px(0), height: bottom - top, class: 'pline' }),
    sv('line', { x1: px(6), y1: top, x2: px(6), y2: bottom, class: 'pline' }),
    sv('circle', { cx: px(6), cy: H / 2, r: 48, class: 'pline' }),
    sv('circle', { cx: px(6), cy: H / 2, r: 3, fill: 'rgba(255,255,255,.6)' }),
    sv('rect', { x: px(0), y: top + LH * 0.45, width: CW * 2.3, height: LH * 2.1, class: 'pline' }),
    sv('rect', { x: px(12) - CW * 2.3, y: top + LH * 0.45, width: CW * 2.3, height: LH * 2.1, class: 'pline' }),
    sv('rect', { x: px(0) - 22, y: py(1) - 42, width: 22, height: 84, class: 'goalnet' }),
    sv('rect', { x: px(12), y: py(1) - 42, width: 22, height: 84, class: 'goalnet' }),
  );
  for (let y = 0; y < 3; y++) {
    svg.append(sv('text', { x: px(6), y: py(y) - LH / 2 + 14, class: 'lane-label', 'text-anchor': 'middle' }, ['TOP', 'MIDDLE', 'BOTTOM'][y]));
  }
  const markerLayer = sv('g', {});
  svg.append(markerLayer);
  const pEls = new Map();
  let ballEl = null;

  function build(match) {
    for (const p of match.players) {
      const g = sv('g', { class: `player ${p.team}`, 'data-idx': p.idx });
      g.append(sv('g', { class: 'glyph' },
        sv('circle', { r: 27, class: 'target-ring' }),
        sv('circle', { r: 26, class: 'me-ring hidden' }),
        sv('circle', { r: 20, class: 'body' }),
        sv('text', { class: 'initials' }, initials(p.name)),
        sv('text', { class: 'status', y: -28 }, ''),
        sv('rect', { x: -18, y: 24, width: 36, height: 4, rx: 2, class: 'sta-bg' }),
        sv('rect', { x: -18, y: 24, width: 36, height: 4, rx: 2, class: 'sta' }),
        sv('text', { class: 'name-tag', y: 42 }, p.name),
        sv('title', {}, p.name),
      ));
      g.addEventListener('click', () => handlers.onPlayerClick?.(p.idx));
      svg.append(g);
      pEls.set(p.idx, g);
    }
    ballEl = sv('g', { class: 'ball' }, sv('circle', { r: 7 }));
    svg.append(ballEl);
  }

  function update(opts) {
    last = opts;
    const { match: m, youSlot, targets = new Set(), markers = [], playback } = opts;
    if (!pEls.size) build(m);
    const k = smallScreen.matches ? 1.45 : 1;
    const groups = new Map();
    for (const p of m.players) {
      const key = `${p.x},${p.y}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p.idx);
    }
    const pos = new Map();
    for (const p of m.players) {
      const group = groups.get(`${p.x},${p.y}`);
      const [dx, dy] = CROWD[group.length][group.indexOf(p.idx)];
      const crowded = group.length > 1;
      const scale = k * (crowded ? 0.85 : 1);
      const X = px(p.x) + dx * k;
      const Y = py(p.y) + dy * k;
      pos.set(p.idx, { X, Y, scale });
      const g = pEls.get(p.idx);
      g.style.transform = `translate(${X}px, ${Y}px)`;
      g.querySelector('.glyph').setAttribute('transform', `scale(${scale})`);
      // Initials are enough when players are bunched up or the pitch is tiny.
      g.querySelector('.name-tag').classList.toggle('hidden', crowded || k > 1);
      g.classList.toggle('down', p.grounded);
      g.classList.toggle('targetable', targets.has(p.idx));
      g.querySelector('.me-ring').classList.toggle('hidden', p.idx !== youSlot);
      g.querySelector('.status').textContent = p.grounded ? '💤' : p.dazed ? '💫' : '';
      const sta = g.querySelector('.sta');
      sta.setAttribute('width', String(Math.max(0, (p.stamina / p.maxStamina) * 36)));
      sta.classList.toggle('low', p.stamina < 25);
      g.querySelector('title').textContent = `${p.name} (${p.role}) · stamina ${p.stamina}/${p.maxStamina}${p.grounded ? ' · on the floor' : ''}${p.dazed ? ' · dazed' : ''}`;
    }
    const c = pos.get(m.ballCarrier);
    const dirX = m.players[m.ballCarrier].team === 'home' ? 1 : -1;
    ballEl.style.transform = `translate(${c.X + 16 * dirX * c.scale}px, ${c.Y + 15 * c.scale}px) scale(${c.scale})`;

    markerLayer.replaceChildren();
    for (const mk of markers) {
      const g = sv('g', { class: 'dest-marker', transform: `translate(${px(mk.x)} ${py(mk.y)})` },
        sv('circle', { r: 20 }),
        sv('text', {}, `${mk.chance}%`),
        sv('title', {}, `${mk.label}: ${mk.chance}%`),
      );
      g.addEventListener('click', () => handlers.onMarkerClick?.(mk.dir));
      markerLayer.append(g);
    }

    const goal = playback?.find((e) => e.goal);
    if (goal) handlers.onGoal?.(goal);
    return 0; // no animation to wait for
  }

  return {
    kind: '2d',
    update,
    setCamera() {},
    dispose() {
      smallScreen.removeEventListener('change', onResize);
      svg.remove();
    },
  };
}
