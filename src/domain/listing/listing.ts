/**
 * `P1` Slice A — the listing record (`E1`) as a logical type.
 *
 * The field set comes from the `DG-1` answers and from nowhere else
 * (`docs/12` *Phase 1*): `OQ-6` (the location inventory and its obligations), `OQ-7`
 * (the public/withheld designations) and `OQ-8`/`OQ-8b` (the obligation set). Every
 * attribute below traces to an approved `FR-DATA-*` requirement listed against it in
 * `docs/08` *Listing entity* and *Field classification*.
 *
 * Deliberately absent, because Slice A does not own them:
 * - **Submitted-at / last-updated-at** (`FR-AUD-02/03`, `DI-6`) — `DI-6` belongs to a
 *   later slice, and no timestamp is added here by convention.
 * - **Publication state** (`OQ-11`) — a separate product concept whose representation is
 *   `DDM-9`, unresolved (`ADR-006` *Explicit deferrals*).
 * - **Review data** (`E4`) — seam `S-7`, open.
 *
 * This is a **logical** model (`docs/08` **P6**): meanings and obligations, never column
 * types, keys, indexes, nullability, or storage shape.
 */

import type { ListingId } from "./listing-id";
import type { ListingStatus } from "./status";

/**
 * A value the business may designate for public display.
 *
 * `OQ-7` decides the **obligation** — postal code is public only where provided *and*
 * designated for public display, and a contact method is public only where the business
 * designated it public (`FR-DATA-11c`). How that designation is *represented* is
 * `DDM-6`, which remains unresolved; this type expresses the logical designation only.
 *
 * `designatedPublic` is optional so that the `S-2` fail-closed default is expressible:
 * an attribute whose designation is undecided is **not public**.
 */
export interface DesignatableValue {
  readonly value: string;
  readonly designatedPublic?: boolean;
}

/** The listing content governed by the `DG-1` answers. */
export interface ListingContent {
  /** `FR-DATA-01` — required at initial submission. */
  readonly name: string;
  /** `FR-DATA-02` — required at initial submission. Set membership is `DI-9`, a later slice. */
  readonly category: string;
  /** `FR-DATA-03` — required at initial submission. */
  readonly description: string;
  /** `FR-DATA-04` (`OQ-6`) — required at initial submission. */
  readonly locality: string;
  /** `FR-DATA-06` (`OQ-6`) — required at initial submission, on every record. */
  readonly country: string;
  /** `FR-DATA-05` (`OQ-6`) — optional; public where provided. */
  readonly administrativeArea?: string;
  /** `FR-DATA-06b` (`OQ-6`) — optional; public only where provided and designated public. */
  readonly postalCode?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly phone?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly email?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly website?: DesignatableValue;
}

/**
 * One listing record: one durable identity, exactly one status at all times (`DI-1`),
 * and its content. A submission **is** a listing whose status is *pending* — there is no
 * separate submission concept (`ADR-006` decision 1; `docs/08` *Listing-submission entity*).
 */
export interface Listing {
  readonly id: ListingId;
  readonly status: ListingStatus;
  readonly content: ListingContent;
}

/**
 * Replaces a listing's content, leaving its identity and status untouched.
 *
 * This is the content-edit operation `DI-8` is stated over: a record survives an edit
 * without becoming a different record. It is pure — the input listing is not mutated.
 */
export function withListingContent(listing: Listing, content: ListingContent): Listing {
  return { id: listing.id, status: listing.status, content };
}
