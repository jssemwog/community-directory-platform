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

Neither exposes any administrative capability. `/admin` and its sign-in pages answer **404**
everywhere except the launcher's local administrator journey (issue #260, below), which is
local, synthetic and incomplete. The mechanism, `ADR-004`, and its storage, `ADR-028`, are
`Accepted`; `DG-3` remains unresolved. A narrow Product Owner exception (issue #254) permits
separately authorized authentication work **locally only** — development mode, the web server
bound to loopback, a local database and synthetic accounts — with no moderation or
business-administration capability. Public administrative reachability remains prohibited. The
full exception is recorded in `docs/13-decision-log.md` (*Gate-scope exception*).

## Local directory demonstration (localhost only)

A **local-only** demonstration of the public directory (`S1`) and listing detail (`S2`), over
the real public read path and projection, with **synthetic, fictional** listings (issue #248).
It needs nothing beyond `npm install`: the PostgreSQL binaries are the ones the test suite
already installs, and no account, service or network access is used.

```
npm run demo:local         # start: database + migrations + synthetic listings + site
npm run demo:local:stop    # stop a database left running (e.g. after closing the terminal)
npm run demo:local:reset   # stop and delete all local demo data (.local-demo/)
npm run demo:local:admin -- add     # while stopped: provision one synthetic administrator
npm run demo:local:admin -- start   # the same demo over local HTTPS, with administrator sign-in
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
database. If the terminal was closed instead, its lock may remain; follow the recovery steps under
"A leftover lock is never removed automatically" below, which end with `npm run demo:local:stop`.

**One command at a time.** Each command creates `.local-demo/launcher.lock` exclusively and holds
it while it runs. While that file exists:
- a second `demo:local` refuses, and so do `demo:local:stop` and `demo:local:reset`. They leave
  the running demo untouched; stop it with Ctrl+C in its own terminal.
- `demo:local` also refuses, before changing anything, if port 3000 on `127.0.0.1` is in use. It
  refuses too if port 54329 is in use while its own cluster is not running. A cluster of its own
  left running by an earlier session is reused.

**A leftover lock is never removed automatically.** If a command ended without releasing the
lock (for example, its terminal was killed), every command refuses. It names the process the lock
records and says that process no longer appears to be running. An unreadable lock is refused the
same way. To recover deliberately:
1. Confirm that no local demo is still running. No terminal is running `demo:local`, no process
   with the recorded id is running, and <http://127.0.0.1:3000> does not respond.
2. Delete `.local-demo/launcher.lock`.
3. Run `npm run demo:local:stop` in case the database was left running, then start again.

**Shutdown.** The launcher asks the site to stop and waits up to 15 seconds for the site process
it started to exit. If needed, it forces that one process to exit and waits again. It then waits
up to 15 seconds for port 3000 to become free. Only then does it stop the database and print
`Stopped.`; otherwise it reports the problem and exits with an error. It never stops a process by
name or port.

This confirms only that the launcher's own child process exited and that port 3000 is free. It
does not prove that every Next.js worker process exited. The orderly stop also relies on
internal, undocumented `next dev` shutdown behaviour (checked against Next.js 16.3.3).

**Reset deletes nothing on doubt.** `demo:local:reset` deletes `.local-demo/` only when PostgreSQL
confirms the cluster is stopped and port 54329 is free. Otherwise it changes nothing and says
why. It refuses even when the process holding the port is unrelated to the demo. Likewise, if
PostgreSQL cannot report the cluster as either running or stopped, `demo:local` and
`demo:local:stop` change nothing.

**Checking the lifecycle.** `node scripts/local-demo/check-lifecycle.mjs` runs the real demo and
checks these rules end to end. It also opens an approved listing's detail page directly and as the
client router requests it after a click on the directory. Run it while no demo is running and no
lock exists; it reseeds the demo database.

**What it is not.**
- Not a deployment: everything listens on `127.0.0.1` only.
- The `/directory` pages are disabled unless all three hold: the demo's
  `LOCAL_DEMO_DATABASE_URL` is set, its host is loopback, and Next.js runs in development mode.
  So `npm run dev`, `npm run build` and `npm start` are unaffected, and those pages answer 404
  there.
- The database password is random per cluster and stays in the git-ignored `.local-demo/`.
- There is no search, submission form or administration. Authentication exists only as the
  local journey below.
- The layout and wording are a demonstration, not the `DU-2` / `DU-7` design decisions.
- **`BI-4` remains pending** (#246). The not-available response is the same for every
  non-public case, but timing equivalence is unresolved.

## Local administrator sign-in journey (localhost only, synthetic accounts)

The first usable administrator sign-in (issue #260, under `ADR-004`, `ADR-028` and the #254
exception): password, then a TOTP code, then a trivial protected page at `/admin` that shows
"Signed in" and a sign-out button. **There is nothing to administer**: no queue, record,
moderation or business-administration capability exists behind it.

1. With the demo stopped, run `npm run demo:local:admin -- add`. It creates one administrator
   whose username must start with `synthetic-`. The password (15 to 128 characters, checked
   against an offline blocklist; see `src/domain/administrator-auth/PASSWORD-BLOCKLIST.md`) is
   read without echo; Ctrl-C stops the command. The `otpauth://` URI and base32 secret are shown
   **once**, for an authenticator app, and one current code confirms the enrolment together with
   **ten recovery codes, shown once**: store them offline. It refuses, before starting anything,
   outside an interactive terminal or with `NODE_ENV=production`.
2. Run `npm run demo:local:admin -- start` and open `https://127.0.0.1:3000/admin/sign-in`.
   If signing out cannot be completed (the local database is unavailable), the page says so and
   you may still be signed in; sign out again once the database is back.
3. **If the authenticator is lost** (issue #268), choose "Use a recovery code instead" after the
   password. A code works once, ends every other session and opens a **restricted recovery
   session** of at most 15 minutes. That session can only:
   - set up a new authenticator: its secret is shown once, then ten fresh codes are shown once and
     the session ends;
   - replace the recovery codes, which are shown once;
   - end.

   It is never administrator access. Reloading a page that shows a secret or codes repeats the
   action and replaces what it showed, and a page that was lost cannot be shown again.

**Local HTTPS, and a certificate warning.** The session cookie keeps its production attributes
(`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`), and WebKit does not send such a cookie back
over plain `http://127.0.0.1`, so this journey runs on HTTPS with a self-signed certificate for
`127.0.0.1` that the local OpenSSL makes in `.local-demo/tls/`. **No trust store is changed**, so
the browser warns about the certificate the first time; accept it for `127.0.0.1` only. Nothing
weakens the cookie for local use. Plain `npm run demo:local` is unchanged: HTTP, with sign-in
unavailable.

**Keys.** `.local-demo/administrator-keys.json` holds two random development-only keys, created
on first use, never printed and never committed. `demo:local:reset` deletes them together with the
cluster and its accounts.

**What is still missing, deliberately.** Revocation, disabling an account, password or TOTP reset,
the operator reset (break-glass) and key replacement are not implemented, so **provisioning and
authentication are incomplete under `ADR-004`**.
- An account whose enrolment was not confirmed cannot sign in, and is cleared only by
  `demo:local:reset`.
- Accounts provisioned before issue #268 have no recovery codes.
- An account left with no usable route (no working authenticator, and no recovery code the user
  knows) cannot be recovered until the operator reset exists. `demo:local:reset` deletes all local
  data and recovers nothing. All local sign-in
shares one per-source throttle window (20 failures per hour). The sign-in pages claim no
accessibility conformance level or browser support (`NOQ-5`, `NOQ-6`).

**Browser tests.** `npm run test:browser` runs the journey in Chromium, Firefox and WebKit with
Playwright against its own temporary database, keys, certificate and servers. It never touches
`.local-demo/`, and CI does not run it. The browsers come from `npx playwright install chromium
firefox webkit`, which downloads them to the user's cache, outside the repository.

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
