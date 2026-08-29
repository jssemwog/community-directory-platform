import type { ReactNode } from "react";

/**
 * Administrative surface layout — the structural boundary segment
 * (docs/07 C3, trust context TB-3).
 *
 * This segment exists so the administrative surface is a separate, visible
 * part of the tree from the first commit, not a folder someone adds later.
 *
 * It enforces nothing yet, and that is deliberate. The authentication and
 * authorization mechanism is ADR-004, which is Blocked by DG-3 (NOQ-9).
 * When that gate opens, C8 is enforced here and at every administrative
 * server entry point — server-side, on every request (ADR-002 O-3).
 *
 * Until then, note ADR-002 O-4: UI visibility is never authorization. This
 * layout must never become the place where access is "granted" by rendering.
 */
export default function AdministrativeLayout({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}
