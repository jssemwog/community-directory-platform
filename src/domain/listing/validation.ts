/**
 * `P1` Slice A — the decided validation obligations, and only those.
 *
 * `OQ-8`/`OQ-8b` (Decided) fill `VR-S1`, `VR-S2` and the `VR-S3` **posture**
 * (`FR-VAL-05`; `docs/08` *Validation rules*), keeping three stages apart:
 *
 * - **`VR-S1` — required at initial submission.** Business name, category, description,
 *   locality and country are present and valid. Administrative area, postal code, phone,
 *   email and website may all be omitted, and a submission omitting every one of them is
 *   **accepted into moderation** (`FR-SUB-05`).
 * - **`VR-S2` — required before approval.** All of the above, **plus at least one usable
 *   contact method** — phone, email or website (`FR-DATA-08`). Locality, administrative
 *   area, postal code, country and any physical-location information are **not** contact
 *   methods and never satisfy it. There is **no offline-business exemption**.
 * - **`VR-S3` — format posture.** Permissive, international-friendly, technology-neutral.
 *   Its **expression** — pattern, library, parser, control, constraint — is deliberately
 *   **not** decided (`VR-S3` *"a model that writes a concrete regular expression here has
 *   not implemented `VR-S3`; it has overwritten it"*). The only part of the posture that is
 *   decided and expressible today is **blankness**: a value is *usable* when it is
 *   **non-blank** (`docs/08`, `FR-DATA-08`). Nothing stricter is applied here — no regular
 *   expression, length limit, normalization, formatting policy, or email/phone/URL
 *   semantics is introduced, and no validation library is used.
 *
 * `VR-5`/`FR-VAL-02` requires validation to identify the specific field(s) at fault, so
 * results are field-level. Violations are returned as values; nothing is thrown.
 *
 * **Category set membership is now implemented** (issue #175). `DDM-3` was open when this
 * module was written, so `DI-9`/`VR-2` could not be enforced; `Accepted` `ADR-021`
 * (2026-10-09) decides it, and the approved vocabulary is now an executable configuration
 * (`category.ts`). A present-and-usable category outside the 16 approved machine keys is
 * therefore a violation here — `CATEGORY_NOT_APPROVED` — and not a tolerated unknown.
 *
 * Still not decided here and therefore still not implemented: location normalization
 * (`DDM-5`), duplicate detection (`VR-S6`, `OQ-12`), and every safety/length boundary
 * `VR-S3` leaves to `DD-1`/`DD-2`.
 */

import { isCategoryKey } from "./category";
import type { ListingContent } from "./listing";
import { err, ok, type Result } from "./result";

/** `VR-S1` — the fields required at initial submission. */
export const REQUIRED_AT_INITIAL_SUBMISSION = [
  "name",
  "category",
  "description",
  "locality",
  "country",
] as const;

export type RequiredAtInitialSubmissionField =
  (typeof REQUIRED_AT_INITIAL_SUBMISSION)[number];

/** `FR-DATA-07`/`FR-DATA-08` — the three contact methods, and the only ones. */
export const CONTACT_METHOD_FIELDS = ["phone", "email", "website"] as const;

export type ContactMethodField = (typeof CONTACT_METHOD_FIELDS)[number];

export type ValidationViolation =
  | {
      readonly code: "REQUIRED_VALUE_MISSING";
      readonly field: RequiredAtInitialSubmissionField;
    }
  | {
      readonly code: "CONTACT_METHOD_MINIMUM_UNMET";
      readonly fields: readonly ContactMethodField[];
    }
  | {
      /**
       * `DI-9`/`VR-2`/`AV-7` — the category is present and usable but is **not one of the
       * 16 approved machine keys** (`ADR-021`; issue #175).
       *
       * Distinct from `REQUIRED_VALUE_MISSING`, which still reports an absent or blank
       * category: a caller that supplied nothing and a caller that supplied an unapproved
       * value have made different mistakes and are told so separately.
       */
      readonly code: "CATEGORY_NOT_APPROVED";
      readonly field: "category";
    };

