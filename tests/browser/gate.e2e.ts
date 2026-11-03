/**
 * The administrator surface is unavailable outside the local gate (issue #260 §6.7, qualified by
 * §12 items 6 and 8).
 *
 * - **O-1 / O-2** come from the harness's closed-gate phases, which ran before the journey server
 *   (one `next dev` may run at a time): a production build under `next start` with the full gate
 *   environment, and `next dev` without it. Each phase was probed at the **handler boundary**
 *   with every method, and at the **real page boundaries** in all three engines.
 * - **O-3 / O-4** probe the running journey server: no answer on non-loopback interfaces, and a
 *   uniform refusal for any `Host` other than the canonical one.
 * - **O-5 / O-6** are static: no Server Action, no administrative capability beyond the journey,
 *   no `NEXT_PUBLIC_` secret, and no canary in the client bundles.
 *
 * What is claimed is a **uniform generic refusal at the handler boundary** and **no administrative
 * content at the page boundary**. Development error pages are not compared byte for byte, no
 * timing equivalence is claimed, and none of this completes `BI-4` (#246 stays open).
 */

import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { expect, test } from "@playwright/test";

import {
  ENTRY_HANDLERS,
  ENTRY_PAGES,
  harnessState,
  METHODS,
  REPOSITORY_ROOT,
  runInjectedSetup,
  send,
  type ClosedGateEvidence,
} from "./harness";

const state = harnessState();
const evidence = JSON.parse(readFileSync(state.closedGateEvidenceFile, "utf8")) as ClosedGateEvidence[];

const EXISTING_ROUTES = ["/", "/_not-found", "/admin", "/directory", "/directory/[listingId]"];
const NEW_ROUTES = ["/admin/sign-in", "/admin/sign-in/code", "/admin/sign-in/code/verify", "/admin/sign-in/password", "/admin/sign-out"];

for (const phase of ["production", "development"] as const) {
  test.describe(`O-${phase === "production" ? "1" : "2"}: ${phase === "production" ? "next start with the full gate environment" : "next dev without the launcher's environment"}`, () => {
    const recorded = evidence.find((entry) => entry.phase === phase);

    test("every handler, for every method, gives the one uniform refusal", async ({ browserName }) => {
      test.skip(browserName !== "chromium", "handler-boundary evidence is engine-independent; asserted once");
      expect(recorded).toBeDefined();

      for (const path of ENTRY_HANDLERS) {
        for (const method of METHODS) {
          const answer = recorded?.handlers.find((entry) => entry.path === path && entry.method === method);
          expect(answer, `${method} ${path}`).toMatchObject({ status: 404, body: method === "HEAD" ? "" : "Not Found" });
          expect(answer?.allow, `${method} ${path}: no automatic Allow`).toBeUndefined();
        }
      }
    });

    test("every page, for every method, is unavailable", async ({ browserName }) => {
      test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");

      for (const path of ENTRY_PAGES) {
        for (const method of METHODS) {
          const answer = recorded?.handlers.find((entry) => entry.path === path && entry.method === method);
          console.log(`[evidence] ${phase} ${method} ${path}: ${String(answer?.status)}${answer?.allow === undefined ? "" : ` Allow: ${answer.allow}`}`);
          expect(answer?.status, `${method} ${path}`).toBe(404);
          expect(answer?.body ?? "", `${method} ${path}`).not.toMatch(/Administrator sign-in|Authenticator code|Signed in/);
        }
      }
    });

    test("in this engine, every page shows no administrative content", async ({ browserName }) => {
      for (const path of ENTRY_PAGES) {
        const page = recorded?.pages.find((entry) => entry.engine === browserName && entry.path === path);
        expect(page, `${browserName} ${path}`).toMatchObject({ status: 404, markers: [] });
      }
    });
  });
}

