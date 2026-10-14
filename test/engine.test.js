import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIELD, chooseAction, createMatch, getOptions, mulberry32, publicState, resolveTurn, validateAction,
} from '../src/engine/index.js';
import * as odds from '../src/engine/odds.js';

const fixed = (v) => () => v; // rng that always returns v: 0 = every roll succeeds, 0.999 = every roll fails
const BLAZE = 0, NOVA = 1, BRUTUS = 2, VIPER = 3, GHOST = 4, RAZOR = 5;

function place(m, idx, x, y) {
  m.players[idx].x = x;
  m.players[idx].y = y;
}
function giveTo(m, idx) {
  m.ballCarrier = idx;
  m.possession = m.players[idx].team;
}
// Everyone recovers unless told otherwise; the carrier passes or shoots as given.
function choicesWith(m, overrides) {
  return m.players.map((p) => overrides[p.idx] ?? (m.ballCarrier === p.idx ? { type: 'shoot' } : { type: 'recover' }));
}

test('createMatch sets up a 3v3 kickoff', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(1) });
  assert.equal(m.players.length, 6);
  assert.deepEqual(m.players.map((p) => p.team), ['home', 'home', 'home', 'away', 'away', 'away']);
  assert.equal(m.ballCarrier, NOVA, 'home midfielder kicks off');
  assert.equal(m.possession, 'home');
  assert.equal(m.turn, 1);
  for (const p of m.players) {
    assert.ok(p.x >= FIELD.MIN_X && p.x <= FIELD.MAX_X);
    assert.ok(p.y >= 0 && p.y <= 2);
    assert.equal(p.stamina, p.maxStamina);
  }
  for (const p of m.players.filter((q) => q.team === 'home')) assert.ok(p.x <= 6, 'home starts in own half');
  for (const p of m.players.filter((q) => q.team === 'away')) assert.ok(p.x >= 6, 'away starts in own half');
});

test('options depend on role: carrier, off-ball attacker, defender', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(2) });
  const types = (idx) => getOptions(m, idx).actions.map((a) => a.type);
  assert.deepEqual(types(NOVA), ['dribble', 'pass', 'shoot', 'power', 'special']);
  assert.deepEqual(types(BLAZE), ['run', 'tackle', 'special', 'recover']);
  assert.deepEqual(types(VIPER), ['tackle', 'mark', 'special', 'recover']);

  const shoot = getOptions(m, NOVA).actions.find((a) => a.type === 'shoot');
  assert.ok(shoot.chance > 0 && shoot.chance < 100);
  const pass = getOptions(m, NOVA).actions.find((a) => a.type === 'pass');
  assert.deepEqual(pass.targets.map((t) => t.target).sort(), [BLAZE, BRUTUS]);

  const inferno = getOptions(m, BLAZE).actions.find((a) => a.type === 'special');
  assert.equal(inferno.enabled, false, 'Inferno Drive needs the ball');
});

test('shots get harder with distance and pressure, power shots less so', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(3) });
  giveTo(m, BLAZE);
  for (const o of [VIPER, GHOST, RAZOR]) place(m, o, 1, 0); // far away
  const ctx = () => odds.makeCtx(m);
  place(m, BLAZE, 10, 1);
  const close = odds.shotChance(ctx(), m.players[BLAZE], 'shoot');
  place(m, BLAZE, 5, 1);
  const far = odds.shotChance(ctx(), m.players[BLAZE], 'shoot');
  const farPower = odds.shotChance(ctx(), m.players[BLAZE], 'power');
  assert.ok(close > far + 0.3, `close ${close} vs far ${far}`);
  assert.ok(farPower > far, 'power shot beats a placed shot from range');

  place(m, BLAZE, 10, 1);
  place(m, RAZOR, 11, 1);
  const pressured = odds.shotChance(ctx(), m.players[BLAZE], 'shoot');
  assert.ok(pressured < close, 'a defender in your face lowers the odds');
});

