/**
 * `FR-ADM-04` — the pure-domain administrative edit of a **pending** listing (issue #215).
 *
 * An administrator moderating a submission may **complete** information that was optional at
 * initial submission and **correct** information that was submitted, before approval. That is a
 * *partial* edit, and it is the first operation in this repository that is: every existing
 * content operation takes a **complete** content set, because `ADR-017` defines a revision
 * proposal as *"a complete set, not a difference"*. A complete set cannot distinguish *leave this
 * field alone* from *remove it*, so `ADR-025` §C.4 records that `FR-ADM-04` needs a three-state
 * partial-edit input before it can exist. This module introduces exactly that, and the operation
 * that consumes it.
 *
 * ## Authority
 *
 * - **`ADR-017`** Q-4 — the business designates; the default is private; an administrator may
 *   **restrict** but never widen; a new or replacement value **defaults to private and inherits
 *   nothing**.
 * - **`ADR-025`** (`Accepted` 2026-10-17) — replacement is **exact carrier inequality**, with no
 *   normalization of any kind; restriction-only enforcement; widening is refused, never coerced.
 * - **The Product Owner ruling of 2026-10-19** (issue #213, recorded by PR #214 in `docs/05`,
 *   `docs/09`, `docs/13` and `docs/traceability-matrix.md`) — the no-op outcome, stated in full
 *   under *The no-op ruling* below.
 *
 * ## What this module is not
 *
 * It is **pure domain**. It reads no clock, performs no I/O, imports nothing from `src/data/`,
 * mutates no argument, and returns a value. There is **no** persistence, transaction, `PS-11`
 * lock, `ADR-023` stale token, SQL, transport, authorization, role, override, audit or messaging
 * here, and **no production consumer** is wired to it yet: `FR-ADM-04`'s persistence path and
 * `FR-ADM-10b` remain unimplemented, and each needs its own gates.
 *
 * It is also **not** `OP-6`. `createPendingRevision` proposes a revision against an **approved**
 * listing; this edits a **pending** record in place, before approval, and the two never meet.
 *
 * ## The no-op ruling
 *
 * An otherwise valid edit whose **fully materialized content and designations exactly equal** the
 * listing's current content **succeeds**, returning the **current `Listing` by exact reference**.
 * It is not refused for producing no material change, `lastUpdatedAt` does not move, and the
 * supplied instant is **not inspected, parsed or compared** on that path — an equal, earlier,
 * malformed or otherwise unusable `at` must not turn a valid no-op into a timestamp failure.
 *
 * Two consequences the ruling states explicitly, and this module obeys literally:
 *
 * 1. **The no-op returns before `withListingContent`**, which is the function that validates the
 *    instant and requires strict advancement. The primitive is reached only on the material path.
 * 2. **Materiality is judged from the materialized content, never from the patch's shape.** A
 *    syntactically busy patch can be a no-op, and a trivial-looking one can be material — an
 *    exactly equal **public** value supplied as **private** is a **restriction**, and restriction
 *    is a real change. No `PatchField` kind is ever consulted to decide materiality.
 *
 * And the order the ruling fixes, which is also `approvePendingRevision`'s established
 * lifecycle → validation → timestamp order with designation enforcement where `OP-6` puts it:
 * **lifecycle → patch validity and materialization → content validation → `ADR-025` →
 * no-op → `DI-6`**. Nothing invalid, malformed or prohibited can be laundered into no-op success,
 * because every one of those stages decides **before** the no-op test is reached.
 *
 * ## Why `at` is a parameter even though a no-op must not look at it
 *
 * The ruling governs **evaluation**, not parameter presence. Making the instant optional, or
 * splitting the operation in two, would let a caller omit it on a **material** edit — a weaker
 * contract than `withListingContent`'s, for the sake of an argument that is simply not read.
 */

import { enforceDesignationPolicy, type DesignatableField } from "./designation";
import type { Instant } from "./instant";
import {
  withListingContent,
  type DesignatableValue,
  type Listing,
  type ListingContent,
} from "./listing";
import { err, ok, type DomainError, type Result } from "./result";
import {
  validateInitialSubmission,
  REQUIRED_AT_INITIAL_SUBMISSION,
  type ValidationViolation,
} from "./validation";
import type { DesignationViolation } from "./designation";

