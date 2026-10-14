// Browser client. Talks to the server over a WebSocket and renders whatever state it is
// sent. All game logic lives on the server; this file only shows it and sends choices.

import { createPitch2D } from './pitch2d.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode etc.: preferences just won't stick
    }
  },
};

const S = {
  ws: null,
  clientId: sessionStorage.getItem('is-client-id'),
  token: sessionStorage.getItem('is-token'),
  name: localStorage.getItem('is-name') || '',
  catalog: null,
  room: null,
  you: null,
  match: null,
  options: null,
  myChoice: null,
  locked: [],
  timerEndsAt: null,
  offset: 0,
  turnSeq: -1,
  seenSeqs: new Set(),
  chat: [],
  reconnectDelay: 500,
  pendingJoin: new URLSearchParams(location.search).get('room'),
  ftDismissedFor: null,
  view: store.get('is-view', '3d'), // '3d' | '2d'
  cam: store.get('is-cam', 'follow'),
  shownScore: null, // score held back while a replay is still playing
  pendingReveal: null,
  revealTimer: null,
};
const ui = { picking: null, hoverDesc: '' };

// ---------------------------------------------------------------------------
// DOM helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}

let toastTimer = null;
function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind === 'info' ? 'info' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const teamName = (t) => S.catalog?.teams[t]?.name ?? t;
const initials = (name) => name.slice(0, 2).toUpperCase();
const oddsClass = (c) => (c >= 60 ? 'hi' : c >= 35 ? 'mid' : 'lo');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Connection

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  setConn('connecting…', '');
  ws.addEventListener('open', () => {
    S.reconnectDelay = 500;
    setConn('online', 'online');
    ws.send(JSON.stringify({ type: 'hello', clientId: S.clientId, token: S.token, name: S.name }));
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  ws.addEventListener('close', (e) => {
    if (S.ws !== ws) return;
    setConn('offline, reconnecting…', 'offline');
    if (e.code === 4000) {
      setConn('opened in another tab', 'offline');
      return;
    }
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 8000);
  });
}

function setConn(text, cls) {
  const c = $('#conn');
  c.textContent = text;
  c.className = `conn ${cls}`;
}

function send(type, payload = {}) {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type, ...payload }));
  else toast('Not connected yet. Hang on…');
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      S.clientId = msg.clientId;
      S.token = msg.token;
      S.catalog = msg.catalog;
      sessionStorage.setItem('is-client-id', msg.clientId);
      sessionStorage.setItem('is-token', msg.token);
      if (!S.name) {
        S.name = msg.name;
        $('#name-input').value = msg.name;
      }
      // If the server didn't put us back in a room, honour an invite link.
      setTimeout(() => {
        if (!S.room && S.pendingJoin) send('joinRoom', { code: S.pendingJoin });
        S.pendingJoin = null;
      }, 150);
      break;
    case 'state':
      onState(msg);
      break;
    case 'chat':
      S.chat.push(msg.message);
      renderChat();
      break;
    case 'left':
      S.room = null;
      S.match = null;
      setUrlRoom(null);
      showScreen('home');
      break;
    case 'error':
      toast(msg.message);
      break;
    default:
      break;
  }
}

function onState(msg) {
  const prevPhase = S.room?.phase;
  const prevScore = S.match ? { ...S.match.score } : null;
  S.room = msg.room;
  S.you = msg.you;
  S.offset = msg.serverNow - Date.now();
  if (msg.chat) {
    S.chat = msg.chat;
    renderChat();
  }
  setUrlRoom(msg.room.code);

  if (msg.match) {
    const newTurn = msg.turnSeq !== S.turnSeq;
    S.match = msg.match;
    S.options = msg.options ?? null;
    S.myChoice = msg.myChoice ?? null;
    S.locked = msg.locked ?? [];
    S.timerEndsAt = msg.timerEndsAt;
    if (newTurn) ui.picking = null;
    S.turnSeq = msg.turnSeq;
  } else {
    S.match = null;
    S.options = null;
    S.myChoice = null;
    S.seenSeqs.clear();
    $('#feed').replaceChildren();
  }

  if (msg.room.phase === 'lobby') {
    flushReveal();
    showScreen('lobby');
    renderLobby();
    $('#overlay-ft').classList.add('hidden');
    return;
  }

  // New play-by-play arrived: replay it on the pitch, and hold back the commentary,
  // score and full-time screen until the replay gets there, so nothing is spoiled.
  if (msg.room.phase === 'over' && prevPhase !== 'over') S.ftDismissedFor = null;
  const entries = takeNewEntries(msg.feed || [], msg.fullFeed);
  const animate = !msg.fullFeed && entries.length > 0;
  if (msg.fullFeed) flushReveal();
  showScreen('match');
  if (animate && prevScore) S.shownScore = prevScore;
  const duration = renderMatch(animate ? entries.at(-1).events : null);
  const reveal = () => {
    appendFeed(entries, animate);
    S.shownScore = null;
    renderScoreboard();
    if (S.room?.phase === 'over') renderFulltime();
    else $('#overlay-ft').classList.add('hidden');
  };
  if (animate && duration > 0) scheduleReveal(reveal, duration);
  else if (entries.length || !S.pendingReveal) {
    flushReveal();
    reveal();
  }
  // Otherwise a replay is still running and its reveal will catch everything up.
}

