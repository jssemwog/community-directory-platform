/**
 * Synthetic, **fictional** listings for the local demonstration (issue #248).
 *
 * Every name, place and contact detail here is invented: web and email addresses use the
 * reserved `example` names (RFC 2606) and phone numbers use the fictional `555-01xx` range.
 *
 * Each listing is created through the existing paths, not written as rows:
 * - `validateInitialSubmission` and `submitListing` (the domain), then `insertSubmittedListing`
 *   (submission persistence);
 * - `persistListingApproval` (`OP-7`) for the approved ones;
 * - `rejectPendingListing` (`OP-8`) for the rejected one.
 *
 * One listing is left pending and one is rejected, so the demo can show that neither appears in
 * the directory and that both answer with the same not-available page as an unknown identity.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { instantOf, type Instant } from "../../src/domain/listing/instant";
import { submitListing, type ListingContent } from "../../src/domain/listing/listing";
import { listingIdOf } from "../../src/domain/listing/listing-id";
import { validateInitialSubmission } from "../../src/domain/listing/validation";
import { persistListingApproval } from "../../src/data/listing-approval";
import { rejectPendingListing } from "../../src/data/listing-rejection";
import { insertSubmittedListing } from "../../src/data/listing-repository";
import type { ListingDatabase } from "../../src/data/listing-table";

export type SyntheticOutcome = "approved" | "pending" | "rejected";

export interface SyntheticListing {
  readonly id: string;
  readonly outcome: SyntheticOutcome;
  readonly content: ListingContent;
}

/** A fixed moment, so every seeding produces the same records. */
const SUBMITTED_AT = 1_767_607_200_000;
const DECIDED_AT = SUBMITTED_AT + 60_000;

export const SYNTHETIC_LISTINGS: readonly SyntheticListing[] = [
  {
    id: "0b7e4c52-6f1a-4d3b-8e29-5a1c7f3d9e01",
    outcome: "approved",
    content: {
      name: "Juniper Lane Bakery",
      category: "food-drink",
      description: "A fictional neighbourhood bakery baking sourdough, rye and seasonal pastries.",
      locality: "Elmstead",
      administrativeArea: "North Vale",
      country: "Exampleland",
      postalCode: { value: "EX1 4JL", designatedPublic: true },
      phone: { value: "+1 555 0101", designatedPublic: true },
      email: { value: "hello@juniper-bakery.example", designatedPublic: true },
      website: { value: "https://juniper-bakery.example", designatedPublic: true },
    },
  },
  {
    id: "1c8f5d63-7a2b-4e4c-9f3a-6b2d8a4e0f12",
    outcome: "approved",
    content: {
      name: "Harbourside Bicycle Repair",
      category: "automotive-transport",
      description: "Fictional repairs, tune-ups and secondhand bicycles by the harbour.",
      locality: "Harrow Bay",
      country: "Exampleland",
      // Supplied but not designated public: the projection withholds it.
      phone: { value: "+1 555 0102", designatedPublic: false },
      email: { value: "workshop@harbourside-bikes.example", designatedPublic: true },
    },
  },
  {
    id: "2d9a6e74-8b3c-4f5d-a04b-7c3e9b5f1a23",
    outcome: "approved",
    content: {
      name: "Elmstead Community Garden",
      category: "community-nonprofit",
      description: "A fictional volunteer-run garden with shared plots and weekend workshops.",
      locality: "Elmstead",
      administrativeArea: "North Vale",
      country: "Exampleland",
      website: { value: "https://elmstead-garden.example/plots", designatedPublic: true },
    },
  },
  {
    id: "3eab7f85-9c4d-4a6e-b15c-8d4fac6a2b34",
    outcome: "approved",
    content: {
      name: "Quillon Street Tutoring",
      category: "education-childcare",
      description: "Fictional after-school tutoring in mathematics, reading and science.",
      locality: "Quillon",
      country: "Exampleland",
      postalCode: { value: "EX9 2QS", designatedPublic: false },
      email: { value: "lessons@quillon-tutoring.example", designatedPublic: true },
    },
  },
  {
    id: "4fbc8a96-ad5e-4b7f-826d-9e5abd7b3c45",
    outcome: "approved",
    content: {
      name: "Copperleaf Pet Grooming",
      category: "pets-animal-services",
      description: "Fictional grooming and nail trims for dogs and cats, by appointment.",
      locality: "Harrow Bay",
      administrativeArea: "South Vale",
      country: "Exampleland",
      phone: { value: "+1 555 0105", designatedPublic: true },
    },
  },
  {
    id: "5acd9ba7-be6f-4c8a-937e-af6bce8c4d56",
    outcome: "pending",
    content: {
      name: "Pending Example Florist",
      category: "retail-shopping",
      description: "A fictional submission that has not been reviewed, so it is not public.",
      locality: "Elmstead",
      country: "Exampleland",
      email: { value: "pending@florist.example", designatedPublic: true },
    },
  },
  {
    id: "6bdeacb8-cf7a-4d9b-a48f-ba7cdf9d5e67",
    outcome: "rejected",
    content: {
      name: "Rejected Example Consultancy",
      category: "professional-services",
      description: "A fictional submission that was rejected, so it is not public.",
      locality: "Quillon",
      country: "Exampleland",
      email: { value: "rejected@consultancy.example", designatedPublic: true },
    },
  },
];

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("A synthetic fixture instant is invalid.");
  }

  return result.value;
}

/** A failure names the fixture and the step, never the data or a database detail. */
function seedingFailure(fixture: SyntheticListing, step: string): Error {
  return new Error(`Seeding the synthetic listing ${fixture.id} failed at: ${step}.`);
}

/**
 * Empty the demo database's listing tables and create every synthetic listing again.
 *
 * Destructive by design. Call it only on the **local demonstration** database.
 */
export async function resetAndSeedSyntheticListings(db: Kysely<ListingDatabase>): Promise<void> {
  await sql`delete from listing_revision`.execute(db);
  await sql`delete from listing`.execute(db);

  const submittedAt = instant(SUBMITTED_AT);
  const decidedAt = instant(DECIDED_AT);

  for (const fixture of SYNTHETIC_LISTINGS) {
    const validated = validateInitialSubmission(fixture.content);

    if (!validated.ok) {
      throw seedingFailure(fixture, "submission validation");
    }

    const submitted = submitListing(listingIdOf(fixture.id), validated.value, submittedAt);

    if (!submitted.ok) {
      throw seedingFailure(fixture, "submission");
    }

    if (!(await insertSubmittedListing(db, submitted.value)).ok) {
      throw seedingFailure(fixture, "submission persistence");
    }

    if (fixture.outcome === "approved") {
      const approved = await persistListingApproval(db, {
        listingId: submitted.value.id,
        viewedLastUpdatedAt: submittedAt,
        approvedAt: decidedAt,
      });

      if (!approved.ok) {
        throw seedingFailure(fixture, "approval");
      }
    }

    if (fixture.outcome === "rejected") {
      const rejected = await rejectPendingListing(db, {
        listingId: submitted.value.id,
        rejectedAt: decidedAt,
      });

      if (!rejected.ok) {
        throw seedingFailure(fixture, "rejection");
      }
    }
  }
}