/**
 * One instruction for one field.
 *
 * Three states, and exactly three: **preserve** it as it stands, **remove** it, or **supply** a
 * new value. The third is the only one that carries anything, which is what makes *remove* and
 * *supply `undefined`* impossible to confuse — the defect a `Partial<ListingContent>` patch has
 * and cannot be rid of.
 *
 * **Exported** because it is structurally present in every member of `AdministrativeEdit`; hiding
 * it would only force callers to spell the union out inline. No `preserve`/`remove` singleton
 * constants or constructor helpers accompany it: no production consumer needs them, and
 * exporting conveniences for tests alone is the mistake `classifyDesignatableChange` was already
 * kept private for.
 */
export type PatchField<T> =
  | { readonly kind: "preserve" }
  | { readonly kind: "remove" }
  | { readonly kind: "supply"; readonly value: T };

/**
 * The same instruction for a field that is **required at initial submission**, with *remove*
 * removed.
 *
 * `VR-S1` requires `name`, `category`, `description`, `locality` and `country` on every record,
 * so asking to remove one is not a request the domain can honour — and the type says so at
 * **compile time** rather than leaving it to a runtime refusal nobody reads until it fires. The
 * runtime guard still exists, because the type is erased and a value can arrive from a cast or a
 * boundary; this just means the mistake cannot be written in typed code at all.
 *
 * **Deliberately not exported.** It is an internal narrowing of `PatchField<T>` with no
 * independent meaning, and nothing outside this module constructs one by name.
 */
type RequiredPatchField<T> =
  | { readonly kind: "preserve" }
  | { readonly kind: "supply"; readonly value: T };

/**
 * One administrative edit: an instruction per field, each optional.
 *
 * **An absent key means `preserve`.** An administrator editing one field should not have to
 * restate the other nine, and an omitted field and an explicit `{ kind: "preserve" }` are the
 * same instruction — they are required to behave identically, and are tested to.
 *
 * **What cannot be edited is expressed by absence, not by refusal.** There is no key for `id`,
 * `status`, `publication` or `timestamps` — identity, lifecycle, publication state, `submittedAt`
 * and the write-once `rejectedAt` anchor are not content, and `FR-ADM-05` is explicit that
 * editing does not change status. A patch therefore cannot even *ask*.
 *
 * **A designatable field's `supply` carries the whole `DesignatableValue`** — carrier *and*
 * designation, together. That is not a convenience: `ADR-025` classifies a field by comparing
 * **carriers**, so a designation instruction with no carrier to compare has no meaning in the
 * policy, and making one unrepresentable is how this input stays faithful to the rule. A
 * **restriction** is therefore written as a `supply` of the **identical carrier** with
 * `designatedPublic: false`.
 */
export interface AdministrativeEdit {
  /** `FR-DATA-01`. */
  readonly name?: RequiredPatchField<string>;
  /** `FR-DATA-02` — the carrier is `CategoryKey`, the 16 governed machine keys, not `string`. */
  readonly category?: RequiredPatchField<ListingContent["category"]>;
  /** `FR-DATA-03`. */
  readonly description?: RequiredPatchField<string>;
  /** `FR-DATA-04`. */
  readonly locality?: RequiredPatchField<string>;
  /** `FR-DATA-06`. */
  readonly country?: RequiredPatchField<string>;
  /** `FR-DATA-05` — optional, and the one optional field that carries no designation. */
  readonly administrativeArea?: PatchField<string>;
  /** `FR-DATA-06b` — designatable. */
  readonly postalCode?: PatchField<DesignatableValue>;
  /** `FR-DATA-07` — designatable. */
  readonly phone?: PatchField<DesignatableValue>;
  /** `FR-DATA-07` — designatable. */
  readonly email?: PatchField<DesignatableValue>;
  /** `FR-DATA-07` — designatable. */
  readonly website?: PatchField<DesignatableValue>;
}

/**
 * The timestamp failures a **material** edit can actually report.
 *
 * Exported as documentation of the reachable set and **pinned by test**, not used to narrow the
 * failure union: `withListingContent`'s own `DomainError` is carried **intact**, exactly as
 * `DESIGNATION_POLICY_REFUSED` carries the policy's violations intact, so no code is restated
 * here and none can drift from what the primitive really produces.
 *
 * Everything in it comes from `resolveListingTimestamps` and `advancedTimestamps`;
 * `REJECTION_TIMESTAMP_ALREADY_SET` is **not** among them, because a content edit is not a
 * rejection and the primitive is called with `becomingRejected` false.
 */
