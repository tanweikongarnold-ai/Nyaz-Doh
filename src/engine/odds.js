// Every success chance in the game is computed here, from distance, player stats and
// what the opponents chose to do this turn (marking, resting, being flattened...).
//
// A ctx is built per turn. With `choices` it reflects what everyone actually picked;
// without, it is an estimate (used for the % shown on buttons and by the AI).

import { FIELD, STAMINA } from './constants.js';
import { clampX, dir, dist, goalFor, segInfo } from './geometry.js';

export function makeCtx(state, choices = null) {
  return {
    state,
    choices,
    knocked: new Set(), // out of the play for the rest of this turn
    immune: new Set(), // Phantom Step: cannot be tackled or marked
    open: new Map(), // idx -> pass bonus for having made a run
    extraMarks: [], // { by, target, eff } from specials
    teamMod: { home: 0, away: 0 }, // Mind Read
    startPos: state.players.map((p) => ({ x: p.x, y: p.y })),
    moved: new Set(),
  };
}

export const isGrounded = (state, p) => p.groundedUntil >= state.turn;
export const isDazed = (state, p) => p.dazedUntil >= state.turn;

// Can this player influence play right now (pressure, intercept, mark)?
export function isActive(ctx, p) {
  if (ctx.knocked.has(p.idx) || isGrounded(ctx.state, p)) return false;
  const c = ctx.choices?.[p.idx];
  return !(c && (c.type === 'recover' || c.type === 'getup'));
}

export const defFactor = (p) => 0.7 + p.stats.def * 0.06;
export const opponentsOf = (state, team) => state.players.filter((o) => o.team !== team);
export const clampChance = (v) => Math.max(0.03, Math.min(0.95, v));

// How much defensive heat is on a spot, from the point of view of `team`.
export function pressureAt(ctx, point, team) {
  let total = 0;
  for (const o of opponentsOf(ctx.state, team)) {
    if (!isActive(ctx, o)) continue;
    const d = dist(o, point);
    const w = d <= 1.5 ? 1 : d <= 2.5 ? 0.5 : 0;
    total += w * defFactor(o);
  }
  return total;
}

// Marking starts from where the marker stood when the turn began: a mark from across
// the pitch is mostly shouting.
const markEff = (d) => (d <= 2 ? 1 : d <= 4 ? 0.6 : 0.3);

export function markPenalty(ctx, target) {
  if (ctx.immune.has(target.idx)) return 0;
  const { state, choices } = ctx;
  let total = 0;
  if (choices) {
    for (const o of opponentsOf(state, target.team)) {
      const c = choices[o.idx];
      if (!c || c.type !== 'mark' || c.target !== target.idx || !isActive(ctx, o)) continue;
      total += markEff(dist(ctx.startPos[o.idx], ctx.startPos[target.idx])) * defFactor(o);
    }
  }
  for (const m of ctx.extraMarks) {
    const by = state.players[m.by];
    if (m.target === target.idx && isActive(ctx, by)) total += m.eff * defFactor(by);
  }
  return total;
}

export function mods(ctx, p) {
  let m = ctx.teamMod[p.team];
  if (isDazed(ctx.state, p)) m -= 0.12;
  if (p.stamina < STAMINA.GASSED_AT) m -= 0.1;
  return m;
}

export function shotChance(ctx, p, kind = 'shoot', pos = p) {
  const d = dist(pos, goalFor(p.team));
  const s = p.stats;
  const press = pressureAt(ctx, pos, p.team);
  const mark = markPenalty(ctx, p);
  const angle = pos.y !== 1 ? 1 : 0;
  let c;
  switch (kind) {
    case 'power':
      c = 0.55 - 0.055 * d + (s.pwr - 5) * 0.03 + (s.sho - 5) * 0.01 - 0.05 * press - 0.05 * mark - 0.02 * angle;
      break;
    case 'inferno':
      c = 0.8 - 0.1 * d + (s.sho - 5) * 0.03 - 0.03 * angle;
      break;
    case 'venom':
      c = 0.56 - 0.035 * d + (s.sho - 5) * 0.03 - 0.04 * press - 0.04 * mark;
      break;
    default:
      c = 0.82 - 0.1 * d + (s.sho - 5) * 0.03 - 0.1 * press - 0.1 * mark - 0.04 * angle;
  }
  return clampChance(c + mods(ctx, p));
}

export function passInfo(ctx, passer, receiver) {
  const d = dist(passer, receiver);
  const interceptors = [];
  for (const o of opponentsOf(ctx.state, passer.team)) {
    if (!isActive(ctx, o)) continue;
    const { d: sd, t } = segInfo(o, passer, receiver);
    if (t <= 0.1 || t >= 0.9) continue;
    const w = sd <= 0.6 ? 1 : sd <= 1.2 ? 0.6 : 0;
    if (w) interceptors.push({ idx: o.idx, w: w * defFactor(o) });
  }
  const lane = interceptors.reduce((sum, i) => sum + i.w, 0);
  const c = 0.96
    - 0.03 * d
    + (passer.stats.pas - 5) * 0.025
    - 0.04 * pressureAt(ctx, passer, passer.team)
    - 0.13 * markPenalty(ctx, receiver)
    - 0.12 * lane
    + (ctx.open.get(receiver.idx) || 0);
  return { chance: clampChance(c + mods(ctx, passer)), interceptors, d };
}

export const dribbleLength = (p) => (p.stats.spd >= 8 ? 3 : 2);
export const runLength = (p) => (p.stats.spd >= 8 ? 4 : 3);

export function dribbleDest(p, variant) {
  const m = dribbleLength(p);
  const dx = dir(p.team);
  if (variant === 'fwd') return { x: clampX(p.x + m * dx), y: p.y };
  const y = variant === 'up' ? p.y - 1 : variant === 'down' ? p.y + 1 : -1;
  if (y < 0 || y >= FIELD.LANES) return null;
  return { x: clampX(p.x + (m - 1) * dx), y };
}

export function dribbleChance(ctx, p, dest) {
  const c = 0.84
    + (p.stats.spd - 5) * 0.03
    - 0.09 * pressureAt(ctx, p, p.team)
    - 0.07 * pressureAt(ctx, dest, p.team)
    - 0.1 * markPenalty(ctx, p);
  return clampChance(c + mods(ctx, p));
}

export function tackleChance(ctx, t, v, rocket = false) {
  const d = dist(t, v);
  const stealing = ctx.state.ballCarrier === v.idx;
  const ts = t.stats, vs = v.stats;
  let c = stealing
    ? 0.4 + (ts.def - 5) * 0.05 - (vs.spd - 5) * 0.04 + (ts.pwr - vs.pwr) * 0.01
    : 0.62 + (ts.def - 5) * 0.03 - (vs.spd - 5) * 0.03 + (ts.pwr - vs.pwr) * 0.03;
  c -= (rocket ? 0.05 : 0.13) * Math.max(0, d - 1.5);
  return clampChance(c + mods(ctx, t));
}

// Pick the forward spot with the least defensive heat.
export function openSpot(ctx, p, x) {
  let best = null;
  for (const y of [p.y, p.y - 1, p.y + 1]) {
    if (y < 0 || y >= FIELD.LANES) continue;
    const heat = pressureAt(ctx, { x, y }, p.team) + (y !== p.y ? 0.05 : 0);
    if (!best || heat < best.heat) best = { x, y, heat };
  }
  return { x: best.x, y: best.y };
}

export const runDest = (ctx, p) => openSpot(ctx, p, clampX(p.x + runLength(p) * dir(p.team)));