test('marking (an opponent action) lowers pass odds to the marked player', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(4) });
  place(m, BLAZE, 10, 0);
  place(m, RAZOR, 11, 0); // right next to Blaze, but not in the passing lane
  // Same situation twice; the only difference is who Razor chose to mark.
  const choices = m.players.map(() => ({ type: 'recover' }));
  choices[RAZOR] = { type: 'mark', target: NOVA };
  const free = odds.passInfo(odds.makeCtx(m, choices), m.players[NOVA], m.players[BLAZE]).chance;
  choices[RAZOR] = { type: 'mark', target: BLAZE };
  const marked = odds.passInfo(odds.makeCtx(m, choices), m.players[NOVA], m.players[BLAZE]).chance;
  assert.ok(marked < free, `marked ${marked} vs free ${free}`);
});

test('validateAction rejects illegal moves', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(5) });
  assert.equal(validateAction(m, NOVA, { type: 'pass', target: VIPER }), null, 'cannot pass to an opponent');
  assert.equal(validateAction(m, NOVA, { type: 'tackle', target: VIPER }), null, 'carrier cannot tackle');
  assert.equal(validateAction(m, VIPER, { type: 'shoot' }), null, 'defender cannot shoot');
  assert.equal(validateAction(m, NOVA, { type: 'dribble', dir: 'sideways' }), null);
  assert.equal(validateAction(m, NOVA, null), null);
  assert.deepEqual(validateAction(m, NOVA, { type: 'pass', target: BLAZE, junk: 1 }), { type: 'pass', target: BLAZE });
  m.players[NOVA].cd.power = 1;
  assert.equal(validateAction(m, NOVA, { type: 'power' }), null, 'power shot on cooldown');
});

test('a goal updates the score and the conceding team kicks off', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(6) });
  giveTo(m, BLAZE);
  place(m, BLAZE, 11, 1);
  const events = resolveTurn(m, choicesWith(m, { [BLAZE]: { type: 'shoot' } }), fixed(0));
  assert.equal(m.score.home, 1);
  assert.equal(m.players[BLAZE].record.goals, 1);
  assert.ok(events.some((e) => e.goal && e.kind === 'goal_shoot'));
  assert.equal(m.possession, 'away');
  assert.equal(m.ballCarrier, GHOST, 'away midfielder kicks off');
  assert.equal(m.turn, 2);
});

test('successful slide tackle steals the ball and dazes the victim', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(7) });
  place(m, RAZOR, m.players[NOVA].x + 1, m.players[NOVA].y);
  const choices = choicesWith(m, { [NOVA]: { type: 'pass', target: BLAZE }, [RAZOR]: { type: 'tackle', target: NOVA } });
  const events = resolveTurn(m, choices, fixed(0));
  assert.equal(m.ballCarrier, RAZOR);
  assert.equal(m.possession, 'away');
  assert.ok(m.players[NOVA].dazedUntil >= m.turn, 'victim is dazed next turn');
  assert.ok(events.some((e) => e.kind.startsWith('tackleSteal')));
  assert.ok(!events.some((e) => e.kind === 'passOk'), "the carrier's pass never happens");
});

test('missed slide tackle leaves the tackler on the floor next turn', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(8) });
  place(m, RAZOR, m.players[NOVA].x + 1, m.players[NOVA].y);
  const choices = choicesWith(m, { [NOVA]: { type: 'pass', target: BLAZE }, [RAZOR]: { type: 'tackle', target: NOVA } });
  resolveTurn(m, choices, fixed(0.999));
  assert.equal(m.possession, 'home');
  const opts = getOptions(m, RAZOR);
  assert.equal(opts.forced, true);
  assert.deepEqual(opts.actions.map((a) => a.type), ['getup']);
});

test('flattening a pass receiver makes the pass fail', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(9) });
  place(m, VIPER, m.players[BLAZE].x + 1, m.players[BLAZE].y);
  const choices = choicesWith(m, { [NOVA]: { type: 'pass', target: BLAZE }, [VIPER]: { type: 'tackle', target: BLAZE } });
  const events = resolveTurn(m, choices, fixed(0));
  assert.ok(events.some((e) => e.kind === 'passToDowned'));
  assert.notEqual(m.ballCarrier, BLAZE);
});

