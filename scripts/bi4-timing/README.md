# BI-4 timing pilot harness (issue #246)

A local harness for the `BI-4` timing pilot: does `OP-2`'s elapsed time distinguish a listing that
never existed from one that is pending, rejected or unpublished? It implements harness gate
revision 5 on top of timing Scope Gate revision 4, **only as far as this local harness needs**.

**It issues no verdict.** No acceptance threshold or bound is applied: 50 µs, 1,000 requests and
55% remain unapproved, and no threshold is derived from noise. A detected difference is an
exploratory lead to be reported on #246. `BI-4` stays pending whatever the harness reports.

## Every run needs its own authorization

Merging this harness authorizes nothing to run (`H-D10`). Each of these needs its own explicit
authorization: **each smoke run**, **each full-pilot replicate**, and **each `cleanup --run`**.

## Boundaries

| Boundary | What is timed | Role |
|---|---|---|
| E1 | `findPubliclyAvailableListing` in-process against a disposable embedded PostgreSQL | **Diagnostic** |
| E2 | Loopback HTTP to `next dev` in a disposable detached worktree; TTFB and TTLB analysed separately | **Exploratory** |

Calibration (E2) is a standalone server in its own process; the delaying proxy is deferred, so
nothing here demonstrates resolution *through* the dev-server stack. E1's injected delay validates
only the E1 harness. Malformed-versus-absent is a comparison of unknown size and direction.

## Inputs: none has a default

| Input | Meaning | Decided |
|---|---|---|
| `--delays-ns a,b,c` | Exactly three distinct calibration delays (ns) | At run authorization (`H-D3`) |
| `--out <dir>` | Absolute, existing, empty; outside the repository and the system temp directory | At run authorization (`H-D9`) |
| `--seed <s>` | Fixes identities, classes, malformed strings and order | At run authorization |
| `--background <n>` | Approved, publicly available background rows | At run authorization (timing `T-D7`) |
| `--commit <sha>` | The authorized commit; the main tree must be clean at it | At run authorization |

## Commands

Every command runs as:

```
node --experimental-transform-types --import ./scripts/local-demo/register.mjs scripts/bi4-timing/cli.ts <subcommand> …
```

| Subcommand | Does |
|---|---|
| `--help` | Prints usage and starts nothing. Also proves the harness and the cluster helper load outside the test runner |
| `smoke --boundary e1\|e2 …` | Three operational passes (§5): S-A normal, S-B simulated SIGINT after the 10th measured request, S-C forced termination of the harness alone, while it is held at its post-10th-request checkpoint, followed by recovery `cleanup` and a second, no-op `cleanup`. Caps: 200 requests / 10 min (E1), 250 / 30 min (E2). Each pass is checked against its expected outcome; a later pass starts only if the earlier one passed and no cap was reached. Writes `smoke-report.json` after every pass and on failure, with the §5.5 runtime projection from a passed S-A. Exits 0 only if all three passed |
| `e1 --replicate 1\|2 …` / `e2 --replicate 1\|2 …` | One full replicate: 29,040 (E1) or 38,730 (E2) requests, under a 20- or 75-minute ceiling |
| `analyze --run <run> --out <dir>` | Statistics, gates and report for one full replicate. Refuses smoke data. 45-minute **cooperative** deadline, checked inside each comparison's loops (not a hard ceiling; see Known limits). When a check finds it passed, `analyze` exits 1 and writes only `incomplete/partial-report.{json,md}`, never `report.json`/`report.md` |
| `cleanup --run <run>` | Replays `run-state.json` and applies the ownership checks to every resource left behind |

Smoke results are **operational checks only**: no timing statistic, comparison, lead or finding.
Expected outcomes: S-A runs to completion with nothing Invalid; S-B is stopped by a simulated
`SIGINT` after exactly 10 measured requests and records only `Aborted: simulated SIGINT`; S-C is exercised, its first
`cleanup` leaves nothing and its second does nothing. Every pass must also leave zero residue.
Anything else (failed, refused, Not exercised, or not started) is a nonzero exit.
If a projected full replicate exceeds 80% of its ceiling, no full run is proposed until the owner
rules (`H-D16`).

