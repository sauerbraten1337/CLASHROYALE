# Riftbound Rivals - Balance Table

Generated from the card data by `npm run balance`. Do not edit by hand:
regenerate it instead, so it always matches what the simulation runs.

## Towers

The defensive baseline everything else is balanced against. A guard tower is tuned
to survive the cheapest swarm in the set (three Shard Hounds, 2 energy, ~370 combined
dps) with roughly 30% health left, so unanswered cheap pressure is genuinely
threatening but any real defensive answer wins the exchange.

| Tower | Health | Damage | Attack speed | DPS | Range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Guard Spire | 1750 | 130 | 1.15/s | 150 | 26 |
| Rift Core | 3150 | 145 | 1.05/s | 152 | 28 |

## Units and buildings

`Health` and `DPS` are totals across every body the card deploys, so a three-body
swarm is compared fairly against a single tank.

`Value/energy` counts only the raw statline, so it reads high for cheap swarms and
low for cards whose value sits in an ability. Shard Hound tops the column by a wide
margin and is deliberately left there: it is the cheap baseline the rest of the set
answers. Measured head-to-head it beats the 3-cost bodies but loses to every card at
4 energy or above, and to a 3-cost assassin, because the column cannot see that it is
melee, ground-only and has no answer to splash.

| Card | Cost | Faction | Bodies | Health | DPS | Range | Targets | Layer | Value/energy |
| --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | ---: |
| Rift Runner | 2 | rift | 1 | 320 | 134 | Melee | Ground | Ground | 428 |
| Shard Hound | 2 | bloom | 3 | 780 | 369 | Melee | Ground | Ground | 1128 |
| Spark Drone | 2 | forge | 1 | 220 | 78 | 12 | Ground + Air | Air | 266 |
| Thunder Seed | 2 | bloom | 1 | 420 | 36 | Melee | Ground | Ground | 282 |
| Chrono Fox | 3 | chrono | 1 | 430 | 125 | Melee | Ground | Ground | 310 |
| Frost Lantern | 3 | chrono | 1 | 460 | 53 | 13 | Ground + Air | Ground | 224 |
| Mirror Mite | 3 | rift | 1 | 420 | 96 | Melee | Ground | Ground | 268 |
| Null Stalker | 3 | rift | 1 | 480 | 144 | Melee | Ground | Ground | 352 |
| Venom Spore | 3 | bloom | 1 | 540 | 54 | Melee | Ground | Ground | 252 |
| Aegis Drummer | 4 | forge | 1 | 640 | 46 | Melee | Ground | Ground | 206 |
| Beacon Spire | 4 | forge | 1 | 720 | 0 | - | Ground + Air | Ground | 180 |
| Echo Witch | 4 | chrono | 1 | 520 | 75 | 15 | Ground + Air | Ground | 205 |
| Hollow Choir | 4 | rift | 3 | 720 | 209 | 11 | Ground + Air | Air | 389 |
| Lumen Warden | 4 | bloom | 1 | 700 | 30 | 10 | Ground | Ground | 205 |
| Phase Wraith | 4 | rift | 1 | 760 | 141 | Melee | Ground | Ground | 331 |
| Quantum Twins | 4 | chrono | 2 | 1280 | 245 | Melee | Ground | Ground | 565 |
| Void Architect | 4 | rift | 1 | 560 | 47 | 13 | Ground + Air | Ground | 187 |
| Bastion Shell | 5 | forge | 1 | 2900 | 69 | Melee | Ground | Ground | 635 |
| Gravity Forge | 5 | forge | 1 | 900 | 0 | - | Ground + Air | Ground | 180 |
| Plasma Bloom | 5 | bloom | 1 | 820 | 77 | 22 | Ground + Air | Ground | 226 |
| Siege Crawler | 5 | forge | 1 | 1150 | 145 | 9 | Buildings | Ground | 346 |
| Warp Lancer | 5 | chrono | 1 | 680 | 118 | 19 | Ground + Air | Ground | 230 |
| Magnetic Golem | 6 | forge | 1 | 2400 | 123 | Melee | Ground | Ground | 482 |
| Geode Titan | 7 | bloom | 1 | 3100 | 126 | Melee | Ground | Ground | 515 |

