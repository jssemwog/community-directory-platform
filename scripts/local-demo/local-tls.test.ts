/**
 * Local HTTPS (issue #260 OD-3): a self-signed certificate for `IP:127.0.0.1` from the local
 * OpenSSL, reused while usable, never a trust-store change, and `next dev` always given both the
 * key and the certificate so it never falls back to `mkcert`.
 */

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { certificateUsable, ensureLocalCertificate, httpsArgumentsFor, opensslCandidates } from "./local-tls";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdp-local-tls-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureLocalCertificate", () => {
  it("makes a 30-day certificate for IP 127.0.0.1 only, then reuses it while usable", async () => {
    const first = await ensureLocalCertificate(join(root, "tls"));
    const cert = new X509Certificate(readFileSync(first.certPath));

    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkHost("localhost")).toBeUndefined();
    expect(cert.ca).toBe(false);
    expect(Math.round((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000)).toBe(30);
    expect(certificateUsable(first, Date.now())).toBe(true);

    const calls: string[] = [];
    const second = await ensureLocalCertificate(join(root, "tls"), { runCommand: async (command) => (calls.push(command), 1) });
    expect(second).toEqual(first);
    expect(calls).toEqual([]);
  }, 60_000);

  it("treats a certificate within a day of expiry as unusable", async () => {
    const first = await ensureLocalCertificate(join(root, "tls"));

    expect(certificateUsable(first, Date.now() + 29 * 86_400_000 - 60_000)).toBe(true);
    expect(certificateUsable(first, Date.now() + 29 * 86_400_000 + 60_000)).toBe(false);
  }, 60_000);

  it("replaces a certificate within a day of expiry with a new 30-day pair", async () => {
    const directory = join(root, "tls");
    const existing = await ensureLocalCertificate(directory);
    // Overwrite the pair with a real one-day certificate from the same OpenSSL.
    const openssl = opensslCandidates(process.env).find((candidate) => spawnSync(candidate, ["version"], { windowsHide: true }).status === 0);
    expect(openssl, "an OpenSSL to make the expiring certificate").toBeDefined();
    const made = spawnSync(openssl ?? "openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", existing.keyPath, "-out", existing.certPath,
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ], { windowsHide: true });
    expect(made.status).toBe(0);

    const expiring = new X509Certificate(readFileSync(existing.certPath));
    expect(certificateUsable(existing, Date.now())).toBe(false);

    const replaced = await ensureLocalCertificate(directory);
    const renewed = new X509Certificate(readFileSync(replaced.certPath));

    expect(replaced).toEqual(existing);
    expect(renewed.serialNumber).not.toBe(expiring.serialNumber);
    expect(Math.round((Date.parse(renewed.validTo) - Date.parse(renewed.validFrom)) / 86_400_000)).toBe(30);
    expect(renewed.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(certificateUsable(replaced, Date.now())).toBe(true);
  }, 60_000);

  it("throws, and changes nothing else, when no OpenSSL produces a usable pair", async () => {
    const tried: string[] = [];
    await expect(ensureLocalCertificate(join(root, "tls"), { runCommand: async (command) => (tried.push(command), -1) })).rejects.toThrow(/no usable OpenSSL/);
    expect(tried).toEqual(opensslCandidates(process.env));
  });

  it("treats a mismatched key and certificate as unusable", async () => {
    const pair = await ensureLocalCertificate(join(root, "a"));
    const other = await ensureLocalCertificate(join(root, "b"));
    writeFileSync(pair.keyPath, readFileSync(other.keyPath));

    expect(certificateUsable(pair, Date.now())).toBe(false);
  }, 60_000);
});

describe("httpsArgumentsFor", () => {
  it("always passes both the key and the certificate", () => {
    expect(httpsArgumentsFor({ keyPath: "k.pem", certPath: "c.pem" })).toEqual([
      "--experimental-https",
      "--experimental-https-key",
      "k.pem",
      "--experimental-https-cert",
      "c.pem",
    ]);
  });
});