function scheduleReveal(fn, ms) {
  flushReveal();
  S.pendingReveal = fn;
  S.revealTimer = setTimeout(() => {
    const f = S.pendingReveal;
    S.pendingReveal = null;
    f?.();
  }, ms);
}

function flushReveal() {
  clearTimeout(S.revealTimer);
  const f = S.pendingReveal;
  S.pendingReveal = null;
  f?.();
}

function setUrlRoom(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  if (url.href !== location.href) history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Screens

function showScreen(name) {
  for (const id of ['home', 'lobby', 'match']) $(`#screen-${id}`).classList.toggle('hidden', id !== name);
  const chatHome = name === 'lobby' ? '#chat-home-lobby' : name === 'match' ? '#chat-home-match' : null;
  const chat = $('#chat');
  if (chatHome) {
    if (chat.parentElement !== $(chatHome)) $(chatHome).append(chat);
    chat.classList.remove('hidden');
  } else {
    chat.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Lobby

function renderLobby() {
  const { room, you, catalog } = S;
  if (!catalog) return;
  $('#lobby-code').textContent = room.code;
  const nameInput = $('#lobby-name');
  if (document.activeElement !== nameInput) nameInput.value = S.name;
  for (const team of ['home', 'away']) {
    const box = $(`#slots-${team}`);
    box.replaceChildren(...catalog.roster.filter((r) => r.team === team).map((r) => slotCard(r, room.slots[r.slot])));
  }

  const form = $('#settings-form');
  const s = room.settings;
  const timerLabel = (t) => (t ? `${t}s per turn` : 'No timer');
  const field = (label, key, values, fmt) => {
    if (!you.isHost) return h('label', { class: 'field' }, label, h('div', { class: 'val' }, fmt(s[key])));
    const sel = h('select', {
      onchange: (e) => {
        const v = key === 'difficulty' ? e.target.value : Number(e.target.value);
        send('settings', { settings: { [key]: v } });
      },
    }, values.map((v) => h('option', { value: v, selected: v === s[key] }, fmt(v))));
    return h('label', { class: 'field' }, label, sel);
  };
  form.replaceChildren(
    field('Match length', 'maxTurns', catalog.turnOptions, (v) => `${v} turns`),
    field('Turn timer', 'turnTimer', catalog.timerOptions, timerLabel),
    field('AI difficulty', 'difficulty', catalog.difficulties, (v) => v[0].toUpperCase() + v.slice(1)),
  );

  const spec = room.spectators.filter((x) => x.connected).map((x) => x.name);
  $('#spectators').textContent = spec.length ? `Spectating: ${spec.join(', ')}` : '';

  const humans = room.slots.filter((x) => x.human);
  const homeH = humans.filter((x) => x.slot < 3).length;
  const awayH = humans.length - homeH;
  const desc = !humans.length
    ? 'Nobody has picked a player: the AI will play itself while you watch.'
    : `${homeH} human${homeH === 1 ? '' : 's'} on Street Kings, ${awayH} on Iron Vipers. AI fills the other ${6 - humans.length} seat${6 - humans.length === 1 ? '' : 's'}.`;
  const start = $('#start-area');
  start.replaceChildren(
    h('div', { class: 'muted small' }, desc),
    you.isHost
      ? h('button', { class: 'btn primary big', type: 'button', onclick: () => send('start') }, 'Start match')
      : h('div', { class: 'muted' }, 'Waiting for the host to start…'),
  );
}

function slotCard(r, slot) {
  const mine = slot.clientId === S.you.clientId;
  let occupant;
  if (!slot.clientId) occupant = h('span', { class: 'ai' }, 'Open. AI will play');
  else if (mine) occupant = h('span', { class: 'human' }, 'You');
  else if (!slot.connected) occupant = h('span', { class: 'offline' }, `${slot.name} (offline, AI covering)`);
  else occupant = h('span', { class: 'human' }, slot.name);
  const st = r.stats;
  let btn = null;
  if (mine) btn = h('button', { class: 'btn small ghost slot-btn', type: 'button', onclick: () => send('leaveSlot') }, 'Leave seat');
  else if (!slot.clientId) btn = h('button', { class: 'btn small slot-btn', type: 'button', onclick: () => send('takeSlot', { slot: r.slot }) }, `Play as ${r.name}`);
  return h('div', { class: `slot ${mine ? 'mine' : ''}` },
    h('div', { class: `avatar ${r.team}` }, initials(r.name)),
    h('div', {},
      h('div', { class: 'slot-name' }, r.name, h('span', { class: 'role' }, r.role)),
      h('div', { class: 'slot-special', title: r.specialDesc }, h('b', {}, r.specialName), ` · ${r.blurb}`),
      h('div', { class: 'statline' },
        ...[['SHO', st.sho], ['PAS', st.pas], ['SPD', st.spd], ['DEF', st.def], ['PWR', st.pwr], ['STA', r.maxStamina]]
          .map(([k, v]) => h('span', {}, `${k} `, h('b', {}, v)))),
      h('div', { class: 'slot-occupant' }, occupant),
    ),
    btn,
  );
}

// ---------------------------------------------------------------------------
// Match

function renderMatch(playback = null) {
  renderScoreboard();
  const duration = renderPitch(playback);
  renderYou();
  renderActions();
  renderRosters();
  return duration;
}

function renderScoreboard() {
  const m = S.match;
  const score = S.shownScore ?? m.score;
  $('#sb-home').textContent = score.home;
  $('#sb-away').textContent = score.away;
  const over = m.phase === 'over';
  $('#sb-clock').textContent = over ? 'FT' : `${m.minute}'`;
  $('#sb-turn').textContent = over ? `Full time · ${m.maxTurns} turns` : `Turn ${m.turn}/${m.maxTurns} · ${m.half === 1 ? '1st' : '2nd'} half`;
  const ts = m.teamStats;
  const total = ts.home.possession + ts.away.possession;
  const homePct = total ? Math.round((ts.home.possession / total) * 100) : 50;
  $('#poss-home').style.width = `${homePct}%`;
  const carrier = m.players[m.ballCarrier];
  $('#poss-label').textContent = over
    ? `Possession ${homePct}% to ${100 - homePct}%`
    : `${carrier.name} has the ball · possession ${homePct}% to ${100 - homePct}%`;
  tickTimer();
}

function tickTimer() {
  const bar = $('#timer-bar');
  const text = $('#timer-text');
  const total = (S.room?.settings.turnTimer || 0) * 1000;
  if (!S.timerEndsAt || !total || S.match?.phase !== 'choosing') {
    bar.style.width = '0';
    text.textContent = S.room?.phase === 'match' && !total ? 'No turn timer' : '';
    return;
  }
  const left = Math.max(0, S.timerEndsAt - (Date.now() + S.offset));
  bar.style.width = `${(left / total) * 100}%`;
  bar.classList.toggle('low', left < 6000);
  text.textContent = `${Math.ceil(left / 1000)}s left`;
}
setInterval(tickTimer, 250);

// ---- pitch ----------------------------------------------------------------
// The pitch is either the 3D scene (three.js, loaded on demand) or the flat SVG one.

const has3D = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
})();
let pitch = null;
let pitchLoading = null;
const pitchHandlers = {
  onPlayerClick: (idx) => onPlayerClick(idx),
  onMarkerClick: (dir) => choose({ type: 'dribble', dir }),
  onGoal: (e) => showGoal(e),
};

function wantedView() {
  return S.view === '3d' && has3D ? '3d' : '2d';
}

function ensurePitch() {
  if (pitch && pitch.kind === wantedView()) return Promise.resolve(pitch);
  if (pitchLoading) return pitchLoading;
  pitchLoading = (async () => {
    pitch?.dispose();
    pitch = null;
    const el = $('#pitch');
    if (wantedView() === '3d') {
      try {
        const mod = await import('./pitch3d.js');
        pitch = mod.createPitch3D(el, pitchHandlers);
        pitch.setCamera(S.cam);
      } catch (err) {
        console.warn('3D pitch unavailable, using 2D', err);
        S.view = '2d';
      }
    }
    if (!pitch) pitch = createPitch2D(el, pitchHandlers);
    renderPitchTools();
    return pitch;
  })().finally(() => {
    pitchLoading = null;
  });
  return pitchLoading;
}

function renderPitchTools() {
  const box = $('#pitch-tools');
  const seg = (items, active, onPick) => h('div', { class: 'seg' }, items.map(([key, label, title]) => h('button', {
    class: `seg-btn ${key === active ? 'on' : ''}`, type: 'button', title, 'aria-pressed': key === active ? 'true' : 'false',
    onclick: () => onPick(key),
  }, label)));
  const kids = [];
  if (has3D) {
    kids.push(seg([['3d', '3D'], ['2d', '2D']], wantedView(), (v) => {
      S.view = v;
      store.set('is-view', v);
      ensurePitch().then(() => renderPitch());
    }));
  }
  if (pitch?.kind === '3d') {
    kids.push(seg([
      ['follow', 'Follow ball', 'Broadcast camera that follows the ball'],
      ['me', 'Behind me', 'Over-the-shoulder view of your player'],
      ['wide', 'Wide', 'The whole pitch'],
      ['top', 'Top', "Bird's-eye view"],
      ['free', 'Free', 'Drag to orbit, scroll or pinch to zoom'],
    ], S.cam, (c) => {
      S.cam = c;
      store.set('is-cam', c);
      pitch.setCamera(c);
      renderPitchTools();
    }));
  }
  box.replaceChildren(...kids);
}

// Returns how long (ms) the pitch needs to replay `playback`.
function renderPitch(playback = null) {
  if (!S.match) return 0;
  if (!pitch || pitch.kind !== wantedView()) {
    ensurePitch().then(() => renderPitch());
    return 0;
  }
  const opt = ui.picking && S.options?.actions.find((a) => a.type === ui.picking);
  const markers = (opt?.variants || []).map((v) => ({ x: v.dest.x, y: v.dest.y, chance: v.chance, label: v.label, dir: v.dir }));
  const targets = pickingTargets();
  const duration = pitch.update({ match: S.match, youSlot: S.you?.slot ?? -1, targets, markers, playback });
  const hint = $('#pitch-hint');
  if (targets.size) hint.textContent = 'Click a highlighted player (or pick from the list) to choose your target.';
  else if (markers.length) hint.textContent = 'Click a yellow ring (or pick from the list) to choose where to dribble.';
  else hint.textContent = pitch.kind === '3d' && S.cam === 'free' ? 'Drag to orbit · scroll or pinch to zoom' : '';
  return duration;
}

function pickingTargets() {
  if (!ui.picking || !S.options) return new Set();
  const opt = S.options.actions.find((a) => a.type === ui.picking);
  return new Set((opt?.targets || []).map((t) => t.target));
}

function onPlayerClick(idx) {
  if (!pickingTargets().has(idx)) return;
  choose({ type: ui.picking, target: idx });
}

// ---- your card -----------------------------------------------------------

function renderYou() {
  const box = $('#you-card');
  const m = S.match;
  const slot = S.you?.slot ?? -1;
  if (slot === -1) {
    box.replaceChildren(h('div', { class: 'you-head' },
      h('div', { class: 'avatar', style: 'background:#334155' }, '👀'),
      h('div', {}, h('div', { class: 'you-name' }, 'Spectating'), h('div', { class: 'you-sub' }, 'Grab an AI seat below to jump in.'))));
    return;
  }
  const p = m.players[slot];
  const r = S.catalog.roster[slot];
  const low = p.stamina < 25;
  const chips = [];
  if (m.ballCarrier === p.idx) chips.push(h('span', { class: 'chip ball' }, '⚽ On the ball'));
  if (p.grounded) chips.push(h('span', { class: 'chip bad' }, '💤 On the floor'));
  if (p.dazed) chips.push(h('span', { class: 'chip warn' }, '💫 Dazed −12%'));
  if (low) chips.push(h('span', { class: 'chip bad' }, 'Gassed −10%'));
  chips.push(h('span', { class: `chip ${p.cd.special ? '' : 'good'}`, title: r.specialDesc }, `★ ${p.specialName}: ${p.cd.special ? `ready in ${p.cd.special}` : 'ready'}`));
  chips.push(h('span', { class: `chip ${p.cd.power ? '' : 'good'}` }, `Power Shot: ${p.cd.power ? `ready in ${p.cd.power}` : 'ready'}`));
  box.replaceChildren(
    h('div', { class: 'you-head' },
      h('div', { class: `avatar ${p.team}` }, initials(p.name)),
      h('div', {},
        h('div', { class: 'you-name' }, `${p.name} `, h('span', { class: 'muted small' }, p.role)),
        h('div', { class: 'you-sub' }, `${teamName(p.team)} · ${plural(p.record.goals, 'goal')} · ${plural(p.record.tacklesWon, 'tackle')} won`))),
    h('div', { class: 'bar-label' }, h('span', {}, 'Stamina'), h('span', {}, `${p.stamina}/${p.maxStamina}`)),
    h('div', { class: `bar ${low ? 'low' : ''}` }, h('div', { style: `width:${(p.stamina / p.maxStamina) * 100}%` })),
    h('div', { class: 'stats-grid' }, ...[['SHO', p.stats.sho], ['PAS', p.stats.pas], ['SPD', p.stats.spd], ['DEF', p.stats.def], ['PWR', p.stats.pwr]]
      .map(([k, v]) => h('div', {}, h('b', {}, v), k))),
    h('div', { class: 'chips' }, chips),
  );
}

// ---- actions ---------------------------------------------------------------

function choose(action) {
  ui.picking = null;
  send('choose', { action });
}

function renderActions() {
  const box = $('#actions');
  const m = S.match;
  box.replaceChildren();
  if (m.phase === 'over') {
    box.append(h('div', { class: 'actions-title' }, 'Full time'), h('p', { class: 'muted' }, 'The final whistle has gone. (Just kidding, there is no whistle.)'));
    return;
  }
  const slot = S.you?.slot ?? -1;
  if (slot === -1) {
    box.append(h('div', { class: 'actions-title' }, "You're watching"));
    const open = S.room.slots.filter((x) => !x.clientId);
    if (open.length) {
      box.append(h('p', { class: 'muted small' }, 'These seats are being played by the AI. Take one over:'),
        h('div', { class: 'spectate-slots' }, open.map((x) => {
          const r = S.catalog.roster[x.slot];
          return h('button', { class: 'btn', type: 'button', onclick: () => send('takeSlot', { slot: x.slot }) }, `Play as ${r.name} (${teamName(r.team)})`);
        })));
    } else {
      box.append(h('p', { class: 'muted small' }, 'Every seat is taken by a human.'));
    }
    return;
  }

  const opts = S.options;
  if (!opts) return;
  const waiting = S.room.slots.filter((x) => x.human && !S.locked.includes(x.slot) && x.slot !== slot).map((x) => x.name);
  const head = h('div', { class: 'actions-head' },
    h('div', { class: 'actions-title' }, S.myChoice ? 'Locked in' : m.ballCarrier === slot ? 'You have the ball!' : m.possession === m.players[slot].team ? 'Your team has the ball' : 'Defend!'),
    h('div', { class: 'muted small' }, `Turn ${m.turn}`));
  box.append(head);

  if (S.myChoice) {
    const forced = opts.forced;
    box.append(h('div', { class: 'locked' },
      h('div', { class: 'locked-box' }, '✔ ', h('b', {}, describeChoice(S.myChoice))),
      h('div', { class: 'waiting-list' }, waiting.length ? `Waiting for ${waiting.join(', ')}…` : 'Resolving…'),
      forced ? h('div', { class: 'muted small' }, 'You were knocked down, so you get up this turn.') : h('button', { class: 'btn small ghost', type: 'button', onclick: () => send('unchoose') }, 'Change my move'),
    ));
    return;
  }

  const list = h('div', { class: 'act-list' });
  const desc = h('div', { class: 'act-desc' }, 'Hover a move to see what it does. Percentages are estimates: opponents choose at the same time.');

  if (ui.picking) {
    const opt = opts.actions.find((a) => a.type === ui.picking);
    if (!opt) {
      ui.picking = null;
      return renderActions();
    }
    list.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => { ui.picking = null; renderActions(); renderPitch(); } }, '← Back'));
    if (opt.targets) {
      for (const t of opt.targets) {
        const sub = [`${t.m}m away`];
        if (t.steal) sub.push('has the ball: steal it');
        else if (opt.type === 'tackle' || opt.special === 'rocket') sub.push('flatten them');
        if (t.carrier) sub.push('ball carrier');
        list.append(actButton({
          name: `${opt.name} → ${t.name}`,
          meta: sub.join(' · '),
          chance: t.chance,
          onclick: () => choose({ type: opt.type, target: t.target }),
        }));
      }
    } else if (opt.variants) {
      for (const v of opt.variants) {
        list.append(actButton({
          name: `${opt.name}: ${v.label}`,
          meta: `${Math.abs(v.dest.x - m.players[slot].x)} cells upfield`,
          chance: v.chance,
          onclick: () => choose({ type: 'dribble', dir: v.dir }),
        }));
      }
    }
    desc.textContent = opt.desc;
  } else {
    for (const a of opts.actions) {
      const needsPick = (a.targets && a.targets.length) || (a.variants && a.variants.length);
      const metaBits = [];
      if (a.cost) metaBits.push(`${a.cost} stamina`);
      if (a.m != null) metaBits.push(`${a.m}m from goal`);
      if (!a.enabled && a.reason) metaBits.push(a.reason);
      let chance = a.chance ?? null;
      if (needsPick && a.enabled) {
        const best = Math.max(...(a.targets || a.variants).map((x) => x.chance ?? -1));
        chance = best >= 0 ? { best } : null;
      }
      const btn = actButton({
        name: a.name,
        meta: metaBits.join(' · '),
        chance,
        more: needsPick && a.enabled,
        special: a.type === 'special',
        disabled: !a.enabled,
        onclick: () => {
          if (needsPick) {
            ui.picking = a.type;
            renderActions();
            renderPitch();
          } else {
            choose({ type: a.type });
          }
        },
      });
      btn.addEventListener('mouseenter', () => { desc.textContent = a.desc; });
      btn.addEventListener('focus', () => { desc.textContent = a.desc; });
      list.append(btn);
    }
  }
  box.append(list, desc);
  if (waiting.length) box.append(h('div', { class: 'waiting-list', style: 'margin-top:8px' }, `Still choosing: ${waiting.join(', ')}`));
}

