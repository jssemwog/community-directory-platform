/**
 * `staging-access.ts` (issue #246, OP-2 staging Scope Gate revision 2 §3.3, §3.5, §7.1, §7.2).
 *
 * SA-1 off unless production with `BI4_STAGING` present; SA-2 deny-all on every invalid condition;
 * SA-3 the configuration that turns the mode on; SA-4 calibration bounds; SA-5 the key check;
 * SA-6 the `S2` path shape; SA-7 the module stays pure; SA-8 the reserved status identity
 * (amendment A1, option D).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BI4_STAGING,
  BI4_STAGING_ACCESS_KEY_SHA256,
  BI4_STAGING_CA_PEM,
  BI4_STAGING_CALIBRATION,
  BI4_STAGING_DATABASE_URL,
  BI4_STAGING_EXPECTED_DATABASE,
  BI4_STAGING_EXPECTED_HOST,
  BI4_STAGING_SYNTHETIC_MARKER,
  CALIBRATION_DELAY_CEILING_NS,
  calibrationOf,
  isStagingHostName,
  isStagingS2Path,
  presentsStagingKey,
  STAGING_KEY_HEADER,
  STAGING_STATUS_IDENTITY,
  stagingKeyDigestHex,
  stagingModeOf,
} from "./staging-access";

const KEY = "A".repeat(20) + "b".repeat(20) + "-_9";
const HOST = "db-staging.example.test";
const MARKER = `bi4-staging-synthetic:${"c".repeat(32)}`;
const UUID_A = "c1000000-0000-4000-8000-000000000001";
const UUID_B = "c2000000-0000-4000-8000-000000000002";

/** A static, public, unit-test-only certificate (no private key anywhere). Only its PEM parses. */
const CA_PEM = [
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

function valid(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    [BI4_STAGING]: "1",
    [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${"p".repeat(32)}@${HOST}:25060/bi4_staging`,
    [BI4_STAGING_EXPECTED_HOST]: HOST,
    [BI4_STAGING_CA_PEM]: CA_PEM,
    [BI4_STAGING_EXPECTED_DATABASE]: "bi4_staging",
    [BI4_STAGING_SYNTHETIC_MARKER]: MARKER,
    [BI4_STAGING_ACCESS_KEY_SHA256]: stagingKeyDigestHex(KEY),
    ...overrides,
  };
}

describe("SA-1: off unless production with BI4_STAGING present", () => {
  it("is off without the flag, or outside production, whatever else is set", () => {
    expect(stagingModeOf({ NODE_ENV: "production" }).kind).toBe("off");
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(stagingModeOf(valid({ NODE_ENV: nodeEnv })).kind, String(nodeEnv)).toBe("off");
      expect(stagingModeOf({ NODE_ENV: nodeEnv, [BI4_STAGING]: "garbage" }).kind).toBe("off");
    }
  });
});

describe("SA-2: armed with any value; deny-all unless fully valid", () => {
  it("denies for any flag value other than exactly 1", () => {
    for (const flag of ["", "0", "true", " 1", "1 ", "01", "yes"]) {
      expect(stagingModeOf(valid({ [BI4_STAGING]: flag })).kind, JSON.stringify(flag)).toBe("deny-all");
    }
  });

  it("denies when combined with E3-local or the local demo", () => {
    expect(stagingModeOf(valid({ BI4_E3_LOCAL: "1" })).kind).toBe("deny-all");
    expect(stagingModeOf(valid({ BI4_E3_LOCAL: "" })).kind).toBe("deny-all");
    expect(stagingModeOf(valid({ LOCAL_DEMO_DATABASE_URL: "postgres://x@127.0.0.1:1/x" })).kind).toBe("deny-all");
  });

  it("denies when any required variable is missing", () => {
    for (const name of [
      BI4_STAGING_DATABASE_URL,
      BI4_STAGING_EXPECTED_HOST,
      BI4_STAGING_CA_PEM,
      BI4_STAGING_EXPECTED_DATABASE,
      BI4_STAGING_SYNTHETIC_MARKER,
      BI4_STAGING_ACCESS_KEY_SHA256,
    ]) {
      expect(stagingModeOf(valid({ [name]: undefined })).kind, name).toBe("deny-all");
    }
  });

  it("denies a malformed URL, host, database, marker, digest or certificate", () => {
    const password = "p".repeat(32);
    const cases: Record<string, string>[] = [
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@other.example.test:25060/bi4_staging` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@${HOST}/bi4_staging` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@${HOST}:25060/bi4_staging?sslmode=disable` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@${HOST}:25060/bi4_staging#x` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@${HOST}:25060/defaultdb` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:short@${HOST}:25060/bi4_staging` },
      { [BI4_STAGING_DATABASE_URL]: `postgres://Bad-Role:${password}@${HOST}:25060/bi4_staging` },
      { [BI4_STAGING_DATABASE_URL]: `mysql://bi4_staging_app:${password}@${HOST}:25060/bi4_staging` },
      { [BI4_STAGING_DATABASE_URL]: "not a url" },
      { [BI4_STAGING_EXPECTED_HOST]: "203.0.113.5", [BI4_STAGING_DATABASE_URL]: `postgres://bi4_staging_app:${password}@203.0.113.5:25060/bi4_staging` },
      { [BI4_STAGING_EXPECTED_HOST]: "DB.Example.Test" },
      { [BI4_STAGING_EXPECTED_DATABASE]: "other" },
      { [BI4_STAGING_SYNTHETIC_MARKER]: "bi4-staging-synthetic:short" },
      { [BI4_STAGING_SYNTHETIC_MARKER]: `bi4-e3-synthetic:${"c".repeat(32)}` },
      { [BI4_STAGING_ACCESS_KEY_SHA256]: "A".repeat(64) },
      { [BI4_STAGING_ACCESS_KEY_SHA256]: "a".repeat(63) },
      { [BI4_STAGING_CA_PEM]: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" },
      { [BI4_STAGING_CA_PEM]: "not a pem" },
    ];
    for (const overrides of cases) {
      expect(stagingModeOf(valid(overrides)).kind, JSON.stringify(Object.keys(overrides))).toBe("deny-all");
    }
  });

  it("denies two concatenated certificates", () => {
    expect(stagingModeOf(valid({ [BI4_STAGING_CA_PEM]: `${CA_PEM}${CA_PEM}` })).kind).toBe("deny-all");
  });

  it("denies a malformed or out-of-bounds calibration value", () => {
    for (const value of ["", "x", `${UUID_A}:-1`, `${UUID_A}:${CALIBRATION_DELAY_CEILING_NS + 1}`, `${UUID_A}:1,${UUID_A}:2`]) {
      expect(stagingModeOf(valid({ [BI4_STAGING_CALIBRATION]: value })).kind, value).toBe("deny-all");
    }
  });
});

