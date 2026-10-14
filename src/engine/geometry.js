import { FIELD } from './constants.js';

export const other = (team) => (team === 'home' ? 'away' : 'home');

// +1 if the team attacks toward higher x.
export const dir = (team) => (team === 'home' ? 1 : -1);

// The goal a team is shooting at.
export const goalFor = (team) => ({ x: team === 'home' ? FIELD.AWAY_GOAL_X : FIELD.HOME_GOAL_X, y: 1 });

export const clampX = (x) => Math.max(FIELD.MIN_X, Math.min(FIELD.MAX_X, x));
export const clampY = (y) => Math.max(0, Math.min(FIELD.LANES - 1, y));

export function dist(a, b) {
  return Math.hypot(a.x - b.x, (a.y - b.y) * FIELD.LANE_W);
}

export const meters = (d) => Math.round(d * FIELD.METERS_PER_CELL);

// Distance from point p to segment a-b, plus how far along the segment (0..1) the closest point is.
export function segInfo(p, a, b) {
  const ax = a.x, ay = a.y * FIELD.LANE_W;
  const bx = b.x, by = b.y * FIELD.LANE_W;
  const px = p.x, py = p.y * FIELD.LANE_W;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { d: Math.hypot(px - ax, py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return { d: Math.hypot(px - (ax + t * vx), py - (ay + t * vy)), t };
}

export function zoneName(team, pos) {
  const d = dist(pos, goalFor(team));
  if (d <= 2.3) return 'the box';
  if (d <= 4.5) return 'the final third';
  if (d <= 7) return 'midfield';
  return 'their own half';
}

export const laneName = (y) => ['the top lane', 'the middle', 'the bottom lane'][y];
