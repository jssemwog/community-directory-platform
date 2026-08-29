# `platform/` — cross-cutting operational concerns

Holds **`C12`** (Observability and Operations) — described in `docs/07` as a
process concern rather than a component of the request path.

**Empty at scaffold time**, and nothing here is decided:

- **No observability vendor or product is selected.** `ADR-005` leaves it
  untouched.
- **Operational-log retention is `NOQ-7`, deferred to `DG-4`.**
- **The exclusion rule is not deferred**: credentials and submission content
  never appear in logs (`NFR-OBS-02`), and it applies from the first log line
  ever written.

`ADR-002` `O-7`: secrets remain server-only. No credential, key, or connection
string may reach the client bundle — which is a constraint on this layer as
much as on `data/`.
