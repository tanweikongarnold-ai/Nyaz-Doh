// Rooms: a lobby with six slots (3 per team). Humans claim slots; every empty or
// disconnected slot is played by the AI. The server is authoritative: clients only
// ever send "I choose X", and the engine decides what happens.

import crypto from 'node:crypto';
import {
  ACTIONS, DIFFICULTIES, ROSTER, SPECIALS, TEAMS, TURN_OPTIONS,
  chooseAction, createMatch, getOptions, publicState, resolveTurn, validateAction,
} from '../src/engine/index.js';

export const TIMER_OPTIONS = [0, 20, 30, 45, 60];
const MAX_CLIENTS = 12;
const SPECTATE_DELAY_MS = 2500; // pace of AI-only matches
const FORCED_DELAY_MS = 900; // when every human is on the floor, wait a beat before resolving
const RECONNECT_GRACE_MS = 90_000;
const EMPTY_ROOM_TTL_MS = 5 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const CATALOG = {
  teams: TEAMS,
  roster: ROSTER.map((r, slot) => ({ slot, ...r, specialName: SPECIALS[r.special].name, specialDesc: SPECIALS[r.special].desc, specialCost: SPECIALS[r.special].cost, specialCooldown: SPECIALS[r.special].cooldown })),
  actions: ACTIONS,
  turnOptions: TURN_OPTIONS,
  timerOptions: TIMER_OPTIONS,
  difficulties: DIFFICULTIES,
};

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) || `Player${crypto.randomInt(10, 100)}`;

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.clients = new Map(); // clientId -> { id, name, connected, needsFullFeed, removeTimer }
    this.slots = Array(ROSTER.length).fill(null);
    this.hostId = null;
    this.settings = { maxTurns: 20, turnTimer: 0, difficulty: 'normal' };
    this.phase = 'lobby'; // lobby | match | over
    this.match = null;
    this.choices = new Map(); // slot -> action
    this.feed = []; // [{ seq, turn, minute, events }]
    this.turnSeq = 0;
    this.timer = null;
    this.timerEndsAt = null;
    this.autoTimer = null;
    this.emptyTimer = null;
    this.chat = [];
  }

  // ---- membership --------------------------------------------------------

  canJoin(clientId) {
    return this.clients.has(clientId) || this.clients.size < MAX_CLIENTS;
  }

  join(session) {
    const existing = this.clients.get(session.id);
    if (existing) {
      clearTimeout(existing.removeTimer);
      existing.connected = true;
      existing.name = session.name;
      existing.needsFullFeed = true;
    } else {
      if (!this.canJoin(session.id)) throw new Error('Room is full');
      this.clients.set(session.id, { id: session.id, name: session.name, connected: true, needsFullFeed: true, removeTimer: null });
      this.system(`${session.name} joined.`);
    }
    if (!this.hostId || !this.clients.get(this.hostId)?.connected) this.hostId = session.id;
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    session.roomCode = this.code;
    this.afterMembershipChange();
  }

  // Socket dropped: keep their seat warm for a while so a refresh doesn't lose it.
  disconnect(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.connected = false;
    clearTimeout(c.removeTimer);
    c.removeTimer = setTimeout(() => this.leave(clientId), RECONNECT_GRACE_MS).unref();
    if (this.hostId === clientId) this.pickNewHost();
    this.afterMembershipChange();
  }

  leave(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    clearTimeout(c.removeTimer);
    this.clients.delete(clientId);
    const slot = this.slotOf(clientId);
    if (slot !== -1) {
      this.slots[slot] = null;
      this.choices.delete(slot);
    }
    const session = this.manager.sessions.get(clientId);
    if (session && session.roomCode === this.code) session.roomCode = null;
    this.system(`${c.name} left.`);
    if (this.hostId === clientId) this.pickNewHost();
    this.afterMembershipChange();
  }

  pickNewHost() {
    const next = [...this.clients.values()].find((c) => c.connected);
    this.hostId = next ? next.id : null;
  }

  afterMembershipChange() {
    const anyoneHere = [...this.clients.values()].some((c) => c.connected);
    if (!anyoneHere) {
      this.clearTimers();
      if (!this.emptyTimer) this.emptyTimer = setTimeout(() => this.manager.destroy(this.code), EMPTY_ROOM_TTL_MS).unref();
      if (!this.clients.size) this.manager.destroy(this.code);
      return;
    }
    if (this.phase === 'match') this.maybeResolve();
    this.broadcast();
  }

  slotOf(clientId) {
    return this.slots.indexOf(clientId);
  }

  // Slots with a connected human. Everything else is AI.
  humanSlots() {
    return this.slots
      .map((cid, slot) => (cid && this.clients.get(cid)?.connected ? slot : -1))
      .filter((s) => s !== -1);
  }

  // ---- lobby actions -------------------------------------------------------

  takeSlot(clientId, slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slots.length) throw new Error('No such slot');
    if (this.slots[slot] && this.slots[slot] !== clientId) throw new Error('That slot is taken');
    const prev = this.slotOf(clientId);
    if (prev !== -1) {
      this.slots[prev] = null;
      this.choices.delete(prev);
    }
    this.slots[slot] = clientId;
    if (this.phase === 'match') this.lockForcedMove(slot);
    this.afterMembershipChange();
  }

  leaveSlot(clientId) {
    const prev = this.slotOf(clientId);
    if (prev === -1) return;
    this.slots[prev] = null;
    this.choices.delete(prev);
    this.afterMembershipChange();
  }

  updateSettings(clientId, s = {}) {
    this.requireHost(clientId);
    if (this.phase === 'match') throw new Error('Settings are locked during a match');
    if (TURN_OPTIONS.includes(s.maxTurns)) this.settings.maxTurns = s.maxTurns;
    if (TIMER_OPTIONS.includes(s.turnTimer)) this.settings.turnTimer = s.turnTimer;
    if (DIFFICULTIES.includes(s.difficulty)) this.settings.difficulty = s.difficulty;
    this.broadcast();
  }

  requireHost(clientId) {
    if (clientId !== this.hostId) throw new Error('Only the host can do that');
  }

  start(clientId) {
    this.requireHost(clientId);
    if (this.phase === 'match') throw new Error('Match already running');
    this.match = createMatch({ maxTurns: this.settings.maxTurns });
    this.phase = 'match';
    this.turnSeq = 0;
    this.feed = [{ seq: 0, turn: 0, minute: 0, events: this.match.events }];
    for (const c of this.clients.values()) c.needsFullFeed = true;
    this.system('Match started!');
    this.beginTurn();
    this.broadcast();
  }

  backToLobby(clientId) {
    this.requireHost(clientId);
    if (this.phase === 'match') throw new Error('Match still running');
    this.phase = 'lobby';
    this.match = null;
    this.feed = [];
    this.broadcast();
  }

  // Host can end a match early (e.g. everyone wants a rematch).
  abort(clientId) {
    this.requireHost(clientId);
    if (this.phase !== 'match') return;
    this.clearTimers();
    this.phase = 'lobby';
    this.match = null;
    this.feed = [];
    this.system('The host ended the match.');
    this.broadcast();
  }

  // ---- turns -------------------------------------------------------------

  choose(clientId, action) {
    if (this.phase !== 'match' || this.match.phase !== 'choosing') throw new Error('Not accepting moves right now');
    const slot = this.slotOf(clientId);
    if (slot === -1) throw new Error('You are spectating');
    const clean = validateAction(this.match, slot, action);
    if (!clean) throw new Error('That move is not available');
    this.choices.set(slot, clean);
    this.maybeResolve();
    this.broadcast();
  }

  unchoose(clientId) {
    const slot = this.slotOf(clientId);
    if (slot === -1 || this.phase !== 'match') return;
    if (getOptions(this.match, slot).forced) return;
    this.choices.delete(slot);
    this.broadcast();
  }

  lockForcedMove(slot) {
    if (!this.match || this.match.phase !== 'choosing') return;
    const opts = getOptions(this.match, slot);
    if (opts.forced) this.choices.set(slot, { type: opts.actions[0].type });
  }

  beginTurn() {
    this.clearTimers();
    this.choices.clear();
    for (const slot of this.humanSlots()) this.lockForcedMove(slot);
    const secs = this.settings.turnTimer;
    if (secs > 0 && this.humanSlots().length) {
      this.timerEndsAt = Date.now() + secs * 1000;
      this.timer = setTimeout(() => this.resolve(), secs * 1000);
    }
    this.maybeResolve();
  }

  maybeResolve() {
    if (this.phase !== 'match' || this.match.phase !== 'choosing') return;
    const humans = this.humanSlots();
    if (!humans.length) {
      // Nobody playing: AI vs AI, at a watchable pace.
      if (!this.autoTimer) this.autoTimer = setTimeout(() => this.resolve(), SPECTATE_DELAY_MS);
      return;
    }
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    if (!humans.every((s) => this.choices.has(s))) return;
    const allForced = humans.every((s) => getOptions(this.match, s).forced);
    if (allForced) {
      this.autoTimer = setTimeout(() => this.resolve(), FORCED_DELAY_MS);
    } else {
      // Defer so the caller can finish (and broadcast) before the turn flips.
      this.autoTimer = setTimeout(() => this.resolve(), 0);
    }
  }

  resolve() {
    if (this.phase !== 'match' || this.match.phase !== 'choosing') return;
    this.clearTimers();
    const m = this.match;
    const { difficulty } = this.settings;
    const humans = new Set(this.humanSlots());
    const autopiloted = [];
    const choices = m.players.map((p) => {
      const picked = this.choices.get(p.idx);
      if (picked) return picked;
      if (humans.has(p.idx)) autopiloted.push(p.name);
      return chooseAction(m, p.idx, difficulty);
    });
    const minute = Math.round(((m.turn - 1) / m.maxTurns) * 90) + 1;
    const turn = m.turn;
    const events = resolveTurn(m, choices);
    if (autopiloted.length) {
      events.splice(1, 0, { kind: 'autopilot', minor: true, text: `Time's up! Autopilot picked for ${autopiloted.join(', ')}.` });
    }
    this.turnSeq++;
    this.feed.push({ seq: this.turnSeq, turn, minute, events });
    if (m.phase === 'over') {
      this.phase = 'over';
      this.choices.clear();
      this.timerEndsAt = null;
    } else {
      this.beginTurn();
    }
    this.broadcast();
  }

  clearTimers() {
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.timer = null;
    this.autoTimer = null;
    this.timerEndsAt = null;
  }

  // ---- chat & broadcast --------------------------------------------------

  say(clientId, text) {
    const c = this.clients.get(clientId);
    const clean = String(text ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
    if (!c || !clean) return;
    this.pushChat({ from: c.name, team: this.teamOf(clientId), text: clean });
  }

  system(text) {
    this.pushChat({ from: null, text });
  }

  pushChat(msg) {
    const entry = { ...msg, ts: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 60) this.chat.shift();
    for (const c of this.clients.values()) this.manager.send(c.id, { type: 'chat', message: entry });
  }

  teamOf(clientId) {
    const slot = this.slotOf(clientId);
    return slot === -1 ? null : ROSTER[slot].team;
  }

  broadcast() {
    const pub = this.match ? publicState(this.match) : null;
    for (const c of this.clients.values()) {
      if (c.connected) this.manager.send(c.id, this.stateFor(c, pub));
    }
  }

  stateFor(client, pub) {
    const slot = this.slotOf(client.id);
    const humans = this.humanSlots();
    const msg = {
      type: 'state',
      serverNow: Date.now(),
      room: {
        code: this.code,
        hostId: this.hostId,
        phase: this.phase,
        settings: { ...this.settings },
        slots: this.slots.map((cid, i) => {
          const c = cid ? this.clients.get(cid) : null;
          return { slot: i, clientId: cid, name: c?.name ?? null, connected: !!c?.connected, human: humans.includes(i) };
        }),
        spectators: [...this.clients.values()].filter((c) => this.slotOf(c.id) === -1).map((c) => ({ name: c.name, connected: c.connected })),
      },
      you: { clientId: client.id, slot, isHost: client.id === this.hostId },
    };
    if (client.needsFullFeed) msg.chat = this.chat;
    if (pub) {
      msg.match = pub;
      msg.turnSeq = this.turnSeq;
      msg.locked = humans.filter((s) => this.choices.has(s));
      msg.timerEndsAt = this.timerEndsAt;
      msg.feed = client.needsFullFeed ? this.feed : this.feed.slice(-3);
      msg.fullFeed = client.needsFullFeed;
      if (slot !== -1 && this.match.phase === 'choosing') {
        msg.options = getOptions(this.match, slot);
        msg.myChoice = this.choices.get(slot) ?? null;
      }
    }
    client.needsFullFeed = false;
    return msg;
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.sessions = new Map(); // clientId -> { id, token, name, roomCode, socket }
  }

  // ---- sessions ----------------------------------------------------------

  hello(socket, { clientId, token, name } = {}) {
    let s = typeof clientId === 'string' ? this.sessions.get(clientId) : null;
    if (s && s.token !== token) s = null;
    if (!s) {
      s = { id: crypto.randomUUID(), token: crypto.randomBytes(18).toString('base64url'), name: cleanName(name), roomCode: null, socket: null };
      name = null; // already applied
      this.sessions.set(s.id, s);
    }
    if (name) s.name = cleanName(name);
    if (s.socket && s.socket !== socket) {
      // Same player opened a newer connection; the old one is stale.
      const old = s.socket;
      s.socket = null;
      old.close(4000, 'Replaced by a newer connection');
    }
    s.socket = socket;
    socket.sessionId = s.id;
    this.send(s.id, { type: 'welcome', clientId: s.id, token: s.token, name: s.name, catalog: CATALOG });
    const room = s.roomCode && this.rooms.get(s.roomCode);
    s.roomCode = null;
    if (room) {
      try {
        room.join(s);
      } catch (err) {
        this.send(s.id, { type: 'error', message: err.message });
      }
    }
    return s;
  }

  socketClosed(socket) {
    const s = this.sessions.get(socket.sessionId);
    if (!s || s.socket !== socket) return;
    s.socket = null;
    const room = s.roomCode && this.rooms.get(s.roomCode);
    if (room) room.disconnect(s.id);
    // Forget sessions that aren't in a room after a while.
    setTimeout(() => {
      if (!s.socket && !s.roomCode) this.sessions.delete(s.id);
    }, RECONNECT_GRACE_MS).unref();
  }

  send(clientId, msg) {
    const sock = this.sessions.get(clientId)?.socket;
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
  }

  // ---- rooms ---------------------------------------------------------------

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(session, { settings, quick } = {}) {
    this.leaveCurrent(session);
    const room = new Room(this.newCode(), this);
    this.rooms.set(room.code, room);
    room.join(session);
    if (settings) room.updateSettings(session.id, settings);
    if (quick) {
      room.takeSlot(session.id, 0);
      room.start(session.id);
    }
    return room;
  }

  joinRoom(session, code) {
    const room = this.rooms.get(String(code ?? '').toUpperCase().trim());
    if (!room) throw new Error('No room with that code');
    if (!room.canJoin(session.id)) throw new Error('Room is full');
    if (session.roomCode !== room.code) this.leaveCurrent(session);
    room.join(session);
    return room;
  }

  leaveCurrent(session) {
    const room = session.roomCode && this.rooms.get(session.roomCode);
    if (room) room.leave(session.id);
    session.roomCode = null;
  }

  destroy(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.clearTimers();
    clearTimeout(room.emptyTimer);
    for (const c of room.clients.values()) clearTimeout(c.removeTimer);
    for (const id of room.clients.keys()) {
      const s = this.sessions.get(id);
      if (s && s.roomCode === code) s.roomCode = null;
    }
    this.rooms.delete(code);
  }

  // ---- message router ----------------------------------------------------

  handle(socket, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'hello') {
      if (!socket.sessionId) this.hello(socket, msg); // one identity per connection
      return;
    }
    const s = this.sessions.get(socket.sessionId);
    if (!s || s.socket !== socket) return;
    try {
      this.route(s, msg);
    } catch (err) {
      this.send(s.id, { type: 'error', message: err.message });
    }
  }

  route(s, msg) {
    const room = s.roomCode ? this.rooms.get(s.roomCode) : null;
    const needRoom = () => {
      if (!room) throw new Error('You are not in a room');
      return room;
    };
    switch (msg.type) {
      case 'setName': {
        s.name = cleanName(msg.name);
        const c = room?.clients.get(s.id);
        if (c) {
          c.name = s.name;
          room.broadcast();
        }
        break;
      }
      case 'createRoom':
        this.createRoom(s, { settings: msg.settings, quick: !!msg.quick });
        break;
      case 'joinRoom':
        this.joinRoom(s, msg.code);
        break;
      case 'leaveRoom':
        this.leaveCurrent(s);
        this.send(s.id, { type: 'left' });
        break;
      case 'takeSlot':
        needRoom().takeSlot(s.id, msg.slot);
        break;
      case 'leaveSlot':
        needRoom().leaveSlot(s.id);
        break;
      case 'settings':
        needRoom().updateSettings(s.id, msg.settings);
        break;
      case 'start':
        needRoom().start(s.id);
        break;
      case 'toLobby':
        needRoom().backToLobby(s.id);
        break;
      case 'abort':
        needRoom().abort(s.id);
        break;
      case 'choose':
        needRoom().choose(s.id, msg.action);
        break;
      case 'unchoose':
        needRoom().unchoose(s.id);
        break;
      case 'chat': {
        const now = Date.now();
        if (now - (s.lastChat || 0) < 400) return;
        s.lastChat = now;
        needRoom().say(s.id, msg.text);
        break;
      }
      default:
        throw new Error(`Unknown message: ${msg.type}`);
    }
  }

  shutdown() {
    for (const code of [...this.rooms.keys()]) this.destroy(code);
  }
}