function actButton({ name, meta, chance, more, special, disabled, onclick }) {
  let oddsEl;
  if (chance && typeof chance === 'object') oddsEl = h('span', { class: `a-odds more` }, `up to ${chance.best}% ›`);
  else if (typeof chance === 'number') oddsEl = h('span', { class: `a-odds ${oddsClass(chance)}` }, `${chance}%`);
  else oddsEl = h('span', { class: 'a-odds more' }, more ? '›' : '');
  return h('button', { class: `act ${special ? 'special' : ''}`, type: 'button', disabled: !!disabled, onclick },
    h('span', { class: 'a-name' }, name),
    oddsEl,
    meta ? h('span', { class: 'a-meta' }, meta) : null,
  );
}

function describeChoice(c) {
  const opt = S.options?.actions.find((a) => a.type === c.type);
  if (!opt) return c.type;
  if (c.target != null) {
    const t = opt.targets?.find((x) => x.target === c.target);
    return `${opt.name} → ${t?.name ?? '?'}${t?.chance != null ? ` (~${t.chance}%)` : ''}`;
  }
  if (c.dir) {
    const v = opt.variants?.find((x) => x.dir === c.dir);
    return `${opt.name}: ${v?.label ?? c.dir}${v ? ` (~${v.chance}%)` : ''}`;
  }
  return `${opt.name}${opt.chance != null ? ` (~${opt.chance}%)` : ''}`;
}

