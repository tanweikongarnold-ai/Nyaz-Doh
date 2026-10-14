// The match engine. Pure game logic, no networking: create a match, list a player's
// options for this turn, and resolve a turn once everyone has chosen.
//
// Every player chooses at the same time. A turn then resolves in phases:
//   0. Mind Read          (instant, affects every roll this turn)
//   1. Other specials     (fastest player first)
//   2. Slide tackles      (fastest player first; getting flattened cancels your action)
//   3. Runs and marking
//   4. The ball carrier's action (dribble / pass / shoot / power shot / special shot)
//   5. Everyone else drifts into position
//   6. Stamina, cooldowns, clock

import { ACTIONS, FIELD, ROSTER, SPECIALS, STAMINA, TEAMS } from './constants.js';
import { clampX, dir, dist, goalFor, meters, other, zoneName } from './geometry.js';
import * as odds from './odds.js';
import { joinNames, say } from './commentary.js';
import { shuffle } from './rng.js';

const ROLE_ORDER = { FWD: 0, MID: 1, DEF: 2 };
const BALL_ACTIONS = new Set(['dribble', 'pass', 'shoot', 'power']);

// [columns back from the centre line, lane]
const KICKOFF_LAYOUT = {
  attack: { FWD: [0, 0], MID: [0, 1], DEF: [3, 2] },
  defend: { FWD: [1, 1], MID: [3, 0], DEF: [4, 2] },
};

const emptyTeamStats = () => ({
  shots: 0, onTarget: 0, goals: 0, passes: 0, passesDone: 0, tackles: 0, tacklesWon: 0, possession: 0,
});

export function createMatch({ maxTurns = 20, kickoff = null, rng = Math.random } = {}) {
  const players = ROSTER.map((r, idx) => ({
    idx,
    id: r.id,
    name: r.name,
    team: r.team,
    role: r.role,
    stats: { ...r.stats },
    special: r.special,
    maxStamina: r.maxStamina,
    stamina: r.maxStamina,
    x: FIELD.CENTER_X,
    y: 1,
    cd: { power: 0, special: 0 },
    groundedUntil: 0,
    dazedUntil: 0,
    record: { goals: 0, shots: 0, passes: 0, passesDone: 0, tackles: 0, tacklesWon: 0, steals: 0 },
  }));
  const first = kickoff ?? (rng() < 0.5 ? 'home' : 'away');
  const state = {
    turn: 1,
    maxTurns,
    phase: 'choosing',
    score: { home: 0, away: 0 },
    possession: first,
    ballCarrier: 0,
    firstKickoff: first,
    players,
    teamStats: { home: emptyTeamStats(), away: emptyTeamStats() },
    events: [],
    lastChoices: null,
  };
  setKickoff(state, first);
  const kicker = players[state.ballCarrier];
  state.events = [
    { kind: 'kickoff', team: first, big: true, text: say('kickoff', { team: TEAMS[first].name, name: kicker.name }, rng) },
  ];
  return state;
}

export function setKickoff(state, team) {
  for (const p of state.players) {
    const [back, lane] = (p.team === team ? KICKOFF_LAYOUT.attack : KICKOFF_LAYOUT.defend)[p.role];
    p.x = clampX(FIELD.CENTER_X - dir(p.team) * back);
    p.y = lane;
  }
  giveBall(state, state.players.find((p) => p.team === team && p.role === 'MID').idx);
}

function giveBall(state, idx) {
  state.ballCarrier = idx;
  state.possession = state.players[idx].team;
}

export const matchMinute = (state) => Math.min(90, Math.round(((state.turn - 1) / state.maxTurns) * 90) + 1);

// ---------------------------------------------------------------------------
// Options: what a player may do this turn, with estimated success chances.

