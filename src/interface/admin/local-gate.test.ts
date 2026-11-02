/**
 * The local administrator gate (issue #260 §6.1 G-1): open only when every condition holds, and
 * each condition, removed alone, closes it.
 */

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LOCAL_ADMIN_ORIGIN,
  LOCAL_ADMIN_THROTTLE_KEY,
  LOCAL_ADMIN_TOTP_KEY_V1,
  localAdministratorConfigurationOf,
  openGateFor,
} from "./local-gate";
import { LOCAL_DEMO_DATABASE_URL } from "../public/local-demo-persistence";

const key = () => randomBytes(32).toString("base64url");
const open = (): Record<string, string | undefined> => ({
  NODE_ENV: "development",
  [LOCAL_DEMO_DATABASE_URL]: "postgresql://demo:secret-value@127.0.0.1:54329/community_directory_demo",
  [LOCAL_ADMIN_ORIGIN]: "https://127.0.0.1:3000",
  [LOCAL_ADMIN_TOTP_KEY_V1]: key(),
  [LOCAL_ADMIN_THROTTLE_KEY]: key(),
});

describe("localAdministratorConfigurationOf", () => {
  it("opens with every condition, exposing the canonical origin and host", () => {
    const configuration = localAdministratorConfigurationOf(open());
    expect(configuration).toMatchObject({ origin: "https://127.0.0.1:3000", host: "127.0.0.1:3000" });
    expect(configuration?.totpKey).toHaveLength(32);
    expect(configuration?.throttleKey).toHaveLength(32);
  });

  it.each([
    ["production mode", { NODE_ENV: "production" }],
    ["test mode", { NODE_ENV: "test" }],
    ["no mode", { NODE_ENV: undefined }],
    ["no marker origin", { [LOCAL_ADMIN_ORIGIN]: undefined }],
    ["an empty marker origin", { [LOCAL_ADMIN_ORIGIN]: "" }],
    ["an http origin", { [LOCAL_ADMIN_ORIGIN]: "http://127.0.0.1:3000" }],
    ["a localhost origin", { [LOCAL_ADMIN_ORIGIN]: "https://localhost:3000" }],
    ["an IPv6 loopback origin", { [LOCAL_ADMIN_ORIGIN]: "https://[::1]:3000" }],
    ["a LAN origin", { [LOCAL_ADMIN_ORIGIN]: "https://192.168.1.20:3000" }],
    ["an origin without a port", { [LOCAL_ADMIN_ORIGIN]: "https://127.0.0.1" }],
    ["an origin with a path", { [LOCAL_ADMIN_ORIGIN]: "https://127.0.0.1:3000/admin" }],
    ["an origin with credentials", { [LOCAL_ADMIN_ORIGIN]: "https://user:pass@127.0.0.1:3000" }],
    ["no database", { [LOCAL_DEMO_DATABASE_URL]: undefined }],
    ["a non-loopback database", { [LOCAL_DEMO_DATABASE_URL]: "postgresql://demo:x@db.internal:5432/app" }],
    ["a malformed database URL", { [LOCAL_DEMO_DATABASE_URL]: "not a url" }],
    ["a non-PostgreSQL database URL", { [LOCAL_DEMO_DATABASE_URL]: "mysql://demo:x@127.0.0.1:3306/app" }],
    ["no TOTP key", { [LOCAL_ADMIN_TOTP_KEY_V1]: undefined }],
    ["a short TOTP key", { [LOCAL_ADMIN_TOTP_KEY_V1]: randomBytes(31).toString("base64url") }],
    ["a long throttle key", { [LOCAL_ADMIN_THROTTLE_KEY]: randomBytes(33).toString("base64url") }],
    ["a padded key", { [LOCAL_ADMIN_THROTTLE_KEY]: `${key()}=` }],
    ["a standard-base64 key", { [LOCAL_ADMIN_THROTTLE_KEY]: `+${key().slice(1)}` }],
    ["no throttle key", { [LOCAL_ADMIN_THROTTLE_KEY]: undefined }],
  ])("closes with %s", (_label, change) => {
    expect(localAdministratorConfigurationOf({ ...open(), ...change })).toBeUndefined();
  });

  it("closes when the two keys are equal", () => {
    const same = key();
    expect(localAdministratorConfigurationOf({ ...open(), [LOCAL_ADMIN_TOTP_KEY_V1]: same, [LOCAL_ADMIN_THROTTLE_KEY]: same })).toBeUndefined();
  });
});

describe("openGateFor", () => {
  it("opens only for the exact canonical Host", () => {
    expect(openGateFor(open(), "127.0.0.1:3000")).toBeDefined();
  });

  it.each([
    "localhost:3000",
    "[::1]:3000",
    "192.168.1.20:3000",
    "127.0.0.1:3001",
    "127.0.0.1",
    "admin.attacker.example:3000",
    "127.0.0.1:3000.attacker.example",
    "",
    null,
    undefined,
  ])("closes for Host %s", (host) => {
    expect(openGateFor(open(), host)).toBeUndefined();
  });

  it("closes for the canonical Host when the environment is closed", () => {
    expect(openGateFor({ ...open(), NODE_ENV: "production" }, "127.0.0.1:3000")).toBeUndefined();
  });
});
