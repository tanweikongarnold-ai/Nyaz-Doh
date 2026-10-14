// AI for every player nobody is controlling (and for humans who run out the clock).
// It reads the same estimated odds the human sees on the buttons, then weighs
// "score now" against "set up a better chance next turn".

import { SPECIALS, STAMINA } from './constants.js';
import { dist, goalFor } from './geometry.js';
import { getOptions } from './match.js';
import * as odds from './odds.js';

const PROFILES = {
  easy: { noise: 0.22, blunder: 0.15, tackleAt: 0.38, specialRate: 0.45, patience: 0.6 },
  normal: { noise: 0.08, blunder: 0.04, tackleAt: 0.46, specialRate: 0.75, patience: 0.75 },
  hard: { noise: 0.02, blunder: 0, tackleAt: 0.5, specialRate: 1, patience: 0.8 },
};

export function chooseAction(state, idx, difficulty = 'normal', rng = Math.random) {
  const prof = PROFILES[difficulty] || PROFILES.normal;
  const opts = getOptions(state, idx);
  const enabled = opts.actions.filter((a) => a.enabled);
  if (!enabled.length) return { type: 'recover' };
  if (opts.forced) return { type: enabled[0].type };
  if (rng() < prof.blunder) return randomAction(enabled, rng);

  const p = state.players[idx];
  const ctx = odds.makeCtx(state);
  const helpers = { state, p, ctx, prof, rng, enabled, get: (type) => enabled.find((a) => a.type === type) };
  if (state.ballCarrier === idx) return carrierAI(helpers);
  if (state.possession === p.team) return supportAI(helpers);
  return defenderAI(helpers);
}

function randomAction(enabled, rng) {
  const a = enabled[Math.floor(rng() * enabled.length)];
  const out = { type: a.type };
  if (a.targets?.length) out.target = a.targets[Math.floor(rng() * a.targets.length)].target;
  if (a.variants?.length) out.dir = a.variants[Math.floor(rng() * a.variants.length)].dir;
  return out;
}

// Best shot (any kind) this player could take from a spot.
function shotPotential(ctx, p, pos) {
  let best = Math.max(odds.shotChance(ctx, p, 'shoot', pos), odds.shotChance(ctx, p, 'power', pos) * 0.9);
  if (SPECIALS[p.special].shot && p.cd.special <= 1) best = Math.max(best, odds.shotChance(ctx, p, p.special, pos) * 0.9);
  return best;
}

function carrierAI({ state, p, ctx, prof, rng, get }) {
  const noise = () => (rng() * 2 - 1) * prof.noise;
  const cands = [];
  const staminaAfter = (cost) => p.stamina - cost;

  for (const type of ['shoot', 'power']) {
    const a = get(type);
    if (!a) continue;
    let v = a.chance / 100;
    if (type === 'power' && staminaAfter(a.cost) < STAMINA.GASSED_AT) v *= 0.85;
    cands.push({ v: v + noise(), action: { type } });
  }
  const sp = get('special');
  if (sp && rng() < prof.specialRate) {
    if (SPECIALS[p.special].shot) {
      cands.push({ v: sp.chance / 100 + 0.03 + noise(), action: { type: 'special' } });
    } else if (p.special === 'phantom') {
      const dest = odds.openSpot(ctx, p, Math.max(1, Math.min(11, p.x + 4 * (p.team === 'home' ? 1 : -1))));
      cands.push({ v: shotPotential(ctx, p, dest) * prof.patience + 0.05 + noise(), action: { type: 'special' } });
    } else if (p.special === 'stomp' && odds.pressureAt(ctx, p, p.team) >= 1.8) {
      cands.push({ v: 0.35 + noise(), action: { type: 'special' } });
    }
  }

  const pass = get('pass');
  for (const t of pass?.targets || []) {
    const r = state.players[t.target];
    const future = shotPotential(ctx, r, r);
    cands.push({ v: (t.chance / 100) * future * prof.patience + noise(), action: { type: 'pass', target: t.target } });
  }
  const dribble = get('dribble');
  for (const vnt of dribble?.variants || []) {
    const future = shotPotential(ctx, p, vnt.dest);
    cands.push({ v: (vnt.chance / 100) * future * prof.patience + noise(), action: { type: 'dribble', dir: vnt.dir } });
  }
  cands.sort((a, b) => b.v - a.v);
  return cands[0]?.action ?? { type: 'pass', target: pass?.targets[0]?.target };
}