export type TimestampAdvancementFailure = Extract<
  DomainError,
  {
    code:
      | "INVALID_INSTANT"
      | "LISTING_TIMESTAMPS_MISSING"
      | "INVALID_LISTING_TIMESTAMPS"
      | "TIMESTAMP_ORDER_VIOLATION"
      | "REJECTION_TIMESTAMP_NOT_APPLICABLE"
      | "REJECTION_TIMESTAMP_MISSING"
      | "INSTANT_NOT_STRICTLY_LATER";
  }
>;

/**
 * Why an administrative edit was refused.
 *
 * A **narrow local union**, on `CreatePendingRevisionFailure`'s precedent and for
 * `designation.ts`'s reason: a refusal this operation can produce is named here, and a refusal it
 * cannot is absent. **Stale-version, retry, storage, locking, authorization and transport
 * failures do not appear**, because none of those concerns exists in a pure domain operation —
 * and **no no-op failure exists at all**, because the ruling introduced none.
 *
 * The last member is `withListingContent`'s own failure type, carried through unchanged. It
 * admits codes a content edit cannot reach, which is honest: narrowing it here would restate the
 * primitive's contract in a second vocabulary that could silently fall out of step with it. The
 * reachable subset is `TimestampAdvancementFailure`, and a test pins it.
 */
export type AdministrativeEditFailure =
  /**
   * `FR-ADM-04` governs editing **during moderation and before approval**. An approved or
   * rejected record is not refused *by this code* as a bad edit — it is simply not this
   * operation's subject, and the caller is told which lifecycle state it offered.
   *
   * Shaped like `LISTING_NOT_APPROVED` and `LISTING_NOT_REJECTED`, which report the opposite
   * applicability gaps, and new because `DomainError` has no listing-pending code: it carries
   * `REVISION_NOT_PENDING`, which is about a revision proposal, not a listing.
   */
  | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  /**
   * The edit is not a usable edit: not an object, carrying a key that is not an editable field,
   * or carrying a field instruction that is not one of the three well-formed states — an unknown
   * `kind`, a `supply` whose `value` is missing or of the wrong carrier type, a `remove` of a
   * required field, or a `preserve`/`remove` that carries a value anyway.
   *
   * The types above exclude every one of these in typed code. They are still checked, because a
   * type is erased at runtime and these values arrive from boundaries, casts and rehydrated
   * records — the same reason `categoryMembershipViolations` widens to `unknown` before testing
   * a `CategoryKey`. A malformed input is a **governed value**, never a thrown error
   * (`ADR-002` `O-11`).
   *
   * `offered` carries the offending value — the edit itself for a container defect, the
   * unrecognised key for an unknown field, or the field's instruction for a shape defect.
   */
  | { readonly code: "INVALID_ADMINISTRATIVE_EDIT"; readonly offered: unknown }
  /**
   * `FR-VAL-04`/`VR-6` — the **materialized** content does not satisfy the initial-submission
   * obligations, carrying `validateInitialSubmission`'s violations through unchanged.
   *
   * **`REVISION_CONTENT_INVALID` is deliberately not reused.** That code reports the
   * **before-approval** obligation set on a **revision proposal**; this reports the
   * **initial-submission** set on a **pending listing**. Reusing it would misstate both the rule
   * set and the record type, and `FR-ADM-04`'s whole point is that an administrator's edit is
   * judged by the same rules a public submission is — never a stricter set, and never a bypass.
   */
  | {
      readonly code: "EDITED_CONTENT_INVALID";
      readonly violations: readonly ValidationViolation[];
    }
  /**
   * `ADR-025` — the edit would publish a value the policy requires to be private.
   *
   * The same code and payload `OP-6` reports, carrying the **complete** violation array in the
   * policy's own deterministic field order, with **no value** in it: a caller that widened two
   * fields is told about both, and nothing private travels in a failure.
   */
  | {
      readonly code: "DESIGNATION_POLICY_REFUSED";
      readonly violations: readonly DesignationViolation[];
    }
  | DomainError;