// ---- rosters ---------------------------------------------------------------

function renderRosters() {
  const m = S.match;
  const box = $('#rosters');
  box.replaceChildren(...['home', 'away'].map((team) => h('div', { class: `roster-team ${team}` },
    h('h4', {}, teamName(team)),
    ...m.players.filter((p) => p.team === team).map((p) => {
      const slot = S.room.slots[p.idx];
      let who;
      if (p.idx === S.you?.slot) who = 'You';
      else if (slot.human) who = slot.name;
      else if (slot.clientId) who = `${slot.name} (offline) · AI`;
      else who = 'AI';
      const lock = slot.human && m.phase === 'choosing'
        ? h('span', { class: `lock ${S.locked.includes(p.idx) ? 'done' : 'wait'}` }, S.locked.includes(p.idx) ? '✔ ready' : '… choosing')
        : null;
      const bits = [p.role, who, `★ ${p.cd.special ? p.cd.special : 'ready'}`];
      if (p.grounded) bits.push('💤 down');
      if (p.dazed) bits.push('💫 dazed');
      if (m.ballCarrier === p.idx) bits.push('⚽');
      return h('div', { class: 'r-row' },
        h('div', { class: 'r-name' }, p.name, lock),
        h('div', { class: 'r-bar' },
          h('div', { class: `bar ${p.stamina < 25 ? 'low' : ''}` }, h('div', { style: `width:${(p.stamina / p.maxStamina) * 100}%` })),
          h('div', { class: 'r-sta' }, `${p.stamina} sta`)),
        h('div', { class: 'r-sub' }, bits.join(' · ')),
      );
    }))));

  const hc = $('#host-controls');
  hc.replaceChildren();
  if (S.you?.isHost && S.room.phase === 'match') {
    hc.append(h('button', {
      class: 'btn small danger', type: 'button',
      onclick: () => { if (confirm('End this match for everyone and go back to the lobby?')) send('abort'); },
    }, 'End match'));
  }
  if (S.you?.slot !== -1 && S.room.phase === 'match') {
    hc.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => send('leaveSlot') }, 'Hand my seat to the AI'));
  }
  hc.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => send('leaveRoom') }, 'Leave room'));
}

