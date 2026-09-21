# Riftbound Rivals

A real-time 1v1 card battler. Two players, two rifts, two cores: spend energy
to deploy units that fight their way across the arena and bring down the other
side's core before the clock runs out.

Matches last three minutes, with a doubled-energy Overcharge phase for the last
minute and sudden death if the arena is still level at time.

Everything here is original: the cards, the factions, the art, the audio and
the mechanics. The project ships **no binary assets at all** — every creature,
structure and sound is generated in code.

## Running it

```bash
npm install
npm run build      # build shared, server and client
npm start          # serve the game on http://localhost:8080
```

For development, with hot reload on the client and a watching server:

```bash
npm run dev        # client on :5173, server on :8080
```

The dev client proxies `/ws` to the server, so the same code path is used in
development and production.

## What is implemented

**Gameplay**
- 30 collectible cards across four factions, plus 3 summon-only tokens
- 20 named abilities, 10 status effects, projectiles, splash, crits,
  knockback, armor, shields and damage-over-time
- An arena with two bridges, static obstacles and a contested centre zone that
  reduces tower damage, so holding the middle is worth something
- Energy economy with an Overcharge phase and a sudden-death period

**Two ways to play**
- **Online 1v1** against another player, server-authoritative, with
  matchmaking, private rooms, disconnect grace and reconnect
- **Practice** against a bot that runs entirely in the browser

**Around the match**
- Deck builder with live cost curve, role balance, anti-air coverage and the
  set's designed synergies surfaced
- Collection, profile, settings and a progression system with levels, card
  unlocks and trophies

## Architecture

```
shared/     card data + the entire simulation engine
  data/       cards, decks, synergies
  sim/        engine core, entities, geometry
  sim/systems targeting, movement, combat, abilities, spells, statuses
  ai/         the bot
server/     Node + ws: wraps the engine authoritatively
  match/      Match, MatchManager (queue, rooms)
  net/        protocol validation, rate limiting
client/     React + Vite
  game/       canvas renderer, particles, procedural art, audio
  net/        websocket client, match sessions
  screens/    battle, deck builder, menus
```

### One engine, two hosts

The single most important decision here: **the simulation lives in `shared/`,
and both hosts run the same copy of it.**

The server runs it for online matches. The client runs its own instance for
practice against the bot. That means there is exactly one implementation of
combat maths, pathing and win conditions — practice and ranked cannot drift
apart, and offline play needs no server.

The battle screen talks to a `MatchSession` interface and never learns which
kind of match it is driving, so rendering, input and HUD code is shared too.

### The client is never trusted

In an online match the client sends **intents**, never state:

```
PLAY_CARD(handIndex, x, y)
```

Note that it sends a hand *index*, not a card id. A client cannot even name a
card it does not hold. Everything else is decided by the server:

- Does this player exist in this match, and is the match accepting plays?
- Is that hand slot in range?
- Can they afford the card?
- Is that a legal position for it?

All of it lives in one place, `Simulation.playCard`, so there is a single
place to audit. `parseClientMessage` is a hard trust boundary in front of
that: every frame is validated for shape, type and bounds before anything
downstream sees it, and each connection has a token-bucket rate limit.

The bot plays through the same `playCard` path. It gets no extra energy, no
hidden information, and cannot see invisible units.

### Determinism

The simulation is a fixed 30 Hz step with all randomness from a seeded PRNG,
so the same seed and inputs always produce the same match. That is what makes
the engine testable, and it is pinned by a test.

Snapshots are broadcast at 15 Hz and interpolated client-side, so the game
renders smoothly at 60 fps without sending 30 updates a second.

## Testing

```bash
npm test              # engine, bot and balance tests (59)
npm run test:server   # server integration over real websockets (17)
npm run test:browser  # single-browser smoke test in Chromium (33)
npm run test:online   # two browsers playing each other end to end (23)
```

The browser tests are the ones that matter most: compiling is not evidence
that a game works. `test:online` opens two isolated browser contexts, queues
them into a match with each other, plays cards, and asserts both clients agree
on the authoritative state.

Three real gaps were found this way and fixed: renaming yourself never reached
the server, leaving an online match did not concede it (the opponent was left
fighting an absent player), and reconnect was implemented on the server but
never actually called by the client, so a mid-match refresh abandoned the
game. `test:online` now reloads a player mid-match and asserts they reclaim
their slot and re-sync with their opponent.

## Balance

[docs/BALANCE.md](docs/BALANCE.md) is generated from the card data with
`npm run balance`, so it cannot drift from what the simulation runs.

The relationships the set rests on are pinned by tests in
`shared/src/__tests__/balance.test.ts`:

- No single card takes a guard tower alone. A tower survives the cheapest
  swarm in the set with ~30% health, so cheap pressure is real but any genuine
  defensive answer wins the exchange.
- Area damage beats swarms; swarms punish single-target heavies; ground-only
  attackers cannot touch air at all.
- Spells are deliberately weak against structures, so no deck can burn a tower
  down from hand.

### The bot

Difficulty was tuned by running bot-vs-bot ablations on each knob rather than
by guesswork, which overturned two assumptions:

- Raising the play threshold and reserving energy both measurably **lose**
  games. A passive bot loses to one that spends its income.
- Reacting faster is only an advantage when paired with energy discipline.
  Without it a quick bot dribbles out cheap cards one at a time and never
  assembles a push.

Skill is now carried mainly by how often the bot fails to answer a push at all
and how often it blunders, both of which are strictly monotonic. Measured over
180 games per pairing across all five bot decks:

| Matchup | Win rate | 95% CI |
| --- | ---: | ---: |
| Hard beats Easy | 61.9% | ±8.8 |
| Hard beats Normal | 61.5% | ±9.1 |
| Normal beats Easy | 72.6% | ±8.1 |

The bot also picks from five decks and four personalities (aggressive,
defensive, control, randomized), so it does not play the same match twice.

## Developer tools

In a practice match:

| Key | Action |
| --- | --- |
| `1`–`4` | Select a hand slot |
| `Esc` | Put the held card down |
| `F1` | Debug overlay: fps, tick, entities, ping, bot reasoning |
| `F2` | Spawn a test unit |
| `F3` | Add energy |
| `F4` | Leave the match |

`F1` works everywhere; `F2`–`F4` mutate the match, so they are refused outside
local practice. The server would reject them regardless.

## Known limitations

- Progression is stored in `localStorage` and is client-side only. It is
  cosmetic; trophies are sent to the server purely as a matchmaking hint and
  are clamped there. A real deployment would need accounts.
- Matchmaking is a single in-memory queue. The shape is right for a real ranked
  queue — candidates are scored and the band widens with wait time — but it
  does not survive a restart or span multiple server instances.
- There is no spectator mode, replay storage or friends list.
