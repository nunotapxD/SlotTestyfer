# SlotTestyfer

Slot machine engine and Monte Carlo tester written in TypeScript. It simulates millions of rounds
to measure a game's RTP (return to player), hit frequency and volatility, and gives a
PASS / FAIL / INCONCLUSIVE verdict against a target RTP, the way a game is checked before release.

> Fictional credits only. There is no real money, no player accounts and no payments.

## Status

| Phase | Scope                                                          | State |
| ----- | -------------------------------------------------------------- | ----- |
| 0     | Monorepo, TypeScript strict, lint, tests, CI, Docker           | done  |
| 1     | Game engine: seeded RNG, config, spin, paylines, wild, scatter | done  |
| 2     | Monte Carlo simulator, exact RTP, worker threads, verdict, CLI | done  |
| 3     | Fastify API, persistence, Docker Compose                       | next  |

## Quick start

Requires Node.js 22+.

```bash
npm install
npm run check                                   # lint + format + build + tests
npm run simulate -- --game games/fruits-96.json --spins 10000000 --seed 42 --target 96
```

```
Game           Fruits 96 (fruits-96)
Run            10,000,000 rounds, seed 42, 8 workers
RTP            95.970% ± 0.132%  (95% CI 95.838% to 96.103%)
Hit frequency  52.91%
Max win        44x total bet
Volatility     2.133 (std dev per round, in total bets)
...
Verdict        PASS  target 96.00% ± 0.50%: confidence interval inside the range
```

Run the same checks inside Docker:

```bash
docker build -t slottestyfer .
docker run --rm slottestyfer
```

## How it works

```
packages/
├─ engine/      pure game logic, no I/O (runs in Node or a browser)
│   rng.ts        seeded mulberry32 PRNG, unbiased nextInt, deriveSeed
│   config.ts     game config schema (Zod) with cross-field checks
│   spin.ts       reel stops -> visible screen
│   evaluate.ts   line wins, wilds, scatters
│   round.ts      bet validation and payout in whole cents
└─ simulator/   Monte Carlo and analysis
    stats.ts      running totals (constant memory, exact integers)
    report.ts     RTP, hit frequency, volatility, confidence interval, verdict
    exact.ts      exact RTP by playing every stop combination
    simulate.ts   chunking and the worker thread pool
    cli.ts        command line
games/          game configurations (JSON)
```

**Reproducible.** Every random decision goes through a seeded RNG. A round is fully described by
its reel stops, so any result can be replayed and audited.

**Deterministic in parallel.** Rounds are split into fixed-size chunks and chunk _i_ always uses
seed `deriveSeed(seed, i)`. Totals are kept as exact integers (wins in line bets), so the same seed
gives the same report on 2 cores or 64.

**Verified two ways.** For small games the exact RTP is computed by playing every combination of
reel stops once. The tests check that the Monte Carlo estimate lands inside its confidence
interval around the exact value.

**Honest verdict.** The RTP is compared against `target ± tolerance` using the 95% confidence
interval: PASS if the whole interval is inside the range, FAIL if it is entirely outside, and
INCONCLUSIVE otherwise, with an estimate of how many rounds would settle it.

**Certification gate in CI.** Every push simulates `fruits-96` and the build fails if it stops
paying 96% ± 0.5%.

## Games

| File               | Exact RTP | Notes                                          |
| ------------------ | --------- | ---------------------------------------------- |
| `fruits-demo.json` | 94.25%    | 3x3, 5 paylines, wild and scatter              |
| `fruits-96.json`   | 95.94%    | Same reels, scatter pays more                  |
| `fruits-88.json`   | 87.98%    | Same reels, fruit pays less: fails a 96% check |

```bash
npm run simulate -- --game games/fruits-88.json --exact
```

## CLI

| Option             | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `--game <file>`    | Game configuration (required)                          |
| `--spins <n>`      | Rounds to simulate (default 1,000,000; `10e6` works)   |
| `--seed <n>`       | Seed (default random, printed in the report)           |
| `--workers <n>`    | Worker threads (default: CPU cores)                    |
| `--target <pct>`   | Target RTP for the verdict, e.g. `96`                  |
| `--tolerance <pp>` | Allowed deviation in percentage points (default `0.5`) |
| `--exact`          | Exact RTP by playing every stop combination            |
| `--json` / `--out` | Print or save the report as JSON                       |

Exit codes: `0` PASS (or no target), `1` FAIL, `2` INCONCLUSIVE, `3` bad input.

## Scripts

| Script             | What it does                    |
| ------------------ | ------------------------------- |
| `npm test`         | Run the test suite (Vitest)     |
| `npm run lint`     | ESLint                          |
| `npm run format`   | Format all files with Prettier  |
| `npm run build`    | Compile all packages            |
| `npm run simulate` | Build and run the simulator CLI |
| `npm run check`    | Everything CI runs              |

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `test:`, `chore:`, `ci:`, `docs:`).
- Work happens on branches and reaches `main` through pull requests.
- Credits are integers in cents; pays are whole multipliers, so every payout is exact.
- The RNG (mulberry32) is not cryptographically secure. Real-money games need a certified RNG.
