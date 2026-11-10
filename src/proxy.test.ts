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

describe("PX-4: the matcher, and S2 is unaffected", () => {
  it("extends the admin matcher by exactly the constant /directory", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*", "/directory"]);
  });

  it("does not run the proxy for an S2 path, per Next's own matcher helper", () => {
    for (const url of ["/directory/9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f", "/directory/not-a-uuid", "/directory/a/b"]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
    }
    expect(unstable_doesMiddlewareMatch({ config, url: "/directory" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/admin/sign-in" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/" })).toBe(false);
  });

  it("passes an S2 path through untouched if the function is called directly", () => {
    setEnvironment("production", "1");
    const response = call("/directory/9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f");

    // Outside the exact rule, the function falls through to the admin branch's pass-through. The
    // matcher above guarantees that this branch is never reached for S2 in a real server.
    expect(response.status).not.toBe(404);
    expect(isPassThrough(response)).toBe(true);
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

  it("imports only next/server", () => {
    const imports = [...source.matchAll(/^import\s.+?from\s+"([^"]+)";?$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["next/server"]);
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
