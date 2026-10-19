/**
 * `ADR-025` — the designation policy for replaced and added listing values (issue #205).
 *
 * `ADR-017`'s Q-4 ruling settled designation *authority*: the business designates each supplied
 * contact value and postal code at submission, the default is private, an administrator may
 * **restrict** but **never** make a business-withheld value public, and a **new or replacement**
 * value **defaults to private and does not inherit** the replaced value's designation. What it
 * deliberately deferred was *when a supplied value counts as a replacement* and *how the
 * restriction-only rule is enforced. `ADR-025` (`Accepted` 2026-10-17, issue #203) fills both.
 *
 * This module is that policy and nothing else. It is **pure**: it reads no clock, performs no
 * I/O, imports nothing from `src/data/`, mutates neither argument, and returns a value.
 *
 * ## The rule, in one sentence
 *
 * A designation-bearing value is **replaced** only where its carrier differs from the listing's
 * current persisted carrier by **exact** comparison; every actual replacement or addition
 * **defaults to private** and may not be made public; an **unchanged** value may keep its
 * designation or be **restricted** public→private, but **never widened** private→public.
 *
 * ## Why the comparison is exact, and why that is not laziness
 *
 * `ADR-025` prohibits trimming, case-folding, punctuation removal, phone-digit comparison, URL
 * parsing, email normalization and *any other inferred canonicalization*, for a reason recorded
 * in the ADR: **the repository governs no normalization for any of these four fields.**
 * `FR-VAL-05` prescribes *"no regular expression, validation library, UI widget, schema type,
 * database constraint, country-specific phone format, URL parser, or email-validation
 * algorithm"*, and the one place canonicalization was ever considered — `ADR-021`'s category
 * keys — records that **nothing is normalized**. So "semantically equal" has no definition in
 * this system to appeal to, and inventing one here would decide a normalization policy inside a
 * privacy rule. `ADR-025` records the cost honestly: re-typing `+353 21 123 4567` as
 * `+353211234567` **is** a replacement and becomes private.
 *
 * The consequence is deliberately conservative. Where the comparison is unsure, the value ends
 * up **private** — never public.
 *
 * ## Private is the absence of an explicit `true`
 *
 * `DesignatableValue.designatedPublic` is optional, so three states reach this module: `true`,
 * `false` and `undefined`. Only `true` is public. That is not a local convention — it is how
 * `publicProjectionOf` already reads a designation, and how `ADR-017` `PS-2`'s fail-closed
 * default is expressed, so a value whose designation nobody set is **not public**.
 *
 * It matters here because the two sides of the comparison arrive from different places: a
 * **current** listing hydrated through `C9` always carries an explicit boolean (`row-mapping.ts`
 * reconstructs one), while **proposed** content built by a caller may carry `undefined`. Treating
 * `undefined` as anything but private would make the rule depend on which side it came from.
 *
 * ## What this module is not
 *
 * - It is **not** a content validator. Blankness, format, length, safety and category membership
 *   are `validation.ts`'s, and `ADR-025` requires this refusal stay **distinct** from malformed
 *   content — so `DesignationViolation` is its own type and is never folded into
 *   `ValidationViolation`.
 * - It is **not** a patch evaluator. It compares two **complete** content sets, because
 *   `ADR-017` defines a proposal as *"a complete set, not a difference"*. An absent proposed
 *   value is therefore an **explicit removal**, never a patch-style omission. The three-state
 *   partial-edit boundary `ADR-025` requires before `FR-ADM-04` is a later unit's problem, and
 *   nothing here invents it.
 * - It is **not** a persistence, transport, normalization or authorization boundary, and gains
 *   none of those by having a consumer. `ADR-025` sequenced this module as step 3 and `OP-6`
 *   reconciliation as step 4; **step 4 landed with issue #207 (PR #208)**, so
 *   `createPendingRevision` now **consumes and enforces** this policy when a pending revision is
 *   created. `FR-ADM-04` and `FR-ADM-10b` remain **unimplemented** future consumers.
 */

import type { DesignatableValue, ListingContent } from "./listing";
import { err, ok, type Result } from "./result";

/**
 * The four fields `ADR-025` governs, in the order they are evaluated.
 *
 * **Deliberately not exported.** Production callers invoke the policy rather than iterating the
 * field list, so exporting the array would be exporting for tests alone. The order is observable
 * — and pinned by test — through the order violations are returned in, and `DesignatableField`
 * below exports the union so a fifth designatable field still forces an intentional change here.
 *
 * `administrativeArea` is **not** in this list: it is a plain `string` on `ListingContent` and
 * carries no designation.
 */
const DESIGNATABLE_FIELDS = ["postalCode", "phone", "email", "website"] as const;

/** A field whose value carries a public/private designation (`FR-DATA-11c`, `FR-DATA-06b`). */
export type DesignatableField = (typeof DESIGNATABLE_FIELDS)[number];

/**
 * `ADR-025`'s classification of one field between two complete content sets.
 *
 * Four names for the five cases the ADR enumerates, because *absent → absent* and
 * *present → exactly equal* are both **unchanged** and the policy treats them identically.
 */
export type DesignationChange = "unchanged" | "removed" | "added" | "replaced";