test("O-1: the build adds exactly the five journey routes, and its client bundles hold no canary", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "build evidence is engine-independent; asserted once");
  const production = evidence.find((entry) => entry.phase === "production");
  const routes = (production?.buildRoutes ?? []).map((line) => line.split(/\s+/)[2]).sort();

  console.log(`[evidence] build routes: ${routes.join(", ")}; client-bundle files scanned ${String(production?.bundleFilesScanned)}, canary hits ${String(production?.bundleCanaryHits)}`);
  expect(routes).toEqual([...EXISTING_ROUTES, ...NEW_ROUTES].sort());
  expect(production?.bundleFilesScanned ?? 0).toBeGreaterThan(0);
  expect(production?.bundleCanaryHits).toBe(0);
});

test("O-3: the journey server does not answer on any non-loopback interface", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "network evidence is engine-independent; asserted once");
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address !== undefined && !address.internal)
    .map((address) => address?.address ?? "");

  test.skip(addresses.length === 0, "this machine has no non-loopback interface to probe");

  for (const address of addresses) {
    const outcome = await new Promise<string>((done) => {
      const socket = connect({ host: address, port: state.port, timeout: 3_000 });
      socket.once("connect", () => {
        socket.destroy();
        done("connected");
      });
      socket.once("timeout", () => {
        socket.destroy();
        done("timeout");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
    });

    console.log(`[evidence] connect ${address.includes(":") ? "IPv6" : "IPv4"} non-loopback interface: ${outcome}`);
    expect(outcome, `connecting through a non-loopback interface`).not.toBe("connected");
  }
});

test("O-4: any Host other than the canonical one gets the uniform refusal", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "handler-boundary evidence is engine-independent; asserted once");
  const lan = Object.values(networkInterfaces()).flat().find((address) => address !== undefined && !address.internal && address.family === "IPv4")?.address ?? "192.0.2.10";
  const hosts = [`localhost:${state.port}`, `[::1]:${state.port}`, `${lan}:${state.port}`, `admin.attacker.example:${state.port}`, `127.0.0.1:${state.port + 1}`, "127.0.0.1"];

  for (const host of hosts) {
    for (const path of [...ENTRY_HANDLERS, ...ENTRY_PAGES]) {
      const answer = await send(state, state.certificatePath, path.includes("/sign-in/") || path === "/admin/sign-out" ? "POST" : "GET", path, {
        headers: { Host: host, Origin: state.origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" },
        body: path === "/admin/sign-in/code" || ENTRY_PAGES.includes(path as (typeof ENTRY_PAGES)[number]) ? undefined : "username=a&password=b",
      });
      expect(answer.status, `${host} ${path}`).toBe(404);
      expect(answer.body).not.toMatch(/Administrator sign-in|Authenticator code|Signed in/);

      if (ENTRY_HANDLERS.includes(path as (typeof ENTRY_HANDLERS)[number])) {
        expect(answer.body, `${host} ${path}`).toBe("Not Found");
      }
    }
  }
});

