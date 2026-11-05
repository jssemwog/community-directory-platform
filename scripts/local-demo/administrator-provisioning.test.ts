/**
 * The provisioning command's refusals that need no database (issue #260 §6.3 V-2), and its
 * enrolment URI. Every refusal happens before any storage call: the database here throws if used.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { enrolmentUriOf as sharedEnrolmentUriOf } from "../../src/domain/administrator-auth/totp-enrolment";
import {
  enrolmentUriOf,
  INCOMPLETE_NOTICE,
  isLoopbackDatabaseUrl,
  launchRefusalOf,
  processTerminal,
  provisionSyntheticAdministrator,
  type ProvisioningTerminal,
} from "./administrator-provisioning";

const untouchable = new Proxy({}, { get: () => { throw new Error("the database must not be reached"); } });

function terminal(interactive: boolean): ProvisioningTerminal & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    interactive,
    lines,
    ask: async () => {
      throw new Error("no prompt expected");
    },
    askSecret: async () => {
      throw new Error("no prompt expected");
    },
    say: (line) => lines.push(line),
  };
}

const deps = (overrides: { environment?: Record<string, string>; databaseUrl?: string } = {}) => ({
  db: untouchable as never,
  clock: Date.now,
  totpKey: randomBytes(32),
  environment: overrides.environment ?? {},
  databaseUrl: overrides.databaseUrl ?? "postgresql://demo:x@127.0.0.1:54329/demo",
});

describe("provisionSyntheticAdministrator refusals before any storage call", () => {
  it.each([
    ["a non-interactive terminal", false, deps(), "NOT_INTERACTIVE"],
    ["NODE_ENV=production", true, deps({ environment: { NODE_ENV: "production" } }), "PRODUCTION"],
    ["a non-loopback database", true, deps({ databaseUrl: "postgresql://demo:x@db.internal:5432/app" }), "NOT_LOCAL_DATABASE"],
  ] as const)("refuses %s", async (_label, interactive, dependencies, reason) => {
    const io = terminal(interactive);
    expect(await provisionSyntheticAdministrator(io, dependencies)).toEqual({ ok: false, reason });
    expect(io.lines[0]).toBe(INCOMPLETE_NOTICE);
  });
});

describe("admin add refuses before it starts anything", () => {
  it("launchRefusalOf refuses a non-interactive terminal and production mode, and nothing else", () => {
    expect(launchRefusalOf({ interactive: false }, {})?.reason).toBe("NOT_INTERACTIVE");
    expect(launchRefusalOf({ interactive: true }, { NODE_ENV: "production" })?.reason).toBe("PRODUCTION");
    expect(launchRefusalOf({ interactive: false }, { NODE_ENV: "production" })?.reason).toBe("NOT_INTERACTIVE");
    expect(launchRefusalOf({ interactive: true }, { NODE_ENV: "development" })).toBeUndefined();
    expect(launchRefusalOf({ interactive: true }, {})).toBeUndefined();
  });

  it("the launcher checks the refusal, and returns on it, before the binaries, lock, cluster, migration and keys", () => {
    // A source-order check: the launcher runs its command on import, so it cannot be called here.
    const source = readFileSync(join(import.meta.dirname, "local-demo.ts"), "utf8");
    const body = source.slice(source.indexOf("async function adminAdd()"), source.indexOf("async function admin()"));
    const at = (needle: string) => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const refusalReturn = body.indexOf("return;", at("launchRefusalOf(terminal, process.env)"));

    expect(refusalReturn).toBeGreaterThan(at("launchRefusalOf(terminal, process.env)"));

    for (const step of ["postgresBinaries()", "takeLauncherLock(", "initialiseIfNeeded(", "startCluster(", "prepareDatabase(", "ensureAdministratorKeys("]) {
      expect(at(step), `${step} comes after the refusal's return`).toBeGreaterThan(refusalReturn);
    }
  });
});

/** A disposable TTY-shaped input: a stream with `isTTY` and a recorded raw mode. */
function ttyInput() {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; rawModes: boolean[]; setRawMode(mode: boolean): void };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.rawModes = [];
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    stream.rawModes.push(mode);
  };
  return stream;
}