## Spells

Every damaging spell is deliberately weak against structures, so no deck can burn
a tower down from hand.

| Card | Cost | Radius | Damage | vs structures | Effect |
| --- | ---: | ---: | ---: | ---: | --- |
| Time Fracture | 2 | 14 | 55 | 30% | slowed 4s |
| Energy Surge | 2 | 0 | - | - | 3x energy for 7s |
| Void Pulse | 2 | 13 | 70 | 25% | dispels buffs, silenced 3s |
| Rift Blast | 3 | 12 | 285 | 35% | knockback 6 |
| Bloom Mend | 3 | 14 | - | - | heals 340, ally shielded 5s |
| Meteor Shard | 4 | 11 | 165 | 45% | 3 impacts, 1.1s delay |

## Cost distribution

| Cost | Count | Cards |
| ---: | ---: | --- |
| 2 | 7 | Energy Surge, Rift Runner, Shard Hound, Spark Drone, Thunder Seed, Time Fracture, Void Pulse |
| 3 | 7 | Bloom Mend, Chrono Fox, Frost Lantern, Mirror Mite, Null Stalker, Rift Blast, Venom Spore |
| 4 | 9 | Aegis Drummer, Beacon Spire, Echo Witch, Hollow Choir, Lumen Warden, Meteor Shard, Phase Wraith, Quantum Twins, Void Architect |
| 5 | 5 | Bastion Shell, Gravity Forge, Plasma Bloom, Siege Crawler, Warp Lancer |
| 6 | 1 | Magnetic Golem |
| 7 | 1 | Geode Titan |

## Role coverage

| Role | Cards |
| --- | ---: |
| single-target | 8 |
| utility | 7 |
| defensive | 6 |
| aoe | 6 |
| assassin | 5 |
| support | 5 |
| ranged | 5 |
| control | 5 |
| swarm | 3 |
| tank | 3 |
| siege | 2 |

## Design counters

The relationships the set is built on, each pinned by a test in
`shared/src/__tests__/balance.test.ts`:

- **Area damage beats swarms.** Splash carriers (Geode Titan, Siege Crawler,
  Plasma Bloom, Meteor Shard) clear multi-body cards efficiently.
- **Swarms beat single-target heavies.** A 2-energy swarm punishes a 5-energy
  single-target unit, so expensive cards are not simply better.
- **Air beats ground-only.** Ground-only attackers cannot touch a flyer at all,
  which is why every deck needs at least two cards that hit air.
- **Buildings-only units ignore defenders.** Siege Crawler walks past everything
  alive, so it must be answered with bodies rather than out-traded.
- **Towers anchor defence.** No single card takes a guard tower alone.

## Intended synergies

| Pairing | Why it works |
| --- | --- |
| Magnetic Golem + Echo Witch | The golem eats the projectiles aimed at it while the witch fires over its shoulder. |
| Gravity Forge + Meteor Shard | The well bunches attackers into one knot; the barrage lands on all of them at once. |
| Gravity Forge + Plasma Bloom | Pulled-in targets sit inside the plasma splash radius. |
| Chrono Fox + Aegis Drummer | The drummer haste turns an already evasive attacker into something untouchable. |
| Void Architect + Hollow Choir | The barrier absorbs the anti-air fire the choir cannot survive on its own. |
| Thunder Seed + Frost Lantern | Slowed enemies cannot leave the seed zone before the strike lands. |
| Geode Titan + Lumen Warden | Sustained healing on the heaviest body in the set, and four shards after it falls. |
| Siege Crawler + Bastion Shell | The shell absorbs everything sent to stop the crawler reaching the tower. |
| Null Stalker + Void Pulse | Strip the shields off the back line, then remove it. |
| Beacon Spire + Aegis Drummer | An endless drone stream, all of it moving at haste. |
