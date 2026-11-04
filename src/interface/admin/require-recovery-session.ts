/**
 * The recovery-session check the recovery page runs on every request, and that completion runs for
 * an invalid `factor_id` (`ADR-004` P-1; issue #268 §3.3, §3.4 step 5 and §3.5).
 *
 * It answers only **valid** or **refused**. Only a live session of `kind = 'recovery'` is valid. A
 * missing, malformed, unknown, expired or disabled session, an administrator session, a storage
 * failure and an unavailable runtime are all simply refused.
 *
 * **The storage effect, disclosed (§3.5).** It calls the merged `checkSession`, which sets a live
 * session's `last_activity_at` before this function rejects its kind. So an administrator token
 * presented here is refused, but its `last_activity_at` is refreshed. `checkSession` never changes
 * `absolute_expires_at`, so a recovery session's 15 minutes are never extended. Storage is not
 * modified to remove the effect.
 */

import { checkSession } from "../../data/administrator-authentication";
import { tokenDigest } from "../../domain/administrator-auth/token";
import { administratorRuntime, DEFAULT_FACTORIES, type RuntimeFactories } from "./authentication-runtime";
import type { LocalAdministratorConfiguration } from "./local-gate";

export type RecoverySession = "valid" | "refused";

export async function recoverySessionOf(
  configuration: LocalAdministratorConfiguration,
  recoveryToken: string | undefined,
  options: { readonly factories?: RuntimeFactories; readonly log?: (line: string) => void } = {},
): Promise<RecoverySession> {
  const digest = recoveryToken === undefined ? null : tokenDigest(recoveryToken);
  let outcome = "SESSION_REFUSED";

  if (digest !== null) {
    try {
      const runtime = await administratorRuntime(configuration, options.factories ?? DEFAULT_FACTORIES);
      const checked = await checkSession(runtime.deps.db, { tokenDigest: digest }, runtime.deps.clock);

      if (checked.ok && checked.value.code === "SESSION_VALID" && checked.value.kind === "recovery") {
        outcome = "SESSION_VALID";
      }
    } catch {
      outcome = "SESSION_REFUSED";
    }
  }

  (options.log ?? ((line: string) => console.info(line)))(
    JSON.stringify({ event: "administrator-authentication", entry: "recovery-session-check", outcome, at: new Date().toISOString() }),
  );

  return outcome === "SESSION_VALID" ? "valid" : "refused";
}
