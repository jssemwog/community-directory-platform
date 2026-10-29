import { describe, expect, it } from "vitest";

import { LOCAL_DEMO_DATABASE_URL, localDemoConnectionStringOf } from "./local-demo-persistence";

const LOCAL = "postgresql://demo:secret@127.0.0.1:54329/community_directory_demo";

function environment(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { NODE_ENV: "development", [LOCAL_DEMO_DATABASE_URL]: LOCAL, ...overrides };
}

describe("the local demo gate (issue #248)", () => {
  it("enables the demo only in development, with a loopback PostgreSQL URL", () => {
    expect(localDemoConnectionStringOf(environment({}))).toBe(LOCAL);

    for (const host of ["localhost", "[::1]"]) {
      const url = `postgres://demo:secret@${host}:54329/demo`;

      expect(localDemoConnectionStringOf(environment({ [LOCAL_DEMO_DATABASE_URL]: url }))).toBe(url);
    }
  });

  it("stays disabled outside development, so a production build never enables it", () => {
    for (const mode of ["production", "test", undefined]) {
      expect(localDemoConnectionStringOf(environment({ NODE_ENV: mode }))).toBeUndefined();
    }
  });

  it("stays disabled when the variable is absent or empty", () => {
    expect(localDemoConnectionStringOf(environment({ [LOCAL_DEMO_DATABASE_URL]: undefined }))).toBeUndefined();
    expect(localDemoConnectionStringOf(environment({ [LOCAL_DEMO_DATABASE_URL]: "" }))).toBeUndefined();
  });

  it("refuses a non-loopback host, a non-PostgreSQL scheme or an unparseable value", () => {
    for (const value of [
      "postgresql://demo:secret@db.example.com:5432/demo",
      "postgresql://demo:secret@10.0.0.5:5432/demo",
      "postgresql://demo:secret@127.0.0.1.example.com:5432/demo",
      "http://127.0.0.1:54329/demo",
      "not a url",
    ]) {
      expect(localDemoConnectionStringOf(environment({ [LOCAL_DEMO_DATABASE_URL]: value }))).toBeUndefined();
    }
  });

  it("reads only the demo variable, never a NEXT_PUBLIC_ one", () => {
    expect(LOCAL_DEMO_DATABASE_URL.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(
      localDemoConnectionStringOf({ NODE_ENV: "development", [`NEXT_PUBLIC_${LOCAL_DEMO_DATABASE_URL}`]: LOCAL }),
    ).toBeUndefined();
  });
});
