# `data/` — the innermost layer

Holds **`C9`** (Listing Repository) — **the single data-access path**
(`ADR-002` `O-1`). It depends on nothing else in `src/`.

**This directory is empty, and that is load-bearing.**

`ADR-003` decided the engine — **PostgreSQL, under a managed operating
posture** — and decided nothing else. Still open, and none of it may be
resolved by code placed here:

- **`DDM-1`** — the named managed service and vendor remain **deferred** by
  owner ruling, and `ADR-010`'s provider-capability validation travels with
  them.
- **`DD-1`, `DDM-2`–`DDM-10`** — no schema, key, index, identity strategy,
  category representation, revision storage, or migration tooling is decided.
- **No ORM, data-access library, driver, or pooler is selected.**

A placeholder repository or a stub client would encode assumptions about all
of the above. Issue #95 therefore adds none, and the application is
**datastore-independent at runtime** at scaffold time.

Two obligations bind whatever eventually lands here:

- **All PostgreSQL access is server-side** (`O-1`). `C9` owns transactions, so
  a create, edit, or moderation action completes fully or has no effect
  (`NFR-DATA-03`).
- **Browser-direct datastore access is prohibited** (`O-2`). No client holds a
  datastore credential and no public route reaches the store
  (`NFR-SEC-08`; `docs/07` `R-10`).

**Empty at scaffold time.**