export function getOptions(state, idx) {
  const p = state.players[idx];
  if (state.phase !== 'choosing' || !p) return { actions: [] };
  const ctx = odds.makeCtx(state);
  const pct = (c) => Math.round(c * 100);
  const can = (cost) => p.stamina >= cost;
  const tired = (cost) => (can(cost) ? null : `Needs ${cost} stamina`);
  const action = (type, extra = {}) => {
    const def = ACTIONS[type];
    return { type, name: def.name, cost: def.cost ?? 0, desc: def.desc, enabled: true, reason: null, ...extra };
  };

  if (odds.isGrounded(state, p)) {
    return { forced: true, actions: [action('getup')] };
  }

  const hasBall = state.ballCarrier === idx;
  const attacking = state.possession === p.team;
  const teammates = state.players.filter((q) => q.team === p.team && q.idx !== idx);
  const opponents = odds.opponentsOf(state, p.team);
  const actions = [];

  const tackleTargets = (range, rocket) => opponents
    .filter((o) => !odds.isGrounded(state, o) && dist(p, o) <= range)
    .map((o) => ({
      target: o.idx,
      name: o.name,
      steal: state.ballCarrier === o.idx,
      chance: pct(odds.tackleChance(ctx, p, o, rocket)),
      m: meters(dist(p, o)),
    }));

  if (hasBall) {
    const variants = ['fwd', 'up', 'down']
      .map((d) => ({ dir: d, dest: odds.dribbleDest(p, d) }))
      .filter((v) => v.dest && (v.dest.x !== p.x || v.dest.y !== p.y))
      .map((v) => ({
        dir: v.dir,
        label: v.dir === 'fwd' ? 'Straight ahead' : v.dir === 'up' ? 'Cut to top lane' : 'Cut to bottom lane',
        dest: v.dest,
        chance: pct(odds.dribbleChance(ctx, p, v.dest)),
      }));
    actions.push(action('dribble', {
      variants,
      enabled: can(ACTIONS.dribble.cost) && variants.length > 0,
      reason: tired(ACTIONS.dribble.cost) ?? (variants.length ? null : 'No room to dribble'),
    }));

    const passTargets = teammates
      .filter((q) => !odds.isGrounded(state, q))
      .map((q) => ({ target: q.idx, name: q.name, chance: pct(odds.passInfo(ctx, p, q).chance), m: meters(dist(p, q)) }));
    // Passing is always allowed, even when exhausted, so the carrier can never get stuck.
    actions.push(action('pass', { targets: passTargets, enabled: passTargets.length > 0, reason: passTargets.length ? null : 'Nobody to pass to' }));

    const goalM = meters(dist(p, goalFor(p.team)));
    actions.push(action('shoot', { chance: pct(odds.shotChance(ctx, p, 'shoot')), m: goalM, enabled: can(ACTIONS.shoot.cost), reason: tired(ACTIONS.shoot.cost) }));
    actions.push(action('power', {
      chance: pct(odds.shotChance(ctx, p, 'power')),
      m: goalM,
      cooldown: p.cd.power,
      enabled: can(ACTIONS.power.cost) && p.cd.power === 0,
      reason: p.cd.power > 0 ? `Ready in ${p.cd.power}` : tired(ACTIONS.power.cost),
    }));
  } else if (attacking) {
    actions.push(action('run', { enabled: can(ACTIONS.run.cost), reason: tired(ACTIONS.run.cost) }));
    const targets = tackleTargets(ACTIONS.tackle.range, false);
    actions.push(action('tackle', {
      targets,
      enabled: can(ACTIONS.tackle.cost) && targets.length > 0,
      reason: tired(ACTIONS.tackle.cost) ?? (targets.length ? null : 'Nobody in range'),
    }));
  } else {
    const targets = tackleTargets(ACTIONS.tackle.range, false);
    actions.push(action('tackle', {
      targets,
      enabled: can(ACTIONS.tackle.cost) && targets.length > 0,
      reason: tired(ACTIONS.tackle.cost) ?? (targets.length ? null : 'Nobody in range'),
    }));
    const markTargets = opponents.map((o) => ({ target: o.idx, name: o.name, carrier: state.ballCarrier === o.idx, m: meters(dist(p, o)) }));
    actions.push(action('mark', { targets: markTargets, enabled: can(ACTIONS.mark.cost), reason: tired(ACTIONS.mark.cost) }));
  }

  // Special ability
  const spec = SPECIALS[p.special];
  const sp = { type: 'special', special: p.special, name: spec.name, cost: spec.cost, desc: spec.desc, cooldown: p.cd.special, enabled: true, reason: null };
  if (spec.needsBall && !hasBall) {
    sp.enabled = false;
    sp.reason = 'Need the ball';
  } else if (spec.noBall && hasBall) {
    sp.enabled = false;
    sp.reason = 'Not while carrying';
  }
  if (spec.shot && hasBall) {
    sp.chance = pct(odds.shotChance(ctx, p, p.special));
    sp.m = meters(dist(p, goalFor(p.team)));
  }
  if (spec.targeted) {
    sp.targets = tackleTargets(spec.range, true);
    if (sp.enabled && !sp.targets.length) {
      sp.enabled = false;
      sp.reason = 'Nobody in range';
    }
  }
  if (sp.enabled && p.cd.special > 0) {
    sp.enabled = false;
    sp.reason = `Ready in ${p.cd.special}`;
  } else if (sp.enabled && !can(spec.cost)) {
    sp.enabled = false;
    sp.reason = `Needs ${spec.cost} stamina`;
  }
  actions.push(sp);

  if (!hasBall) actions.push(action('recover'));
  return { actions };
}

