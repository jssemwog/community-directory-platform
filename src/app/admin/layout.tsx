import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { openGateFor } from "../../interface/admin/local-gate";

/**
 * Administrative surface layout — the structural boundary segment (docs/07 C3, trust context
 * TB-3).
 *
 * It applies **only the local administrator gate** (issue #260, under the #254 exception):
 * outside the launcher's local journey every administrative page is unavailable (OD-6). That is
 * defence in depth, never authorization: ADR-002 O-4 holds, a layout's check does not extend to
 * the pages and handlers beneath it, and each page and Route Handler repeats its own checks
 * (ADR-004 P-1 *Where the check runs*, BI-9). This layout must never become the place where
 * access is "granted" by rendering.
 */
export default async function AdministrativeLayout({ children }: { children: ReactNode }) {
  if (openGateFor(process.env, (await headers()).get("host")) === undefined) {
    notFound();
  }

  return <section>{children}</section>;
}
