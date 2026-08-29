# Community Directory Platform

**This repository currently holds the approved planning chain and an
application scaffold. It does not hold a working product.** No listing, no
search, no submission path, no moderation workflow, and no data store exist
yet.

The governing documents are `docs/01`–`docs/13`, `docs/traceability-matrix.md`,
and the ADR register in `docs/adr/`. **Where code and the chain disagree, the
chain wins.**

## Prerequisites

- **Node.js** `>=20.9.0` (developed against 22.12.0)
- **npm** (bundled with Node; the package manager for this repository, per the
  owner ruling recorded on issue #95)

## Local development

```
npm install      # install dependencies from package-lock.json
npm run dev      # start the development server
npm run build    # production build
npm start        # run the production build
npm run typecheck # TypeScript, no emit
```

The development server serves two structural surfaces:

| Path | Surface | Trust context |
|---|---|---|
| `/` | Public | `TB-1` / `TB-2` |
| `/admin` | Administrative | `TB-3` |

Both are **empty shells**. `/admin` is *not* protected, because the
authentication mechanism is `ADR-004`, which is blocked by `DG-3`.

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
hosting configuration · no test framework · no linting tooling · no product
feature of any kind.

Each absence is a recorded decision, not an oversight. See issue #95 and
`docs/12-implementation-plan.md` (`P0b`).
