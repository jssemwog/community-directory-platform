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

## E3-local acceptance (`e3-check`)

`E3-local` lets the real listing-detail route (`S2`, `OP-2`) run under `next build` + `next start`
against a **disposable synthetic** cluster that `e3-check` created and owns (`E3-local` Scope Gate
revision 4, approved, with its approval record's clarification). **The live run needs its own
authorization**, separate from the gate and from this code. It computes no timing statistic,
applies no threshold, and leaves `BI-4` pending.

```
e3-check --out <abs dir> --commit <sha>
```

From Git Bash, pinned at live-run authorization to the merged commit (`<MERGED_SHA>`, short form
`<SHORT>`), with both exit statuses captured immediately after the pipeline:

```bash
cd /c/Users/jssem/ag_projects/community-directory-platform && \
node --experimental-transform-types --import ./scripts/local-demo/register.mjs \
  scripts/bi4-timing/cli.ts e3-check \
  --out "C:/Users/jssem/Downloads/bi4-e3/e3-check-<SHORT>" \
  --commit <MERGED_SHA> \
  2>&1 | tee "C:/Users/jssem/Downloads/bi4-e3/e3-check-<SHORT>.console.log"; statuses=("${PIPESTATUS[@]}"); echo "e3-check exit=${statuses[0]} tee exit=${statuses[1]}"
```

**The mode** (`src/interface/public/e3-local-persistence.ts`):
- **When it is on:** default off, and only when `NODE_ENV=production` and `BI4_E3_LOCAL=1`.
- **What it reads:** `BI4_E3_DATABASE_URL`, `BI4_E3_EXPECTED_SYSTEM_IDENTIFIER`, `BI4_E3_EXPECTED_DATABASE`
  and `BI4_E3_SYNTHETIC_MARKER`. None has a `NEXT_PUBLIC_` name.
- **What the URL must be:** host exactly `127.0.0.1`, an explicit port, the expected database as
  its path, and no query string.
- **Per-connection checks:** every newly opened pool connection runs C-1 to C-4 in `pg-pool`'s
  awaited `onConnect`, before it is handed out:
  - C-1: system identifier;
  - C-2: database;
  - C-3: marker;
  - C-4: a non-superuser role.
- **The pool:** one client, `idleTimeoutMillis: 0`, never recycled.
- **Refusal:** a failed check, or any checkout error, refuses the process until restart.
- **What a request sees:**

| Route | Under `E3-local` |
|---|---|
| `/directory` (`S1`) | `404` from `src/proxy.ts` (plain text, every method). `/directory/` is the framework's `308` to `/directory`; case and encoding variants are recorded, not normalized |
| `/directory/[id]` (`S2`) | The layout's pre-check runs before anything renders: refused, or its own checkout failed → `404`. Otherwise the page reads on a guarded client; a refusal that arrives after the response was committed renders the generic not-available content (ruling S-7) |
| `/admin/**` | Unchanged: `404` with the admin headers |
| Under `next dev` | Unchanged: the local demo, with every `BI4_E3_*` variable ignored |

**The run, in order:**

| Step | What happens |
|---|---|
| E-A1 | Disposable worktree, `npm ci`, `next build` with no `BI4_E3_*` variable and no database URL, before any cluster exists |
| L-1 to L-3 | Cluster created with `withEmbeddedPostgres({ slug, databases: [] })`: **no database and no migration**. Before the callback the helper runs only `initdb` (a bootstrap child process with no listener; **not** network SQL) and the server start, so it sends no SQL. Postmaster proven from `postmaster.pid`. **Before the run's first network SQL statement**, every listening entry on the cluster port must be owned by that postmaster, on loopback, with one on `127.0.0.1`. If this fails, no network SQL is sent at all, during cleanup included: nothing was registered with the helper, whose cleanup is `pg_ctl stop` |
| L-4 | As superuser, over `127.0.0.1` on the harness-owned port: a bootstrap connection to the built-in `postgres` database creates `bi4_e3` and is closed even on failure. Then, on `bi4_e3`: migrations, synthetic fixtures, identity (`data_directory` must be the created directory), marker, and the per-run app role. The role's `PUBLIC` defaults are revoked; it holds only `CONNECT`, `USAGE` on `public`, `SELECT` on `listing` and `EXECUTE` on `pg_control_system()` |
| E-A2 | `next start` with every value but the flag. Every route answers `404`, except `/directory/`, which gets the framework's `308` |
| E-A3 | Flag on, wrong expected identifier. The first `S2` request is the triggering request and must be `404`, and so must the next |
| E-A4 | Verified. The equivalence set (two never-existed, pending, rejected, unpublished) must match on status, body with only its own UUID masked, and header list with only `Date` removed. The malformed control must show the not-available content with no fixture text. The public control is sent first and last and must show its name and differ from never-existed |
| E-A4b | Fault injection: the marker is changed and the app's sessions are terminated. It has its **own PASS or FAIL** (both injected requests must answer `404`), reported separately with the observed statuses. It never changes the normal acceptance result or the exit code |
| E-A5 | Stored states verified; then leak scans of `.next/static` (values and the `BI4_E3_` prefix), the rest of `.next`, every response and every log |

**Rules that apply throughout:**
- **Database listener:** checked again before each `next start`, at each handoff and after each
  phase's last request.
- **App listener:** must be exactly one `127.0.0.1` entry owned by the recorded `next start`
  process or a descendant.
- **Hard cap:** **60 HTTP attempts** across every phase, readiness and failed attempts included.
- **Wire status:** read from direct responses; redirects are never followed.
- **Stopping a phase's server:** the server and each recorded descendant are stopped deepest
  first, only after the full identity check (PID, creation time, executable, command line) says
  verified. A mismatch is never stopped. If recording descendants fails, or any inspection, stop or
  exit check is inconclusive, the run stops **before the next phase** and the intent log is kept
  for teardown.
- **After the run:** owned-resource teardown, then the **independent residue checks**: recorded
  process identities, paths, ports, worktree registrations, restricted-file metadata and the main
  tree's `git status`. Zero residue is reported only when teardown, the intent log and these checks
  all show nothing left. A failed inspection or any residue is reported and exits nonzero.
- **What the run writes:** `e3-check.json`, `e3-check.md` and `run-state.json` in `--out`. **The
  app-role password and full database URL are redacted** (`[redacted]`) from these files and from
  console output, including response headers and exception messages; the redacted findings are
  kept.
- **Exit code:** `0` only when normal acceptance passed **and** zero residue was established;
  `2` for a refusal before anything was created; otherwise `1`.

**Bounded setup (amendment A1 revision 2, approved):**

| Step | Hard deadline | On timeout, Ctrl-C or the 30-minute ceiling |
|---|---|---|
| `npm ci` | 10 min | The step's recorded tree is stopped deepest first, each process only after the full identity check, exits confirmed; then the orphan sweep |
| `next build` | 10 min | As for `npm ci` |
| Cluster startup, until the callback is entered | 3 min | The gate closes. The owned `initdb` or `postgres` children are found and stopped; the helper gets 120 s to settle |

**Absolute deadlines.** Each deadline is fixed before the step begins, as the earlier of the step's
own deadline and the run's 30-minute deadline. The run's abort interrupts the step.

**Process steps** (`npm ci`, `next build`):
- **Before `start()`:** the abort signal and the remaining time are checked. If either has run out,
  nothing is started.
- **During `start()`:** the time it takes counts against the same deadline.
- **After `start()`:** both are checked again. If startup crossed the deadline, the recorded
  process is settled and the run stops.
- **Before an exit counts as success:** both are checked again.

An identity inspection inside `start()` is unbounded (A1-3), so it can delay settlement.

**Cluster startup:** the callback itself checks the abort signal and the absolute deadline at
entry. It does so before cancelling the startup timer, before checking the listener, and before
permitting any SQL. A late callback is therefore refused even if the timer has not fired yet.

**After a timeout or interruption:**
- **The outcome is fixed:** no later step or phase starts.
- **A late completion is noted only:** an exit code of 0, or the cluster becoming ready, never
  counts as success and never resumes the run.
- **The late cluster callback is refused twice:** it throws before L-3, and `connectSuperuser`
  refuses too. So it issues no SQL and cannot advance the run.

**Finding the cluster's startup children:** a child counts only if it is the harness's own
child, its executable is exactly the bundled `initdb.exe` or `postgres.exe` (identified by path
beside the declared `pg_ctl`; never run), and its parsed `--pgdata=` or `-D` argument names the
recorded cluster directory.

**`pg_ctl stop`** runs only after both existing proofs: `postmaster.pid`, proven for that
directory, names the recorded child, and that child's live identity verifies. Its wait is bounded
(`-t 30` plus an outer 30 s timer), but `pg_ctl` is **never killed**. An unproven outcome is
recorded in the intent log, together with the fact that the `pg_ctl` PID is unavailable, and left
unresolved. The cluster root and parent are then preserved, the run exits 1, and no zero-residue
claim is made.

**The orphan sweep stops a process only if all of these hold:**
- its parent is a recorded process that was verified, stopped, and confirmed exited;
- its parent PID matches;
- it was created after its parent and no later than the moment that parent's stop was sent;
- its executable is in the owned set;
- its identity is complete, and passes the identity check again immediately before the stop.

A command line is never proof. Anything uncertain is recorded with only its PID, which means it is
never stopped and keeps the directories it could use.

**Final teardown preserves what unresolved work could still use:**
- **A pending cluster helper:** its cluster entry is `left`, and its root and parent are never
  touched.
- **An unconfirmed or uncertain process:** the worktree and harness root are kept.
- **In every case:** the intent log is kept, and the run exits 1.

**Not bounded (ruling A1-3):**
- **What:** Git calls (`git worktree add`, `list`, `remove`) and the PowerShell CIM inspections
  have no timeout, so they **can overrun the 30-minute limit**.
- **Ctrl-C:** it takes effect only after the in-flight call returns.
- **A call that never returns:** the launcher cannot end it, and the operator has to end the
  harness process.
- **What is kept:** the intent log, written at every step, for a separately authorized
  `cleanup --run`.

**Residual window (revision 3 §3):** a listener can change between an inspection and a connection.
The rechecks and the per-connection identity checks narrow that window, but they do not close it.
This mode guards against accidental use of another database, not against a deliberate local
attacker.

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

## OP-2 private staging (`staging-*`)

Implements **OP-2 staging Scope Gate revision 2** (SHA-256
`30fb50b046a7a062b8b3d98c844a66c36664c930eb58844e12014d8cc3e12443`), approved for implementation
and local development checks, with three approval rulings:
1. cache feedback from a local configured check;
2. the event-loop histogram is report-only and shown side by side;
3. seven days as the planning basis, with a $24 projected-spend stop and a $30 operating ceiling.

**It gathers no timing evidence. `BI-4` stays pending, #246 stays open, `OP-1` timing stays
outstanding and S-C stays Not exercised. Public production stays gated by `DG-4`.**

### Every live use needs its own authorization

Merging authorizes nothing. Each of these needs its own explicit authorization:
- the §5 regression runs;
- **P-0, the required live `e3-check` on the candidate**;
- provisioning, setup and readiness;
- any measurement;
- teardown.

The tool **provisions nothing and deletes no provider resource**. The operator creates and deletes
them in the provider consoles, and the tool verifies before and after. **The existing E3-local
launcher (`e3-check`) is unchanged.**

### P-0 comes first, and is enforced

Hosted staging needs a passed live `e3-check` on **exactly** the authorized candidate commit, with a
configured disposable database (gate §5.3).

- **Enforcement:** `staging-record` refuses to contact DigitalOcean or write a record unless
  `run.p0Report` (that run's `e3-check.json`) hashes to `run.p0ReportSha256`, and the report shows
  all of:
  - the authorized commit;
  - normal acceptance passed;
  - E-A4b `pass`;
  - no problems and no safety problems;
  - nothing left by teardown.
- **The record** carries the report's hash and commit. A record without them is refused at V-1.
- **Since the candidate must be a commit,** P-0 can run only after this work is committed.

### The application mode

- **Where it is on:** production only, when `BI4_STAGING` is present (`src/interface/public/staging-access.ts`).
  - **Fully valid:** the mode is **on**.
  - **Anything else** (a value other than `1`, a missing or malformed variable, `BI4_E3_LOCAL` or
    the demo's variable also set, calibration malformed or over the 2 ms ceiling): **deny-all**.
- **Publicly reachable, application-key gated** (`src/proxy.ts`).
  - **The matcher** is global (`/:path*`) in every build. Outside staging, behaviour is unchanged.
  - **Under staging,** only `GET`/`HEAD` on one `S2` path and `GET /bi4-staging/status` pass, and
    only with the key in exactly one `X-BI4-Staging-Key` header, no query string and no `Cookie`.
    Everything else, admin included, gets the plain gate `404`.
  - **The key header** is deleted from the forwarded request.
  - **Keyed `S2` responses** get `Cache-Control: private, no-store`.
- **The data source** (`staging-persistence.ts`):
  - **C-1′:** TLS `verify-full` with the pinned CA.
  - **C-2 to C-4:** in `onConnect`: database, marker and a non-superuser role.
  - **One client;** sticky, silent refusal, with `E3-local`'s post-#284 semantics.
- **The status route** reports identity, state, counters and, for the same window, the event-loop
  histogram and the realized calibration delays, side by side. It answers `notFound()` for every
  method outside the mode.

**A driver hazard, pinned by test (SI-2):** with an IP-literal host, `pg` checks the server
certificate against `localhost`, not against that IP. The mode therefore refuses IP literals:
**the host must be a DNS name**.

### What the counters observe (§7.4)

- **No arrival is observable.** A calibration busy-wait blocks the event loop, and no JavaScript
  runs while it does.
- **`overlappedReads`** counts reads that **began** while another read was in progress, observed at
  dispatch into the persistence. **Any observed overlap during a measured phase invalidates the
  run** (SP-5).
- **The event-loop histogram is report-only.** The calibration delays are reported beside it, are
  not subtracted from it, and no stall is attributed to a cause.
- **L-11:** Render health probes and unsolicited traffic reach the same process, and cannot be
  observed per request.

### Database preflight and TLS controls

Every SQL-sending subcommand (`staging-setup`, `staging-verify`, `staging-marker`,
`staging-predelete`) runs the same gate, in this order, and stops at the first failing step.

1. **Preflight, with no connection and no SQL.**
   - V-1: the record's hash.
   - V-2: the API's cluster ID, name, project, region, engine, version, size, host, port and
     creation time all equal the record.
   - V-3: the CA's hash.
   - V-6, by phase:
     - setup needs exactly `defaultdb` (a fresh cluster);
     - a marker change or D-1 needs `bi4_staging` and nothing foreign;
     - verify refuses foreign databases.
   - V-7: the trusted sources equal the recorded Render ranges plus, when given, the operator's own
     rule. **This is a network filter only.**
2. **V-4, TLS controls, sending identity reads only.**
   - The positive control (recorded host and recorded CA) must succeed.
   - **Both negative controls must be refused by TLS certificate verification:** a public root CA
     that did not issue the certificate, and the resolved IPv4 literal of the host.
   - A refusal for any other reason (a timeout, a closed port) leaves that control
     **inconclusive**, and V-4 fails.
3. **Operator SQL.** The first statement on every connection is the V-5 identity read.
   - `staging-verify` connects to `bi4_staging` only once it exists. Before setup it says the marker
     and privilege checks are not yet applicable.
   - `staging-marker` re-marks only our database:
     - before `--set wrong`, the current marker must be the recorded one;
     - before `--set recorded`, it must be a staging-shaped marker.

**R-8 (`staging-verify --operator-rule none`)** passes only on a **network refusal**. A successful
connection, a TLS failure or an unclassified failure fails R-8.

### Commands

From Git Bash, with secrets only in the environment (never flags):

```bash
export BI4_STAGING_DO_TOKEN=...          # read-only (or database:read + project:read); valid until deadline + 3 days
export BI4_STAGING_DOADMIN_PASSWORD=...  # setup, verify, marker, predelete only
export BI4_STAGING_KEY="$(cat <out>/staging-key.secret.txt)"   # status and readiness only
node --experimental-transform-types --import ./scripts/local-demo/register.mjs scripts/bi4-timing/cli.ts staging-<subcommand> ...
```

Name the cluster `bi4-staging-<12 lower-case hex>` when creating it. The record refuses any other
name.

`--inputs` for `staging-record` holds:
- **DigitalOcean:** the cluster ID, the project name, and the expected trusted sources (Render
  Virginia's published outbound ranges);
- **Render:** the service fields from the dashboard, with `autoDeploy: "no"`, `previews: "off"`,
  `edgeCache: "off"` and an empty `healthCheckPath`;
- **Run:** `run.authorizedCommit`, `run.window` (`7-day`), `run.calibrationIdentities` (0 to 4),
  `run.p0Report` and `run.p0ReportSha256`.

### Readiness coverage and outstanding operator evidence

This is exactly what the tool establishes, and what remains the operator's evidence. The same table
is in `READINESS_COVERAGE` and in every `readiness.json`. `staging-readiness` prints the outstanding
rows after its own result: **passing it does not complete readiness.**

| Gate check | Covered by | Kind | Outstanding operator evidence |
|---|---|---|---|
| P-0 | `staging-record` (`p0Problems`) | automated + operator action | the separately authorized live `e3-check` on the committed candidate; its `e3-check.json` and SHA-256 |
| R-0 | `staging-regress-capture` / `-compare` / `-teardown` | automated + operator action | the operator creates the worktrees, builds, starts and stops the servers, and provides each launch-environment **operator attestation**. PB-3 versus PB-4 rests on that attestation alone (procedure below) |
| R-1 | `staging-build-scan` | automated | none beyond the build |
| R-2 | `staging-record` (`recordProblems`) and `staging-status` (service ID, hostname, commit) | automated + operator action | the Render settings transcribed from the dashboard: plan, region, instances, health path, auto-deploy, previews, edge cache, variable names. The response size is in `readiness.json` |
| R-2b | `staging-readiness`: K-1 to K-5 **through Render** | automated | none |
| R-3 | `staging-readiness` | automated | none |
| R-4 | `staging-readiness`: GET on every path, plus the disallowed methods on S2 and status | automated | none |
| R-5 | `staging-verify` (V-4: positive, wrong-CA and IP-literal controls) and `staging-status` (`verified`) | automated | none |
| R-6 | `staging-setup` and `staging-verify` | automated | none |
| R-7 | `staging-marker`, then `staging-status --expect refused` / `verified` | automated + operator action | the two Render service restarts, with their times |
| R-8 | `staging-verify --operator-rule none` (network refusal required) | automated + operator action | removing the operator's trusted-source rule in the console |
| R-9 | `staging-readiness` | automated | none |
| R-10 | `staging-readiness` (`Date` and `Rndr-Id` removed, own UUID masked) | automated | none |
| R-11 | none | **not implemented** | the calibration pilot belongs to the later measurement slice |
| R-12 | `staging-readiness` (every response) | automated + operator action | an export of the Render application logs for the scan |
| M-1 | `staging-status --previous` | automated | none |
| M-2 | none | **operator evidence** | the Render event list for each window: no deploy, restart, instance, edge-cache, plan or suspension event |
| M-3, M-4, M-5, M-8 | none | **not implemented** | the remote measurement harness (later slice) |
| M-6 | `staging-project` | automated + operator action | the accrued amounts from both billing pages at each phase boundary |
| M-7 | `staging-verify --operator-rule none` | automated + operator action | no operator rule during the run |
| T-1, T-3, T-4 (D-2) | `staging-status` or `staging-identity`; `staging-predelete`; `staging-confirm-deleted` | automated + operator action | the console deletions themselves |
| T-2 | `staging-readiness` (responses) | **operator evidence** | the final Render log export and the run's console output, for the leak scan |
| T-5, T-6 | `staging-identity` (F-1 to F-4 checklist; F-4 automated) | **operator evidence** | the Render service and project deletions, the token revocation time, and deletion of the local key, CA and password files |

### Regression (§5): operator-managed procedure, for review

The tool does **not** create worktrees, build, or start or stop servers (a departure from §5's
wording, retained for review). The operator does those steps. **The tool proves each claim before
it captures, and proves teardown afterwards.** Use one run directory per regression run: absolute,
outside the repository and the temp directory. Captures are never overwritten.

**1. Worktrees, by the operator.** Create one detached worktree per side, outside the repository:

```bash
git worktree add --detach <abs>/bi4-regress-baseline ba1002746f2b8a9d133182151af97961d1dfa06c
git worktree add --detach <abs>/bi4-regress-candidate <candidate sha>
# in each:  npm ci  &&  npx next build      (PB-1 to PB-4)
```

**2. Servers, by the operator.** Start each server from its own worktree, bound to `127.0.0.1`, with
only the mode's variables. Write the variables you set to a JSON file per server,
`{"variables": {...}}`, holding `BI4_*` and `LOCAL_DEMO_*` names only. **This file is the launch
environment's operator attestation.** No tool here can read a running process's environment, so
it is a statement by the operator, not an observation. The capture report records it as
`launchEnvironment.kind: "operator attestation"`, with its SHA-256 and the corroboration that
applies.

| Mode | Servers | `variables` |
|---|---|---|
| PB-1 | baseline and candidate: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p <port>` | `{}` |
| PB-2 | the same | `{"BI4_E3_LOCAL": "1"}` |
| PB-3 | candidate only | `{"BI4_STAGING": "1"}` |
| PB-4 | candidate only | `BI4_STAGING` and `BI4_E3_LOCAL` set to `1`, plus staging variables valid in form (synthetic values) |
| PB-5 | `npm run demo:local` in the baseline worktree, then stop it, then the same in the candidate worktree (fixed port 3000, so one at a time) | `{}` |

**3. Capture each side** (`staging-regress-capture`). It runs in three stages:

| Stage | Checks | HTTP | On a finding |
|---|---|---|---|
| **1** | **Commit:** `git -C <worktree> rev-parse HEAD` equals `--commit`; no tracked changes; the worktree is registered with the main repository, detached at that commit, and outside the main tree. **The baseline must be `ba10027`.** **Launch environment (operator attestation):** the file matches the mode exactly. **Listener identity:** every listener on the port is on `127.0.0.1` and owned by one process, whose command line runs Next.js **from this worktree**; its PID and creation time are recorded | **none** | **Stop before any HTTP request.** The capture is written with its findings and no exchanges. A check that throws stops it too, and writes nothing |
| **2** | **Mode signature:** PB-1 `/directory` is the framework 404; PB-2 it is the plain `Not Found`; PB-3/PB-4 `/` is the gate 404; PB-5 `/directory` lists the demo's approved listing. **Build** (PB-1, PB-2): the static asset served is byte-identical to the file in this worktree's `.next` | `/`, `/directory`, and the asset | **Skip the regression matrix.** The capture is written with its findings |
| **3** | The regression matrix: the §5 list × GET, HEAD, POST and OPTIONS, with fixed identities, so both sides send identical requests (PB-5: the demo requests) | the matrix | — |

The capture records where it stopped (`stoppedAt`). The exit code is 0 only when all three stages
ran. The cap is 250 attempts per capture, so 500 per run.

**What corroborates the launch-environment attestation.** Nothing reads the environment, so
corroboration comes only from HTTP behaviour and process identity. It is recorded per capture
(`launchEnvironment.corroboration`, from `ATTESTATION_CORROBORATION`):

| Mode | Independently corroborated by | What stays attested only |
|---|---|---|
| PB-1 | `/` answers 200, so the staging gate is off. `/directory` is the framework 404, so the E3-local rule is off. The listener runs `next start` from the stated worktree. The build proof | the exact absence of every other `BI4_*` variable |
| PB-2 | `/` answers 200, so staging is off. `/directory` is the plain `Not Found`, so `BI4_E3_LOCAL=1` reached the proxy. Listener identity. The build proof | the absence of other `BI4_*` variables |
| PB-3 | `/` is the gate 404, so `BI4_STAGING` is armed and deny-all is in force. Listener identity | **whether `BI4_E3_LOCAL` was also set.** No build proof: every asset is gated |
| PB-4 | the same as PB-3 | **whether `BI4_E3_LOCAL` was set.** No build proof |
| PB-5 | `/directory` lists the demo's approved listing, so the dev demo's data source is configured. Listener identity | the absence of `BI4_*` variables, which `next dev` ignores anyway. No build proof: dev server |

**PB-3 and PB-4 cannot be distinguished by HTTP behaviour.** Both are deny-all: every request gets
the same gate `404`. Which of the two modes a capture shows rests on the operator attestation
alone.

**4. Compare** (`staging-regress-compare --mode PB-n`). It refuses captures with unresolved
problems, the wrong side or mode, a baseline other than `ba10027`, a candidate equal to the
baseline, or differing request lists. Then:

- **PB-1/PB-2:** status, header list and body are equal after masking `Date`, `ETag`, `x-nextjs-*`
  and build IDs.
- **PB-3/PB-4:** the candidate denies every probe: the gate `404`, or `308` for trailing-slash forms.
- **PB-5, the demo listing comparison:** for `/directory`, the approved listing
  (`0b7e4c52-…`, "Juniper Lane Bakery"), the pending and rejected listings, and a malformed
  identity, status and body agree after the dev request-ID mask. In addition, **on both sides**:
  - the approved page shows its name;
  - the pending, rejected and malformed pages show the not-available content;
  - no non-public listing's name appears anywhere.

**5. Teardown, by the operator, then proven** (`staging-regress-teardown`). Stop each server in its
own terminal (Ctrl+C), then run `git worktree remove --force <worktree>` for each. The tool then
proves, for every capture in the run directory:
- the recorded PID is gone (or now belongs to a different process, by creation time);
- nothing listens on the port;
- the worktree directory is gone and no longer registered;
- the main tree's `git status` shows only the two pre-existing untracked files.

Anything else is reported as residue, with exit code 1.

### Local configured check (approval ruling 1)

`staging-local-check` records keyed `S2` `Cache-Control` verbatim from the candidate under
`next start` in a configured staging mode, against a disposable cluster with TLS for `localhost`.
**This is implementation feedback only. R-2b through Render remains the readiness gate.** The check
run during implementation observed `private, no-store`.

### Window and spend (seven-day planning basis)

`staging-project` adds the remaining days to the deadline at the gate's rates: Render $25 a month
prorated per second, and DigitalOcean at its worst case, $15.15, unless the billing page shows
hourly accrual.
- **$24** projected stops measurement and starts teardown.
- **$30** is the operating ceiling.
- **The deadline** is the cluster's creation + 7 days, and never after 2026-12-11 23:59
  America/New_York.

**The dates and estimated charges are confirmed at provisioning approval.**
