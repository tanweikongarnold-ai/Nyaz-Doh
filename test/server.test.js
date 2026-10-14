import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

let srv;
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1' });
});
after(async () => {
  await srv.close();
});

// Minimal test client: queues every message and lets tests wait for one that matches.
async function client(name, identity = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of waiters.slice()) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r) => ws.once('open', r));
  const c = {
    ws,
    inbox,
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    // Resolves with the next message (from now on) matching pred.
    next: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name}: timed out waiting`)), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    last: (type) => inbox.filter((m) => m.type === type).at(-1),
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  const welcome = c.next((m) => m.type === 'welcome');
  c.send('hello', { name, ...identity });
  c.welcome = await welcome;
  return c;
}

test('static client is served', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ILLEGAL/);
  const js = await fetch(`http://127.0.0.1:${srv.port}/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  const evil = await fetch(`http://127.0.0.1:${srv.port}/..%2fpackage.json`);
  assert.ok([403, 404].includes(evil.status));
  const three = await fetch(`http://127.0.0.1:${srv.port}/vendor/three/build/three.module.js`);
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type'), /javascript/);
  const threePkg = await fetch(`http://127.0.0.1:${srv.port}/vendor/three/package.json`);
  assert.equal(threePkg.status, 403, 'only .js files are exposed from node_modules');
  const escape = await fetch(`http://127.0.0.1:${srv.port}/vendor/three/..%2f..%2fserver%2findex.js`);
  assert.ok([403, 404].includes(escape.status));
});

test('quick match puts you in a running game vs AI', async () => {
  const a = await client('Solo');
  assert.ok(a.welcome.catalog.roster.length === 6);
  const st = a.next((m) => m.type === 'state' && m.room.phase === 'match');
  a.send('createRoom', { quick: true });
  const s = await st;
  assert.equal(s.you.slot, 0);
  assert.equal(s.match.turn, 1);
  assert.ok(s.options.actions.length > 0);

  // Make a legal move; the turn should resolve straight away (only human in the room).
  const opt = s.options.actions.find((x) => x.enabled && !x.targets && !x.variants) ?? s.options.actions.find((x) => x.enabled);
  const action = { type: opt.type };
  if (opt.targets) action.target = opt.targets[0].target;
  if (opt.variants) action.dir = opt.variants[0].dir;
  const resolved = a.next((m) => m.type === 'state' && m.turnSeq === 1);
  a.send('choose', { action });
  const r = await resolved;
  assert.equal(r.match.turn, 2);
  assert.ok(r.feed.some((f) => f.seq === 1 && f.events.length > 0));
  await a.close();
});

