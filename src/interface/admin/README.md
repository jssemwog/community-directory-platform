# `interface/admin/` — the administrative surface (`TB-3`)

Holds **`C3`** (Administrative Interface). Built in `P4`; nothing exists yet.

`docs/07` `R-6` names this surface **the likeliest place in the system for a
security mistake**, because it lives inside the same application as the public
one. The separation is structural for that reason.

Every module added here is subject to:

- **`C8` gates it, server-side, on every request** (`ADR-002` `O-3`). Not once
  at a layout; at every entry point.
- **UI visibility is never authorization** (`O-4`). A hidden control is a
  courtesy; a hidden route is not a boundary (`BI-9`).
- **Nothing is learned from being refused** (`BI-4` applies here too).
- **`BI-6`**: status, submitted-at, last-updated, review attribution, and
  moderation notes must never reach a public surface — and this is the layer
  that finally holds them.

The mechanism behind `C8` is **`ADR-004`**, `Accepted` 2026-10-30 (issue #252).
`DG-3` remains `Unresolved`; a narrow exception (issue #254; full exception in `docs/13`,
*Gate-scope exception*) permits separately authorized authentication work **locally only**
(development mode, the web server bound to loopback, a local database, synthetic accounts), with
no moderation or business-administration capability.

## What exists (issue #260)

The first **local, synthetic** sign-in journey, and nothing to administer:

- `local-gate.ts`: the gate. Development mode, the launcher's canonical `https://127.0.0.1:<port>`
  origin, its loopback database, valid development keys, and an exact `Host`. Otherwise every
  administrative entry point answers 404.
- `request-checks.ts`: `Origin`, `Sec-Fetch-Site`, form type, size and fields, before any storage
  call. A body that fails or aborts while being read is refused the same way.
- `session-cookies.ts`: the three `__Host-` cookies (session, challenge and, since issue #268, the
  restricted recovery session), which can only be written with every production attribute.
- `authentication-runtime.ts`: one runtime per process on `globalThis`, created through one shared
  promise, so `ADR-028` D-17's limiter count P is the process count (measured as 1, issue #260 §6.8).
- `entry-points.ts` and `require-administrator.ts`: the three `POST` handlers and the page session
  check, each repeated at its own entry point. `/admin` reads its session from the raw `Cookie`
  header, refusing a duplicated session cookie. A sign-out whose deletion fails answers `503` and
  keeps the cookie, rather than appearing complete.

## The recovery journey (issue #268)

Still local and synthetic, and still nothing to administer:

- `recovery-entry-points.ts`: password then a recovery code (a restricted recovery session in its
  own cookie), TOTP re-enrolment start and completion, code regeneration, and the recovery logout.
  - Every request passes the gate and the request checks first. A refused request (class A) makes
    no storage call and sends no `Set-Cookie`.
  - A refused completion code can be retried against the same factor; the secret is not shown again.
- `require-recovery-session.ts`: the recovery page's session check. It accepts only a live
  `recovery` session. The merged `checkSession` refreshes a live session's activity before the
  kind is rejected; that effect is disclosed and tested.
- `display-once.ts`: the `POST` response documents that show a new secret or codes once. They are
  escaped and script-free, and carry no secret in any URL or request-bearing attribute.
- `/admin` never reads the recovery cookie, and refuses a recovery session's kind.

**Revocation and disablement** (issue #270) are operator commands, not part of this surface. Every
session check here refuses a session they ended, and every step refuses a disabled account.

**Still missing, deliberately:** re-enablement, the operator reset and key replacement.
Authentication is therefore **incomplete** under `ADR-004`, and nothing here is, or may become,
publicly reachable.
