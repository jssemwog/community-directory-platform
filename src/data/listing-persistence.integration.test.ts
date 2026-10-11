/**
 * Live tests for the first `C9` persistence slice (issue #177).
 *
 * **Against a real PostgreSQL server, with the real first migration applied through the governed
 * `Migrator`.** The unit tests prove the mapping and the configuration rules; these prove the
 * things only a server can settle — that `DateStyle = ISO` is actually in force before the first
 * statement on every pooled backend, that a governed instant survives the round trip to the
 * millisecond, that the store refuses what the application refuses, and that a listing written
 * through `insertSubmittedListing` comes back through `findListingById` as the same aggregate.
 *
 * They are **unconditional**: the binaries ship with the `embedded-postgres` development
 * dependency, so there is nothing to probe and nothing to skip.
 *
 * Isolation and cleanup are owned by `testing/embedded-cluster.ts` (issue #179): one isolated
 * cluster for this file on an **ephemeral port** with a **disposable data directory**, torn down
 * on every path — success, assertion failure and setup failure alike. The helper closes this
 * file's clients first, requests shutdown once, **waits for the owned postmaster to exit**, and
 * only then removes the directory, under a bounded retry for Windows' transient file-handle
 * release. Cleanup is verified, and a cleanup that cannot prove the cluster is gone fails this
 * file rather than leaving one behind.
 *
 * **The server version is harness detail with no production authority.** No PostgreSQL version is
 * selected (`ADR-013` names only the provider), and nothing here asserts version-specific
 * behaviour. No credential, environment variable or provisioning of any kind is involved: the
 * configuration is handed to the boundary by this file, which is exactly the posture issue #177
 * requires of its callers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  useEmbeddedPostgres,
} from "./testing/embedded-cluster";

import { CATEGORY_KEYS } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing } from "../domain/listing/listing";
import { createListingPersistence, type ListingPersistence } from "./connection";
import { findListingById, insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";

/**
 * The narrow slice of `pg` this file reaches directly.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts` established. It is used only to build the
 * migration runner's own pool and to assert the driver's global state, never to stand in for the
 * boundary under test.
 */
interface PgModule {
  readonly types: { getTypeParser(oid: number, format: string): unknown };
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

const VERIFIED_DATABASE = "listing_persistence_verification";
/** A second database whose category `CHECK`s are dropped, so hostile rows can be stored. */
const HOSTILE_DATABASE = "listing_hostile_verification";

/**
 * One isolated cluster for this file, owned by the shared helper (issue #179), with the governed
 * migration already applied to both databases through the same real provider and `Migrator` this
 * file used to drive itself.
 *
 * The helper waits for the owned postmaster to exit before removing the disposable directory,
 * which is what this file's own teardown never did: `EmbeddedPostgres.stop()` returns while the
 * postmaster's children may still hold handles on it.
 */
const cluster = useEmbeddedPostgres({
  slug: "persistence",
  databases: [VERIFIED_DATABASE, HOSTILE_DATABASE],
  migrate: [VERIFIED_DATABASE, HOSTILE_DATABASE],
});

/** Test timing, not lifecycle: one place a pool needs a moment to notice a dead socket. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let persistence: ListingPersistence;
let hostile: ListingPersistence;

function connectionStringFor(database: string): string {
  return cluster.connectionStringFor(database);
}

const SUBMITTED_AT = 1_767_323_045_123;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** A pending submission, exactly as the domain would have produced it. */
function submission(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content: {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
    },
    timestamps: {
      submittedAt: instant(SUBMITTED_AT),
      lastUpdatedAt: instant(SUBMITTED_AT),
    },
    ...overrides,
  };
}

