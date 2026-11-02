/**
 * The administrator cookies (issue #260 §6.2 C-1): exactly the production attributes, and no way
 * to produce a weaker cookie.
 */

import { describe, expect, it } from "vitest";

import { CHALLENGE_COOKIE, clearCookie, readCookie, SESSION_COOKIE, setCookie } from "./session-cookies";

const TOKEN = "Zq3k8x0aB-_9ZQ3K8X0Ab-_9zq3k8x0aB-_9ZQ3K8X0";

function attributesOf(header: string): string[] {
  return header.split(";").slice(1).map((part) => part.trim());
}

describe("setCookie and clearCookie", () => {
  it.each([SESSION_COOKIE, CHALLENGE_COOKIE] as const)("%s carries exactly Max-Age, Path=/, Secure, HttpOnly and SameSite=Strict", (name) => {
    const header = setCookie(name, TOKEN, 300.9);
    expect(header.startsWith(`${name}=${TOKEN};`)).toBe(true);
    expect(attributesOf(header)).toEqual(["Max-Age=300", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]);
    expect(header).not.toMatch(/Domain/i);
  });

  it("never sets a non-positive lifetime when storing", () => {
    expect(setCookie(SESSION_COOKIE, TOKEN, -5)).toContain("Max-Age=1;");
  });

  it.each([SESSION_COOKIE, CHALLENGE_COOKIE] as const)("clearing %s keeps every attribute", (name) => {
    expect(attributesOf(clearCookie(name))).toEqual(["Max-Age=0", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]);
  });

  it.each(["", "has space", "semi;colon", "équipe", "x".repeat(129)])("refuses a value that is not a base64url token: %s", (value) => {
    expect(() => setCookie(SESSION_COOKIE, value, 60)).toThrow(RangeError);
  });

  it("offers no option that could omit an attribute", () => {
    expect(setCookie.length).toBe(3);
    expect(clearCookie.length).toBe(1);
  });
});

describe("readCookie", () => {
  it("reads the named cookie among others", () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=${TOKEN}; x=y`, SESSION_COOKIE)).toBe(TOKEN);
  });

  it.each([
    ["no header", null],
    ["no such cookie", "other=1"],
    ["a duplicated cookie", `${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${TOKEN}`],
    ["an empty value", `${SESSION_COOKIE}=`],
    ["a malformed value", `${SESSION_COOKIE}=not a token`],
    ["an over-long value", `${SESSION_COOKIE}=${"x".repeat(129)}`],
    ["the other cookie only", `${CHALLENGE_COOKIE}=${TOKEN}`],
  ])("gives undefined for %s", (_label, header) => {
    expect(readCookie(header, SESSION_COOKIE)).toBeUndefined();
  });
});
