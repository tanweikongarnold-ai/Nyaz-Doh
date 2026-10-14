// Plays lots of all-AI matches and prints balance numbers.
// Usage: node scripts/simulate.js [matches] [difficulty] [turns]

import { chooseAction, createMatch, mulberry32, resolveTurn } from '../src/engine/index.js';

const N = Number(process.argv[2] || 500);
const difficulty = process.argv[3] || 'normal';
const turns = Number(process.argv[4] || 20);

const totals = { home: 0, away: 0, draws: 0, homeWins: 0, awayWins: 0, goals: [], shots: 0, tackles: 0, tacklesWon: 0, passes: 0, passesDone: 0 };
const kinds = {};
const goalKinds = {};
const actionCounts = {};

for (let i = 0; i < N; i++) {
  const rng = mulberry32(1000 + i);
  const m = createMatch({ maxTurns: turns, rng });
  while (m.phase === 'choosing') {
    const choices = m.players.map((p) => chooseAction(m, p.idx, difficulty, rng));
    for (const c of choices) actionCounts[c.type] = (actionCounts[c.type] || 0) + 1;
    const events = resolveTurn(m, choices, rng);
    for (const e of events) {
      kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      if (e.goal) goalKinds[e.kind] = (goalKinds[e.kind] || 0) + 1;
    }
  }
  totals.home += m.score.home;
  totals.away += m.score.away;
  totals.goals.push(m.score.home + m.score.away);
  if (m.score.home > m.score.away) totals.homeWins++;
  else if (m.score.away > m.score.home) totals.awayWins++;
  else totals.draws++;
  for (const t of ['home', 'away']) {
    const s = m.teamStats[t];
    totals.shots += s.shots;
    totals.tackles += s.tackles;
    totals.tacklesWon += s.tacklesWon;
    totals.passes += s.passes;
    totals.passesDone += s.passesDone;
  }
}

const avg = (x) => (x / N).toFixed(2);
console.log(`${N} matches, ${turns} turns, ${difficulty}`);
console.log(`goals/match ${avg(totals.home + totals.away)} (home ${avg(totals.home)}, away ${avg(totals.away)})`);
console.log(`results: home ${totals.homeWins}, away ${totals.awayWins}, draws ${totals.draws}`);
console.log(`shots/match ${avg(totals.shots)}, tackles/match ${avg(totals.tackles)} (won ${((totals.tacklesWon / totals.tackles) * 100).toFixed(0)}%), passes/match ${avg(totals.passes)} (done ${((totals.passesDone / totals.passes) * 100).toFixed(0)}%)`);
console.log('goals by kind', goalKinds);
console.log('actions', actionCounts);
console.log('events', kinds);
