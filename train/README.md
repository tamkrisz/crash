# train/ — evolve a stronger AI by simulating tons of matches

This folder trains a better light-cycle bot. The *training* runs entirely here; the
only `src/` change is the `evolved` difficulty (see "Result in the game" below).
It does **Route A**: evolve the existing `AiProfile` knobs with a genetic algorithm,
scoring every candidate by playing thousands of headless matches against the stock
bots — using the *real* game engine, not a reimplementation.

## Scripts

| file | what it does |
|---|---|
| [headless.ts](headless.ts) | runs one real `Game` match with no canvas (the engine) |
| [pool.ts](pool.ts) / [worker.ts](worker.ts) | parallel match pool (one worker per core; injects a profile per slot) |
| [evolve.ts](evolve.ts) | evolve a profile vs a **fixed reference field** (e.g. cheating hunters) |
| [selfplay.ts](selfplay.ts) | **co-evolution**: candidates fight a hall of fame of past champions |
| [hunterplus.ts](hunterplus.ts) | evolve a **kill-maximizing** hunter in GIGA (128-cycle) mode |
| [eval.ts](eval.ts) | score any saved profile vs a configurable field (`MODE`/`DIFFICULTY`/`ROSTER`) |
| [gigaval.ts](gigaval.ts) | big-sample giga **kill gauntlet** to rank contenders reliably |
| [sanity.ts](sanity.ts) | smoke test the headless harness |

## What was trained (and a lesson in overfitting)

1. **Deep run vs cheating HUNTERS** (`evolve.ts`, `DIFFICULTY=cheating PERSONA=hunter`)
   → a fast evasive **pacifist** that beat a field of cheating hunters **~72%** of the
   time. But it **overfit**: vs a *mixed* cheating field it scored ~16% (below chance).
