# SlotTestyfer

Slot machine engine and Monte Carlo tester written in TypeScript. It simulates millions of spins to
measure a game's RTP (return to player), hit frequency and volatility, and gives a PASS/FAIL verdict
against a target RTP.

> Fictional credits only. There is no real money, no player accounts and no payments.

## Status

| Phase | Scope                                                | State   |
| ----- | ---------------------------------------------------- | ------- |
| 0     | Monorepo, TypeScript strict, lint, tests, CI, Docker | done    |
| 1     | Game engine: seeded RNG, reels, paylines, paytable   | next    |
| 2     | Monte Carlo simulator and certification verdict      | planned |
| 3     | Fastify API, persistence, Docker Compose             | planned |

## Layout

```
slottestyfer/
├─ packages/
│  └─ engine/     game engine (pure TypeScript, no I/O)
├─ games/         game configurations (JSON)
├─ Dockerfile     runs lint, typecheck and tests in a container
└─ .github/workflows/ci.yml
```

## Getting started

Requires Node.js 22+ and Docker.

```bash
npm install          # installs tools and creates package-lock.json
npm run check        # lint + format check + typecheck + tests
```

Run the same checks inside Docker:

```bash
docker build -t slottestyfer .
docker run --rm slottestyfer
```

## Scripts

| Script              | What it does                   |
| ------------------- | ------------------------------ |
| `npm test`          | Run the test suite (Vitest)    |
| `npm run lint`      | ESLint                         |
| `npm run format`    | Format all files with Prettier |
| `npm run typecheck` | TypeScript in strict mode      |
| `npm run check`     | Everything CI runs             |

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `test:`, `chore:`, `ci:`, `docs:`).
- Work happens on branches and reaches `main` through pull requests.
- Credits are integers in cents to avoid floating point drift.
