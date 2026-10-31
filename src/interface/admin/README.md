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
no moderation or business-administration capability. No authentication or authorization is
implemented yet.

**Empty at scaffold time.**