/**
 * The decided, expressible part of `VR-S3`: a value is usable when it is non-blank.
 *
 * An absent value and a value of whitespace alone are both unusable. This states no
 * format rule of any kind.
 */
export function isUsableValue(candidate: string | undefined): boolean {
  return candidate !== undefined && candidate.trim().length > 0;
}

function requiredFieldViolations(
  content: ListingContent,
): readonly ValidationViolation[] {
  return REQUIRED_AT_INITIAL_SUBMISSION.filter(
    (field) => !isUsableValue(content[field]),
  ).map((field) => ({ code: "REQUIRED_VALUE_MISSING", field }) as const);
}

/**
 * `DI-9`/`VR-2`/`AV-7` — the category must be one of the 16 approved machine keys.
 *
 * Reported **only when the value is present and usable**, so that an absent or blank
 * category keeps reporting `REQUIRED_VALUE_MISSING` and a caller never receives two
 * violations for one omission. The existing `VR-S1` rule is unchanged.
 *
 * The value is widened to `unknown` before the guard deliberately. `ListingContent.category`
 * is typed `CategoryKey`, but the type is erased at runtime and these validators exist
 * precisely to judge values arriving from a boundary, a cast or a rehydrated record — so the
 * check must be a real one, not a tautology the compiler optimises away in the reader's head.
 * Widening is safe; nothing is asserted about the value.
 *
 * **Nothing is normalized.** A padded, mis-cased or label-shaped value is a violation, not
 * something to repair (`OQ-5` admits no aliases; `VR-S3` leaves format expression undecided).
 */
function categoryMembershipViolations(
  content: ListingContent,
): readonly ValidationViolation[] {
  if (!isUsableValue(content.category)) {
    return [];
  }

  return isCategoryKey(content.category as unknown)
    ? []
    : [{ code: "CATEGORY_NOT_APPROVED", field: "category" } as const];
}

/**
 * `VR-S2` — is at least one contact method usable?
 *
 * "Usable" is **structural**: non-blank and retained as the value proposed for the
 * listing. It is never verified as owned, reachable or active — no confirmation email,
 * SMS, call, ownership proof, domain check or third-party validation exists here.
 */
export function usableContactMethodsOf(
  content: ListingContent,
): readonly ContactMethodField[] {
  return CONTACT_METHOD_FIELDS.filter((field) => isUsableValue(content[field]?.value));
}

/**
 * `VR-S1` + `VR-S3` — the rules applicable at initial submission.
 *
 * The contact minimum is **not** applied at this step (`FR-VAL-01`): a submission
 * carrying no phone, email or website is valid here and enters moderation normally.
 */
export function validateInitialSubmission(
  content: ListingContent,
): Result<ListingContent, readonly ValidationViolation[]> {
  const violations = [
    ...requiredFieldViolations(content),
    ...categoryMembershipViolations(content),
  ];

  return violations.length === 0 ? ok(content) : err(violations);
}

/**
 * `VR-S1` + `VR-S3` + `VR-S2` — the before-approval obligation set (`FR-ADM-06`,
 * `FR-VAL-05`). It is the same rule set for a public submission, an administrator's
 * completion of one (`FR-ADM-04`), and the content of a pending revision (`VR-6`,
 * `FR-VAL-04`) — there is no privileged bypass.
 *
 * A pending record that fails here is **not** in an invalid state; it is precisely the
 * legitimately incomplete record an administrator completes before approval.
 */
export function validateBeforeApproval(
  content: ListingContent,
): Result<ListingContent, readonly ValidationViolation[]> {
  const violations = [
    ...requiredFieldViolations(content),
    ...categoryMembershipViolations(content),
  ];

  if (usableContactMethodsOf(content).length === 0) {
    violations.push({
      code: "CONTACT_METHOD_MINIMUM_UNMET",
      fields: CONTACT_METHOD_FIELDS,
    });
  }

  return violations.length === 0 ? ok(content) : err(violations);
}