describe("SA-3: the configuration that turns the mode on", () => {
  it("is on, with the expected values and calibration off by default", () => {
    const mode = stagingModeOf(valid());
    expect(mode.kind).toBe("on");
    if (mode.kind !== "on") return;
    expect(mode.configuration.expected).toEqual({ host: HOST, database: "bi4_staging", role: "bi4_staging_app", marker: MARKER });
    expect(mode.configuration.keyDigestHex).toBe(stagingKeyDigestHex(KEY));
    expect(mode.configuration.calibration).toEqual([]);
    expect(mode.configuration.caPem).toBe(CA_PEM);
  });

  it("accepts a DNS name that resolves locally, such as localhost, but never an IP literal", () => {
    expect(isStagingHostName("localhost")).toBe(true);
    expect(isStagingHostName("db-123.b.db.ondigitalocean.com")).toBe(true);
    expect(isStagingHostName("127.0.0.1")).toBe(false);
    expect(isStagingHostName("::1")).toBe(false);
    expect(isStagingHostName("[::1]")).toBe(false);
    expect(isStagingHostName("-bad.example")).toBe(false);
  });

  it("turns calibration on only with a valid value", () => {
    const mode = stagingModeOf(valid({ [BI4_STAGING_CALIBRATION]: `${UUID_A}:0,${UUID_B}:${CALIBRATION_DELAY_CEILING_NS}` }));
    expect(mode.kind).toBe("on");
    if (mode.kind !== "on") return;
    expect(mode.configuration.calibration).toEqual([
      { identity: UUID_A, delayNs: 0 },
      { identity: UUID_B, delayNs: CALIBRATION_DELAY_CEILING_NS },
    ]);
  });
});

