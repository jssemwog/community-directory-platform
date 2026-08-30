/**
 * Public surface root — the structural entry point for the public read path
 * (docs/07 C1, trust context TB-1).
 *
 * Scaffold only. It renders no listing, no category, no search, and no
 * submission form, because no data model exists yet (P1) and no public
 * projection has been built (P2). It reads nothing from any data source.
 */
export default function PublicSurfaceRoot() {
  return (
    <main>
      <h1>Community Directory Platform</h1>
      <p>Public surface. Application scaffold only — no directory content exists yet.</p>
    </main>
  );
}
