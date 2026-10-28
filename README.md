# Community Directory Platform

**This repository currently holds the approved planning chain and an
application scaffold. It does not hold a working product.** No listing, no
search, no submission path, no moderation workflow, and no data store exist
yet.

The governing documents are `docs/01`–`docs/13`, `docs/traceability-matrix.md`,
and the ADR register in `docs/adr/`. **Where code and the chain disagree, the
chain wins.**

## Prerequisites

- **Node.js** `>=22.12.0` (minimum supported; developed and tested against 22.12.0)
- **npm** (bundled with Node; the package manager for this repository, per the
  owner ruling recorded on issue #95)

## Local development

```
npm install      # install dependencies from package-lock.json
npm run dev      # start the development server
npm run build    # production build
npm start        # run the production build
npm run typecheck # TypeScript, no emit
npm test         # run the test suite once (Vitest, non-watch)
```

The development server serves two structural surfaces:

| Path | Surface | Trust context |
|---|---|---|
| `/` | Public | `TB-1` / `TB-2` |
| `/admin` | Administrative | `TB-3` |

Both are **empty shells**. `/admin` is *not* protected, because the
authentication mechanism is `ADR-004`, which is blocked by `DG-3`.

## Local directory demonstration (localhost only)

A **local-only** demonstration of the public directory (`S1`) and listing detail (`S2`), over
the real public read path and projection, with **synthetic, fictional** listings (issue #248).
It needs nothing beyond `npm install`: the PostgreSQL binaries are the ones the test suite
already installs, and no account, service or network access is used.

```
npm run demo:local         # start: database + migrations + synthetic listings + site
npm run demo:local:stop    # stop a database left running (e.g. after closing the terminal)
npm run demo:local:reset   # stop and delete all local demo data (.local-demo/)
```

**Start.** `npm run demo:local` initialises a PostgreSQL cluster in `.local-demo/` on first run,
starts it on `127.0.0.1:54329`, applies the migrations, and re-creates seven fictional listings
through the existing submission, approval and rejection operations — five approved, one pending,
one rejected. It then runs the development server on `127.0.0.1:3000`.

**View.** Open <http://127.0.0.1:3000/directory>. The five approved listings appear; open one
for its detail. The pending and rejected listings do not appear, and their addresses show the
same "not available" page as an address that never existed:

- pending: `/directory/5acd9ba7-be6f-4c8a-937e-af6bce8c4d56`
- rejected: `/directory/6bdeacb8-cf7a-4d9b-a48f-ba7cdf9d5e67`

**Stop.** Press **Ctrl+C** in the terminal running `demo:local`; it stops the site and then the
database. If the terminal was closed instead, run `npm run demo:local:stop`.

**What it is not.**
- Not a deployment: everything listens on `127.0.0.1` only.
- The `/directory` pages are disabled unless all three hold: the demo's
  `LOCAL_DEMO_DATABASE_URL` is set, its host is loopback, and Next.js runs in development mode.
  So `npm run dev`, `npm run build` and `npm start` are unaffected, and those pages answer 404
  there.
- The database password is random per cluster and stays in the git-ignored `.local-demo/`.
- There is no search, submission form, administration or authentication.
- The layout and wording are a demonstration, not the `DU-2` / `DU-7` design decisions.
- **`BI-4` remains pending** (#246). The not-available response is the same for every
  non-public case, but timing equivalence is unresolved.

## Project structure

```
src/
  app/                Next.js route segments — the delivery mechanism
    page.tsx            public surface entry
    admin/page.tsx      administrative surface entry
  interface/          C1, C2 (public/) and C3 (admin/) — surface modules
  domain/             C4–C8, C10, C11 — application and domain logic
  data/               C9 — the single data-access path (empty; see ADR-003)
  platform/           C12 — observability and operations
```

**Dependencies point strictly inward: interface → domain → data access**
(`docs/07`; `ADR-002` `O-9`). Each directory carries a `README.md` describing
what it holds and what may not be decided inside it.

## What the scaffold deliberately does not include

No database connectivity, provider, driver, ORM, migration, or schema · no
authentication or identity provider · no CI pipeline · no deployment or
hosting configuration · no linting tooling · no product
feature of any kind.

Each absence is a recorded decision, not an oversight. See issue #95 and
`docs/12-implementation-plan.md` (`P0b`).

## Tests

**Vitest is installed and enabled** as the implementation of Accepted `ADR-012`,
and `npm test` runs it once, without watch mode. No Vitest configuration file
exists; the runner's defaults are used.

The only committed test is a **tooling verification test**
(`tests/vitest-runner.test.ts`), which proves the runner executes. **No `P1`
Slice A or domain tests exist yet** — that is issue #109 — and **CI does not run
tests**; wiring the test command into CI, and making a test check required,
remain separate later governed work.