// ---- feed ------------------------------------------------------------------

// Feed entries we haven't shown yet (all of them on a full refresh).
function takeNewEntries(entries, full) {
  if (full) {
    $('#feed').replaceChildren();
    S.seenSeqs.clear();
  }
  const fresh = entries.filter((e) => !S.seenSeqs.has(e.seq));
  for (const e of fresh) S.seenSeqs.add(e.seq);
  return fresh;
}

function appendFeed(entries, highlight) {
  const feed = $('#feed');
  for (const entry of entries) {
    feed.prepend(h('li', { class: `turn-block ${highlight ? 'fresh' : ''}` },
      h('div', { class: 't-min' }, entry.seq === 0 ? 'KICK-OFF' : `${entry.minute}'`),
      entry.events.map(renderEvent)));
  }
}

function renderEvent(e) {
  const cls = ['ev'];
  if (e.team) cls.push(e.team);
  if (e.kind === 'turnHeader') cls.push('header');
  if (e.minor) cls.push('minor');
  if (e.big) cls.push('big');
  if (e.goal) cls.push('goal');
  const li = h('div', { class: cls.join(' ') }, e.text);
  if (e.chance != null) {
    li.append(h('span', { class: `roll ${e.ok ? 'ok' : 'no'}`, title: 'Success chance vs the dice (0–99). Under the chance = success.' },
      `${e.label} ${e.chance}% · rolled ${e.roll} ${e.ok ? '✔' : '✘'}`));
  }
  return li;
}

