/**
 * Which public read source the directory routes use (issue #246, `E3-local` Scope Gate
 * revision 4 §4 row 4).
 *
 * 1. **The local demo**, when it is configured. It is development-only (`local-demo-persistence.ts`),
 *    so under `next dev` the demo is chosen exactly as before, and every `BI4_E3_*` variable is
 *    ignored.
 * 2. **`E3-local`**, when it is configured. It is production-only (`e3-local-persistence.ts`).
 * 3. Otherwise **none**, and the routes answer 404 as if absent.
 *
 * The two modes are mutually exclusive by `NODE_ENV`, so the order only matters as a guard.
 */

import type { ListingPersistence } from "../../data/connection";
import { e3LocalPersistence, type E3Local } from "./e3-local-persistence";
import { localDemoPersistence } from "./local-demo-persistence";

export type PublicReadSource =
  | { readonly kind: "demo"; readonly persistence: ListingPersistence }
  | { readonly kind: "e3-local"; readonly e3: E3Local };

/** Seams for tests. Production uses the real factories. */
export interface PublicReadSeams {
  readonly demo?: () => ListingPersistence | undefined;
  readonly e3Local?: () => E3Local | undefined;
}

/** The configured source, or `undefined` when neither mode is configured. */
export function publicReadSource(seams: PublicReadSeams = {}): PublicReadSource | undefined {
  const demo = (seams.demo ?? localDemoPersistence)();

  if (demo !== undefined) {
    return { kind: "demo", persistence: demo };
  }

  const e3 = (seams.e3Local ?? e3LocalPersistence)();

  return e3 === undefined ? undefined : { kind: "e3-local", e3 };
}
