// Play-by-play lines. Each event kind has several templates so the same move reads
// differently every time. {placeholders} are filled from the event's vars.

import { pick } from './rng.js';

const LINES = {
  kickoff: [
    '{team} kick off. {name} rolls it to the centre spot. No referee. No rules.',
    'We are LIVE. {name} gets {team} underway, and nobody here has read the rulebook.',
    '{team} to kick off. {name} on the ball. Somebody is getting slide-tackled in the next ten seconds.',
  ],
  turnHeader: [
    '{name} has it for {team}, {m}m from goal.',
  ],

  dribbleOk: [
    '{name} drops a shoulder and glides {m}m forward into {zone}.',
    'Silky feet from {name}! {m}m gained, now in {zone}.',
    '{name} knocks it past the nearest body and charges into {zone}.',
    '{name} skips through the gap. Into {zone}!',
  ],
  dribbleHeld: [
    '{name} tries to turn but is boxed in. Ball kept, no ground gained.',
    'Nowhere to go for {name}. Shields it and waits.',
    '{name} goes left, goes right, goes nowhere. Still on the ball though.',
  ],
  dribbleLost: [
    '{target} reads it and pickpockets {name}!',
    '{name} dribbles straight into {target}. Turnover!',
    'Too cute from {name}. {target} just takes it.',
  ],

  passOk: [
    '{name} pings it {m}m to {target}.',
    'Crisp ball from {name}, and {target} takes it in stride.',
    '{name} finds {target} with a pass that had eyes.',
    'Simple, tidy. {name} to {target}.',
  ],
  passThrough: [
    '{name} spots the run and slides it through. {target} is in!',
    'Through ball! {name} picks out {target} sprinting into space.',
    '{target} makes the run, {name} delivers. That is a connection.',
  ],
  passIntercepted: [
    '{target} jumps the lane and picks off {name}\'s pass!',
    '{name} tries to find {receiver}, but {target} was waiting for that.',
    'Read like a comic book. {target} intercepts.',
  ],
  passLoose: [
    '{name} overhits it, and {target} mops up the loose ball.',
    'That pass from {name} was meant for nobody. {target} collects.',
  ],
  passToDowned: [
    '{name} passes to {receiver}, but {receiver} is face-down on the turf. {target} grabs the loose ball.',
  ],

  goal_shoot: [
    '{name} pulls the trigger from {m}m... GOAL! Bottom corner!',
    '{name} opens the body and passes it into the net. GOAL!',
    'From {m}m, {name} picks a spot and finds it. GOOOAL!',
  ],
  goal_power: [
    '{name} winds up from {m}m. POWER SHOT! The net nearly comes off its hinges. GOAL!',
    'OH MY. {name} absolutely LEATHERS it from {m}m and it\'s in! The keeper is still checking all their fingers are attached.',
    '{name} hits it so hard the ball changes shape. GOAL from {m}m!',
  ],
  goal_inferno: [
    '{name} sets the ball ON FIRE. INFERNO DRIVE from {m}m! It burns straight through the net! GOAL!',
    'The air shimmers... {name} unleashes the INFERNO DRIVE! Unstoppable! GOAL!',
  ],
  goal_venom: [
    '{name} whips it from {m}m. VENOM CURVE! It bends round everyone like it\'s alive. GOAL!',
    'That ball should not move like that. {name}\'s VENOM CURVE wraps into the top corner! GOAL!',
  ],
  shotSaved: [
    '{name} fires from {m}m. Strong hand from the keeper, saved!',
    'Good effort from {name}, but the keeper gets down and gathers it.',
    '{name} goes for goal, and the keeper says no.',
  ],
  shotPost: [
    '{name} strikes from {m}m... OFF THE POST! It rebounds to {target}!',
    'CLANG! {name} rattles the woodwork from {m}m! {target} pounces on the rebound.',
  ],
  shotBlocked: [
    '{name} shoots, but {target} throws a body in the way. Blocked!',
    '{target} takes {name}\'s shot right in the chest. Painful. Effective.',
    'Blocked! {target} gets a toe to {name}\'s strike.',
  ],
  shotWide: [
    '{name} lets fly from {m}m... and it sails into the car park.',
    'Wide. Very wide. {name} won\'t want to watch that one back.',
    '{name} skies it from {m}m. That might still be going up.',
  ],

  tackleSteal: [
    '{name} launches into a slide and takes the ball AND {target}! No whistle. There\'s never a whistle.',
    'Studs-up from {name}! {target} goes flying and {name} comes away with the ball.',
    '{name} slides in from {m}m and cleans out {target}. Possession {team}!',
  ],
  tackleStealCrit: [
    'BONE-RATTLING slide from {name}! {target} is somewhere in the next postcode and {name} has the ball!',
    '{name} absolutely DEMOLISHES {target}. That should be illegal. It isn\'t. {team} ball!',
  ],
  tackleMissBall: [
    '{name} slides in at {target}... who skips over it. {name} is eating turf.',
    'Huge lunge from {name}, but {target} was never there. {name} is on the floor.',
    '{name} goes to ground from {m}m and gets nothing. {target} keeps the ball.',
  ],
  tackleKnock: [
    '{name} wipes out {target} off the ball! Completely illegal. Completely allowed.',
    'Nobody was looking at the ball, and {name} takes the chance to flatten {target}.',
    '{name} slide-tackles {target}, who doesn\'t even have the ball. Ruthless.',
  ],
  tackleKnockCrit: [
    '{name} TORPEDOES {target}! That\'s a highlight reel hit, and {target} is seeing stars.',
  ],
  tackleMiss: [
    '{name} goes in on {target}, misses everything, and slides into the advertising boards.',
    '{name} lunges at {target} and hits only air. Down goes {name}.',
  ],
  tackleImmune: [
    '{name} slides straight through {target}\'s afterimage! Phantom Step!',
  ],
  tackleNoTarget: [
    '{name} slides in on {target}, who is already flat on the floor. Overkill.',
  ],

  rocketSteal: [
    'ROCKET SLIDE! {name} launches from {m}m away, takes the ball off {target} and does not stop sliding for a while.',
  ],
  rocketKnock: [
    'ROCKET SLIDE! {name} covers {m}m on the seat of the shorts and wipes out {target}!',
  ],
  rocketMiss: [
    'ROCKET SLIDE from {m}m, but {target} hops over it! {name} pops straight back up.',
  ],

  cancelled: [
    '{name} never gets the chance. Already flattened.',
    '{name} was about to do something clever. Was.',
  ],
  marks: [
    'Marking: {list}.',
  ],
  run: [
    '{name} bursts forward into space.',
    '{name} makes a sharp run into {zone}.',
    '{name} sprints in behind. Somebody find {name}!',
  ],
  recover: [
    'Taking a breather: {list}.',
  ],
  getup: [
    'Back on their feet: {list}.',
  ],

  mindread: [
    '{name}\'s eyes glow. MIND READ! {team} know exactly what\'s coming.',
    '{name} taps their temple. MIND READ, and {opp} suddenly look very predictable.',
  ],
  stomp: [
    '{name} raises a boot... EARTHQUAKE STOMP! The pitch cracks open!',
    'EARTHQUAKE STOMP! {name} hits the ground so hard the floodlights flicker!',
  ],
  stompResult: [
    'The shockwave flattens {list}.',
  ],
  stompDodge: [
    '{target} phases straight through the shockwave.',
  ],
  stompWhiff: [
    '...but nobody was close enough. {name} just made a very large hole.',
  ],
  stompSteal: [
    'The ball pops loose and {name} scoops it up!',
  ],
  phantomBall: [
    '{name} flickers... PHANTOM STEP! Reappears {m}m upfield with the ball!',
  ],
  phantomRun: [
    '{name} vanishes. PHANTOM STEP! Now standing in acres of space in {zone}.',
  ],
  phantomDefend: [
    '{name} vanishes and reappears right in front of {target}. PHANTOM STEP smother!',
  ],

  halftime: [
    'HALF-TIME. {home} {hs}-{as} {away}. Everyone gets a breather and some ice for their shins.',
  ],
  fulltime: [
    'FULL-TIME! {home} {hs}-{as} {away}. {verdict}',
  ],
  restartGoalKick: [
    '{target} restarts for {team}.',
  ],
};

export function say(kind, vars = {}, rng = Math.random) {
  const lines = LINES[kind];
  if (!lines) return kind;
  return pick(rng, lines).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