let goalTimer = null;
function showGoal(e) {
  const b = $('#goal-banner');
  const scorer = S.match.players[e.actor];
  b.replaceChildren('GOAL!', h('small', {}, `${scorer?.name ?? ''} · ${teamName(e.team)}`));
  b.style.color = e.team === 'home' ? '#93c5fd' : '#fca5a5';
  b.classList.remove('hidden');
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  clearTimeout(goalTimer);
  goalTimer = setTimeout(() => b.classList.add('hidden'), 2300);
}

// ---- full time ---------------------------------------------------------------

function renderFulltime() {
  const ov = $('#overlay-ft');
  if (S.ftDismissedFor === S.turnSeq) {
    ov.classList.add('hidden');
    return;
  }
  const m = S.match;
  const { home, away } = m.score;
  const ts = m.teamStats;
  const totalPoss = ts.home.possession + ts.away.possession || 1;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const mySide = S.you.slot === -1 ? null : m.players[S.you.slot].team;
  let title = 'FULL-TIME';
  if (mySide) title = home === away ? 'DRAW' : (home > away) === (mySide === 'home') ? 'VICTORY' : 'DEFEAT';
  const scorers = (team) => m.players.filter((p) => p.team === team && p.record.goals)
    .map((p) => `${p.name}${p.record.goals > 1 ? ` ×${p.record.goals}` : ''}`).join(', ') || '–';
  const mvpScore = (p) => p.record.goals * 3 + p.record.tacklesWon + p.record.steals * 0.5 + p.record.passesDone * 0.4;
  const mvp = m.players.slice().sort((a, b) => mvpScore(b) - mvpScore(a))[0];
  const row = (label, a, b) => h('tr', {}, h('td', {}, a), h('td', { class: 'lbl' }, label), h('td', {}, b));
  const isHost = S.you.isHost;
  $('#ft-card').replaceChildren(
    h('div', { class: 'ft-title', id: 'ft-title' }, title),
    h('div', { class: 'ft-score' },
      h('div', { class: 'home' }, h('div', { class: 't' }, teamName('home')), h('div', { class: 'n' }, home)),
      h('div', { class: 'muted' }, '–'),
      h('div', { class: 'away' }, h('div', { class: 't' }, teamName('away')), h('div', { class: 'n' }, away))),
    h('table', { class: 'ft-table' }, h('tbody', {},
      row('Scorers', scorers('home'), scorers('away')),
      row('Shots', ts.home.shots, ts.away.shots),
      row('On target', ts.home.onTarget, ts.away.onTarget),
      row('Passes completed', `${ts.home.passesDone}/${ts.home.passes}`, `${ts.away.passesDone}/${ts.away.passes}`),
      row('Tackles won', `${ts.home.tacklesWon}/${ts.home.tackles}`, `${ts.away.tacklesWon}/${ts.away.tackles}`),
      row('Possession', pct(ts.home.possession, totalPoss), pct(ts.away.possession, totalPoss)))),
    h('div', { class: 'ft-mvp' }, 'MVP: ', h('b', {}, `${mvp.name} (${teamName(mvp.team)})`),
      h('div', { class: 'muted small' }, `${plural(mvp.record.goals, 'goal')} · ${plural(mvp.record.tacklesWon, 'tackle')} won · ${plural(mvp.record.passesDone, 'pass')} completed`)),
    h('div', { class: 'ft-actions' },
      isHost ? h('button', { class: 'btn primary', type: 'button', onclick: () => send('start') }, 'Rematch') : null,
      isHost ? h('button', { class: 'btn', type: 'button', onclick: () => send('toLobby') }, 'Back to lobby') : h('span', { class: 'muted small' }, 'Waiting for the host to start a rematch…'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.ftDismissedFor = S.turnSeq; ov.classList.add('hidden'); } }, 'View pitch'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => send('leaveRoom') }, 'Leave room')),
  );
  ov.classList.remove('hidden');
}