// Returns a clean action if it is legal for this player right now, otherwise null.
export function validateAction(state, idx, action) {
  if (!action || typeof action !== 'object') return null;
  const opt = getOptions(state, idx).actions.find((a) => a.type === action.type);
  if (!opt || !opt.enabled) return null;
  const out = { type: opt.type };
  if (opt.targets) {
    const t = opt.targets.find((x) => x.target === action.target);
    if (!t) return null;
    out.target = t.target;
  }
  if (opt.variants) {
    const v = opt.variants.find((x) => x.dir === action.dir);
    if (!v) return null;
    out.dir = v.dir;
  }
  return out;
}

// Used when a choice is missing or illegal. Never fails.
export function defaultAction(state, idx) {
  const p = state.players[idx];
  if (odds.isGrounded(state, p)) return { type: 'getup' };
  if (state.ballCarrier !== idx) return { type: 'recover' };
  const mate = state.players
    .filter((q) => q.team === p.team && q.idx !== idx && !odds.isGrounded(state, q))
    .sort((a, b) => dist(p, a) - dist(p, b))[0];
  return mate ? { type: 'pass', target: mate.idx } : { type: 'shoot' };
}

// ---------------------------------------------------------------------------
// Turn resolution

export function resolveTurn(state, choicesIn = [], rng = Math.random) {
  if (state.phase !== 'choosing') throw new Error('Match is not accepting turns');
  const T = state.turn;
  const P = state.players;
  const choices = P.map((p) => validateAction(state, p.idx, choicesIn[p.idx]) ?? defaultAction(state, p.idx));
  const ctx = odds.makeCtx(state, choices);
  const events = [];
  const carrier0 = state.ballCarrier;

  const ev = (kind, vars = {}, extra = {}) => {
    const e = { kind, text: say(kind, vars, rng), ...extra };
    events.push(e);
    return e;
  };
  const roll = (chance) => {
    const r = rng();
    return { chance: Math.round(chance * 100), roll: Math.floor(r * 100), ok: r < chance, r };
  };
  const pay = (p, cost) => {
    p.stamina = Math.max(0, p.stamina - cost);
  };
  const useSpecial = (p) => {
    pay(p, SPECIALS[p.special].cost);
    p.cd.special = SPECIALS[p.special].cooldown;
  };
  const bySpeed = (list) => shuffle(rng, list).sort((a, b) => b.stats.spd - a.stats.spd);
  const chosen = (type, pred) => P.filter((p) => choices[p.idx].type === type && (!pred || pred(p)));
  const cancelled = (p) => {
    if (!ctx.knocked.has(p.idx)) return false;
    ev('cancelled', { name: p.name }, { actor: p.idx, team: p.team });
    return true;
  };
  const knock = (v, dmg) => {
    ctx.knocked.add(v.idx);
    v.dazedUntil = T + 1;
    pay(v, dmg);
  };
  const ground = (p) => {
    ctx.knocked.add(p.idx);
    p.groundedUntil = T + 1;
  };
  const at = (p) => ({ x: p.x, y: p.y });
  const moveTo = (p, pos) => {
    p.x = pos.x;
    p.y = pos.y;
    ctx.moved.add(p.idx);
  };
  // Hand the ball to whoever is nearest a spot. Players who are down can't reach it.
  const looseBall = (point, exclude = -1) => {
    const pool = P.filter((q) => q.idx !== exclude && !ctx.knocked.has(q.idx) && !odds.isGrounded(state, q));
    const list = (pool.length ? pool : P).slice();
    const winner = shuffle(rng, list).sort((a, b) => dist(a, point) - dist(b, point))[0];
    giveBall(state, winner.idx);
    return winner;
  };
  const goalKick = (team) => {
    const own = goalFor(other(team));
    const mates = P.filter((q) => q.team === team);
    const pool = mates.filter((q) => !ctx.knocked.has(q.idx) && !odds.isGrounded(state, q));
    const keeperOut = (pool.length ? pool : mates).sort((a, b) => dist(a, own) - dist(b, own))[0];
    giveBall(state, keeperOut.idx);
    return keeperOut;
  };

  {
    const c = P[carrier0];
    events.push({
      kind: 'turnHeader',
      team: c.team,
      text: say('turnHeader', { minute: matchMinute(state), name: c.name, team: TEAMS[c.team].name, m: meters(dist(c, goalFor(c.team))) }, rng),
    });
  }

  // --- Phase 0: Mind Read -------------------------------------------------
  for (const p of chosen('special', (q) => q.special === 'mindread')) {
    useSpecial(p);
    ctx.teamMod[p.team] += 0.1;
    ctx.teamMod[other(p.team)] -= 0.1;
    ev('mindread', { name: p.name, team: TEAMS[p.team].name, opp: TEAMS[other(p.team)].name }, { actor: p.idx, team: p.team, big: true });
  }

  // --- Phase 1: specials ---------------------------------------------------
  for (const p of bySpeed(chosen('special', (q) => ['phantom', 'stomp', 'rocket'].includes(q.special)))) {
    if (cancelled(p)) continue;
    useSpecial(p);
    if (p.special === 'phantom') doPhantom(p);
    else if (p.special === 'stomp') doStomp(p);
    else doTackle(p, P[choices[p.idx].target], true);
  }

  // --- Phase 2: slide tackles ---------------------------------------------
  for (const p of bySpeed(chosen('tackle'))) {
    if (cancelled(p)) continue;
    pay(p, ACTIONS.tackle.cost);
    doTackle(p, P[choices[p.idx].target], false);
  }

  // --- Phase 3: runs and marking -----------------------------------------
  for (const p of chosen('run')) {
    if (cancelled(p)) continue;
    pay(p, ACTIONS.run.cost);
    moveTo(p, odds.runDest(ctx, p));
    ctx.open.set(p.idx, 0.08);
    ev('run', { name: p.name, zone: zoneName(p.team, p) }, { actor: p.idx, team: p.team });
  }
  const markLines = [];
  for (const p of chosen('mark')) {
    if (cancelled(p)) continue;
    pay(p, ACTIONS.mark.cost);
    markLines.push(`${p.name} → ${P[choices[p.idx].target].name}`);
  }
  if (markLines.length) {
    const team = P.find((p) => choices[p.idx].type === 'mark').team;
    ev('marks', { list: markLines.join(', ') }, { team, minor: true });
  }

  // --- Phase 4: the ball ---------------------------------------------------
  let scored = null;
  {
    const c = P[carrier0];
    const cc = choices[carrier0];
    const ballAction = BALL_ACTIONS.has(cc.type) || (cc.type === 'special' && SPECIALS[c.special].shot);
    if (ballAction) {
      if (ctx.knocked.has(carrier0)) {
        // Lost the ball (or got flattened) before acting; the tackle line already told the story.
        if (state.ballCarrier === carrier0) ev('cancelled', { name: c.name }, { actor: c.idx, team: c.team });
      } else if (state.ballCarrier === carrier0) {
        if (cc.type === 'dribble') doDribble(c, cc.dir);
        else if (cc.type === 'pass') doPass(c, P[cc.target]);
        else if (cc.type === 'special') {
          useSpecial(c);
          scored = doShot(c, c.special);
        } else {
          pay(c, ACTIONS[cc.type].cost);
          if (cc.type === 'power') c.cd.power = ACTIONS.power.cooldown;
          scored = doShot(c, cc.type);
        }
      }
    }
  }

  // --- Phase 5: positioning -------------------------------------------------
  if (scored) {
    setKickoff(state, other(scored));
  } else {
    reposition(state, ctx, choices);
  }

  // --- Phase 6: upkeep ----------------------------------------------------
  const rested = [];
  const gotUp = [];
  for (const p of P) {
    const type = choices[p.idx].type;
    let gain = STAMINA.REGEN;
    if (type === 'recover' && !ctx.knocked.has(p.idx)) {
      gain += STAMINA.RECOVER_BONUS;
      rested.push(p.name);
    } else if (type === 'getup') {
      gain += STAMINA.GETUP_BONUS;
      gotUp.push(p.name);
    }
    p.stamina = Math.min(p.maxStamina, p.stamina + gain);
    if (p.cd.power > 0) p.cd.power--;
    if (p.cd.special > 0) p.cd.special--;
  }
  if (gotUp.length) ev('getup', { list: joinNames(gotUp) }, { minor: true });
  if (rested.length) ev('recover', { list: joinNames(rested) }, { minor: true });

  state.teamStats[state.possession].possession++;
  const half = Math.ceil(state.maxTurns / 2);
  if (T >= state.maxTurns) {
    state.phase = 'over';
    const { home, away } = state.score;
    const verdict = home === away
      ? 'Honours even. Nobody wins, everybody limps.'
      : `${TEAMS[home > away ? 'home' : 'away'].name} win it!`;
    ev('fulltime', { home: TEAMS.home.name, away: TEAMS.away.name, hs: home, as: away, verdict }, { big: true });
  } else {
    if (T === half) {
      setKickoff(state, other(state.firstKickoff));
      for (const p of P) p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA.HALFTIME_BONUS);
      ev('halftime', { home: TEAMS.home.name, away: TEAMS.away.name, hs: state.score.home, as: state.score.away }, { big: true });
    }
    state.turn = T + 1;
  }
  state.events = events;
  state.lastChoices = choices;
  return events;

  // ---- action implementations (hoisted; they close over the turn's state) ----

  // Events carry animation hints for the 3D view: `path` is how the ball travelled,
  // `holder` who ended up with it, `slide`/`teleport` how a player moved.
  function doTackle(t, v, rocket) {
    const m = meters(dist(t, v));
    const slide = { from: at(t), to: at(v) };
    const vars = { name: t.name, target: v.name, m, team: TEAMS[t.team].name };
    t.record.tackles++;
    state.teamStats[t.team].tackles++;
    if (ctx.knocked.has(v.idx)) {
      moveTo(t, v);
      ev('tackleNoTarget', vars, { actor: t.idx, team: t.team, target: v.idx, slide });
      return;
    }
    if (ctx.immune.has(v.idx)) {
      moveTo(t, v);
      if (!rocket) ground(t);
      ev('tackleImmune', vars, { actor: t.idx, team: t.team, target: v.idx, slide });
      return;
    }
    const stealing = state.ballCarrier === v.idx;
    const res = roll(odds.tackleChance(ctx, t, v, rocket));
    const crit = res.ok && res.r < (res.chance / 100) * 0.25;
    moveTo(t, v);
    const info = { actor: t.idx, team: t.team, target: v.idx, slide, chance: res.chance, roll: res.roll, ok: res.ok, label: rocket ? 'Rocket Slide' : 'Slide tackle' };
    if (res.ok) {
      t.record.tacklesWon++;
      state.teamStats[t.team].tacklesWon++;
      knock(v, crit ? 18 : 10);
      if (stealing) {
        giveBall(state, t.idx);
        t.record.steals++;
        ev(rocket ? 'rocketSteal' : crit ? 'tackleStealCrit' : 'tackleSteal', vars, { ...info, big: true, holder: t.idx });
      } else {
        ev(rocket ? 'rocketKnock' : crit ? 'tackleKnockCrit' : 'tackleKnock', vars, { ...info, big: crit || rocket });
      }
    } else {
      if (!rocket) ground(t);
      ev(rocket ? 'rocketMiss' : stealing ? 'tackleMissBall' : 'tackleMiss', vars, info);
    }
  }

  function doStomp(b) {
    ev('stomp', { name: b.name }, { actor: b.idx, team: b.team, big: true });
    const victims = P.filter((o) => o.team !== b.team && !ctx.knocked.has(o.idx) && !odds.isGrounded(state, o) && dist(b, o) <= 2.5);
    if (!victims.length) {
      ev('stompWhiff', { name: b.name }, { actor: b.idx, team: b.team });
      return;
    }
    const hit = [];
    const hitIdx = [];
    let carrierHit = false;
    for (const o of victims) {
      if (ctx.immune.has(o.idx)) {
        ev('stompDodge', { target: o.name }, { actor: o.idx, team: o.team });
        continue;
      }
      const res = roll(dist(b, o) <= 1.5 ? 0.8 : 0.5);
      if (!res.ok) continue;
      knock(o, 12);
      hit.push(o.name);
      hitIdx.push(o.idx);
      if (state.ballCarrier === o.idx) carrierHit = true;
    }
    if (hit.length) ev('stompResult', { list: joinNames(hit) }, { actor: b.idx, team: b.team, victims: hitIdx });
    else ev('stompWhiff', { name: b.name }, { actor: b.idx, team: b.team });
    if (carrierHit) {
      giveBall(state, b.idx);
      ev('stompSteal', { name: b.name }, { actor: b.idx, team: b.team, big: true, holder: b.idx });
    }
  }

  function doPhantom(n) {
    const from = at(n);
    if (state.ballCarrier === n.idx) {
      moveTo(n, odds.openSpot(ctx, n, clampX(n.x + 4 * dir(n.team))));
      ctx.immune.add(n.idx);
      ev('phantomBall', { name: n.name, m: meters(dist(from, n)) }, {
        actor: n.idx, team: n.team, big: true, teleport: { from, to: at(n) }, path: [{ from, to: at(n), style: 'blink' }],
      });
    } else if (state.possession === n.team) {
      moveTo(n, odds.openSpot(ctx, n, clampX(n.x + 5 * dir(n.team))));
      ctx.immune.add(n.idx);
      ctx.open.set(n.idx, 0.15);
      ev('phantomRun', { name: n.name, zone: zoneName(n.team, n) }, { actor: n.idx, team: n.team, big: true, teleport: { from, to: at(n) } });
    } else {
      const c = P[state.ballCarrier];
      moveTo(n, { x: clampX(c.x + dir(c.team)), y: c.y });
      ctx.extraMarks.push({ by: n.idx, target: c.idx, eff: 1.5 });
      ev('phantomDefend', { name: n.name, target: c.name }, { actor: n.idx, team: n.team, big: true, target: c.idx, teleport: { from, to: at(n) } });
    }
  }

  function doDribble(c, variant) {
    pay(c, ACTIONS.dribble.cost);
    const from = { x: c.x, y: c.y };
    const dest = odds.dribbleDest(c, variant);
    const res = roll(odds.dribbleChance(ctx, c, dest));
    const info = { actor: c.idx, team: c.team, chance: res.chance, roll: res.roll, ok: res.ok, label: 'Dribble' };
    if (res.ok) {
      moveTo(c, dest);
      ev('dribbleOk', { name: c.name, m: meters(dist(from, dest)), zone: zoneName(c.team, dest) }, { ...info, path: [{ from, to: dest, style: 'carry' }] });
      return;
    }
    const thieves = odds.opponentsOf(state, c.team)
      .filter((o) => odds.isActive(ctx, o) && dist(o, c) <= 2.5)
      .sort((a, b) => dist(a, c) - dist(b, c) || b.stats.def - a.stats.def);
    if (res.r < res.chance / 100 + 0.15 || !thieves.length) {
      ev('dribbleHeld', { name: c.name }, info);
      return;
    }
    const thief = thieves[0];
    giveBall(state, thief.idx);
    thief.record.steals++;
    ev('dribbleLost', { name: c.name, target: thief.name }, { ...info, target: thief.idx, holder: thief.idx });
  }

  function doPass(c, r) {
    pay(c, ACTIONS.pass.cost);
    c.record.passes++;
    state.teamStats[c.team].passes++;
    if (ctx.knocked.has(r.idx)) {
      const got = looseBall(r, r.idx);
      ev('passToDowned', { name: c.name, receiver: r.name, target: got.name }, {
        actor: c.idx, team: c.team, ok: false, label: 'Pass', target: r.idx, holder: got.idx,
        path: [{ from: at(c), to: at(r), style: 'pass' }, { from: at(r), to: at(got), style: 'loose' }],
      });
      return;
    }
    const { chance, interceptors } = odds.passInfo(ctx, c, r);
    const res = roll(chance);
    const info = { actor: c.idx, team: c.team, target: r.idx, chance: res.chance, roll: res.roll, ok: res.ok, label: 'Pass' };
    const style = dist(c, r) > 5 ? 'loft' : 'pass';
    if (res.ok) {
      giveBall(state, r.idx);
      c.record.passesDone++;
      state.teamStats[c.team].passesDone++;
      ev(ctx.open.has(r.idx) ? 'passThrough' : 'passOk', { name: c.name, target: r.name, m: meters(dist(c, r)) }, {
        ...info, holder: r.idx, path: [{ from: at(c), to: at(r), style }],
      });
      return;
    }
    // Who gets it? Defenders in the lane, the receiver's markers, or whoever is closest.
    const weights = new Map();
    for (const i of interceptors) weights.set(i.idx, (weights.get(i.idx) || 0) + i.w);
    for (const o of odds.opponentsOf(state, c.team)) {
      if (!odds.isActive(ctx, o)) continue;
      const mc = choices[o.idx];
      if (mc.type === 'mark' && mc.target === r.idx) weights.set(o.idx, (weights.get(o.idx) || 0) + 0.8);
      const d = dist(o, r);
      if (d <= 3) weights.set(o.idx, (weights.get(o.idx) || 0) + (3 - d) * 0.25);
    }
    if (!weights.size) {
      const got = looseBall(r, r.idx);
      ev('passLoose', { name: c.name, target: got.name }, {
        ...info, holder: got.idx, path: [{ from: at(c), to: at(r), style: 'loft' }, { from: at(r), to: at(got), style: 'loose' }],
      });
      return;
    }
    let total = 0;
    for (const w of weights.values()) total += w;
    let pickR = rng() * total;
    let thief = null;
    for (const [idx, w] of weights) {
      pickR -= w;
      thief = P[idx];
      if (pickR <= 0) break;
    }
    giveBall(state, thief.idx);
    thief.record.steals++;
    ev('passIntercepted', { name: c.name, receiver: r.name, target: thief.name }, {
      ...info, holder: thief.idx, path: [{ from: at(c), to: at(thief), style }],
    });
  }

  // Returns the scoring team, or null.
  function doShot(c, kind) {
    const d = dist(c, goalFor(c.team));
    const m = meters(d);
    const res = roll(odds.shotChance(ctx, c, kind));
    const label = kind === 'shoot' ? 'Shot' : kind === 'power' ? 'Power Shot' : SPECIALS[kind].name;
    const info = { actor: c.idx, team: c.team, chance: res.chance, roll: res.roll, ok: res.ok, label };
    c.record.shots++;
    state.teamStats[c.team].shots++;
    // Where the ball ends up, for the animation. Deterministic so it doesn't disturb the dice.
    const g = goalFor(c.team);
    const dx = dir(c.team);
    const aim = (((state.turn * 37 + c.idx * 11) % 7) - 3) / 10; // -0.3..0.3 lanes off-centre
    const side = aim >= 0 ? 1 : -1;
    const keeperSpot = { x: g.x - dx * 0.15, y: 1 };
    if (res.ok) {
      c.record.goals++;
      state.score[c.team]++;
      state.teamStats[c.team].goals++;
      state.teamStats[c.team].onTarget++;
      ev(`goal_${kind}`, { name: c.name, m }, { ...info, big: true, goal: true, path: [{ from: at(c), to: { x: g.x + dx * 0.3, y: 1 + aim }, style: kind }] });
      return c.team;
    }
    const defTeam = other(c.team);
    const blockers = odds.opponentsOf(state, c.team).filter((o) => odds.isActive(ctx, o) && dist(o, c) <= 1.5);
    const blockOdds = kind === 'power' ? 0.3 : kind === 'shoot' ? 0.45 : 0.2;
    if (blockers.length && kind !== 'inferno' && rng() < blockOdds) {
      const b = blockers[Math.floor(rng() * blockers.length)];
      if (kind === 'power') pay(b, 8);
      giveBall(state, b.idx);
      ev('shotBlocked', { name: c.name, target: b.name, m }, { ...info, target: b.idx, holder: b.idx, path: [{ from: at(c), to: at(b), style: 'deflect' }] });
    } else if (res.r < res.chance / 100 + 0.08) {
      const got = looseBall({ x: g.x - dx, y: 1 });
      const post = { x: g.x, y: 1 + side * 0.4 };
      ev('shotPost', { name: c.name, target: got.name, m }, {
        ...info, holder: got.idx, path: [{ from: at(c), to: post, style: kind }, { from: post, to: at(got), style: 'loose' }],
      });
    } else if (res.r < res.chance / 100 + 0.4) {
      state.teamStats[c.team].onTarget++;
      const k = goalKick(defTeam);
      ev('shotSaved', { name: c.name, m }, { ...info, save: true, path: [{ from: at(c), to: { x: keeperSpot.x, y: 1 + aim * 0.8 }, style: kind }] });
      ev('restartGoalKick', { target: k.name, team: TEAMS[defTeam].name }, {
        team: defTeam, minor: true, holder: k.idx, path: [{ from: keeperSpot, to: at(k), style: 'loft' }],
      });
    } else {
      const k = goalKick(defTeam);
      ev('shotWide', { name: c.name, m }, { ...info, path: [{ from: at(c), to: { x: g.x + dx * 0.8, y: 1 + side * 0.75 }, style: kind }] });
      ev('restartGoalKick', { target: k.name, team: TEAMS[defTeam].name }, {
        team: defTeam, minor: true, holder: k.idx, path: [{ from: keeperSpot, to: at(k), style: 'loft' }],
      });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Off-ball movement. Attackers spread out ahead of and behind the ball; defenders
// press the carrier and cover the runners goal-side. Markers stick to their mark.

function reposition(state, ctx, choices) {
  const P = state.players;
  const att = state.possession;
  const dA = dir(att);
  const carrier = P[state.ballCarrier];
  const free = (p) => p.idx !== carrier.idx && !ctx.moved.has(p.idx) && !ctx.knocked.has(p.idx) && !odds.isGrounded(state, p);
  const reach = (p) => {
    if (choices[p.idx].type === 'recover') return 1;
    return Math.max(1, (p.stats.spd >= 8 ? 3 : 2) - (p.stamina < STAMINA.GASSED_AT ? 1 : 0));
  };

  // Attackers
  const offBall = P.filter((p) => p.team === att && p.idx !== carrier.idx).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const lanes = [0, 1, 2].filter((l) => l !== carrier.y);
  const adv = clampX(carrier.x + 3 * dA);
  const layouts = [
    [{ x: adv, y: lanes[0] }, { x: clampX(carrier.x - dA), y: lanes[1] }],
    [{ x: adv, y: lanes[1] }, { x: clampX(carrier.x - dA), y: lanes[0] }],
  ];
  const attSpots = bestAssignment(offBall, layouts.flatMap((l) => [l, [l[1], l[0]]]));
  offBall.forEach((p, i) => {
    if (free(p) && choices[p.idx].type !== 'mark') stepToward(p, attSpots[i], reach(p));
  });

  // Defenders
  const defenders = P.filter((p) => p.team !== att);
  const coverSpots = [{ x: clampX(carrier.x + dA), y: carrier.y }, ...offBall.map((a) => ({ x: clampX(a.x + dA), y: a.y }))];
  const perms = permutations(coverSpots);
  const defSpots = bestAssignment(defenders, perms);
  defenders.forEach((p, i) => {
    if (!free(p)) return;
    const c = choices[p.idx];
    if (c.type === 'mark') {
      const t = P[c.target];
      stepToward(p, { x: clampX(t.x + dir(t.team)), y: t.y }, reach(p) + 1);
    } else {
      stepToward(p, defSpots[i], reach(p));
    }
  });
}

function bestAssignment(players, spotLists) {
  let best = null;
  let bestCost = Infinity;
  for (const spots of spotLists) {
    const cost = players.reduce((sum, p, i) => sum + dist(p, spots[i]), 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = spots;
    }
  }
  return best;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]));
}

