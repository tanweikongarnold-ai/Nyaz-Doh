// Static game data: the pitch, the two teams, the six characters and every action's cost.

export const FIELD = {
  MIN_X: 1, // players stand on columns 1..11
  MAX_X: 11,
  LANES: 3, // 0 = top, 1 = centre, 2 = bottom
  LANE_W: 2, // one lane is as far as two columns when measuring distance
  CENTER_X: 6,
  HOME_GOAL_X: 0, // home defends the left goal and attacks right
  AWAY_GOAL_X: 12,
  METERS_PER_CELL: 5,
};

export const TEAMS = {
  home: { id: 'home', name: 'Street Kings', short: 'SKG', color: '#3b82f6' },
  away: { id: 'away', name: 'Iron Vipers', short: 'IVP', color: '#ef4444' },
};

// Slot order is fixed: 0-2 play for home, 3-5 for away.
export const ROSTER = [
  {
    id: 'blaze', name: 'Blaze', team: 'home', role: 'FWD', maxStamina: 100, special: 'inferno',
    stats: { sho: 9, pas: 5, spd: 7, def: 3, pwr: 8 },
    blurb: 'Lethal finisher. Lives in the box.',
  },
  {
    id: 'nova', name: 'Nova', team: 'home', role: 'MID', maxStamina: 110, special: 'phantom',
    stats: { sho: 6, pas: 9, spd: 9, def: 4, pwr: 5 },
    blurb: 'Fastest player on the street. Sees every pass.',
  },
  {
    id: 'brutus', name: 'Brutus', team: 'home', role: 'DEF', maxStamina: 120, special: 'stomp',
    stats: { sho: 4, pas: 6, spd: 4, def: 9, pwr: 9 },
    blurb: 'A wall with legs. Slow, but nothing gets past.',
  },
  {
    id: 'viper', name: 'Viper', team: 'away', role: 'FWD', maxStamina: 100, special: 'venom',
    stats: { sho: 9, pas: 6, spd: 8, def: 3, pwr: 6 },
    blurb: 'Curls it from anywhere. Slippery on the ball.',
  },
  {
    id: 'ghost', name: 'Ghost', team: 'away', role: 'MID', maxStamina: 110, special: 'mindread',
    stats: { sho: 6, pas: 9, spd: 7, def: 6, pwr: 6 },
    blurb: 'Reads the game three moves ahead.',
  },
  {
    id: 'razor', name: 'Razor', team: 'away', role: 'DEF', maxStamina: 120, special: 'rocket',
    stats: { sho: 5, pas: 5, spd: 6, def: 9, pwr: 8 },
    blurb: 'Tackles first, asks questions never.',
  },
];

export const SPECIALS = {
  inferno: {
    name: 'Inferno Drive', cost: 30, cooldown: 5, needsBall: true, shot: true,
    desc: 'A flaming shot that defenders and markers cannot touch, and nobody can block.',
  },
  phantom: {
    name: 'Phantom Step', cost: 25, cooldown: 4,
    desc: 'With the ball: blink 4 cells forward, untouchable this turn. Off the ball: teleport into space, unmarkable. Defending: appear goal-side of the carrier and smother them.',
  },
  stomp: {
    name: 'Earthquake Stomp', cost: 35, cooldown: 5,
    desc: 'A shockwave that flattens opponents within 2.5 cells (80% up close, 50% at the edge), cancelling their actions. Flatten the carrier and Brutus takes the ball.',
  },
  venom: {
    name: 'Venom Curve', cost: 30, cooldown: 5, needsBall: true, shot: true,
    desc: 'A swerving shot that barely cares about distance, pressure or marking.',
  },
  mindread: {
    name: 'Mind Read', cost: 25, cooldown: 4,
    desc: 'Reads the play before it happens: +10% to every roll for your team, -10% for theirs, this turn.',
  },
  rocket: {
    name: 'Rocket Slide', cost: 30, cooldown: 5, range: 7, targeted: true, noBall: true,
    desc: 'A slide tackle from up to 7 cells away that barely loses accuracy over distance. Missing does not leave Razor on the floor.',
  },
};

export const ACTIONS = {
  dribble: { name: 'Dribble', cost: 7, desc: 'Carry the ball forward. Fast players cover more ground.' },
  pass: { name: 'Pass', cost: 4, desc: 'Find a teammate. Distance, marking and defenders in the lane make it riskier.' },
  shoot: { name: 'Shoot', cost: 10, desc: 'A placed shot. Deadly up close, hopeless from range.' },
  power: { name: 'Power Shot', cost: 22, cooldown: 2, desc: 'Brute force. Loses far less to distance and pressure, but costs a lot.' },
  tackle: { name: 'Slide Tackle', cost: 14, range: 5, desc: 'Slide into any opponent: steal the ball or flatten them. Miss and you spend next turn on the floor.' },
  mark: { name: 'Mark', cost: 4, desc: 'Shadow an opponent. Their passes, shots and dribbles get harder.' },
  run: { name: 'Make Run', cost: 6, desc: 'Sprint into space so you are open for a pass this turn.' },
  special: { name: 'Special Ability', desc: '' },
  recover: { name: 'Recover', cost: 0, desc: 'Catch your breath for +20 extra stamina. You do not defend this turn.' },
  getup: { name: 'Get Up', cost: 0, desc: 'You are on the floor. Get up (+8 stamina).' },
};

export const STAMINA = {
  REGEN: 5, // everyone, every turn
  RECOVER_BONUS: 20,
  GETUP_BONUS: 8,
  HALFTIME_BONUS: 30,
  GASSED_AT: 25, // below this, everything is 10% worse
};

export const DIFFICULTIES = ['easy', 'normal', 'hard'];
export const TURN_OPTIONS = [10, 16, 20, 30];
