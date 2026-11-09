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
| `validate-e2 --out <dir> --validation-out <dir> …` | One validation-only E2 pass (V-A), not a smoke run, evaluated by the shared E2 gates; see "Validation pass V-A" below |
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
- **Worktree removal is gated, retried and never forced by deletion.** The worktree is removed
  only after every recorded process is confirmed exited. That check polls within the teardown
  allowance; a process that is unresolved, lacks an identity or cannot be inspected blocks
  removal. A failed `git worktree remove` is retried up to 5 times within the allowance, and
  the recorded path, commit and Git registration are rechecked before each retry. The worktree
  is settled only when the directory **and** its Git registration are both confirmed gone; the
  original error is kept in the log and the entry's reason. If only one is gone, or the
  inspection fails, the worktree is reported unresolved and what remains is preserved. A failed
  removal never falls back to a recursive delete. The teardown deadline is rechecked immediately
  before every `git worktree remove`, including the first. Once the allowance has expired, no new
  command starts: the worktree is reported unresolved and its root is preserved. The deadline is
  not a hard stop for a command already running. One started just before it may finish after it,
  and its result is still recorded.
- **A harness root is kept while anything recorded inside it is unresolved.** The root is
  removed only when no recorded resource inside it is left or still open. (The first E2 smoke on
  `c15d228` showed the old gap: the worktree removal failed with "Permission denied" and was
  left, but its root was then recursively removed.)
- **Timeouts:** a phase that reaches its ceiling is aborted; teardown then has its own 3-minute
  allowance. If teardown is still running when that ends, the harness stops trying, records what
  was left, marks the run Invalid (timeout, cleanup incomplete) and prints the exact `cleanup`
  command.
- **Never touched:** `.local-demo/` is never opened, listed, stat-ed, read or written.
  `CLAUDE.md` and the handoff file are never read; only their existence, size and modification
  time are compared before and after.

## Response bodies and headers (E2)

This follows harness gate revision 5 as changed by the approved E2 Next.js body-mask amendment,
revision 4 (§7.3, §11.2A, §11.3, §11.4, §11.4A).

HTTP timing is interpreted only if every measured never-existed, pending, rejected and unpublished
response agrees exactly: the body after masking the request's own UUID and then the one `next dev`
request-ID value below (same replacement counts, same status), and the headers compared exactly
after the UUID masking, with `Date` the only header removed and checked instead by a fixed
**timestamp plausibility check** — not proof that `Date` is independent of state.

**The `next dev` request-ID mask (`H-D20`).** At E2 only, on a copy of each stored UUID-masked
body, exactly one 21-byte value (`A–Z a–z 0–9 _ -`) is replaced with 21 `*` bytes, and only
inside the exact context `<script id="_R_">self.__next_r="` … `";if(document.cookie.indexOf('next-instant-navigation-testing=')>-1){`,
followed by a `</script>`. A missing, duplicate, unexpected or malformed occurrence withholds
("Withheld — next dev request-ID mask failed"), as does a value repeated across measured
responses ("Withheld — next dev request-ID value repeated"). When any response in the agreement
set fails the mask, replicate-wide post-mask agreement is reported as not established; the
successful responses are still compared, and that result is labelled a subset comparison, which
can add a body mismatch but never establishes agreement. Every other byte is compared
exactly. **This is an exploratory local rule.** It does not establish independence from listing
state, stream-chunk equivalence or anything about production timing, and all-unique values do not
establish independence from listing state. No other field is masked.