beforeAll(async () => {
  // The boundary under test, configured entirely by this caller.
  persistence = createListingPersistence({
    pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 4 },
    startupParameters: { application_name: "listing_persistence_tests" },
  });

  hostile = createListingPersistence({
    pool: { connectionString: connectionStringFor(HOSTILE_DATABASE), max: 1 },
  });

  // Registered rather than closed by a local `afterAll`: the helper closes every registered
  // resource before it asks the server to stop, so that ordering is the lifecycle's property
  // and not a consequence of hook-registration order.
  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());

  // Dropping a constraint needs no key list, so the governed vocabulary is still stated in
  // exactly two executable places (`ADR-021` decision 10, issue #175). This database exists so
  // that a row the domain cannot represent can be *stored* and the read path's classification
  // of it proved end to end.
  await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);
  await sql`alter table listing drop constraint listing_status_check`.execute(hostile.db);
}, CLUSTER_TIMEOUT_MS);

/**
 * Run `body` with the session time zone pinned, restoring whatever it was.
 *
 * Extreme dates need this. PostgreSQL renders a `timestamptz` in the **session** zone, and a
 * geographic zone's historical offset carries **seconds** before standard time was adopted
 * (`-04:56:02` for New York) — which the governed parser refuses by ruling (issue #173). Without
 * pinning, a test over distant dates would pass or fail according to the host's time zone.
 */
async function withSessionTimeZone(zone: string, body: () => Promise<void>): Promise<void> {
  const before = await sql<{
    zone: string;
  }>`select current_setting('timezone') as zone`.execute(persistence.db);
  const previous = before.rows[0]?.zone ?? "UTC";

  await sql.raw(`set time zone '${zone}'`).execute(persistence.db);

  try {
    await body();
  } finally {
    await sql.raw(`set time zone '${previous}'`).execute(persistence.db);
  }
}