function stepToward(p, target, steps) {
  for (let i = 0; i < steps; i++) {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    if (!dx && !dy) return;
    if (dx && Math.abs(dx) >= Math.abs(dy) * FIELD.LANE_W) p.x += Math.sign(dx);
    else p.y += Math.sign(dy);
  }
}

// ---------------------------------------------------------------------------
// What clients get to see. Choices stay secret until the turn resolves.

export function publicState(state) {
  return {
    turn: state.turn,
    maxTurns: state.maxTurns,
    minute: matchMinute(state),
    half: state.turn <= Math.ceil(state.maxTurns / 2) ? 1 : 2,
    phase: state.phase,
    score: { ...state.score },
    possession: state.possession,
    ballCarrier: state.ballCarrier,
    teamStats: structuredClone(state.teamStats),
    events: state.events,
    lastChoices: state.lastChoices,
    players: state.players.map((p) => ({
      idx: p.idx,
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      stats: p.stats,
      special: p.special,
      specialName: SPECIALS[p.special].name,
      x: p.x,
      y: p.y,
      stamina: p.stamina,
      maxStamina: p.maxStamina,
      cd: { ...p.cd },
      grounded: odds.isGrounded(state, p),
      dazed: odds.isDazed(state, p),
      record: { ...p.record },
    })),
  };
}
