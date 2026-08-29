# `interface/` — the outermost layer

Surface-facing modules. This layer may depend on `domain/`. **Nothing in
`domain/` or `data/` may depend on anything here** — dependencies point
strictly inward: interface → domain → data access (`docs/07`; `ADR-002` `O-9`).

| Component | Lives in | Surface |
|---|---|---|
| `C1` — Public Directory Interface | `public/` | Public read (`TB-1`) |
| `C2` — Submission Interface | `public/` | Public write (`TB-2`) |
| `C3` — Administrative Interface | `admin/` | Administrative (`TB-3`) |

The split into `public/` and `admin/` is the trust boundary made structural.
It is not an organisational preference, and merging the two directories would
erase the only structural signal that a change crosses a surface.

`src/app/` holds the Next.js route segments — the delivery mechanism. The
modules here hold the surface logic those segments call. Keeping them apart is
`ADR-002` `O-8`: domain and application logic does not live in components
merely because co-location is convenient.

**Empty at scaffold time.** No surface behaviour exists yet.