/**
 * Why a proposal was refused: a designation would have become public where `ADR-025` forbids it.
 *
 * One entry per offending field. **Distinct from `ValidationViolation` by type, not by
 * convention** — `ADR-025` requires this refusal stay separate from malformed content, stale
 * input, timestamp-advancement failure, lifecycle failure and storage failure, and a compile-time
 * guard pins the non-assignability in both directions.
 *
 * `change` records which classification produced the refusal, so a caller can tell an attempted
 * widening of an unchanged value from a replacement that asked to be published.
 */
export type DesignationViolation = {
  readonly code: "DESIGNATION_WIDENING_REFUSED";
  readonly field: DesignatableField;
  readonly change: DesignationChange;
};

/** Whether a designation is public. Only an explicit `true` is; `false` and absent are not. */
function isPublic(designatable: DesignatableValue | undefined): boolean {
  return designatable?.designatedPublic === true;
}

/**
 * Classify one field between the current and proposed content.
 *
 * **Exact carrier comparison**, with no normalization of any kind — see the module header for why
 * that is the governed choice rather than a shortcut. Only the `value` participates: a
 * designation change alone never makes a value a replacement, which is what allows an unchanged
 * value to be restricted.
 *
 * **Deliberately not exported.** The Release Gate tested the Development Gate's reason for
 * exporting it — that *unchanged* versus *removed* is otherwise unobservable — and rejected it:
 * test observability must not decide a production API. No requirement identifies a consumer
 * (`FR-CONF-04` governs the resulting **revision** state, not designation outcomes), and nothing
 * governed is lost, because the policy **enforces** the removal rule behaviourally — it returns
 * the proposal, so the removed field is absent and the old value is demonstrably not preserved.
 *
 * `DesignationChange` stays exported because `DesignationViolation.change` carries it; only the
 * computation is private. One consequence is recorded honestly rather than hidden: a removal is
 * always accepted, so **`"removed"` can never appear in a violation** and that member of the
 * union is unreachable through the public surface. It is kept because it is `ADR-025`'s own
 * vocabulary for the case, and narrowing the union would misstate the policy.
 */
function classifyDesignatableChange(
  current: DesignatableValue | undefined,
  proposed: DesignatableValue | undefined,
): DesignationChange {
  if (current === undefined) {
    // Nothing to replace. An arriving value is an addition, which `ADR-025` treats as a
    // replacement for designation purposes; nothing arriving leaves the field as it was.
    return proposed === undefined ? "unchanged" : "added";
  }

  if (proposed === undefined) {
    // `ADR-017`'s proposal is a complete set, so an absent value here is the caller saying
    // "remove it" — never "leave it alone". Whether absence is permitted at all is
    // `validation.ts`'s requiredness question, not this rule's.
    return "removed";
  }

  // `===` on the carriers, deliberately. Any difference at all — whitespace, case, punctuation,
  // phone spacing, URL spelling — is a replacement.
  return current.value === proposed.value ? "unchanged" : "replaced";
}

/**
 * Enforce `ADR-025` over two complete content sets.
 *
 * Returns the **`proposed` content, by exact reference**, when every governed field is
 * permissible. Nothing is reconstructed and no designation is rewritten: every case that
 * survives is already compliant, because a replacement or addition asking to be public is
 * *refused* rather than coerced, and one that does not ask is private whether its designation is
 * `false` or absent (`PS-2`, `publicProjectionOf`).
 *
 * Returns **every** violation otherwise, in `DESIGNATABLE_FIELDS` order. All four fields are
 * evaluated before returning — `FR-VAL-02`/`VR-5` require the specific fields at fault, and a
 * caller that widened two of them is told about both. There is **no partial success**: a refusal
 * carries no content.
 *
 * Non-designation content — name, category, description, locality, country, administrative area —
 * is neither examined nor altered by this rule. The operation changes no listing identity,
 * status, timestamp or publication metadata, because it is handed content rather than a listing
 * and returns content rather than one.
 *
 * **There is no override.** The signature takes no role, flag or option, so no caller can ask for
 * the refusal to be waived.
 *
 * Assumes content that has already passed the readable-content guard and the validators: it
 * judges designation transitions only, and reports nothing about format or blankness.
 */
export function enforceDesignationPolicy(
  current: ListingContent,
  proposed: ListingContent,
): Result<ListingContent, readonly DesignationViolation[]> {
  const violations: DesignationViolation[] = [];

  for (const field of DESIGNATABLE_FIELDS) {
    const before = current[field];
    const after = proposed[field];
    const change = classifyDesignatableChange(before, after);

    if (!isPublic(after)) {
      // Private, or restricted to private, or removed: always permitted. `ADR-025` allows an
      // unchanged value to be restricted public→private, and never objects to a private one.
      continue;
    }

    if (change === "unchanged" && isPublic(before)) {
      // The business's own public designation, carried forward unchanged. Permitted.
      continue;
    }

    // Everything reaching here would publish a value `ADR-025` requires to be private: an
    // addition or replacement asking to be public, or a private value being widened. Refused
    // explicitly — never coerced, ignored, or folded into ordinary validation.
    violations.push({ code: "DESIGNATION_WIDENING_REFUSED", field, change });
  }

  return violations.length === 0 ? ok(proposed) : err(violations);
}