// ---- chat ------------------------------------------------------------------

function renderChat() {
  const log = $('#chat-log');
  log.replaceChildren(...S.chat.map((c) => (c.from
    ? h('li', {}, h('span', { class: `who ${c.team || ''}` }, c.from), c.text)
    : h('li', { class: 'sys' }, c.text))));
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Wiring

function saveName(input = $('#name-input')) {
  const v = input.value.trim().slice(0, 16);
  if (!v || v === S.name) return;
  S.name = v;
  localStorage.setItem('is-name', v);
  $('#name-input').value = v;
  send('setName', { name: v });
}

$('#name-input').value = S.name;
$('#name-input').addEventListener('change', () => saveName());
$('#lobby-name').addEventListener('change', (e) => saveName(e.target));
$('#lobby-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
$('#btn-quick').addEventListener('click', () => {
  saveName();
  send('createRoom', { quick: true });
});
$('#btn-create').addEventListener('click', () => {
  saveName();
  send('createRoom');
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveName();
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Room codes are 4 letters.');
    return;
  }
  send('joinRoom', { code });
});
$('#btn-leave').addEventListener('click', () => send('leaveRoom'));
$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${S.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied. Send it to your friends!', 'info');
  } catch {
    prompt('Copy this invite link:', link);
  }
});
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  send('chat', { text });
  input.value = '';
});
$('#btn-help').addEventListener('click', () => $('#overlay-help').classList.remove('hidden'));
$('#btn-help-close').addEventListener('click', () => $('#overlay-help').classList.add('hidden'));
$('#overlay-help').addEventListener('click', (e) => {
  if (e.target.id === 'overlay-help') $('#overlay-help').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#overlay-help').classList.add('hidden');
    if (ui.picking) {
      ui.picking = null;
      if (S.match) {
        renderActions();
        renderPitch();
      }
    }
  }
});

// A duplicated browser tab inherits sessionStorage, so it would hijack the original
// tab's seat. Ask other tabs whether our identity is already live; if so, start fresh.
async function ensureUniqueIdentity() {
  if (!('BroadcastChannel' in window)) return;
  const bc = new BroadcastChannel('illegal-soccer-tabs');
  if (S.clientId) {
    const taken = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 150);
      bc.onmessage = (e) => {
        if (e.data?.type === 'iam' && e.data.id === S.clientId) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      bc.postMessage({ type: 'who', id: S.clientId });
    });
    if (taken) {
      S.clientId = null;
      S.token = null;
      sessionStorage.removeItem('is-client-id');
      sessionStorage.removeItem('is-token');
    }
  }
  bc.onmessage = (e) => {
    if (e.data?.type === 'who' && S.clientId && e.data.id === S.clientId) bc.postMessage({ type: 'iam', id: S.clientId });
  };
}

showScreen('home');
ensureUniqueIdentity().then(connect);
