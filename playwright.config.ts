import { defineConfig } from "@playwright/test";

/**
 * The real-browser layer for the local administrator journey (issue #260 §3.9, OD-1).
 *
 * Runs only locally, through `npm run test:browser` (OD-9); CI is unchanged and does not cover
 * it. Files are `tests/browser/*.e2e.ts`, which Vitest's default include never matches.
 * `harness.ts` is the global setup: it owns a temporary cluster, keys, certificate and servers,
 * and never touches `.local-demo/`.
 *
 * One worker, so the three engines run one after another against the one server and database.
 * `ignoreHTTPSErrors` applies only to this automated harness: it trusts the run's own self-signed
 * certificate. A person using the journey by hand sees the browser's certificate warning instead,
 * and no trust store is changed (§12 qualification 5).
 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.e2e.ts",
  globalSetup: "./tests/browser/harness.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
  use: { ignoreHTTPSErrors: true },
  projects: [
    // Server evidence (D-17's P) first, so its concurrent-first-request test really is first.
    { name: "server", testMatch: "process-count.e2e.ts", use: { browserName: "chromium" } },
    { name: "chromium", testIgnore: "process-count.e2e.ts", dependencies: ["server"], use: { browserName: "chromium" } },
    { name: "firefox", testIgnore: "process-count.e2e.ts", dependencies: ["server"], use: { browserName: "firefox" } },
    { name: "webkit", testIgnore: "process-count.e2e.ts", dependencies: ["server"], use: { browserName: "webkit" } },
  ],
});