test("O-7: with the gate open, OPTIONS on each page path gets the uniform refusal, not the framework's 400", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "handler-boundary evidence is engine-independent; asserted once");
  const open = await send(state, state.certificatePath, "GET", "/admin/sign-in");
  expect(open.status, "the control: the gate is open on this server").toBe(200);
  expect(open.body).toContain("Administrator sign-in");

  for (const path of ENTRY_PAGES) {
    const answer = await send(state, state.certificatePath, "OPTIONS", path, { headers: { Origin: state.origin } });
    console.log(`[evidence] open gate OPTIONS ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
    expect(answer.status, path).toBe(404);
    expect(answer.body, path).toBe("Not Found");
    expect(answer.headers["content-type"], path).toBe("text/plain; charset=utf-8");
    expect(answer.headers.allow, path).toBeUndefined();
  }
});

test("harness: teardown removes the temporary root and the cluster even when cluster startup or evidence copying fails", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "harness evidence is engine-independent; asserted once");
  test.setTimeout(300_000);

  const beforeCluster = await runInjectedSetup("cluster-start,evidence");
  expect(beforeCluster.code).toBe(1);
  expect(beforeCluster.root).toBeDefined();
  expect(existsSync(beforeCluster.root ?? ""), "the temporary root is removed when the cluster fails to start").toBe(false);
  expect(beforeCluster.clusterPort).toBeUndefined();
  expect(beforeCluster.stderr).toContain("injected: the cluster failed to start");
  expect(beforeCluster.stderr).toContain("copy the evidence: injected");

  const afterCluster = await runInjectedSetup("after-cluster,evidence");
  expect(afterCluster.code).toBe(1);
  expect(existsSync(afterCluster.root ?? ""), "the temporary root is removed").toBe(false);
  expect(afterCluster.clusterPort).toBeDefined();
  expect(existsSync(afterCluster.clusterRoot ?? ""), "the cluster's own directory is removed despite the failed copy").toBe(false);
  expect(afterCluster.stderr).toContain("copy the evidence: injected");
  expect(afterCluster.stderr).not.toContain("clean up the cluster:");
  expect(afterCluster.stderr).not.toContain("remove the temporary root:");

  const listening = await new Promise<boolean>((done) => {
    const socket = connect({ host: "127.0.0.1", port: afterCluster.clusterPort ?? 0, timeout: 3_000 });
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("timeout", () => (socket.destroy(), done(false)));
    socket.once("error", () => done(false));
  });
  expect(listening, "the cluster no longer listens").toBe(false);
  console.log(`[evidence] harness cleanup: cluster-start failure root removed=${!existsSync(beforeCluster.root ?? "")}; after-cluster failure root removed=${!existsSync(afterCluster.root ?? "")}, cluster directory removed=${!existsSync(afterCluster.clusterRoot ?? "")}, port listening=${listening}`);
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const ALLOWED_PACKAGES = /^(next\/(headers|navigation|server)|react|kysely|otpauth|node:.+)$/;
const ALLOWED_MODULES = [
  "src/interface/admin/",
  "src/domain/administrator-auth/",
  "src/data/administrator-authentication",
  "src/data/administrator-authentication-table",
  "src/data/connection",
  "src/interface/public/local-demo-persistence",
];

test("O-5: no Server Action, no route beyond the journey, and no import of any administrative capability", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "static evidence is engine-independent; asserted once");
  const source = [...filesUnder(join(REPOSITORY_ROOT, "src", "app")), ...filesUnder(join(REPOSITORY_ROOT, "src", "interface"))];

  for (const file of source) {
    expect(readFileSync(file, "utf8"), relative(REPOSITORY_ROOT, file)).not.toMatch(/["']use server["']/);
  }

  const adminFiles = filesUnder(join(REPOSITORY_ROOT, "src", "app", "admin")).map((file) => relative(join(REPOSITORY_ROOT, "src", "app", "admin"), file).split(sep).join("/")).sort();
  expect(adminFiles).toEqual(["layout.tsx", "page.tsx", "sign-in/code/page.tsx", "sign-in/code/verify/route.ts", "sign-in/page.tsx", "sign-in/password/route.ts", "sign-out/route.ts"]);

  const administrative = [
    ...filesUnder(join(REPOSITORY_ROOT, "src", "app", "admin")),
    ...filesUnder(join(REPOSITORY_ROOT, "src", "interface", "admin")).filter((file) => !/\.test\.ts$/.test(file)),
    join(REPOSITORY_ROOT, "src", "proxy.ts"),
  ];

  for (const file of administrative.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const specifiers = [...readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((match) => match[1] ?? "");

    for (const specifier of specifiers) {
      const allowed = specifier.startsWith(".")
        ? ALLOWED_MODULES.some((prefix) => relative(REPOSITORY_ROOT, resolve(file, "..", specifier)).split(sep).join("/").startsWith(prefix))
        : ALLOWED_PACKAGES.test(specifier);
      expect(allowed, `${relative(REPOSITORY_ROOT, file)} imports ${specifier}`).toBe(true);
    }
  }
});

test("O-6: no NEXT_PUBLIC_ variable carries a key, marker or database URL", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "static evidence is engine-independent; asserted once");
  const source = [...filesUnder(join(REPOSITORY_ROOT, "src")), ...filesUnder(join(REPOSITORY_ROOT, "scripts"))].filter((file) => /\.(ts|tsx|mjs)$/.test(file));

  for (const file of source) {
    expect(readFileSync(file, "utf8"), relative(REPOSITORY_ROOT, file)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(ADMIN|KEY|ORIGIN|DATABASE|TOTP|THROTTLE)/);
  }
});
