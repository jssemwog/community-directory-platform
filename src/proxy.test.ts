/**
 * Regressions for `src/proxy.ts` (issue #246, `E3-local` Scope Gate revision 4 §2 and §6.1,
 * PX-1 to PX-8).
 *
 * These call the proxy function directly, without a server. **They do not establish wire
 * status**: whether `next start` sends these responses with these statuses, and how the
 * framework's trailing-slash redirect answers `/directory/`, is checked only by the separately
 * authorized live `e3-check` acceptance run.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

import { STAGING_STATUS_IDENTITY, STAGING_VARIABLES, stagingKeyDigestHex } from "./interface/public/staging-access";
import { config, proxy } from "./proxy";

const ORIGIN = "http://127.0.0.1:3999";
const ADMIN_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "same-origin",
};
const ADMIN_PAGE_PATHS = ["/admin", "/admin/sign-in", "/admin/sign-in/code", "/admin/sign-in/recovery", "/admin/recovery"];
const METHODS = ["GET", "HEAD", "POST", "OPTIONS", "PUT", "DELETE"];
/** The reserved S2 identity that serves staging status (amendment A1, option D). */
const STATUS = `/directory/${STAGING_STATUS_IDENTITY}`;

const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;

function setEnvironment(nodeEnv: string | undefined, flag: string | undefined): void {
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  if (flag === undefined) delete env.BI4_E3_LOCAL;
  else env.BI4_E3_LOCAL = flag;
}

function call(path: string, method = "GET") {
  return proxy(new NextRequest(`${ORIGIN}${path}`, { method }));
}

/** Header names the proxy added (the pass-through marker headers are Next's own, not ours). */
function addedHeaders(response: Response): Record<string, string> {
  const added: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!name.startsWith("x-middleware-")) added[name] = value;
  });
  return added;
}

function isPassThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  saved.NODE_ENV = env.NODE_ENV;
  saved.BI4_E3_LOCAL = env.BI4_E3_LOCAL;
});

afterEach(() => {
  setEnvironment(saved.NODE_ENV, saved.BI4_E3_LOCAL);
});

describe("PX-1/PX-2: the /directory index under E3-local", () => {
  it("answers a plain-text 404 for every method, with no admin header", async () => {
    setEnvironment("production", "1");

    for (const method of METHODS) {
      const response = call("/directory", method);

      expect(response.status, method).toBe(404);
      expect(isPassThrough(response), method).toBe(false);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("referrer-policy")).toBeNull();
      expect(await response.text()).toBe("Not Found");
    }
  });

  it("matches on the pathname only, so a query string still gets 404", () => {
    setEnvironment("production", "1");

    expect(call("/directory?x=1").status).toBe(404);
    expect(call("/directory?listingId=00000000-0000-0000-0000-000000000000").status).toBe(404);
  });
});

describe("PX-3: development and flag-off behaviour are preserved", () => {
  it("passes /directory through with no header added in development, even with the flag set", () => {
    setEnvironment("development", "1");
    const response = call("/directory");

    expect(isPassThrough(response)).toBe(true);
    expect(addedHeaders(response)).toEqual({});
  });

  it("passes /directory through in production unless the flag is exactly 1", () => {
    for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) {
      setEnvironment("production", flag);
      const response = call("/directory");

      expect(isPassThrough(response), JSON.stringify(flag)).toBe(true);
      expect(addedHeaders(response), JSON.stringify(flag)).toEqual({});
    }
  });

  it("passes /directory through under test or an unset NODE_ENV", () => {
    for (const mode of ["test", undefined]) {
      setEnvironment(mode, "1");
      expect(isPassThrough(call("/directory")), String(mode)).toBe(true);
    }
  });
});

