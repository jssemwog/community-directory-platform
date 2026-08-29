# `domain/` — application and domain logic

Plain modules behind the seams. May depend on `data/`. **May not depend on
`interface/` or on `src/app/`** — dependencies point strictly inward
(`docs/07`; `ADR-002` `O-9`).

| Component | Responsibility | Status |
|---|---|---|
| `C4` — Directory Query Service | The approved-record read path and the public projection | `P2` |
| `C5` — Submission Service | The public write path | `P3` |
| `C6` — Moderation Service | **Sole writer of status**; the lifecycle transitions | `P4` |
| `C7` — Validation Rules | Shared, authoritative, server-side (`O-5`) | `P3`/`P4` |
| `C8` — Identity and Access | The gate for `TB-3`, enforced on every request (`O-3`) | `P4`, mechanism blocked by `DG-3` (`ADR-004`) |
| `C10` — Audit Recorder | **Conditional** — exists only if `OQ-14`/`NOQ-8` resolves yes | `DG-3` |
| `C11` — Abuse Safeguard | **Conditional** — the seam is built in `P3`; the mechanism is `OQ-9` | `DG-3` |

`ADR-002` `O-11`: logic here must be testable **in-process, without a browser
and without a deployed environment**. That is why it is a plain module tree and
not a pile of framework components.

`C10` and `C11` are listed so their absence reads as a decision, not an
omission (`IP-7`). Neither may be built before its question is answered.

**Empty at scaffold time.**