function ttyOutput() {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; written: () => string };
  let text = "";
  stream.isTTY = true;
  stream.columns = 80;
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  stream.written = () => text;
  return stream;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the real terminal's prompts (processTerminal, with disposable TTY fixtures)", () => {
  it("never echoes the secret, keeps Unicode split across reads whole, and restores the terminal", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const io = processTerminal({ input, output });
    expect(io.interactive).toBe(true);

    const username = io.ask("Username: ");
    await tick();
    input.write("synthetic-ada\r");
    expect(await username).toBe("synthetic-ada");
    // The fixture does capture echo: readline echoed the (non-secret) username it read.
    expect(output.written()).toContain("synthetic-ada");
    expect(input.listenerCount("keypress"), "no readline listener remains after a question").toBe(0);

    const secret = "Pässwörd ✓ 🔑 naïve façade";
    const bytes = Buffer.from(`${secret}x`, "utf8");
    const before = output.written().length;
    const password = io.askSecret("Password: ");
    await tick();
    expect(input.isRaw).toBe(true);

    // Split inside the multi-byte "ä", then inside the four-byte key emoji, then a backspace.
    const umlaut = bytes.indexOf(Buffer.from("ä")) + 1;
    const emoji = bytes.indexOf(Buffer.from("🔑")) + 2;
    for (const piece of [bytes.subarray(0, umlaut), bytes.subarray(umlaut, emoji), bytes.subarray(emoji)]) {
      input.write(piece);
      await tick();
    }
    input.write(Buffer.from([0x7f]));
    await tick();
    input.write("\r");

    expect(await password).toBe(secret);
    await tick();
    expect(output.written().slice(before)).toBe("Password: \n");
    expect(input.isRaw).toBe(false);
    expect(input.rawModes.at(-1)).toBe(false);
    expect(input.listenerCount("data")).toBe(0);

    io.close();
    expect(input.isRaw).toBe(false);
  });

  it.each([
    ["Ctrl-C", (input: PassThrough) => input.write("secret-so-far\u0003")],
    ["Ctrl-D", (input: PassThrough) => input.write("secret-so-far\u0004")],
    ["the end of input", (input: PassThrough) => { input.write("secret-so-far"); input.end(); }],
  ])("interrupts a secret prompt on %s, echoing nothing and restoring raw mode", async (_label, interrupt) => {
    const input = ttyInput();
    const output = ttyOutput();
    const io = processTerminal({ input, output });
    const password = io.askSecret("Password: ");
    const settled = password.catch((error: unknown) => error);
    await tick();
    interrupt(input);

    expect(await settled).toEqual(new Error("Interrupted; nothing further was changed."));
    await tick();
    expect(output.written()).toBe("Password: \n");
    expect(output.written()).not.toContain("secret");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("interrupts a line question on Ctrl-C and leaves raw mode off", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const io = processTerminal({ input, output });
    const answer = io.ask("Username: ").catch((error: unknown) => error);
    await tick();
    input.write("\u0003");

    expect(await answer).toEqual(new Error("Interrupted; nothing further was changed."));
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("reports a non-TTY terminal as not interactive", () => {
    const io = processTerminal({ input: new PassThrough(), output: new PassThrough() });
    expect(io.interactive).toBe(false);
  });
});

describe("isLoopbackDatabaseUrl", () => {
  it.each([
    ["postgresql://demo:x@127.0.0.1:54329/demo", true],
    ["postgres://demo:x@localhost/demo", true],
    ["postgresql://demo:x@[::1]:5432/demo", true],
    ["postgresql://demo:x@10.0.0.5/demo", false],
    ["mysql://demo:x@127.0.0.1/demo", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(expected);
  });
});

describe("enrolmentUriOf", () => {
  it("gives an otpauth URI with the ADR-004 parameters and the matching base32 secret", () => {
    const secret = Buffer.alloc(20, 7);
    const { uri, base32 } = enrolmentUriOf("synthetic-ada", secret);
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(parsed.searchParams.get("secret")).toBe(base32);
    expect(decodeURIComponent(parsed.pathname)).toContain("synthetic-ada");
  });
});

describe("the recovery-code provisioning (issue #268 §3.1, §6.4)", () => {
  it("delegates to the shared builder, with identical output", () => {
    const secret = Buffer.alloc(20, 5);
    expect(enrolmentUriOf("synthetic-ada", secret)).toEqual(sharedEnrolmentUriOf("synthetic-ada", secret));
  });

  it("the notice says codes are shown once and that provisioning is still incomplete under ADR-004", () => {
    expect(INCOMPLETE_NOTICE).toMatch(/Ten recovery codes are shown once/);
    expect(INCOMPLETE_NOTICE).toMatch(/still incomplete under ADR-004/);
    expect(INCOMPLETE_NOTICE).not.toMatch(/not implemented: this account has none/);
  });

  it("the notice no longer lists revocation or disabling as unimplemented (issue #270 §3.4)", () => {
    expect(INCOMPLETE_NOTICE).not.toMatch(/revocation/i);
    expect(INCOMPLETE_NOTICE).not.toMatch(/disabling an account/i);
    expect(INCOMPLETE_NOTICE).toMatch(/re-enabling a disabled account are not implemented/);
  });

  it("the notice no longer lists the operator reset as unimplemented (Unit OR, OR-D11)", () => {
    expect(INCOMPLETE_NOTICE).not.toMatch(/the operator reset are not implemented/);
    expect(INCOMPLETE_NOTICE).toMatch(/password-only or TOTP-only reset and re-enabling a disabled account are not implemented/);
  });

  it("confirms only through the RA-5 confirmation, never the caller-restricted confirmTotpEnrolment", () => {
    const source = readFileSync(join(import.meta.dirname, "administrator-provisioning.ts"), "utf8");
    expect(source).toMatch(/confirmTotpEnrolmentWithRecoveryCodes\(/);
    expect(source).not.toMatch(/confirmTotpEnrolment(?!WithRecoveryCodes)/);
  });
});