describe("the connection boundary, against a real server", () => {
  it(
    "has DateStyle = ISO on the very first statement of a fresh backend",
    async () => {
      // A boundary created here and used once, so this really is the first statement its
      // backend ever receives — the claim does not depend on the order tests happen to run in.
      // If the setting were applied by a query rather than by the startup packet, this is
      // where it would show.
      const fresh = createListingPersistence({
        pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 1 },
      });

      try {
        const first = await sql<{
          datestyle: string;
        }>`select current_setting('datestyle') as datestyle`.execute(fresh.db);

        expect(first.rows[0]?.datestyle).toMatch(/^ISO/);
      } finally {
        await fresh.shutdown();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "has DateStyle = ISO on several distinct backends independently",
    async () => {
      const seen: { pid: number; datestyle: string }[] = [];

      // Four concurrent statements force the pool to open four separate backends, each of
      // which must have been configured during its own handshake.
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const result = await sql<{
            pid: number;
            datestyle: string;
          }>`select pg_backend_pid() as pid, current_setting('datestyle') as datestyle`.execute(
            persistence.db,
          );
          const row = result.rows[0];

          if (row !== undefined) {
            seen.push(row);
          }
        }),
      );

      expect(seen).toHaveLength(4);
      expect(new Set(seen.map((row) => row.pid)).size).toBeGreaterThan(1);

      for (const row of seen) {
        expect(row.datestyle, `backend ${row.pid}`).toMatch(/^ISO/);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "preserves the caller's own startup parameters alongside the governed one",
    async () => {
      const result = await sql<{
        application_name: string;
      }>`select current_setting('application_name') as application_name`.execute(
        persistence.db,
      );

      expect(result.rows[0]?.application_name).toBe("listing_persistence_tests");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "delivers a governed instant as epoch milliseconds, not as a Date",
    async () => {
      const result = await sql<{
        at: unknown;
      }>`select '2026-01-02 03:04:05.123+00'::timestamptz(3) as at`.execute(persistence.db);
      const at = result.rows[0]?.at;

      expect(typeof at).toBe("number");
      expect(at).not.toBeInstanceOf(Date);
      expect(at).toBe(1_767_323_045_123);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it("leaves the driver's global timestamptz parser untouched", () => {
    // The override is registered per pool, so an unrelated consumer — the migration runner in
    // this very file — still receives the driver's default `Date`.
    const parser = pg.types.getTypeParser(1184, "text") as (value: string) => unknown;

    expect(parser("2026-01-02 03:04:05.123+00")).toBeInstanceOf(Date);
  });
});

describe("persisting a submitted listing (OP-3)", () => {
  it(
    "stores it and reads it back as the same aggregate",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value).toEqual(listing);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "round-trips every field, including optional values and their designations",
    async () => {
      const listing = submission({
        content: {
          name: "Quay Books",
          category: "retail-shopping",
          description: "A bookshop.",
          locality: "Cobh",
          country: "IE",
          administrativeArea: "County Cork",
          postalCode: { value: "P24 XYZ", designatedPublic: true },
          phone: { value: "+353 21 111 1111", designatedPublic: true },
          email: { value: "hello@example.ie", designatedPublic: false },
          website: { value: "https://example.ie", designatedPublic: false },
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value).toEqual(listing);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "preserves the exact millisecond of every governed instant",
    async () => {
      await withSessionTimeZone("UTC", async () => {
      // Values chosen to catch truncation, rounding and second-level storage alike.
      for (const epochMilliseconds of [
        1_767_323_045_123,
        1_767_323_045_001,
        1_767_323_045_999,
        1_767_323_045_000,
        -2_208_988_800_123,
        0,
        // Above 2^53 microseconds, where `interval * double precision` — the only such
        // operator PostgreSQL declares — stops being exactly representable. These are the
        // values the first version of this suite never tried, and they are the reason the
        // interval is now parsed from an integer instead of multiplied.
        9_007_199_254_740,
        9_007_199_254_741,
        99_999_999_999_999,
        253_402_300_799_999,
        -62_135_596_800_000,
      ]) {
        const listing = submission({
          timestamps: {
            submittedAt: instant(epochMilliseconds),
            lastUpdatedAt: instant(epochMilliseconds + 1),
          },
        });

        expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok, String(epochMilliseconds)).toBe(true);
        if (!found.ok) return;

        expect(found.value.timestamps.submittedAt).toEqual(instant(epochMilliseconds));
        expect(found.value.timestamps.lastUpdatedAt).toEqual(instant(epochMilliseconds + 1));
      }
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "uses the application's identifier, with no database default or generator",
    async () => {
      const id = randomUUID();
      const listing = submission({ id: listingIdOf(id) });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        id: string;
        has_default: boolean;
      }>`select l.id::text as id,
                (select count(*) > 0
                   from pg_attrdef d
                   join pg_class c on c.oid = d.adrelid
                  where c.relname = 'listing' and d.adnum = 1) as has_default
           from listing l where l.id = ${id}::uuid`.execute(persistence.db);

      expect(stored.rows[0]?.id).toBe(id);
      // `ADR-019` decision 5: PostgreSQL declares no generation default for the identifier.
      expect(stored.rows[0]?.has_default).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "takes the instants from the application, never from the database clock",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        matches: boolean;
        near_now: boolean;
      }>`select submitted_at = '2026-01-02 03:04:05.123+00'::timestamptz(3) as matches,
                abs(extract(epoch from (now() - submitted_at))) < 60 as near_now
           from listing where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
        persistence.db,
      );

      expect(stored.rows[0]?.matches).toBe(true);
      // And it is emphatically not "whatever time the insert happened".
      expect(stored.rows[0]?.near_now).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "stores a newly submitted listing as pending, with nothing that applies only later",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        status: string;
        publication_state: string | null;
        unpublish_reason: string | null;
        rejected_at: number | null;
      }>`select status, publication_state, unpublish_reason, rejected_at
           from listing where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
        persistence.db,
      );

      expect(stored.rows[0]).toEqual({
        status: "pending",
        publication_state: null,
        unpublish_reason: null,
        rejected_at: null,
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "stores every approved category key exactly",
    async () => {
      for (const category of CATEGORY_KEYS) {
        const listing = submission({
          content: { ...submission().content, category },
        });

        expect((await insertSubmittedListing(persistence.db, listing)).ok, category).toBe(true);

        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok, category).toBe(true);
        if (!found.ok) return;

        expect(found.value.content.category).toBe(category);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps SQL-shaped content as data",
    async () => {
      const hostileText = "'); drop table listing; --";
      const listing = submission({
        content: {
          ...submission().content,
          name: hostileText,
          description: `Robert'); DROP TABLE listing;--`,
          locality: "O'Brien's Bridge",
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value.content.name).toBe(hostileText);
      expect(found.value.content.locality).toBe("O'Brien's Bridge");

      // The table is still there, which is the real assertion.
      const survived = await sql<{ present: boolean }>`select true as present from listing limit 1`.execute(
        persistence.db,
      );

      expect(survived.rows[0]?.present).toBe(true);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the stored instant is exact, by PostgreSQL's own accounting", () => {
  it(
    "agrees with extract(epoch) to the millisecond, independently of the parser",
    async () => {
      // A second oracle on purpose: the round-trip test above reads values back through the
      // governed parser, so if the write and the read shared a rounding mistake they could
      // agree with each other and both be wrong. `extract(epoch …)` is PostgreSQL's own exact
      // numeric accounting of what it stored.
      // Includes a BC-era instant: the **write** must be exact even where the governed parser
      // will later refuse to read it back, which is why this oracle is PostgreSQL's own.
      for (const epochMilliseconds of [
        0, 1, -1, 1_767_323_045_123, -2_208_988_800_123,
        9_007_199_254_741, 99_999_999_999_999, -99_999_999_999_999,
        253_402_300_799_999, -62_135_596_800_000,
      ]) {
        const listing = submission({
          timestamps: {
            submittedAt: instant(epochMilliseconds),
            lastUpdatedAt: instant(epochMilliseconds),
          },
        });

        expect(
          (await insertSubmittedListing(persistence.db, listing)).ok,
          String(epochMilliseconds),
        ).toBe(true);

        const stored = await sql<{
          exact: string;
        }>`select (extract(epoch from submitted_at) * 1000)::numeric::text as exact
             from listing
            where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
          persistence.db,
        );

        // Rendered as numeric text, so a fractional microsecond remainder would show rather
        // than being hidden by an integer cast.
        expect(Number(stored.rows[0]?.exact), String(epochMilliseconds)).toBe(epochMilliseconds);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "is unaffected by the session time zone",
    async () => {
      const epochMilliseconds = 1_767_323_045_123;
      const listing = submission({
        timestamps: {
          submittedAt: instant(epochMilliseconds),
          lastUpdatedAt: instant(epochMilliseconds),
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const readings: number[] = [];

      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        await withSessionTimeZone(zone, async () => {
          const found = await findListingById(persistence.db, listing.id);

          expect(found.ok, zone).toBe(true);
          if (!found.ok) return;

          readings.push(
            (found.value.timestamps.submittedAt as unknown as { epochMilliseconds: number })
              .epochMilliseconds,
          );
        });
      }

      expect(readings).toEqual([epochMilliseconds, epochMilliseconds, epochMilliseconds]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses to read back a BC-era instant, and says why",
    async () => {
      // `instantOf` admits any safe integer, so an instant before 1 AD is storable — and
      // issue #173 ruled that BC-era text must be **refused loudly**, never silently misread.
      // The write is exact (the oracle above proves it); only the read refuses.
      const listing = submission({
        timestamps: {
          submittedAt: instant(-99_999_999_999_999),
          lastUpdatedAt: instant(-99_999_999_999_999),
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      await withSessionTimeZone("UTC", async () => {
        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok).toBe(false);
        if (found.ok) return;

        // Its own outcome: the database is healthy and the row is present, so this is neither
        // an infrastructure failure nor "not found".
        expect(found.error).toEqual({ code: "STORED_INSTANT_UNREADABLE", reason: "BC_ERA" });
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses a stored instant whose rendered offset carries seconds, and says why",
    async () => {
      // Under a geographic zone, a pre-standard-time date renders with an offset like
      // `-04:56:02`, which issue #173 also ruled must be refused rather than approximated.
      // 1800-01-01 UTC: safely AD, so the BC refusal cannot pre-empt this one — a nearby
      // value was tried first and rendered as 1 BC once shifted west, which is why the two
      // refusals are tested on deliberately separated dates.
      const listing = submission({
        timestamps: {
          submittedAt: instant(-5_364_662_400_000),
          lastUpdatedAt: instant(-5_364_662_400_000),
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      await withSessionTimeZone("America/New_York", async () => {
        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok).toBe(false);
        if (found.ok) return;

        expect(found.error).toEqual({
          code: "STORED_INSTANT_UNREADABLE",
          reason: "OFFSET_HAS_SECONDS",
        });
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses an instant outside PostgreSQL's own range, loudly",
    async () => {
      // `instantOf` admits any safe integer, which reaches past `timestamptz`'s lower bound.
      // That must fail explicitly rather than be rounded into range.
      const listing = submission({
        timestamps: {
          submittedAt: instant(-9_007_199_254_740_991),
          lastUpdatedAt: instant(-9_007_199_254_740_991),
        },
      });

      const result = await insertSubmittedListing(persistence.db, listing);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("STORAGE_FAILURE");
      if (result.error.code !== "STORAGE_FAILURE") return;

      expect(result.error.sqlState).toBe("22008");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the store refuses what the application refuses", () => {
  it(
    "reports a duplicate identifier and leaves the stored row untouched",
    async () => {
      const first = submission();

      expect((await insertSubmittedListing(persistence.db, first)).ok).toBe(true);

      const impostor = submission({
        id: first.id,
        content: { ...first.content, name: "Overwritten Name" },
      });
      const second = await insertSubmittedListing(persistence.db, impostor);

      expect(second.ok).toBe(false);
      if (second.ok) return;

      expect(second.error).toEqual({ code: "LISTING_ALREADY_EXISTS" });

      // Nothing was overwritten: no upsert, no `on conflict`, no retry.
      const found = await findListingById(persistence.db, first.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value.content.name).toBe("Harbour Bakery");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "recognises a duplicate only from the identity constraint, not from any unique violation",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const duplicate = await insertSubmittedListing(persistence.db, listing);

      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) return;

      expect(duplicate.error).toEqual({ code: "LISTING_ALREADY_EXISTS" });

      // And the classification is gated on the constraint, not on `23505` alone. A second
      // unique index on `listing` is a plausible future addition (duplicate detection is an
      // open question under `VR-S6`/`OQ-12`), and a name collision reported as "this listing
      // already exists" would be a confidently wrong answer. Proved by adding one here.
      // Partial, and over a name only this test uses: other tests have already stored several
      // listings sharing a name, so an unconditional unique index could not be created and the
      // probe would prove nothing.
      const probeName = "UNIQUE-INDEX-PROBE-NAME";

      // `create index` is a utility statement and accepts no bind parameters, so the value is
      // emitted as a SQL literal rather than a placeholder.
      await sql`
        create unique index listing_probe_unique_name
          on listing (name) where name = ${sql.lit(probeName)}
      `.execute(persistence.db);

      try {
        const first = submission({ content: { ...submission().content, name: probeName } });

        expect((await insertSubmittedListing(persistence.db, first)).ok).toBe(true);

        const sameName = submission({
          content: { ...submission().content, name: probeName },
        });
        const result = await insertSubmittedListing(persistence.db, sameName);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.code).toBe("STORAGE_FAILURE");
        if (result.error.code !== "STORAGE_FAILURE") return;

        expect(result.error.sqlState).toBe("23505");
        expect(result.error.constraint).toBe("listing_probe_unique_name");
      } finally {
        await sql`drop index listing_probe_unique_name`.execute(persistence.db);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "is deterministic when the same identifier is inserted concurrently",
    async () => {
      const listing = submission();

      const outcomes = await Promise.all([
        insertSubmittedListing(persistence.db, listing),
        insertSubmittedListing(persistence.db, listing),
        insertSubmittedListing(persistence.db, listing),
      ]);

      // Exactly one winner, and every loser gets the same explicit answer — no partial write,
      // no retry, no upsert.
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

      for (const outcome of outcomes.filter((o) => !o.ok)) {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) continue;
        expect(outcome.error).toEqual({ code: "LISTING_ALREADY_EXISTS" });
      }

      const stored = await sql<{
        count: string;
      }>`select count(*)::text as count from listing
           where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
        persistence.db,
      );

      expect(stored.rows[0]?.count).toBe("1");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports an unapproved category as a storage failure, never as a business outcome",
    async () => {
      // The domain's guard and the store's `CHECK` agree; neither substitutes for the other.
      const listing = submission({
        content: {
          ...submission().content,
          // Reaching the store with this requires defeating the compile-time type, which is
          // exactly the boundary under test.
          category: "food-and-drink" as (typeof CATEGORY_KEYS)[number],
        },
      });

      const result = await insertSubmittedListing(persistence.db, listing);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("STORAGE_FAILURE");
      if (result.error.code !== "STORAGE_FAILURE") return;

      expect(result.error.sqlState).toBe("23514");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("a lost idle connection does not crash the process", () => {
  it(
    "survives having its backend terminated by the server",
    async () => {
      // This is the failure CI found: an idle client killed by the server (`57P01`,
      // `admin_shutdown`) raises the pool's `error` event, and an unhandled `EventEmitter`
      // `error` **throws** — which would take down `ADR-005`'s long-running process and, as
      // the build log showed, print the client object including its password.
      //
      // The proof is the absence of an unhandled error: Vitest fails a file whose run emits
      // one, so this test passing *is* the assertion. The queries below confirm the boundary
      // is still usable afterwards.
      const victim = createListingPersistence({
        pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 1 },
      });

      try {
        const pid = await sql<{
          pid: number;
        }>`select pg_backend_pid() as pid`.execute(victim.db);
        const backend = pid.rows[0]?.pid;

        expect(backend).toBeTypeOf("number");

        // Terminated from a different connection, so the victim learns about it while idle.
        await sql`select pg_terminate_backend(${backend})`.execute(persistence.db);

        // Give the victim's socket time to receive the FATAL and emit on the pool.
        await sleep(250);

        // The pool recovers by opening a replacement connection, which is the behaviour that
        // makes a no-op handler the right answer rather than a swallowed defect.
        const after = await sql<{ one: number }>`select 1 as one`.execute(victim.db);

        expect(after.rows[0]?.one).toBe(1);
      } finally {
        await victim.shutdown();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("a storage failure leaks nothing (issue #177 §11)", () => {
  it(
    "keeps the failing row's values and the credential out of its enumerable surface",
    async () => {
      // Measured during this unit: a PostgreSQL constraint error carries
      // `detail: "Failing row contains (…)"` as an **enumerable own property**, so a failure
      // that passed the driver error through verbatim would publish listing content into any
      // log line or JSON response that touched it.
      const sensitive = "SENSITIVE-ROW-VALUE-DO-NOT-ECHO";
      const listing = submission({
        content: {
          ...submission().content,
          name: sensitive,
          category: "food-and-drink" as (typeof CATEGORY_KEYS)[number],
        },
      });

      const result = await insertSubmittedListing(persistence.db, listing);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      const failure = result.error;

      // The driver really did attach the row, so this test is not vacuous.
      expect(JSON.stringify((failure as { cause?: unknown }).cause ?? {})).toContain(sensitive);

      // And none of it escapes through the routes that actually get used.
      expect(JSON.stringify(failure)).not.toContain(sensitive);
      expect(JSON.stringify({ ...failure })).not.toContain(sensitive);
      expect(Object.keys(failure)).not.toContain("cause");
      expect(Object.keys(failure).sort()).toEqual(["code", "constraint", "sqlState"]);
      expect(JSON.stringify(failure)).not.toContain(CLUSTER_PASSWORD);

      // What is exposed is schema metadata, which is the part worth reading.
      if (failure.code !== "STORAGE_FAILURE") return;
      expect(failure.sqlState).toBe("23514");
      expect(failure.constraint).toBe("listing_category_check");

      // The cause is still reachable deliberately, for diagnosis.
      expect(failure.cause).toBeDefined();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps the credential out of a connection failure",
    async () => {
      const wrong = createListingPersistence({
        pool: {
          connectionString: connectionStringFor("database_that_does_not_exist"),
          max: 1,
          connectionTimeoutMillis: 5_000,
        },
      });

      try {
        const result = await findListingById(wrong.db, listingIdOf(randomUUID()));

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // Not "not found": the query never ran.
        expect(result.error.code).toBe("STORAGE_FAILURE");
        expect(JSON.stringify(result.error)).not.toContain(CLUSTER_PASSWORD);
        expect(JSON.stringify({ ...result.error })).not.toContain(CLUSTER_PASSWORD);
      } finally {
        await wrong.shutdown();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("retrieving by identifier", () => {
  it(
    "reports not found for an identifier that was never stored",
    async () => {
      const result = await findListingById(persistence.db, listingIdOf(randomUUID()));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({ code: "LISTING_NOT_FOUND" });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a malformed identifier as a storage failure, not as not found",
    async () => {
      // `uuid` cannot parse this, so the query itself fails. A boundary that reported "not
      // found" here would be hiding a defect behind an ordinary answer.
      const result = await findListingById(persistence.db, listingIdOf("not-a-uuid"));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("STORAGE_FAILURE");
      if (result.error.code !== "STORAGE_FAILURE") return;

      expect(result.error.sqlState).toBe("22P02");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "performs no write",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const before = await sql<{ count: string }>`select count(*)::text as count from listing`.execute(
        persistence.db,
      );

      await findListingById(persistence.db, listing.id);
      await findListingById(persistence.db, listingIdOf(randomUUID()));

      const after = await sql<{ count: string }>`select count(*)::text as count from listing`.execute(
        persistence.db,
      );

      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "touches no revision row at all",
    async () => {
      const listing = submission();

      await insertSubmittedListing(persistence.db, listing);
      await findListingById(persistence.db, listing.id);

      const revisions = await sql<{
        count: string;
      }>`select count(*)::text as count from listing_revision`.execute(persistence.db);

      expect(revisions.rows[0]?.count).toBe("0");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "hydrates lifecycle shapes this slice cannot itself create",
    async () => {
      // Written with raw SQL on purpose: approval, unpublication and rejection are write paths
      // issue #177 excludes, but their stored shapes are legal and must read back correctly.
      const cases = [
        {
          label: "approved and publicly available",
          state: sql`'publicly_available'`,
          reason: sql`null`,
          status: "approved",
          rejected: sql`null`,
        },
        {
          label: "approved and unpublished",
          state: sql`'unpublished'`,
          reason: sql`'Reported by a visitor'`,
          status: "approved",
          rejected: sql`null`,
        },
        {
          label: "rejected",
          state: sql`null`,
          reason: sql`null`,
          status: "rejected",
          rejected: sql`'2026-01-02 09:00:00.500+00'::timestamptz(3)`,
        },
      ] as const;

      for (const shape of cases) {
        const id = randomUUID();

        await sql`
          insert into listing (
            id, status, name, category, description, locality, country,
            publication_state, unpublish_reason,
            submitted_at, last_updated_at, rejected_at
          ) values (
            ${id}::uuid, ${shape.status}, 'Stored Directly', 'food-drink', 'A description.',
            'Kinsale', 'IE', ${shape.state}, ${shape.reason},
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            ${shape.rejected}
          )
        `.execute(persistence.db);

        const found = await findListingById(persistence.db, listingIdOf(id));

        expect(found.ok, shape.label).toBe(true);
        if (!found.ok) return;

        expect(found.value.status, shape.label).toBe(shape.status);

        if (shape.status === "rejected") {
          expect(found.value.timestamps.rejectedAt).toEqual(instant(1_767_344_400_500));
          expect(found.value.publication).toBeUndefined();
        } else {
          expect(found.value.publication, shape.label).toBeDefined();
          expect(found.value.timestamps.rejectedAt).toBeUndefined();
        }
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "hydrates a designation flag with no value as an absent field",
    async () => {
      // Storable because no `CHECK` ties the flag to a non-null value.
      const id = randomUUID();

      await sql`
        insert into listing (
          id, status, name, category, description, locality, country,
          postal_code, postal_code_designated_public,
          phone, phone_designated_public,
          submitted_at, last_updated_at
        ) values (
          ${id}::uuid, 'pending', 'Flag Without Value', 'food-drink', 'A description.',
          'Kinsale', 'IE', null, true, null, true,
          '2026-01-02 03:04:05.123+00'::timestamptz(3),
          '2026-01-02 03:04:05.123+00'::timestamptz(3)
        )
      `.execute(persistence.db);

      const found = await findListingById(persistence.db, listingIdOf(id));

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect("postalCode" in found.value.content).toBe(false);
      expect("phone" in found.value.content).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("a stored row the domain cannot represent", () => {
  it(
    "is reported as unreadable, and never as not found",
    async () => {
      // This database has its category and status `CHECK`s dropped, so rows the application
      // could never write can still be stored — which is the only honest way to prove how the
      // read path classifies them.
      const unapproved = randomUUID();
      const unknownStatus = randomUUID();

      for (const [id, status, category] of [
        [unapproved, "pending", "food-and-drink"],
        [unknownStatus, "archived", "food-drink"],
      ] as const) {
        await sql`
          insert into listing (
            id, status, name, category, description, locality, country,
            submitted_at, last_updated_at
          ) values (
            ${id}::uuid, ${status}, 'Hostile Row', ${category}, 'A description.',
            'Kinsale', 'IE',
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            '2026-01-02 03:04:05.123+00'::timestamptz(3)
          )
        `.execute(hostile.db);
      }

      const badCategory = await findListingById(hostile.db, listingIdOf(unapproved));

      expect(badCategory.ok).toBe(false);
      if (badCategory.ok) return;

      expect(badCategory.error).toEqual({
        code: "LISTING_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });

      const badStatus = await findListingById(hostile.db, listingIdOf(unknownStatus));

      expect(badStatus.ok).toBe(false);
      if (badStatus.ok) return;

      expect(badStatus.error).toEqual({
        code: "LISTING_UNREADABLE",
        failure: { code: "UNKNOWN_LISTING_STATUS", column: "status" },
      });

      // And the row is genuinely there — so "unreadable" is not a disguised "absent".
      const present = await sql<{
        count: string;
      }>`select count(*)::text as count from listing where id = ${unapproved}::uuid`.execute(
        hostile.db,
      );

      expect(present.rows[0]?.count).toBe("1");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("shutdown", () => {
  it(
    "releases the pool, and a closed boundary refuses further work rather than hanging",
    async () => {
      const closing = createListingPersistence({
        pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 1 },
      });

      const before = await sql<{ one: number }>`select 1 as one`.execute(closing.db);

      expect(before.rows[0]?.one).toBe(1);

      await closing.shutdown();
      // Idempotent: the second call is a no-op, not the driver's double-end error.
      await closing.shutdown();

      await expect(sql`select 1`.execute(closing.db)).rejects.toThrow();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves no backend of its own behind",
    async () => {
      const result = await sql<{
        count: string;
      }>`select count(*)::text as count from pg_stat_activity
           where application_name = 'listing_persistence_tests_transient'`.execute(
        persistence.db,
      );

      expect(result.rows[0]?.count).toBe("0");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the typed database exposes no unauthorized operation", () => {
  it("offers exactly the two repository functions, and no update or delete", () => {
    // A compile-time fact, recorded at runtime so it is visible in the suite: every column's
    // update type in `listing-table.ts` is `never`, and `listing_revision`'s insert type is
    // `never` too, so an unauthorized write does not compile.
    const database: Kysely<ListingDatabase> = persistence.db;

    expect(typeof database.insertInto).toBe("function");
    expect(typeof insertSubmittedListing).toBe("function");
    expect(typeof findListingById).toBe("function");
  });
});