function supportAI({ state, p, ctx, prof, rng, get }) {
  const carrier = state.players[state.ballCarrier];
  if (p.stamina < 18 && get('recover')) return { type: 'recover' };

  const sp = get('special');
  if (sp && rng() < prof.specialRate) {
    if (p.special === 'phantom' && rng() < 0.4) return { type: 'special' };
    if (p.special === 'mindread' && shotPotential(ctx, carrier, carrier) >= 0.35) return { type: 'special' };
    if (p.special === 'stomp') {
      const near = odds.opponentsOf(state, p.team).filter((o) => dist(o, p) <= 2.5 && !odds.isGrounded(state, o));
      if (near.length >= 2 || near.some((o) => dist(o, carrier) <= 1.5)) return { type: 'special' };
    }
    if (p.special === 'rocket') {
      const t = sp.targets.filter((x) => x.chance >= 55).sort((a, b) => b.chance - a.chance)[0];
      if (t && rng() < 0.35) return { type: 'special', target: t.target };
    }
  }

  // Bodyguard: flatten whoever is breathing down the carrier's neck.
  const tackle = get('tackle');
  if (tackle && p.stamina > 45) {
    const threat = tackle.targets
      .filter((t) => dist(state.players[t.target], carrier) <= 1.5 && t.chance >= 50)
      .sort((a, b) => b.chance - a.chance)[0];
    if (threat && rng() < 0.3) return { type: 'tackle', target: threat.target };
  }

  if (p.role === 'DEF' && rng() < 0.6 && get('recover')) return { type: 'recover' };
  const nearGoal = dist(p, goalFor(p.team)) <= 2.3;
  if (nearGoal && rng() < 0.5 && get('recover')) return { type: 'recover' };
  if (get('run')) return { type: 'run' };
  return { type: 'recover' };
}

function defenderAI({ state, p, ctx, prof, rng, get }) {
  const carrier = state.players[state.ballCarrier];
  const danger = shotPotential(ctx, carrier, carrier);
  const mates = state.players.filter((q) => q.team === p.team && !odds.isGrounded(state, q));

  // Specials first: they're the big swings.
  const sp = get('special');
  if (sp && rng() < prof.specialRate) {
    if (p.special === 'stomp' && dist(p, carrier) <= 2.5) return { type: 'special' };
    if (p.special === 'rocket') {
      const t = sp.targets.find((x) => x.target === carrier.idx);
      if (t && t.chance >= 50 && (danger >= 0.25 || dist(p, carrier) > 2)) return { type: 'special', target: t.target };
    }
    if (p.special === 'mindread' && danger >= 0.3) return { type: 'special' };
    if (p.special === 'phantom' && danger >= 0.32 && dist(p, carrier) > 3) return { type: 'special' };
  }

  // The teammate with the best tackle odds on the carrier is the presser.
  const tackleOdds = (q) => (q.stamina >= 14 ? odds.tackleChance(ctx, q, carrier) : 0) - (dist(q, carrier) > 5 ? 1 : 0);
  const presser = mates.slice().sort((a, b) => tackleOdds(b) - tackleOdds(a))[0];
  const tackle = get('tackle');
  const mark = get('mark');

  if (presser?.idx === p.idx) {
    const t = tackle?.targets.find((x) => x.target === carrier.idx);
    const want = prof.tackleAt - (danger >= 0.4 ? 0.08 : 0);
    if (t && t.chance / 100 >= want && p.stamina >= 22) return { type: 'tackle', target: carrier.idx };
    if (mark) return { type: 'mark', target: carrier.idx };
    return { type: 'recover' };
  }

  if (p.stamina < 18 && danger < 0.35 && get('recover')) return { type: 'recover' };

  // Everyone else picks up the most dangerous runner the others aren't on.
  const others = mates.filter((q) => q.idx !== presser?.idx).sort((a, b) => a.idx - b.idx);
  const threats = odds.opponentsOf(state, p.team)
    .filter((o) => o.idx !== carrier.idx)
    .sort((a, b) => dist(a, goalFor(a.team)) - dist(b, goalFor(b.team)));
  const rank = others.findIndex((q) => q.idx === p.idx);
  const assignment = threats[rank] ?? threats[0] ?? carrier;

  if (tackle && p.stamina > 40 && rng() < 0.2) {
    const t = tackle.targets.find((x) => x.target === assignment.idx && x.chance >= 58);
    if (t) return { type: 'tackle', target: t.target };
  }
  if (mark) return { type: 'mark', target: assignment.idx };
  return { type: 'recover' };
}
