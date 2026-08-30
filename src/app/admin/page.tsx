/**
 * Administrative surface root — the structural entry point for the
 * administrative path (docs/07 C3, trust context TB-3).
 *
 * Scaffold only. It exposes no queue, no record, no moderation action, and no
 * administrative capability of any kind, because none exists yet (P4) and the
 * authentication boundary it must sit behind is not decided (ADR-004, DG-3).
 */
export default function AdministrativeSurfaceRoot() {
  return (
    <main>
      <h1>Administration</h1>
      <p>
        Administrative surface. Application scaffold only — no administrative
        capability exists yet, and no authentication boundary is implemented.
      </p>
    </main>
  );
}