/**
 * The one optional field that is a plain string: present or absent, with no designation.
 *
 * Its own constant rather than an inline literal, so the three lists below can be proved to
 * partition `ListingContent`'s keys exhaustively at compile time.
 */
const OPTIONAL_PLAIN_FIELDS = ["administrativeArea"] as const;

/**
 * The four designatable fields, in `ADR-025`'s own evaluation order.
 *
 * Pinned here because `designation.ts` deliberately does not export its array — but the
 * `DesignatableField` **union** is exported, and the `satisfies` below is what makes this a copy
 * that cannot drift: a fifth designatable field, or a renamed one, fails to compile here.
 */
const DESIGNATABLE_FIELDS = [
  "postalCode",
  "phone",
  "email",
  "website",
] as const satisfies readonly DesignatableField[];

/**
 * Every field an administrative edit may name, and the only ones.
 *
 * `REQUIRED_AT_INITIAL_SUBMISSION` is **imported, not restated**: the required set belongs to
 * `validation.ts`, and reusing it means a sixth required field forces an intentional change here
 * rather than silently becoming uneditable.
 */
const EDITABLE_FIELDS = [
  ...REQUIRED_AT_INITIAL_SUBMISSION,
  ...OPTIONAL_PLAIN_FIELDS,
  ...DESIGNATABLE_FIELDS,
] as const;

/** Compile-time proof that the three lists partition `ListingContent` with nothing left over. */
type EditableField = (typeof EDITABLE_FIELDS)[number];
const _editableFieldsAreExhaustive: ReadonlySet<EditableField> = new Set<keyof ListingContent>(
  EDITABLE_FIELDS,
);
void _editableFieldsAreExhaustive;

/** One field instruction, read structurally rather than trusted from the erased type. */
type ReadPatch =
  | { readonly kind: "preserve" }
  | { readonly kind: "remove" }
  | { readonly kind: "supply"; readonly value: unknown };

/**
 * Read one field instruction, or report that it is not one.
 *
 * `value` is detected by **own-property presence**, not by `!== undefined`: a `supply` whose
 * value is genuinely `undefined` must be refused as malformed rather than silently treated as a
 * removal, and a `preserve` carrying an inert `value` key must be refused rather than quietly
 * accepted — that is the shape the three-state design exists to rule out.
 */
function readPatch(candidate: unknown): ReadPatch | undefined {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const carriesValue = Object.prototype.hasOwnProperty.call(record, "value");

  if (record["kind"] === "preserve" || record["kind"] === "remove") {
    return carriesValue ? undefined : { kind: record["kind"] };
  }

  if (record["kind"] === "supply" && carriesValue) {
    return { kind: "supply", value: record["value"] };
  }

  return undefined;
}

/**
 * Is this a usable `DesignatableValue`?
 *
 * The carrier must be a string and the designation, where present, a boolean. Absent is
 * permitted and means **private** — `PS-2`'s fail-closed default, and the same reading
 * `publicProjectionOf` and `enforceDesignationPolicy` already use. Nothing is normalized and no
 * format rule is stated: blankness and format remain `validation.ts`'s question.
 */
function isDesignatableValue(candidate: unknown): candidate is DesignatableValue {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }

  const record = candidate as Record<string, unknown>;

  return (
    typeof record["value"] === "string" &&
    (record["designatedPublic"] === undefined || typeof record["designatedPublic"] === "boolean")
  );
}

/** Set a field only when it has a value, so a removal leaves the key genuinely **absent**. */
function assign(target: Record<string, unknown>, field: EditableField, value: unknown): void {
  if (value !== undefined) {
    target[field] = value;
  }
}

/**
 * Apply the edit to the listing's current content, producing a **complete** `ListingContent`.
 *
 * Shape checking and materialization are one pass deliberately: a field is read exactly once, and
 * there is no window in which a value has been judged well formed by one traversal and then used
 * by a second that could disagree.
 *
 * **Nothing is mutated.** A fresh object is built; the listing, its content, the edit and every
 * `DesignatableValue` inside either of them are only ever read. A supplied value is carried by
 * reference into the new content — the same thing `enforceDesignationPolicy` does when it returns
 * its `proposed` argument — so no caller's object is copied, rewritten or frozen behind its back.
 *
 * **Nothing is normalized**, here or anywhere below: `ADR-025` prohibits trimming, case folding,
 * punctuation removal, phone-digit comparison, URL parsing, email normalization and any other
 * inferred canonicalization, because the repository governs none for these fields.
 */