## Isolation and cleanup

- **Refusals before anything is created:** port 3000 or 54329 occupied (whatever holds it — and
  a free port is never taken to mean the personal demo is stopped); a main tree that is not clean
  at the authorized commit; `LOCAL_DEMO_DATABASE_URL` set in the harness's environment; an
  unsuitable output directory; a restricted-file baseline that cannot be taken.
- **Disposable resources:** one embedded cluster per pass or replicate (`withEmbeddedPostgres`,
  database `bi4_timing`, autovacuum off for `listing` on that database only). The cluster's
  run-specific parent `%TEMP%\cdp-bi4-cluster-<random>` is recorded and created **before**
  startup. The helper's own root is redirected into it by pointing `TEMP`/`TMP` at the parent for
  the synchronous start of the call only. Its exact path is recorded before the server is
  initialised. If the root is not exactly where it was recorded, the run is refused; at E2 a detached
  worktree in `%TEMP%\cdp-bi4-http-…` with its own `npm ci --prefer-offline --no-audit --no-fund
  --ignore-scripts`; `next dev` with an allowlisted environment and an explicit database URL that
  is checked against the recorded cluster before `next dev` starts.
- **Intent log:** `<out>/run-state.json` records every resource, and every process's identity
  (PID, creation time, executable, command line, port), before or as it is created.
- **Cluster recovery:** `cleanup` removes only the recorded root (after a verified `pg_ctl`
  shutdown, if its recorded postmaster is alive), then the parent, and only when the parent is
  empty. If the parent holds anything unrecorded, it is reported and left, never searched or
  removed.
- **Ownership before every removal:** a live process is checked against its recorded identity
  immediately before it is stopped, alone, with `taskkill /PID <pid> /F` — never `/T`. An
  unrecorded process is reported, never stopped. Only the recorded worktree is removed, with
  `git worktree remove --force <recorded path>`. **`git worktree prune` is never run**; a stale
  worktree record is reported for an owner ruling.
- **Timeouts:** a phase that reaches its ceiling is aborted; teardown then has its own 3-minute
  allowance. If teardown is still running when that ends, the harness stops trying, records what
  was left, marks the run Invalid (timeout, cleanup incomplete) and prints the exact `cleanup`
  command.
- **Never touched:** `.local-demo/` is never opened, listed, stat-ed, read or written.
  `CLAUDE.md` and the handoff file are never read; only their existence, size and modification
  time are compared before and after.

## Response bodies and headers (E2)

HTTP timing is interpreted only if every measured never-existed, pending, rejected and unpublished
response agrees exactly: the body after masking **only** the request's own UUID (same replacement
count, same status), and the headers compared exactly after the same masking, with `Date` the
only header removed and checked instead by a fixed **timestamp plausibility check** — not proof
that `Date` is independent of state. Any difference withholds timing interpretation for that
boundary replicate ("Withheld — masked body mismatch" / "Withheld — response header mismatch")
and preserves the raw evidence. A header mismatch is labelled state-associated only when the
evidence separates listing states. The variation model is diagnostic only and never establishes
agreement. Raw headers are kept for every request; raw bodies are rebuilt exactly from the stored
masked bodies and recorded offsets and checked against their raw hashes.

## Known limits

- **Windows only.** Process identity and stopping use CIM queries and `taskkill`.
- **S-C cluster survival is unverified.** Node places non-detached children in a job object that
  is closed when the harness dies. `next dev` and the calibration server are spawned detached so
  they survive, but the embedded postmaster is started by the shared cluster helper, which this
  harness does not change. If it dies with the harness, S-C reports **Not exercised** for that
  survivor (a nonzero smoke exit), as the gate requires, and the owner rules before any full run.
