/**
 * The password policy (issue #260 §6.2 P-1 to P-4): length in code points after NFC, the
 * case-insensitive offline blocklist, and the blocklist's provenance.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkNewPassword, passwordBlocklist } from "./password-policy";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const lf = (text: string) => text.split("\r\n").join("\n");
const SOURCES = (process.env.PASSWORD_BLOCKLIST_SOURCES ?? "").split(";").filter((path) => path !== "");
const SOURCES_PRESENT = SOURCES.length === 3 && SOURCES.every((path) => existsSync(path));
const BUILD_SCRIPT = "../../../scripts/local-demo/build-password-blocklist.mjs";

describe("checkNewPassword (P-1, P-2)", () => {
  it("counts code points after NFC: a decomposed input that normalizes to 15 passes", () => {
    const decomposed = "é".repeat(15);
    expect(decomposed.length).toBe(30);
    expect(checkNewPassword(decomposed)).toEqual({ ok: true, normalized: "é".repeat(15) });
  });

  it("counts an astral character once", () => {
    expect(checkNewPassword(`${"\u{1F511}".repeat(15)}`).ok).toBe(true);
    expect(checkNewPassword(`${"\u{1F511}".repeat(14)}`)).toEqual({ ok: false, rule: "TOO_SHORT" });
  });

  it.each([
    [14, { ok: false, rule: "TOO_SHORT" }],
    [15, { ok: true }],
    [128, { ok: true }],
    [129, { ok: false, rule: "TOO_LONG" }],
  ])("a password of %i characters", (length, expected) => {
    expect(checkNewPassword("q7".repeat(65).slice(0, length))).toMatchObject(expected);
  });

  it("refuses a blocklisted entry and its case variants, naming only the rule", () => {
    const entry = [...passwordBlocklist()].find((candidate) => /[a-z]/.test(candidate)) ?? "";
    expect(entry.length).toBeGreaterThanOrEqual(15);

    for (const variant of [entry, entry.toUpperCase(), entry.replace(/[a-z]/, (letter) => letter.toUpperCase())]) {
      expect(checkNewPassword(variant)).toEqual({ ok: false, rule: "BLOCKLISTED" });
    }
  });

  it("applies no composition rule", () => {
    expect(checkNewPassword("aaaaaaaaaaaaaaaaaaaaaaaaq").ok).toBe(true);
  });
});

describe("the committed blocklist (P-3, P-4)", () => {
  const text = lf(readFileSync(join(HERE, "password-blocklist.txt"), "utf8"));
  const note = readFileSync(join(HERE, "PASSWORD-BLOCKLIST.md"), "utf8");

  it("matches the SHA-256 and entry count its provenance note records", () => {
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    expect(note).toContain(digest);
    expect(note).toContain(`| Entries | ${(text.split("\n").length - 1).toLocaleString("en-US")} |`);
  });

  it("holds only NFC, lower-case, distinct entries of 15 to 128 code points, sorted", () => {
    const entries = text.split("\n").slice(0, -1);
    expect(new Set(entries).size).toBe(entries.length);
    expect([...entries].sort()).toEqual(entries);

    for (const entry of entries) {
      const length = [...entry].length;
      expect(length >= 15 && length <= 128 && entry === entry.normalize("NFC").toLowerCase(), entry.length.toString()).toBe(true);
    }
  });

  // Skipped unless PASSWORD_BLOCKLIST_SOURCES names the three pinned SecLists files, in the order
  // the provenance note gives; nothing is ever fetched.
  it.skipIf(!SOURCES_PRESENT)("P-4: the offline build script reproduces it byte for byte from the pinned sources", async () => {
    const { blocklistOf } = (await import(/* @vite-ignore */ BUILD_SCRIPT)) as { blocklistOf(texts: string[]): string };
    expect(blocklistOf(SOURCES.map((path) => readFileSync(path, "utf8")))).toBe(text);
  });
});