**The Next.js version guard.** The run records the lockfile from the run commit's object, and the
worktree's copy, read **once** before `npm ci` (amendment revision 5, A5-1). That one buffer feeds
both checks: Git's filtered blob ID of it (`git -C <worktree> hash-object --stdin
--path=package-lock.json`) must equal the commit's blob ID, and its bytes must equal the commit's
exactly or after CR LF → LF of the copy only (a standalone CR is never removed, and the commit's
bytes are never changed). The raw hashes, both blob IDs and the worktree's `core.autocrlf`,
`core.eol`, `core.safecrlf`, `check-attr` and `ls-files --eol` for `package-lock.json` are
recorded. It also records the worktree's
`node_modules/next/package.json` before `next dev` starts and again after measuring, and the
launched process's entry script, observed command line and live identity. Both reads must give
the same name, version and manifest SHA-256, and the same canonical resolved paths for the
manifest and the entry script, each inside the package and the worktree. The observed Windows
command line must parse into exactly the expected arguments: the Node executable, the entry
script, `dev`, `--hostname`, `127.0.0.1`, `--port` and the port. Normal Windows quoting of the two
paths is accepted, including paths with spaces; malformed quoting, changed, extra or reordered
arguments, and ambiguous paths withhold. Missing or mismatched evidence, or any version other than
the reviewed `16.3.3`, withholds ("Withheld — Next.js version guard, pending review"). Each
outcome carries the first failed check, in a fixed order, and a one-line reason that names it
(A5-2); the reason never changes the outcome. The
Next.js version guard is evidence of the pinned version, the package manifest and that
manifest's link to the launched executable. It does not verify every installed file: the entry
script's bytes and every installed file other than the manifest are not hashed, so a content
change at an unchanged resolved path is not detected. Runs made before this guard existed,
including the second E2 smoke, have no such evidence and stay withheld.

Any difference withholds timing interpretation for that boundary replicate ("Withheld — masked
body mismatch" / "Withheld — response header mismatch") and preserves the raw evidence. An E2 body
mismatch is withheld, not Invalid, and any independent Invalid condition still takes priority. It
is described with counts, recurrence within each state and overlap between states, and is never
called state-associated or a possible non-timing `BI-4` finding on the strength of disjoint or
all-unique signatures. A header mismatch is labelled state-associated only when the evidence
separates listing states. The variation model is diagnostic only: it runs on the UUID-masked
bodies, before the request-ID mask, whenever they differ, and never establishes agreement or lifts
withholding. Raw headers are kept for every request; raw bodies are rebuilt exactly from the
stored masked bodies and recorded offsets and checked against their raw hashes. A stored body that
is absent or does not match its hash counts as a failed mask.

## Validation pass V-A (`validate-e2`)

Amendment revision 5, A5-3 and A5-4. **Validation only, not a smoke run.** It needs its own
authorization (`H-D10`), like every run.

- **One pass** of the E2 smoke schedule (73 requests; measured `next` responses are 5 each of NE,
  NC-A, NC-B, PE, RJ, UP and MF), with its own cluster, worktree and `npm ci`. It never starts S-B
  or S-C, produces no smoke verdict and no §5.5 projection, and changes no recorded verdict or the
  S-C criteria.
- **Marked, not relabelled.** Its manifest has `mode: "smoke"`, `validation: "e2-evidence"` and no
  pass label, so `analyze` still refuses it.
- **Order.** Output separation and preflight (the main tree's lockfile through the same
  one-buffer checks, real-path forms of `%TEMP%` and Node, no `cdp-bi4-*` entry, only the main
  worktree, the usual refusals) → cluster, fixtures, stored states → worktree and **its** lockfile
  check, stopping before `npm ci` and `next dev` on failure with owned-resource teardown
  (`Invalid (validation stop): worktree lockfile <check>`) → `npm ci` and the pre-start manifest
  read → `next dev` and the launch identity → the schedule → the post-measurement read, only if
  every measured request completed → **stored states verified while the database is still up** →
  teardown → restricted-file metadata and zero residue → evaluation. Smoke and full runs keep their
  existing order (teardown, then stored-state verification).
- **Output directories.** `--out` and `--validation-out` both follow the existing rules (absolute,
  existing, empty, outside the repository and outside the system temp directory), and neither may
  equal, contain or sit inside the other on resolved paths, Windows junctions and links included.
  This is checked before anything is created or written; a bad directory refuses with exit 2 and
  writes nothing, not even `preflight-stop.*`. Immediately before **every** report write
  (`preflight-stop.*`, `validation.*` or `incomplete/partial-validation.*`), the full destination
  policy runs again: both paths must resolve, and the destination must still be empty, outside
  the repository and the system temp directory, and separate from `--out`, all on resolved paths.
  Any failure means no report is written.
- **Limits.** The **80-attempt HTTP budget is hard and shared**: every HTTP attempt counts —
  readiness polling of both servers (failures included) and every planned request (failures
  included) — and the budget is checked before each send. When it is spent, nothing more is sent
  (`Invalid (validation cap)`). Every attempt is traced in `<out>\http-attempts.json`, and the
  report gives the count by phase and server. The plan itself is 73 requests, so readiness probes
  for both servers share 7 attempts.
- **Listener checked before every probe.** V-A uses a strict listener lookup
  (`windowsListenerLookup`: a CIM query on `MSFT_NetTCPConnection` with terminating errors and a
  success envelope), which returns every listening entry on the port with its local address and
  owning PID. A successful empty result means unbound; a failed or malformed lookup is an
  inspection error and can never read as unbound. (The existing `listener(port)` used by teardown
  and recovery is unchanged.) Before **every** readiness HTTP attempt, retries included, and again
  for **both** servers immediately before the scheduled traffic, the port must have exactly one
  listening entry, bound to `127.0.0.1`, owned by the recorded server process or one of its
  descendants, and the recorded process must still have its recorded creation time. An unbound
  port is waited for, with no HTTP, only within that server's readiness bound (at handoff, unbound
  is refused). A failed lookup, several entries, a wrong address, a foreign owner or a gone or
  replaced server stops the pass before anything is sent (`Invalid (validation stop): <server>
  listener …`), and owned-resource teardown runs. Probes that fail, and their retries, are charged
  to the budget. The **20-minute**
  pass limit, the existing **3-minute** teardown allowance and the **5-minute** evaluation limit
  are **cooperative**: checked between steps and in loops, never enforced from outside, and no
  limit kills the process. A step in progress runs to its end, so the pass limit can be overrun by
  `git worktree add`, synchronous `git` calls, `npm ci`, cluster start-up, migrations and fixture
  loading, or an in-flight request up to its timeout; the teardown allowance by one stop, CIM
  inspection, `git worktree remove` or directory removal; the evaluation limit by one body read or
  report write.
- **Evaluation** uses the same `evaluateE2Evidence` as `analyze`, plus the E2 validity checks and
  the run's Invalid reasons, and writes only to `--validation-out` (which must not be, contain or
  sit inside `--out`). It computes no timing statistic. The report keeps independent Invalid
  conditions (listed first, and first in the interpretation line), the version-guard refusal, the
  mask refusal and any residual body mismatch in separate sections, then headers and operational
  counts.
- **The gate result is the first line** of `validation.md` and is printed on exit: "Gate result:
  WITHHELD — <labels>", "Gate result: agreement" or "Gate result: not established". A clean exit
  can carry WITHHELD. Exit 0 needs a clean pass, zero residue and a complete report with **no
  Invalid reason**, including one only the evaluation finds (the gate result and the Invalid
  interpretation are both printed); a refusal is exit 2, anything else exit 1.
- **Incomplete evaluation** writes only `incomplete/partial-validation.{json,md}`, headed
  "INCOMPLETE — gate result not established", and exits 1.
- **Historical residue (A5-4) is a separate prerequisite.** Before an authorized V-A, a fresh
  read-only check against the second smoke's three intent logs must find none of their recorded
  paths, processes or worktree registrations still present. `validate-e2` does not perform that
  check: its own preflight looks only at the current temp directory and worktree list, and its
  residue check covers only the new pass's intent log, so neither can stand in for the historical
  one. The second smoke's S-C stays Not exercised, and recovery of a surviving postmaster remains
  a separate decision.

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