describe("PX-4: the global matcher, and S2 is unaffected outside staging", () => {
  it("is exactly the global matcher (OP-2 staging Scope Gate revision 2 §3.1)", () => {
    expect(config.matcher).toEqual(["/:path*"]);
  });

  it("runs the proxy for every path, per Next's own matcher helper", () => {
    for (const url of [
      "/",
      "/directory",
      "/directory/9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f",
      "/directory/a/b",
      "/admin/sign-in",
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Fx.png&w=64&q=75",
      "/favicon.ico",
      "/bi4-staging/status",
      "/directory/__bi4_status__",
      "/anything/else",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
  });

  it("passes S2 and every non-admin path through with no header added, flag on or off", () => {
    for (const flag of ["1", undefined]) {
      setEnvironment("production", flag);
      for (const path of ["/", "/directory/9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f", "/_next/static/chunks/main.js", "/bi4-staging/status", STATUS, "/Admin", "/administrator"]) {
        for (const method of METHODS) {
          const response = call(path, method);
          expect(isPassThrough(response), `${method} ${path}`).toBe(true);
          expect(addedHeaders(response), `${method} ${path}`).toEqual({});
        }
      }
    }
  });
});

describe("PX-5: admin matching and headers are preserved, with the flag on and off", () => {
  for (const [nodeEnv, flag] of [
    ["production", "1"],
    ["production", undefined],
    ["development", "1"],
    ["development", undefined],
  ] as const) {
    it(`keeps the admin behaviour under ${nodeEnv} with the flag ${flag ?? "absent"}`, async () => {
      setEnvironment(nodeEnv, flag);

      for (const path of ADMIN_PAGE_PATHS) {
        const refused = call(path, "OPTIONS");
        expect(refused.status, path).toBe(404);
        expect(refused.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(refused.headers.get("cache-control")).toBe("no-store");
        expect(await refused.text()).toBe("Not Found");
      }

      for (const path of ["/admin", "/admin/sign-in", "/admin/api/anything"]) {
        const response = call(path);
        expect(isPassThrough(response), path).toBe(true);
        expect(addedHeaders(response), path).toEqual(ADMIN_HEADERS);
      }

      const handlerOptions = call("/admin/api/anything", "OPTIONS");
      expect(isPassThrough(handlerOptions)).toBe(true);
      expect(addedHeaders(handlerOptions)).toEqual(ADMIN_HEADERS);
    });
  }
});

describe("PX-6: the flag is read on each request", () => {
  it("changes outcome when the environment changes between calls", () => {
    setEnvironment("production", "1");
    expect(call("/directory").status).toBe(404);

    setEnvironment("production", undefined);
    expect(isPassThrough(call("/directory"))).toBe(true);

    setEnvironment("production", "1");
    expect(call("/directory").status).toBe(404);
  });
});

describe("PX-7: isolation from the database and from rendering state", () => {
  const source = readFileSync(fileURLToPath(new URL("./proxy.ts", import.meta.url)), "utf8");

  it("imports only next/server and the pure staging-access module", () => {
    const imports = [...source.matchAll(/^import\s[\s\S]+?from\s+"([^"]+)";?$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["next/server", "./interface/public/staging-access"]);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it("declares no module-level mutable state", () => {
    expect(source).not.toMatch(/^(let|var)\s/m);
  });
});

describe("PX-8: /directory/ and other spellings are outside the exact rule", () => {
  it("does not answer 404 for /directory/, which the framework redirects before the proxy runs", () => {
    setEnvironment("production", "1");
    const request = new NextRequest(`${ORIGIN}/directory/`);

    // Next's request URL keeps the slash, so the exact rule does not apply; nothing is normalized.
    expect(request.nextUrl.pathname).toBe("/directory/");
    expect(proxy(request).status).not.toBe(404);
  });

  it("does not normalize case", () => {
    setEnvironment("production", "1");
    expect(call("/Directory").status).not.toBe(404);
    expect(call("/DIRECTORY").status).not.toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* OP-2 staging gate (issue #246, OP-2 staging Scope Gate revision 2 §3, §4.1), PX-9 to PX-14.   */
/* These call the function directly. They do not establish wire behaviour: that is the local      */
/* configured check, the separately authorized PB runs, and readiness through Render (R-2b, R-3).  */
/* ------------------------------------------------------------------------------------------- */

const STAGING_KEY = "Z".repeat(40) + "-_7";
const STAGING_HOST = "db-staging.example.test";
const STAGING_UUID = "9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f";
const STAGING_NAMES = [...STAGING_VARIABLES, "BI4_E3_LOCAL", "LOCAL_DEMO_DATABASE_URL", "NODE_ENV"];
/** A static, public, unit-test-only certificate (no private key anywhere). Only its PEM parses. */
const stagingCaPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBnzCCAUWgAwIBAgIUM/tHawQHc2VgtgOJ5sjZf38C2RkwCgYIKoZIzj0EAwIw",
  "JTEjMCEGA1UEAwwaYmk0LXN0YWdpbmctdW5pdC10ZXN0LW9ubHkwHhcNMjYxMTEx",
  "MTEzNDQ4WhcNMzYxMTA4MTEzNDQ4WjAlMSMwIQYDVQQDDBpiaTQtc3RhZ2luZy11",
  "bml0LXRlc3Qtb25seTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPueybXMoSgm",
  "HRwFP4x+RFH+dexRFE9Z6Bm+FptL1yydxnHlZTKEmlIKhX6wPAKX/5yJ9IwWDfO4",
  "gmfHkiE3aFyjUzBRMB0GA1UdDgQWBBSp1WZT67VAq4Uyu3yH8Ypxh16BDTAfBgNV",
  "HSMEGDAWgBSp1WZT67VAq4Uyu3yH8Ypxh16BDTAPBgNVHRMBAf8EBTADAQH/MAoG",
  "CCqGSM49BAMCA0gAMEUCIAffgOmcM/XT520QRFBNjSn2gVkoP1AFxePl+HlnMHz0",
  "AiEAyQRumnKXOaeHWZ/83mUuIYtRsnZHJz7ljDGcueLpdJ0=",
  "-----END CERTIFICATE-----",
].join("\n") + "\n";

function stagingEnvironment(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    NODE_ENV: "production",
    BI4_STAGING: "1",
    BI4_STAGING_DATABASE_URL: `postgres://bi4_staging_app:${"p".repeat(32)}@${STAGING_HOST}:25060/bi4_staging`,
    BI4_STAGING_EXPECTED_HOST: STAGING_HOST,
    BI4_STAGING_CA_PEM: stagingCaPem,
    BI4_STAGING_EXPECTED_DATABASE: "bi4_staging",
    BI4_STAGING_SYNTHETIC_MARKER: `bi4-staging-synthetic:${"d".repeat(32)}`,
    BI4_STAGING_ACCESS_KEY_SHA256: stagingKeyDigestHex(STAGING_KEY),
    BI4_STAGING_CALIBRATION: undefined,
    BI4_E3_LOCAL: undefined,
    LOCAL_DEMO_DATABASE_URL: undefined,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

function stagingCall(path: string, init: { method?: string; key?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.key !== null) headers.set("X-BI4-Staging-Key", init.key ?? STAGING_KEY);
  return proxy(new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers }));
}

async function expectGate(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(404);
  expect(isPassThrough(response), label).toBe(false);
  expect(addedHeaders(response), label).toEqual({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  expect(await response.text(), label).toBe("Not Found");
}

describe("OP-2 staging gate", () => {
  const savedStaging: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of STAGING_NAMES) savedStaging[name] = env[name];
  });

  afterEach(() => {
    for (const name of STAGING_NAMES) {
      if (savedStaging[name] === undefined) delete env[name];
      else env[name] = savedStaging[name];
    }
  });

  it("PX-9: keyless, wrong-key, query-string, cookie and duplicate-header requests all get the gate 404", async () => {
    stagingEnvironment();
    const paths = [
      "/", "/directory", `/directory/${STAGING_UUID}`, "/directory/malformed", "/admin", "/admin/sign-in", "/admin/sign-in/password",
      "/_next/static/chunks/main.js", "/_next/image?url=%2Fx.png&w=64&q=75", "/favicon.ico", "/bi4-staging/status", STATUS, "/random/path",
    ];
    for (const path of paths) {
      for (const method of METHODS) {
        await expectGate(stagingCall(path, { method, key: null }), `keyless ${method} ${path}`);
        await expectGate(stagingCall(path, { method, key: "W".repeat(43) }), `wrong key ${method} ${path}`);
      }
    }
    await expectGate(stagingCall(`/directory/${STAGING_UUID}?k=${STAGING_KEY}`, { key: null }), "key in query only");
    await expectGate(stagingCall(`/directory/${STAGING_UUID}?x=1`), "keyed with a query string");
    await expectGate(stagingCall(`/directory/${STAGING_UUID}`, { key: null, headers: { cookie: `x-bi4-staging-key=${STAGING_KEY}` } }), "key in cookie only");
    await expectGate(stagingCall(`/directory/${STAGING_UUID}`, { headers: { cookie: "a=b" } }), "keyed with a cookie");
    const duplicated = new Headers();
    duplicated.append("x-bi4-staging-key", STAGING_KEY);
    duplicated.append("x-bi4-staging-key", STAGING_KEY);
    await expectGate(proxy(new NextRequest(`${ORIGIN}/directory/${STAGING_UUID}`, { headers: duplicated })), "duplicate header");
  });

  it("PX-10: a valid key reaches only GET/HEAD S2 (status included); admin, /bi4-staging/status and everything else get the gate 404", async () => {
    stagingEnvironment();
    for (const path of ["/", "/directory", "/admin", "/admin/sign-in", "/admin/recovery/codes", "/_next/static/chunks/main.js", "/favicon.ico", "/random"]) {
      for (const method of METHODS) await expectGate(stagingCall(path, { method }), `keyed ${method} ${path}`);
    }
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) await expectGate(stagingCall(`/directory/${STAGING_UUID}`, { method }), `keyed ${method} S2`);
    for (const method of METHODS) await expectGate(stagingCall("/bi4-staging/status", { method }), `keyed ${method} /bi4-staging/status`);
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) await expectGate(stagingCall(STATUS, { method }), `keyed ${method} status`);

    for (const method of ["GET", "HEAD"]) {
      for (const path of [`/directory/${STAGING_UUID}`, "/directory/malformed", STATUS]) {
        expect(isPassThrough(stagingCall(path, { method })), `${method} ${path}`).toBe(true);
      }
    }
    await expectGate(stagingCall(`${STATUS}?x=1`), "keyed status with a query string");
    await expectGate(stagingCall(STATUS, { headers: { cookie: "a=b" } }), "keyed status with a cookie");
  });

  it("PX-11: the key header is deleted from the forwarded request", () => {
    stagingEnvironment();
    for (const path of [`/directory/${STAGING_UUID}`, STATUS]) {
      const response = stagingCall(path, { headers: { accept: "text/html" } });
      const overridden = (response.headers.get("x-middleware-override-headers") ?? "").split(",");
      expect(overridden, path).not.toContain("x-bi4-staging-key");
      expect(overridden, path).toContain("accept");
      expect(response.headers.get("x-middleware-request-x-bi4-staging-key"), path).toBeNull();
      expect([...response.headers.values()].some((value) => value.includes(STAGING_KEY)), path).toBe(false);
    }
  });

  it("PX-12: keyed S2 responses, status included, get Cache-Control private, no-store", () => {
    stagingEnvironment();
    for (const path of [`/directory/${STAGING_UUID}`, "/directory/malformed", STATUS]) {
      for (const method of ["GET", "HEAD"]) expect(stagingCall(path, { method }).headers.get("cache-control"), `${method} ${path}`).toBe("private, no-store");
    }
  });

  it("PX-13: deny-all on every invalid condition, even with a valid key", async () => {
    const cases: Record<string, string | undefined>[] = [
      { BI4_STAGING: "" },
      { BI4_STAGING: "0" },
      { BI4_STAGING_ACCESS_KEY_SHA256: undefined },
      { BI4_STAGING_CA_PEM: "nope" },
      { BI4_E3_LOCAL: "1" },
      { LOCAL_DEMO_DATABASE_URL: "postgres://x@127.0.0.1:1/x" },
      { BI4_STAGING_CALIBRATION: "garbage" },
    ];
    for (const overrides of cases) {
      stagingEnvironment(overrides);
      for (const path of [`/directory/${STAGING_UUID}`, STATUS, "/bi4-staging/status", "/admin", "/"]) {
        await expectGate(stagingCall(path), `${JSON.stringify(overrides)} ${path}`);
      }
    }
  });

  it("PX-14: the staging variables are ignored outside production", () => {
    for (const nodeEnv of ["development", "test"]) {
      stagingEnvironment({ NODE_ENV: nodeEnv });
      const response = stagingCall("/", { key: null });
      expect(isPassThrough(response), nodeEnv).toBe(true);
      expect(addedHeaders(response), nodeEnv).toEqual({});
    }
  });
});
