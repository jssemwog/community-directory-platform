/**
 * Which public read source the directory routes use (issue #246, `E3-local` Scope Gate
 * revision 4 §4 row 4; OP-2 staging Scope Gate revision 2 §3.5).
 *
 * **First, the OP-2 staging mode** (production only, `staging-access.ts`):
 * - **on:** the staging source, and nothing else;
 * - **deny-all** (armed but not validly configured, or combined with `BI4_E3_LOCAL` or the demo's
 *   variable): **no source**, so the routes answer 404. The proxy already refuses every request;
 *   this is the second line;
 * - **off** (`BI4_STAGING` absent): the order below, unchanged from before staging existed.
 *
 * 1. **The local demo**, when it is configured. It is development-only (`local-demo-persistence.ts`),
 *    so under `next dev` the demo is chosen exactly as before, and every `BI4_E3_*` variable is
 *    ignored.
 * 2. **`E3-local`**, when it is configured. It is production-only (`e3-local-persistence.ts`).
 * 3. Otherwise **none**, and the routes answer 404 as if absent.
 *
 * The demo and `E3-local` are mutually exclusive by `NODE_ENV`, so their order only matters as a
 * guard.
 */

import type { ListingPersistence } from "../../data/connection";
import { e3LocalPersistence, type E3Local } from "./e3-local-persistence";
import { localDemoPersistence } from "./local-demo-persistence";
import { stagingSource, type StagingHandle, type StagingSource } from "./staging-persistence";

export type PublicReadSource =
  | { readonly kind: "demo"; readonly persistence: ListingPersistence }
  | { readonly kind: "e3-local"; readonly e3: E3Local }
  | { readonly kind: "staging"; readonly staging: StagingHandle };

/** Seams for tests. Production uses the real factories. */
export interface PublicReadSeams {
  readonly demo?: () => ListingPersistence | undefined;
  readonly e3Local?: () => E3Local | undefined;
  readonly staging?: () => StagingSource;
}

/** The configured source, or `undefined` when none is configured. */
export function publicReadSource(seams: PublicReadSeams = {}): PublicReadSource | undefined {
  const staging = (seams.staging ?? stagingSource)();

  if (staging.kind === "on") {
    return { kind: "staging", staging: staging.handle };
  }

  if (staging.kind === "deny-all") {
    return undefined;
  }

  const demo = (seams.demo ?? localDemoPersistence)();

  if (demo !== undefined) {
    return { kind: "demo", persistence: demo };
  }

  const e3 = (seams.e3Local ?? e3LocalPersistence)();

  return e3 === undefined ? undefined : { kind: "e3-local", e3 };
}
