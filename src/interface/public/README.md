# `interface/public/` — the public surface (`TB-1`, `TB-2`)

Holds **`C1`** (Public Directory Interface) and **`C2`** (Submission Interface).

The public read path is built in `P2`; the public write path in `P3`. Neither
exists yet.

Two obligations govern everything that will be added here:

- **The public projection is a rule, not a list** (`BI-1`, `BI-3`, `BI-4`,
  `BI-6`). No field outside the approved public set is ever exposed. The set
  itself comes from the `DG-1` answers, not from code written here.
- **A public submission can never produce an approved record** (`BI-2`).
  Supplying a status, timestamp, or administrative field is rejected, not
  ignored.

**Local demonstration only (issue #248).** `directory-view.ts` maps the `C9` read results
to the `S1`/`S2` view states (results, empty directory, error; present, not available, error),
and `local-demo-persistence.ts` is the composition root the `/directory` pages use. That root
is enabled **only** for `npm run demo:local`: a loopback database, development mode, and the
demo's own variable. **There is no production composition root**, and no pool, TLS or
credential policy is decided here (`ADR-016`). `BI-4` remains pending (#246).