test('two players: lobby, seats, simultaneous turns, chat, reconnect', async () => {
  const host = await client('Host');
  const created = host.next((m) => m.type === 'state' && m.room?.code);
  host.send('createRoom');
  const s0 = await created;
  const code = s0.room.code;
  assert.equal(s0.room.phase, 'lobby');
  assert.equal(s0.you.isHost, true);

  const guest = await client('Guest');
  const joined = guest.next((m) => m.type === 'state' && m.room.code === code);
  guest.send('joinRoom', { code: code.toLowerCase() });
  const g0 = await joined;
  assert.equal(g0.you.isHost, false);

  // Guest can't start or change settings
  const err = guest.next((m) => m.type === 'error');
  guest.send('start');
  assert.match((await err).message, /host/i);

  host.send('settings', { settings: { maxTurns: 10, turnTimer: 20, difficulty: 'hard' } });
  await host.next((m) => m.type === 'state' && m.room.settings.maxTurns === 10 && m.room.settings.difficulty === 'hard');

  host.send('takeSlot', { slot: 0 }); // Blaze, home
  await host.next((m) => m.type === 'state' && m.room.slots[0].clientId === m.you.clientId);
  const taken = guest.next((m) => m.type === 'error');
  guest.send('takeSlot', { slot: 0 });
  assert.match((await taken).message, /taken/);
  guest.send('takeSlot', { slot: 4 }); // Ghost, away
  await guest.next((m) => m.type === 'state' && m.room.slots[4].clientId === m.you.clientId);

  const chatMsg = guest.next((m) => m.type === 'chat' && m.message.text === 'gg ez');
  host.send('chat', { text: 'gg ez' });
  assert.equal((await chatMsg).message.from, 'Host');

  const hostStarted = host.next((m) => m.type === 'state' && m.room.phase === 'match');
  const guestStarted = guest.next((m) => m.type === 'state' && m.room.phase === 'match');
  host.send('start');
  const hs = await hostStarted;
  const gs = await guestStarted;
  assert.ok(hs.timerEndsAt > Date.now());
  assert.equal(hs.you.slot, 0);
  assert.equal(gs.you.slot, 4);

  const pick = (opts) => {
    const a = opts.actions.find((x) => x.enabled);
    const out = { type: a.type };
    if (a.targets) out.target = a.targets[0].target;
    if (a.variants) out.dir = a.variants[0].dir;
    return out;
  };

  // Host locks in; turn must NOT resolve until the guest does.
  const hostLocked = guest.next((m) => m.type === 'state' && m.locked?.includes(0));
  host.send('choose', { action: pick(hs.options) });
  const gl = await hostLocked;
  assert.equal(gl.turnSeq, 0);
  assert.equal(gl.myChoice, null, "guest can't see the host's choice");

  const turnDone = host.next((m) => m.type === 'state' && m.turnSeq === 1);
  guest.send('choose', { action: pick(gs.options) });
  const t1 = await turnDone;
  assert.equal(t1.match.turn, 2);

  // Guest drops; their seat stays reserved but the AI covers it, so host alone resolves turns.
  const guestId = guest.welcome.clientId;
  const guestToken = guest.welcome.token;
  const dropped = host.next((m) => m.type === 'state' && m.room.slots[4].connected === false);
  await guest.close();
  const d = await dropped;
  assert.equal(d.room.slots[4].clientId, guestId);
  assert.equal(d.room.slots[4].human, false);
  const turn2 = host.next((m) => m.type === 'state' && m.turnSeq === 2);
  host.send('choose', { action: pick(t1.options) });
  await turn2;

  // Guest comes back with the same identity and gets the seat back.
  const back = await client('Guest', { clientId: guestId, token: guestToken });
  const restored = back.inbox.find((m) => m.type === 'state') ?? (await back.next((m) => m.type === 'state'));
  assert.equal(restored.you.slot, 4);
  assert.equal(restored.room.phase, 'match');
  assert.equal(restored.fullFeed, true);
  assert.ok(restored.feed.length >= 3);

  // Forged token doesn't hijack the seat.
  const imposter = await client('Imposter', { clientId: guestId, token: 'nope' });
  assert.notEqual(imposter.welcome.clientId, guestId);

  // Host ends the match.
  const aborted = back.next((m) => m.type === 'state' && m.room.phase === 'lobby');
  host.send('abort');
  await aborted;

  await Promise.all([host.close(), back.close(), imposter.close()]);
});

test('turn timer autopilots players who do not choose', async () => {
  const a = await client('Slowpoke');
  a.send('createRoom');
  await a.next((m) => m.type === 'state' && m.room?.phase === 'lobby');
  a.send('takeSlot', { slot: 3 });
  await a.next((m) => m.type === 'state' && m.room.slots[3].clientId);
  // Shortest allowed option is 20s; shrink it for the test by poking the room directly.
  const room = srv.manager.rooms.get(a.last('state').room.code);
  room.settings.turnTimer = 0.2;
  const done = a.next((m) => m.type === 'state' && m.turnSeq === 1, 4000);
  a.send('start');
  const s = await done;
  assert.ok(s.feed.at(-1).events.some((e) => e.kind === 'autopilot'));
  await a.close();
});

test('bad input gets an error, not a crash', async () => {
  const a = await client('Fuzzer');
  a.ws.send('not json');
  a.ws.send(JSON.stringify({ type: 'choose', action: { type: 'shoot' } }));
  const e1 = await a.next((m) => m.type === 'error');
  assert.match(e1.message, /not in a room/);
  a.send('joinRoom', { code: 'ZZZZ' });
  const e2 = await a.next((m) => m.type === 'error');
  assert.match(e2.message, /No room/);
  a.send('createRoom', { quick: true });
  await a.next((m) => m.type === 'state' && m.room.phase === 'match');
  a.send('choose', { action: { type: 'tackle', target: 0 } });
  const e3 = await a.next((m) => m.type === 'error');
  assert.match(e3.message, /not available/);
  await a.close();
});