- **A postmaster started before its identity is recorded is never stopped.** If the harness dies
  during cluster startup, the root's path is already recorded, but a postmaster whose identity
  was not recorded is left and reported for an owner ruling.
- **Cluster recovery fails closed.** A missing, unreadable, malformed or mismatched
  `postmaster.pid` is never treated as proof that the cluster is stopped. The root and its
  parent are removed only after one of these:
  - a verified `pg_ctl` shutdown of the recorded postmaster, with its exit observed;
  - the recorded postmaster is verified gone (with `postmaster.pid` missing or naming a dead PID);
  - with no recorded identity, a proven `postmaster.pid` names a dead PID.

  Otherwise both are kept, the resource is reported as left, and `cleanup` exits 1.
- **A failed process lookup is never absence.** The CIM query runs with
  `$ErrorActionPreference = 'Stop'`, and it must return an explicit
  `{"ok":true,"processes":[...]}` envelope with exit 0 and empty stderr. Only a successful, empty
  result means "no such process". Any of the following raises `ProcessInspectionError`:
  - a PowerShell or CIM failure, or PowerShell failing to start;
  - output that is malformed or lacks the envelope;
  - more than one match, or a different PID;
  - an incomplete identity (no decimal creation time, a missing field).

  A cluster whose postmaster cannot be inspected keeps its root and parent, is reported
  unresolved, and makes `cleanup` exit 1.
- **Unavailable fields never verify a process.** A lookup may return `null` for the executable or
  command line (CIM withholds them for some processes), and that stays representable. But a stop
  or a cluster shutdown needs both fields non-blank on the recorded **and** the live identity,
  and equal to each other. Two missing values are not a match. PID reuse is still decided by valid
  creation times alone.
- **S-B's interruption is simulated, not a signal.** After its 10th measured request, S-B calls
  the same abort handler the real `SIGINT`, `SIGTERM`, `SIGBREAK` and `SIGHUP` listeners use,
  directly, and records `Aborted: simulated SIGINT`. It does not call `process.emit("SIGINT")` or
  send a signal, so no other `SIGINT` listener in the process runs. The first E1 smoke (on
  `9a5e427`) emitted `SIGINT`, and its embedded-cluster shutdown failed at `complete-shutdown`.
  The suspected cause is a race with `embedded-postgres`'s own exit hook, which also listens for
  `SIGINT`. That cause is a hypothesis: it has not been reproduced. S-B therefore no longer
  exercises the real signal-delivery path. That path is covered only by fake-source unit tests.
- **S-C has a deterministic kill point.** After its 10th measured request the child writes
  `sc-ready.json` (its PID, count and identity), then sends nothing while it holds for up to 60
  s. The parent kills it only after checking that marker against the identity it recorded at
  spawn, and then the live identity. If no marker appears, S-C is refused and nothing is killed.
  If the hold times out, the child aborts its own run.
- **The analysis deadline is cooperative, not a hard ceiling.** It is checked inside the
  analysis's own loops and at stage boundaries, and nothing outside the process enforces it.
  Work between two checks (one iteration, reading the run, `diagnoseVariation`, writing the
  report) can overrun 45 minutes. A stalled process is not terminated.
- **No run has been made.** The unit tests use fakes and synthetic data only; none starts a
  cluster, process, worktree or measurement. Two tests create, and then remove, their own
  temporary directory.

## Analysis rules and deferrals

- **Proposed deferral:** precision projections of held-out classifier accuracy at each k (timing
  r4 §5.4) are not computed. Held-out accuracy at k = 1, 10 and 100, with its 95% two-way
  cluster-bootstrap interval, is still reported. Only median and p10 half-widths are projected.
- **Exploratory control rules** (not owner-ratified; listed in every report): a positive control
  is consistent when the median-difference interval covers the expected difference; the null
  fires when its median or p10 interval excludes 0 or an accuracy interval lies above 0.50;
  "difference detected" uses the same rule; Kruskal–Wallis for identity heterogeneity; a
  3-scaled-MAD identity flag (flagged, never dropped).
