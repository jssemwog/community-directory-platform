<!--
This template is derived from CONTRIBUTING.md and docs/12-implementation-plan.md
(Pull-request strategy, Review and approval workflow, Definition of done). Where it
appears to conflict with the approved chain (docs/01–docs/12), the chain wins.

Fill every section. Where one does not apply, write "none" so the absence reads as a
decision, not an omission. One pull request per issue, small enough to review in one
sitting. Split anything that touches two surfaces, mixes a refactor with a behavior
change, or mixes an ADR with the code that depends on it — the ADR merges first.
-->

## Approaches an open question?

<!--
The single most valuable line here. A field name, a default, a status value, an
ordering, a retention period, a category, or an asserted list can each close a question
the product owner was never asked. State it plainly if this change comes near one — and
name the rule you built, leaving the list to configuration. Write "none" only after
checking there is genuinely none.
-->

**Does this change approach an unresolved open question?**

-

## Traceability

- **Closes:** #<!-- issue number; this pull request closes exactly one issue -->
- **Requirement / source-document reference:** <!-- FR-… · a journey (V… / L… / A…) · NFR-… · docs/NN-… — the identifiers, no prose (IP-4) -->
- **Implementation phase:** <!-- P0a · P0b · P1 · P2 · P3 · P4 · P5 -->
- **Related decision gate:** <!-- DG-0 · DG-1 · DG-2 · DG-3 · DG-4 · none -->
- **Open questions it must not answer:** <!-- OQ-… · NOQ-… · AQ-… · none -->

## Scope

- **What this change does:** <!-- one reviewable increment; the smallest thing that satisfies the requirement -->
- **Files or areas changed:**
- **Explicit exclusions:** <!-- what this deliberately does NOT do — distinguish excluded (not in the MVP, docs/03) from blocked (would be built, but its decision is unmade) -->

## Invariants and verification

- **Invariants it touches, and how they are proven:** <!-- BI-… and/or DI-…, each proven by an attacking test in this pull request (IP-5, IP-6) — or "none" if it touches no invariant -->
- **Its tests are in this pull request:** <!-- yes / not applicable. A boundary proven "next sprint" was unprotected in between (IP-6, non-negotiable) -->
- **Validation performed:** <!-- how the behavior was verified, at the level where it is enforced — not only through the interface (IP-5, BI-9) -->

## Documentation

- **Documentation and traceability updates this change necessitates:** <!-- docs/NN-…, an ADR, the traceability matrix — updated in this pull request (IP-9) — or "none" -->

## Risks, assumptions, and follow-up

- **Risks:**
- **Assumptions carried:** <!-- any shaping input consciously carried as a stated assumption, not resolved by default -->
- **Follow-up work:**

---

## Definition of done

<!-- The eight conditions from docs/12-implementation-plan.md. Condition 3 is the sharp
one: "the test passes" is not the standard; "we tried to break it and could not" is. -->

- [ ] 1 — The behavior matches the approved requirement — no more, and no less.
- [ ] 2 — Its tests are merged with it (`IP-6`), at the level where the behavior is enforced (`IP-5`).
- [ ] 3 — Every invariant it touches is proven by an attacking test — one that attempts the violation and fails to achieve it.
- [ ] 4 — Empty, error, validation, loading, and confirmation states exist where `docs/10` requires them.
- [ ] 5 — Keyboard operability holds for the flows it touches.
- [ ] 6 — No open question was answered by it. Any decision made is recorded in an ADR or a document amendment in this pull request.
- [ ] 7 — Documentation and traceability are updated (`IP-9`).
- [ ] 8 — It is reviewed, approved, and merged to `main`.

---

## Reviewer checklist

<!-- Reviewer responsibilities, in priority order (CONTRIBUTING.md, Review). -->

- [ ] **Does this change silently answer an unresolved open question?** — a field name, a default, a status value, a retention period, or an ordering can each quietly close a question the product owner has not been asked. **This is the failure mode the whole plan exists to prevent.**
- [ ] **Issue scope satisfied** — the change delivers what its issue states, no more and no less.
- [ ] **Dependencies merged** — nothing this change depends on is still unmerged.
- [ ] **Traceability maintained** — the change names the requirement it serves, and the chain holds in both directions.
- [ ] **Verification appropriate to the work** — proven where it is enforced, not only through the interface; invariants attacked, not merely exercised.
- [ ] **Documentation updated where required** — the documentation still tells the truth after this merge (`IP-9`).
- [ ] **No unrelated changes** — nothing outside the issue's scope has been slipped in.
- [ ] **No secrets or private information introduced** — no credentials, tokens, or personal data appear in the diff.
