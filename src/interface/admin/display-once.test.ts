/**
 * The display-once documents (issue #268 §6.1, §3.4 and RJ-D14): complete, escaped, script-free,
 * keyboard-usable, and carrying a secret in no request-bearing attribute.
 */

import { describe, expect, it } from "vitest";

import {
  codesDocument,
  completionDocument,
  documentResponse,
  escapeHtml,
  notAcceptedDocument,
  startDocument,
  WARNINGS,
} from "./display-once";

const CODES = Array.from({ length: 10 }, (_, index) => `${index}0112233-44556677-8899aabb-ccddeeff`.slice(0, 35));
const ENROLMENT = { uri: "otpauth://totp/Issuer:label?secret=JBSWY3DPEHPK3PXP&issuer=Issuer", base32: "JBSWY3DPEHPK3PXP" };
const FACTOR = "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b";

const ALL = {
  start: startDocument(ENROLMENT, FACTOR),
  completion: completionDocument(CODES),
  codes: codesDocument(CODES),
  retry: notAcceptedDocument(FACTOR),
  restartOnly: notAcceptedDocument(undefined),
};

/** Every value of an attribute that can cause or name a request. */
function requestAttributes(html: string): string[] {
  return [...html.matchAll(/\s(href|src|action|formaction|srcset|poster|data)="([^"]*)"/g)].map((match) => match[2] ?? "");
}

describe("every display-once document", () => {
  it.each(Object.entries(ALL))("%s is a complete document with no script, external resource or style", (_name, html) => {
    expect(html.startsWith("<!DOCTYPE html>\n<html lang=\"en\">")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<style|<object|<embed|javascript:/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it.each(Object.entries(ALL))("%s points every request-bearing attribute at a fixed same-origin path", (_name, html) => {
    for (const value of requestAttributes(html)) {
      expect(value).toMatch(/^\/admin\/(sign-in|recovery(\/reenrolment\/(start|complete)|\/codes)?)$/);
    }
  });

  it("the response is 200, text/html and no-store, with exactly the cookies given", () => {
    const plain = documentResponse(ALL.codes);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(plain.headers.getSetCookie()).toEqual([]);
    expect(documentResponse(ALL.completion, ["a=; Max-Age=0"]).headers.getSetCookie()).toEqual(["a=; Max-Age=0"]);
  });
});

describe("the secret and the codes (§3.4, RJ-D14)", () => {
  it("the start document shows the secret and the otpauth URI as text only, never in an attribute", () => {
    expect(ALL.start).toContain(`<code>${ENROLMENT.base32}</code>`);
    expect(ALL.start).toContain(`<code>${escapeHtml(ENROLMENT.uri)}</code>`);

    for (const value of requestAttributes(ALL.start)) {
      expect(value).not.toContain(ENROLMENT.base32);
      expect(value).not.toContain("otpauth");
    }

    expect(ALL.start).not.toMatch(/<a\s/);
    expect(ALL.start).toContain(WARNINGS.startAfter);
    expect(ALL.start).toContain(`name="factor_id" value="${FACTOR}"`);
  });

  it.each([["completion", ALL.completion], ["codes", ALL.codes]])("the %s document lists exactly the ten codes, each once", (_name, html) => {
    for (const code of CODES) {
      expect(html.split(`<code>${code}</code>`)).toHaveLength(2);
    }

    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).not.toContain("otpauth");
  });

  it("only the start document carries a secret; no other document mentions otpauth", () => {
    for (const html of [ALL.completion, ALL.codes, ALL.retry, ALL.restartOnly]) {
      expect(html).not.toContain(ENROLMENT.base32);
      expect(html).not.toContain("otpauth");
    }
  });

  it("each document carries its replacement or display warning (§3.4.1)", () => {
    expect(ALL.codes).toContain(WARNINGS.codesAfter);
    expect(ALL.completion).toContain(WARNINGS.completedAfter);
    expect(ALL.retry).toContain(WARNINGS.startBefore);
    expect(ALL.restartOnly).toContain(WARNINGS.startBefore);
  });
});

describe("code not accepted (RJ-D3)", () => {
  it("uses one template and message; it differs only in the retry form and the escaped factor_id", () => {
    const other = notAcceptedDocument("11111111-2222-4333-8444-555555555555");
    const normalize = (html: string) => html.replace(/<h2>Try again<\/h2>\n<form method="post" action="\/admin\/recovery\/reenrolment\/complete">[\s\S]*?<\/form>\n/, "");

    expect(normalize(ALL.retry)).toBe(ALL.restartOnly);
    expect(normalize(other)).toBe(ALL.restartOnly);
    expect(ALL.retry.replace(FACTOR, "X")).toBe(other.replace("11111111-2222-4333-8444-555555555555", "X"));
    expect(ALL.restartOnly).not.toContain('name="factor_id"');
    expect(ALL.restartOnly).toContain('action="/admin/recovery/reenrolment/start"');
  });
});

describe("escaping (attacking)", () => {
  it.each(['"><script>alert(1)</script>', "a&b<c>d'e", "</code></main>"])("escapes %s in every position", (hostile) => {
    for (const html of [
      startDocument({ uri: hostile, base32: hostile }, hostile),
      completionDocument([hostile]),
      codesDocument([hostile]),
      notAcceptedDocument(hostile),
    ]) {
      expect(html).not.toContain(hostile);
      expect(html).toContain(escapeHtml(hostile));
      expect(html).not.toMatch(/<script/i);
    }
  });

  it("escapes the five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
