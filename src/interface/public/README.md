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

**Empty at scaffold time.**