function materializeEdit(
  listing: Listing,
  edit: AdministrativeEdit,
): Result<ListingContent, AdministrativeEditFailure> {
  if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
    return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: edit });
  }

  const offered = edit as Record<string, unknown>;

  // An unrecognised key is refused rather than ignored. Silently dropping it would turn a
  // caller's typo into a successful edit that changed nothing it was asked to.
  for (const key of Object.keys(offered)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: key });
    }
  }

  const current = listing.content;
  const materialized: Record<string, unknown> = {};

  for (const field of REQUIRED_AT_INITIAL_SUBMISSION) {
    const instruction = offered[field];

    if (instruction === undefined) {
      assign(materialized, field, current[field]);
      continue;
    }

    const patch = readPatch(instruction);

    // `remove` is excluded by `RequiredPatchField` in typed code; this is the runtime half of
    // that rule, for a value that reached here from a cast or a boundary.
    if (patch === undefined || patch.kind === "remove") {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    if (patch.kind === "preserve") {
      assign(materialized, field, current[field]);
      continue;
    }

    // `category`'s carrier is `CategoryKey`, but membership is **not** checked here: an
    // unapproved key is a content violation, and `validateInitialSubmission` reports it as
    // `CATEGORY_NOT_APPROVED` at the next stage. This checks only that a string arrived.
    if (typeof patch.value !== "string") {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    materialized[field] = patch.value;
  }

  for (const field of OPTIONAL_PLAIN_FIELDS) {
    const instruction = offered[field];

    if (instruction === undefined) {
      assign(materialized, field, current[field]);
      continue;
    }

    const patch = readPatch(instruction);

    if (patch === undefined) {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    if (patch.kind === "preserve") {
      assign(materialized, field, current[field]);
      continue;
    }

    if (patch.kind === "remove") {
      continue;
    }

    if (typeof patch.value !== "string") {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    materialized[field] = patch.value;
  }

  for (const field of DESIGNATABLE_FIELDS) {
    const instruction = offered[field];

    if (instruction === undefined) {
      assign(materialized, field, current[field]);
      continue;
    }

    const patch = readPatch(instruction);

    if (patch === undefined) {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    if (patch.kind === "preserve") {
      assign(materialized, field, current[field]);
      continue;
    }

    if (patch.kind === "remove") {
      // A removal leaves **no** surviving designation, because it leaves no value to carry one.
      continue;
    }

    if (!isDesignatableValue(patch.value)) {
      return err({ code: "INVALID_ADMINISTRATIVE_EDIT", offered: instruction });
    }

    materialized[field] = patch.value;
  }

  // The one cast in this module, and what makes it sound: the loops above are driven by
  // `EDITABLE_FIELDS`, which is proved exhaustive over `keyof ListingContent` at compile time,
  // and every value assigned has just been checked against its field's carrier. `category` is a
  // checked string whose **membership** the next stage judges.
  return ok(materialized as unknown as ListingContent);
}

/** Whether a designation is public. Only an explicit `true` is — `designation.ts`'s `isPublic`. */
function isPublic(designatable: DesignatableValue | undefined): boolean {
  return designatable?.designatedPublic === true;
}

/**
 * Are two designation-bearing values the same value with the same designation?
 *
 * The carrier is compared with `===`, **exactly**, as `ADR-025` requires. The designation is
 * compared as *public or not public*, because `false` and absent are the **same** designation
 * everywhere else in this system (`PS-2`, `publicProjectionOf`, `enforceDesignationPolicy`). That
 * matters here and nowhere else: a listing hydrated through `C9` always carries an explicit
 * boolean, while an administrator's supplied value may carry none, and reading them as different
 * would make an edit material purely because of which side a value came from.
 */
function designatableIsUnchanged(
  before: DesignatableValue | undefined,
  after: DesignatableValue | undefined,
): boolean {
  if (before === undefined || after === undefined) {
    return before === after;
  }

  return before.value === after.value && isPublic(before) === isPublic(after);
}

/**
 * Is the materialized content identical to the listing's current content?
 *
 * This is the ruling's no-op test, and it is stated over the **materialized** content — carriers
 * and designations alike — never over the patch. Every editable field participates, so one
 * skipped field cannot make a real change look like a no-op.
 *
 * An exactly equal **public** carrier supplied as **private** is therefore **not** unchanged:
 * `isPublic` differs, the content is material, and the restriction is applied and timestamped.
 * That is the ruling's section 6, and it is the single case where two identical-looking carriers
 * are a change.
 */
function contentIsUnchanged(current: ListingContent, materialized: ListingContent): boolean {
  for (const field of REQUIRED_AT_INITIAL_SUBMISSION) {
    if (current[field] !== materialized[field]) {
      return false;
    }
  }

  for (const field of OPTIONAL_PLAIN_FIELDS) {
    if (current[field] !== materialized[field]) {
      return false;
    }
  }

  for (const field of DESIGNATABLE_FIELDS) {
    if (!designatableIsUnchanged(current[field], materialized[field])) {
      return false;
    }
  }

  return true;
}

/**
 * Apply one administrative edit to a **pending** listing (`FR-ADM-04`).
 *
 * The stages, in the order the ruling fixes, with the **first failing stage winning** across
 * them and existing accumulation preserved **within** them:
 *
 * 1. **Lifecycle** — the record must be *pending*.
 * 2. **Patch validity and materialization** — the edit is read and applied to a complete content
 *    set.
 * 3. **Content validation** — `validateInitialSubmission`, reused unchanged, accumulating every
 *    violation. `validateBeforeApproval` is **never** called: that is `FR-ADM-06`'s gate.
 * 4. **`ADR-025`** — `enforceDesignationPolicy`, reused unchanged, invoked **once**, evaluating
 *    all four designatable fields and returning every violation in its own order.
 * 5. **No-op** — the materialized content is compared with the current content.
 * 6. **`DI-6`** — `withListingContent`, called **exactly once** and **only** for a material edit.
 *
 * On a **no-op** the listing is returned **by exact reference**: not cloned, not reconstructed,
 * not re-frozen, with `lastUpdatedAt` untouched and `at` never read. On a **material** edit a new
 * immutable `Listing` is returned with `lastUpdatedAt` advanced once, and identity, status,
 * `submittedAt`, `rejectedAt` and publication state carried through by the primitive. **No
 * failure ever carries a partial listing.**
 *
 * Pure and deterministic: the same inputs give the same outcome, no input is mutated, and no
 * clock, randomness or I/O is consulted.
 *
 * **The listing's content is assumed readable**, on the same terms `withListingContent` and
 * `enforceDesignationPolicy` already assume it: the readable-content guard belongs to the caller
 * that hydrated the record, and inventing a second one here would duplicate `INVALID_LISTING`.
 */
export function applyAdministrativeEdit(
  listing: Listing,
  edit: AdministrativeEdit,
  at: Instant,
): Result<Listing, AdministrativeEditFailure> {
  // (1) Lifecycle, first. `String` rather than a bare read because a rehydrated record can carry
  // anything in `status`, and a failure must report a string rather than smuggle out an object.
  if (listing.status !== "pending") {
    return err({ code: "LISTING_NOT_PENDING", status: String(listing.status) });
  }

  // (2) Patch validity and materialization.
  const materialized = materializeEdit(listing, edit);

  if (!materialized.ok) {
    return materialized;
  }

  // (3) The initial-submission rules, applied to the **result** of the edit. An administrator's
  // completion is validated exactly as a public submission is (`FR-ADM-04`: never a bypass).
  const validated = validateInitialSubmission(materialized.value);

  if (!validated.ok) {
    return err({ code: "EDITED_CONTENT_INVALID", violations: validated.error });
  }

  // (4) `ADR-025`, before any no-op judgement, so a prohibited widening cannot be laundered into
  // success by also happening to leave the carrier equal.
  const designation = enforceDesignationPolicy(listing.content, materialized.value);

  if (!designation.ok) {
    return err({ code: "DESIGNATION_POLICY_REFUSED", violations: designation.error });
  }

  // (5) The ruling. Returned **here** — before the instant is touched in any way, and before the
  // primitive that would touch it is called.
  if (contentIsUnchanged(listing.content, materialized.value)) {
    return ok(listing);
  }

  // (6) `DI-6`, for material edits only, exactly once.
  return withListingContent(listing, materialized.value, at);
}