2. **50 generations of self-play** (`selfplay.ts`, seeded from #1) → a robust
   **aggressive duelist**. Measured with `eval.ts`:

   | opponent field | deep model (#1) | self-play champion (#2) |
   |---|---|---|
   | cheating hunters (4, small) | **72%** | 62% |
   | mixed cheating (4, small)   | 16% | **34%** |
   | mixed cheating (6, medium)  | 12% | **40%** |

   (chance = 100/field, i.e. 25% or 17%.) The self-play champion is the one shipped as
   the `evolved` difficulty — it generalizes across characters and arena sizes.

3. **Hunter+** (`hunterplus.ts`) — a killer for **GIGA** (128-cycle) mode, fitness =
   **kills only**, seeded from the cheating hunter. Giga matches are expensive, so one
   match scores all 128 slots at once (the whole population per match). Kills are very
   noisy (most of the 127 deaths are self-crashes, not frags), so the champion was
   picked by a big-sample `gigaval.ts` gauntlet (960 samples each), **not** the noisy
   per-generation best:

   | giga contender | kills/match (960 samples) |
   |---|---|
   | **Hunter+ champion** | **1.04** |
   | stock cheating hunter | 0.64 |

   ~64% more kills. The GA didn't just amp the hunter — it **dropped** breach/stalk,
   set `openRate 0` (never wastes a rocket on a wall), and pushed `flood`/`escapeSpace`
   way up (survive longer ⇒ kill more). Shipped as the **HUNTER+** character.

## Reproduce

```bash
# build all entries (re-run after editing any .ts)
node_modules/.bin/esbuild train/{evolve,selfplay,hunterplus,eval,gigaval,worker,sanity}.ts \
  --bundle --format=esm --platform=node --outdir=train/out

# 1) deep run vs cheating hunters -> train/out/best-profile.json
POP=32 GENS=18 MATCHES=14 FIELD=4 SIZE=small DIFFICULTY=cheating PERSONA=hunter \
  node train/out/evolve.js

# 2) self-play, seeded from #1 -> train/out/selfplay-best.json
POP=30 GENS=50 MATCHES=14 FIELD=4 SIZE=small node train/out/selfplay.js

# 3) evaluate vs mixed cheating characters
PROFILE=train/out/selfplay-best.json DIFFICULTY=cheating ROSTER=random \
  FIELD=4 MATCHES=300 node train/out/eval.js

# 4) Hunter+ : kill-maximizing GIGA hunter -> train/out/hunterplus-best.json
POP=32 GENS=30 K=10 STEP_CAP=4500 PREY_DIFF=hard node train/out/hunterplus.js
# rank it reliably vs the stock hunter (big sample)
K=60 COPIES=16 PROFILES=train/out/hunterplus-best.json node train/out/gigaval.js
```

`eval.ts` knobs: `PROFILE`, `DIFFICULTY`, `ROSTER` (`random` | `uniform:<persona>` |
`balanced`), `MODE` (`classic`/`mega`/`giga`/`tera`), `FIELD`, `SIZE`, `MATCHES`, `LABEL`.

## Result in the game

Two trained bots ship in-game:

- **`evolved` A.I. SKILL** — the self-play champion. Wiring: `Difficulty` in
  [../src/types.ts](../src/types.ts), the profile in `AI_DIFFICULTY`
  ([../src/game.ts](../src/game.ts)), a button in [../index.html](../index.html). Pick
  **EVOLVED** skill + **BALANCED** character for the profile exactly as trained.
- **`HUNTER+` character** — the giga kill-machine. Wiring: `Personality` +
  `PERSONALITIES` in [../src/types.ts](../src/types.ts), the `PERSONALITY_STYLE`
  transform in [../src/game.ts](../src/game.ts), a button + the auto-built MIX modal in
  [../index.html](../index.html). It's a fixed trained profile, so it ignores the skill
  dial (always elite).

## How it works (and why it's faithful)

- [headless.ts](headless.ts) drives the actual [`Game`](../src/game.ts) class with **no
  canvas and no rendering**. It only:
  - stubs `document` + a 2D context (a self-returning `Proxy`) so construction doesn't crash,
  - overrides the global `Math.random` with a seeded PRNG for reproducible matches,
  - reads/writes the public `Player.aiProfile` field to inject candidate genomes.

  The single-threaded path runs the **complete brain** (`aiChoose` + shooting + sprint)
  inside `Game`, so an evolved profile behaves identically in the browser. The parallel
  worker path stays off (Node has no global `Worker`; fields are kept small), so there's
  zero behavioural drift.

- [evolve.ts](evolve.ts) is the genetic algorithm. A genome **is** an `AiProfile`. Each
  generation scores every genome over many seeded matches (common random numbers across
  candidates for fair, low-variance comparison), keeps the elites, and regenerates the
  rest via tournament selection → uniform crossover → Gaussian mutation. Fitness rewards
  outliving rivals and winning.

## Speed

Matches are simulated in parallel on a pool of worker threads (one per core,
[pool.ts](pool.ts) / [worker.ts](worker.ts)), and each generation uses **successive
halving**: every genome is scored on a few matches, the weakest are culled, and only
survivors spend the full match budget. Together these gave ~5× wall-clock speedup at
equal-or-better quality in testing (capped by core count + core type — e.g. Apple
Silicon's slower efficiency cores).

## Run it

Bundle all entries once (re-run only after editing a `.ts` file), then run:

```bash
# from the repo root
node_modules/.bin/esbuild train/evolve.ts train/worker.ts train/sanity.ts \
  --bundle --format=esm --platform=node --outdir=train/out
node train/out/evolve.js
```

Tunable via env vars (defaults in parens): `POP` (20), `GENS` (8), `MATCHES` (16,
the full budget a finalist plays), `ELITE` (4), `FIELD` (6), `STEP_CAP` (5000),
`SEED` (1234), `WORKERS` (= core count), `RUNGS` (halving schedule, e.g.
`4:12,4:6,8:5` = matches:keep per rung). Scale up for a stronger bot:

```bash
POP=40 GENS=30 MATCHES=24 node train/out/evolve.js
```

Sanity-check the harness alone (one core, no pool):

```bash
node train/out/sanity.js
```

## The end result

Training produces **just numbers** — a tuned `AiProfile` — written to:

- `train/out/best-profile.json` — the evolved genome (the same knob shape the game
  already understands), e.g. `{ "aimRange": …, "flood": …, "open": …, "hunt": … }`.
- `train/out/evolve-log.csv` — best/mean fitness per generation.

The run also prints an honest **validation** on unseen seeds: the evolved bot's win
rate vs the stock field it trained against (a lone bot among `FIELD` equals wins
~`100/FIELD`% by chance, so anything well above that is real skill).

### Using the result in the game

The training touches nothing, but to *play against* the evolved bot you plug those
numbers into [src/game.ts](../src/game.ts) — either as a new entry in `AI_DIFFICULTY`
(a new difficulty) or in `PERSONALITY_STYLE` (a new character), or load the JSON and
assign it to `player.aiProfile`. That's a small, separate edit you opt into.

## Limitations / honest notes

- This evolves the **existing heuristic's parameters**. It will find the best bot
  expressible by those knobs — it cannot invent behaviours the knobs can't represent
  (that's Route B: deep RL self-play).
- A genome is scored vs **stock `hard` bots**. It's tuned to beat *that* field; change
  `difficulty`/`map`/`size` in `evolve.ts` to target other conditions, or add the
  population itself as opponents (co-evolution) for a more robust bot.
- The seeded PRNG makes matches reproducible, but rocket sub-stepping vs the browser's
  per-frame `dt` differs slightly; outcomes are equivalent per cycle-step, not bit-identical.