test('Earthquake Stomp flattens nearby opponents and cancels their moves', () => {
  const m = createMatch({ kickoff: 'away', rng: mulberry32(10) });
  // Ghost has the ball. Put Brutus right next to Ghost and Viper.
  place(m, GHOST, 6, 1);
  place(m, VIPER, 6, 0);
  place(m, BRUTUS, 5, 1);
  const choices = choicesWith(m, { [BRUTUS]: { type: 'special' }, [VIPER]: { type: 'run' }, [GHOST]: { type: 'shoot' } });
  const events = resolveTurn(m, choices, fixed(0));
  assert.ok(events.some((e) => e.kind === 'stomp'));
  assert.equal(m.ballCarrier, BRUTUS, 'Brutus scoops up the loose ball');
  assert.ok(events.some((e) => e.kind === 'cancelled' && e.actor === VIPER));
  assert.equal(m.players[BRUTUS].cd.special, 4, 'cooldown 5, ticked once at end of turn');
});

test('power shot cooldown and stamina cost apply', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(11) });
  giveTo(m, BLAZE);
  place(m, BLAZE, 8, 1);
  const before = m.players[BLAZE].stamina;
  resolveTurn(m, choicesWith(m, { [BLAZE]: { type: 'power' } }), fixed(0.999));
  assert.equal(m.players[BLAZE].cd.power, 1);
  assert.equal(m.players[BLAZE].stamina, before - 22 + 5);
});

test('invalid choices fall back to a safe default instead of crashing', () => {
  const m = createMatch({ kickoff: 'home', rng: mulberry32(12) });
  const events = resolveTurn(m, [{ type: 'nonsense' }, { type: 'shoot', target: 99 }, null, undefined, 5, 'x'], mulberry32(1));
  assert.ok(events.length > 0);
  assert.equal(m.turn, 2);
});

test('full AI matches keep the game state valid', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(seed);
    const difficulty = ['easy', 'normal', 'hard'][seed % 3];
    const m = createMatch({ maxTurns: 16, rng });
    let turns = 0;
    while (m.phase === 'choosing') {
      const choices = m.players.map((p) => chooseAction(m, p.idx, difficulty, rng));
      choices.forEach((c, i) => assert.ok(validateAction(m, i, c), `AI picked an illegal move ${JSON.stringify(c)} (seed ${seed})`));
      const events = resolveTurn(m, choices, rng);
      turns++;
      for (const e of events) assert.ok(!/\{\w+\}/.test(e.text), `unfilled placeholder: ${e.text}`);
      assert.equal(m.players[m.ballCarrier].team, m.possession);
      for (const p of m.players) {
        assert.ok(p.x >= FIELD.MIN_X && p.x <= FIELD.MAX_X, `x out of range: ${p.x}`);
        assert.ok(p.y >= 0 && p.y <= 2, `y out of range: ${p.y}`);
        assert.ok(p.stamina >= 0 && p.stamina <= p.maxStamina, `stamina out of range: ${p.stamina}`);
        assert.ok(p.cd.power >= 0 && p.cd.special >= 0);
      }
    }
    assert.equal(turns, 16);
    assert.equal(m.phase, 'over');
    assert.ok(m.events.some((e) => e.kind === 'fulltime'));
    const pub = publicState(m);
    assert.equal(pub.players.length, 6);
    assert.equal(pub.score.home + pub.score.away, m.teamStats.home.goals + m.teamStats.away.goals);
  }
});

test('halftime swaps the kickoff and restores some stamina', () => {
  const m = createMatch({ maxTurns: 10, kickoff: 'home', rng: mulberry32(13) });
  const rng = mulberry32(99);
  for (let i = 0; i < 5; i++) resolveTurn(m, m.players.map((p) => chooseAction(m, p.idx, 'normal', rng)), rng);
  assert.equal(m.turn, 6);
  assert.ok(m.events.some((e) => e.kind === 'halftime'));
  assert.equal(m.possession, 'away');
  assert.equal(m.ballCarrier, GHOST);
});
