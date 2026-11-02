/**
 * The session check every protected administrator page runs on every request (`ADR-004` P-1,
 * `AA-1`, `AA-5`, `BI-9`; issue #260 §3.2).
 *
 * It answers only **valid** or **refused**. A missing, malformed, unknown, idle-expired,
 * absolute-expired or disabled session, a session of another kind (such as a future restricted
 * recovery session), a storage failure and an unavailable runtime are all simply refused, and the
 * caller sends every refusal to the same place. A layout never calls this on a page's behalf:
 * each page calls it itself.
 */

import { checkSession } from "../../data/administrator-authentication";
import { tokenDigest } from "../../domain/administrator-auth/token";
import { administratorRuntime, DEFAULT_FACTORIES, type RuntimeFactories } from "./authentication-runtime";
import type { LocalAdministratorConfiguration } from "./local-gate";

export type AdministratorSession = "valid" | "refused";

export async function administratorSessionOf(
  configuration: LocalAdministratorConfiguration,
  sessionToken: string | undefined,
  options: { readonly factories?: RuntimeFactories; readonly log?: (line: string) => void } = {},
): Promise<AdministratorSession> {
  const digest = sessionToken === undefined ? null : tokenDigest(sessionToken);
  let outcome = "SESSION_REFUSED";

  if (digest !== null) {
    try {
      const runtime = await administratorRuntime(configuration, options.factories ?? DEFAULT_FACTORIES);
      const checked = await checkSession(runtime.deps.db, { tokenDigest: digest }, runtime.deps.clock);

      if (checked.ok && checked.value.code === "SESSION_VALID" && checked.value.kind === "administrator") {
        outcome = "SESSION_VALID";
      }
    } catch {
      outcome = "SESSION_REFUSED";
    }
  }

  (options.log ?? ((line: string) => console.info(line)))(
    JSON.stringify({ event: "administrator-authentication", entry: "session-check", outcome, at: new Date().toISOString() }),
  );

  return outcome === "SESSION_VALID" ? "valid" : "refused";
}
