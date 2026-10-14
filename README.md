# Illegal Soccer 3v3

A turn-based, multiplayer 3v3 street soccer game inspired by the Roblox game *Illegal Soccer*. There's no referee and no fouls. Slide tackles are encouraged.

> Unofficial fan project. Not affiliated with Roblox or the creators of Illegal Soccer.

- **Solo:** you against an AI rival team, with AI teammates.
- **Co-op:** up to 3 friends against the AI.
- **Head-to-head:** up to 3v3 humans. Any empty seat is played by the AI.
- **Spectate:** start a room with nobody seated and watch the AI play itself, or join a running match and take over an AI seat mid-game.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. Click **Quick match vs AI** to play right away, or **Create a room** and send the invite link to your friends.

### Playing with friends

- **Same Wi-Fi:** start the server and have friends open `http://<your-computer's-LAN-IP>:3000`. Run `ipconfig` (Windows) or `ifconfig` / `ip addr` (Mac/Linux) to find your IP.
- **Over the internet:** deploy it to any Node host that supports WebSockets (Render, Railway, Fly.io and so on). The start command is `npm start`, and the server reads the `PORT` environment variable. You can also expose your local server with a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

Each browser tab is its own player, so you can test multiplayer on one computer by opening the invite link in a second tab or a private window. If you refresh or briefly lose connection, you get your seat back. The AI covers for you for up to 90 seconds while you reconnect.

## How a turn works

Every turn, all six players secretly pick a move at the same time. Then the turn plays out in this order:

1. **Mind Read** (it affects every roll this turn)
2. **Other specials**, fastest player first
3. **Slide tackles**, fastest player first. If you get flattened before your move resolves, your move is cancelled.
4. **Runs** and **marking**
5. The **ball carrier's move**: dribble, pass, shoot, power shot or special shot
6. Everyone else drifts into position. Stamina regenerates and cooldowns tick down.

The host can set the match length (10, 16, 20 or 30 turns), a turn timer (off, or 20 to 60 seconds; if you don't choose in time, autopilot picks for you) and the AI difficulty. At half-time the other team kicks off and everyone gets some stamina back.

### Moves

| Move | Who | Stamina | What it does |
|---|---|---|---|
| Dribble | Carrier | 7 | Carry the ball 2 cells, or 3 if your speed is 8+. Straight ahead, or cut to a neighbouring lane. |
| Pass | Carrier | 4 | Pass to a teammate. Distance, marking on the receiver and defenders in the passing lane all lower the odds. Teammates who just made a run are easier to find. |
| Shoot | Carrier | 10 | Accurate up close, but falls off quickly with distance and pressure. |
| Power Shot | Carrier | 22 | Loses far less to distance and pressure. 2-turn cooldown. |
| Slide Tackle | Anyone without the ball | 14 | Slide into the carrier to steal the ball, or into anyone else to flatten them and cancel their move. Range 25m. If you miss, you're on the floor next turn. |
| Mark | Defenders | 4 | Shadow an opponent. Passes to them, their shots and their dribbles all get harder. |
| Make Run | Attackers | 6 | Sprint 3 to 4 cells into space and become open for a pass this turn. |
| Recover | Anyone without the ball | 0 | Gain 20 extra stamina, but you put no pressure on anyone. |
| Special | Varies | 25–35 | Every character has one. Long cooldowns. |

Below 25 stamina you're **gassed** and every roll is 10% worse. Getting flattened leaves you **dazed** (−12%) for a turn.

### Characters

| Team | Player | Role | SHO | PAS | SPD | DEF | PWR | Special |
|---|---|---|---|---|---|---|---|---|
| Street Kings | Blaze | FWD | 9 | 5 | 7 | 3 | 8 | **Inferno Drive**: a flaming shot that ignores pressure and marking, and can't be blocked |
| Street Kings | Nova | MID | 6 | 9 | 9 | 4 | 5 | **Phantom Step**: blink 4 cells forward untouchable, teleport into space, or appear goal-side of the carrier |
| Street Kings | Brutus | DEF | 4 | 6 | 4 | 9 | 9 | **Earthquake Stomp**: a shockwave that can flatten every opponent within 2.5 cells; flatten the carrier and Brutus takes the ball |
| Iron Vipers | Viper | FWD | 9 | 6 | 8 | 3 | 6 | **Venom Curve**: a swerving shot that barely cares about distance or pressure |
| Iron Vipers | Ghost | MID | 6 | 9 | 7 | 6 | 6 | **Mind Read**: +10% to your team's rolls and −10% to theirs for the turn |
| Iron Vipers | Razor | DEF | 5 | 5 | 6 | 9 | 8 | **Rocket Slide**: a tackle from up to 35m away; missing doesn't put Razor on the floor |

### The odds

Every move's chance of success is calculated from:

- **Distance**: to goal for shots, to the receiver for passes, to the target for tackles
- **Stats**: shooting, passing, speed, defense and power
- **Opponent actions**: who's marking whom, defenders standing in the passing lane, pressure from nearby defenders (unless they're recovering or on the floor), Mind Read, and anyone flattened before they could act
- **Your condition**: gassed or dazed

The percentages on the buttons are estimates based on where everyone is standing. The real roll also includes what your opponents secretly chose. The play-by-play shows every roll, for example `Shot 47% · rolled 31 ✔`.

## Project layout

```
src/engine/      pure game logic, no networking
  constants.js   pitch, teams, characters, moves
  odds.js        every success-chance formula
  match.js       options, validation, turn resolution, positioning
  ai.js          AI decision-making (easy / normal / hard)
  commentary.js  play-by-play text
server/
  index.js       static file server + WebSocket endpoint (/ws)
  rooms.js       rooms, seats, reconnects, turn timers, AI fill-in
public/          browser client (plain HTML/CSS/JS, no build step)
test/            engine and server tests
scripts/         balance simulator
```

The server is authoritative. Clients only send "I choose X"; the server validates the move, keeps everyone's choice secret until the turn resolves, and runs the engine.

## Tests and balance

```bash
npm test                          # engine rules + multiplayer server tests
npm run sim -- 500 normal 20      # simulate 500 AI-vs-AI matches and print balance numbers
```

On normal difficulty, AI-vs-AI matches average about 3 goals in 20 turns, and the two teams win about equally often.