describe("SA-4: calibration bounds", () => {
  it("accepts 1 to 4 distinct v4 identities with delays from 0 to the 2 ms ceiling", () => {
    expect(CALIBRATION_DELAY_CEILING_NS).toBe(2_000_000);
    const four = ["c1", "c2", "c3", "c4"].map((p, i) => `${p}000000-0000-4000-8000-00000000000${i}:${i * 1000}`).join(",");
    expect(calibrationOf(four)).toHaveLength(4);
    const five = `${four},c5000000-0000-4000-8000-000000000005:1`;
    expect(calibrationOf(five)).toBeUndefined();
  });

  it("refuses non-v4, upper-case, padded or fractional entries", () => {
    for (const value of [
      "c1000000-0000-1000-8000-000000000001:1",
      "C1000000-0000-4000-8000-000000000001:1",
      `${UUID_A}:01`,
      `${UUID_A}:1.5`,
      ` ${UUID_A}:1`,
      `${UUID_A}:1,`,
    ]) {
      expect(calibrationOf(value), value).toBeUndefined();
    }
  });
});

describe("SA-5: the key check", () => {
  const digest = stagingKeyDigestHex(KEY);
  const headersWith = (value?: string) => {
    const headers = new Headers();
    if (value !== undefined) headers.set(STAGING_KEY_HEADER, value);
    return headers;
  };

  it("accepts exactly the key, by its digest", () => {
    expect(presentsStagingKey(headersWith(KEY), digest)).toBe(true);
    const upper = new Headers([["X-BI4-Staging-Key", KEY]]);
    expect(presentsStagingKey(upper, digest)).toBe(true);
  });

  it("refuses a missing, wrong, malformed or duplicated key", () => {
    expect(presentsStagingKey(headersWith(), digest)).toBe(false);
    expect(presentsStagingKey(headersWith(`${KEY.slice(0, 42)}x`), digest)).toBe(false);
    // Surrounding whitespace is not part of an HTTP field value (`Headers` trims it), so an
    // overlong value is the malformed case here.
    expect(presentsStagingKey(headersWith(`${KEY}x`), digest)).toBe(false);
    expect(presentsStagingKey(headersWith(`${KEY.slice(0, 20)} ${KEY.slice(21)}`), digest)).toBe(false);
    expect(presentsStagingKey(headersWith(""), digest)).toBe(false);
    const duplicated = new Headers();
    duplicated.append(STAGING_KEY_HEADER, KEY);
    duplicated.append(STAGING_KEY_HEADER, KEY);
    expect(presentsStagingKey(duplicated, digest)).toBe(false);
  });
});

describe("SA-6: the S2 path shape", () => {
  it("matches one non-empty segment under /directory only", () => {
    expect(isStagingS2Path(`/directory/${UUID_A}`)).toBe(true);
    expect(isStagingS2Path("/directory/not-a-uuid")).toBe(true);
    for (const path of ["/directory", "/directory/", "/directory/a/b", "/Directory/x", "/", "/admin", "/_next/static/x.js"]) {
      expect(isStagingS2Path(path), path).toBe(false);
    }
  });
});

describe("SA-8: the reserved status identity (amendment A1, option D)", () => {
  it("is one S2 segment, never UUID-shaped, and cannot collide with the harness malformed controls", () => {
    expect(STAGING_STATUS_IDENTITY).toBe("__bi4_status__");
    expect(isStagingS2Path(`/directory/${STAGING_STATUS_IDENTITY}`)).toBe(true);
    expect(STAGING_STATUS_IDENTITY).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(STAGING_STATUS_IDENTITY).not.toMatch(/^(e3|demo)-malformed-/);
    expect(encodeURIComponent(STAGING_STATUS_IDENTITY)).toBe(STAGING_STATUS_IDENTITY);
  });
});

describe("SA-7: the module stays pure", () => {
  const source = readFileSync(fileURLToPath(new URL("./staging-access.ts", import.meta.url)), "utf8");

  it("imports only node:crypto and declares no module-level mutable state", () => {
    const imports = [...source.matchAll(/^import\s[\s\S]+?from\s+"([^"]+)";?$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["node:crypto"]);
    expect(source).not.toMatch(/^(let|var)\s/m);
    expect(source).not.toMatch(/console\./);
  });
});
