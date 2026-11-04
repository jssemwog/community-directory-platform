/**
 * The server-side recovery steps (`ADR-004` P-1, P-4; `ADR-029`; issue #266).
 *
 * **No transport, no cookie and no route call these.** They compose the recovery-code primitive
 * and the `C9` recovery operations, and in this unit only tests exercise them. The recovery
 * journey (a later, separately authorized unit) wires them to a local-only surface.
 *
 * - `recoveryStep`: password, then a recovery code, yields the **restricted recovery session**.
 *   It discards the TOTP factor (`ADR-029` RA-1) and takes no hash slot.
 * - `reenrolmentStart`: inside a recovery session, a new pending factor whose origin is that
 *   session (RA-3, RA-4).
 * - `reenrolmentCompletion`: inside the same session, activates that factor, ends the session and
 *   issues ten fresh codes (FA-R).
 * - `regeneration`: inside a recovery session, replaces the code set.
 *
 * Each returns plaintext (the new TOTP secret, or the codes) **to its caller only**, for one
 * display. Nothing here logs. The outcomes carry internal reasons for tests and logs; a caller
 * must still give every refusal and failure one generic response (`ADR-004` P-5).
 *
 * **The `recovery_code` counter's subject** is the D-7 keyed digest of the administrator id under
 * its own `recovery-code-administrator` purpose (issue #266 amendment 2). The same administrator's
 * `totp` row uses `totp-administrator`, so the separate purposes prevent linking the two rows by
 * equality of their subject digests alone.
 */

import { randomUUID } from "node:crypto";

import {
  completeRecoveryChallenge,
  completeRecoveryReenrolment,
  regenerateRecoveryCodes,
  startRecoveryReenrolment,
  type AuthenticationStorageFailure,
  type RecoveryChallengeOutcome,
  type RecoveryCodeRegenerationOutcome,
  type RecoveryReenrolmentCompletionOutcome,
  type RecoveryReenrolmentStartOutcome,
} from "../../data/administrator-authentication";
import { keyedDigest } from "./keyed-digest";
import { generateRecoveryCodes, recoveryCodeDigest, type RandomSource } from "./recovery-code";
import { sealTotpSecret, TOTP_KEY_BYTES } from "./secret-box";
import { totpVerifierFor, type SignInDependencies } from "./sign-in";
import { generateToken, tokenDigest } from "./token";
import { generateTotpSecret } from "./totp";

/** What the recovery steps need: the sign-in dependencies, and optionally a random source for codes. */
export interface RecoveryDependencies extends Pick<SignInDependencies, "db" | "clock" | "throttleKey" | "totpKeys"> {
  /**
   * The key version a new TOTP secret is sealed under. It is chosen by configuration and is never
   * inferred from the keyring (for example as its highest version). This decides no key-rotation
   * policy (`ADR-004` P-6).
   */
  readonly currentTotpKeyVersion: number;
  readonly randomForCodes?: RandomSource;
}

type StorageFailureOutcome = { readonly code: "STORAGE_FAILURE"; readonly failure: AuthenticationStorageFailure };

const RECOVERY_SESSION_INVALID = { code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" } as const;

/** Returned when the configured current TOTP key version names no usable key. Nothing is written. */
export type TotpKeyUnavailable = { readonly code: "TOTP_KEY_UNAVAILABLE" };

const TOTP_KEY_UNAVAILABLE: TotpKeyUnavailable = { code: "TOTP_KEY_UNAVAILABLE" };

/**
 * Exactly the configured current key, or `undefined` when the keyring holds no usable key under
 * that version (none at all, the wrong length, or a version `sealTotpSecret` would reject).
 */
function currentKey(deps: RecoveryDependencies): { readonly version: number; readonly key: Buffer } | undefined {
  const version = deps.currentTotpKeyVersion;
  const key = deps.totpKeys.get(version);

  if (!Number.isSafeInteger(version) || version <= 0 || key === undefined || key.length !== TOTP_KEY_BYTES) {
    return undefined;
  }

  return { version, key };
}

export type RecoveryStepOutcome =
  | { readonly code: "RECOVERY_SESSION_ISSUED"; readonly recoverySessionToken: string; readonly absoluteExpiresAt: number }
  | Exclude<RecoveryChallengeOutcome, { readonly code: "RECOVERY_SESSION_ISSUED" }>
  | StorageFailureOutcome;

/** Password (already verified into a challenge), then a recovery code. Takes no hash slot. */
export async function recoveryStep(
  deps: RecoveryDependencies,
  request: { readonly challengeToken: string; readonly code: string; readonly sourceAddress: string },
): Promise<RecoveryStepOutcome> {
  const challengeDigest = tokenDigest(request.challengeToken);

  if (challengeDigest === null) {
    return { code: "REFUSED", reason: "UNKNOWN_CHALLENGE" };
  }

  const session = generateToken();
  const completed = await completeRecoveryChallenge(
    deps.db,
    {
      challengeDigest,
      sourceDigest: keyedDigest(deps.throttleKey, "source-address", request.sourceAddress),
      recoveryCodeSubjectDigestFor: (administratorId) =>
        keyedDigest(deps.throttleKey, "recovery-code-administrator", administratorId),
      // Parsed only when the locked transaction reaches verification (issue #266 RD-4).
      codeDigest: () => recoveryCodeDigest(request.code),
      sessionTokenDigest: session.digest,
      sessionId: randomUUID(),
    },
    deps.clock,
  );

  if (!completed.ok) {
    return { code: "STORAGE_FAILURE", failure: completed.failure };
  }

  const outcome = completed.value;

  return outcome.code === "RECOVERY_SESSION_ISSUED"
    ? { code: "RECOVERY_SESSION_ISSUED", recoverySessionToken: session.token, absoluteExpiresAt: outcome.absoluteExpiresAt }
    : outcome;
}

export type ReenrolmentStartStepOutcome =
  | { readonly code: "REENROLMENT_STARTED"; readonly factorId: string; readonly secret: Buffer }
  | Exclude<RecoveryReenrolmentStartOutcome, { readonly code: "REENROLMENT_STARTED" }>
  | TotpKeyUnavailable
  | StorageFailureOutcome;

/**
 * Inside a recovery session: a new pending factor, sealed under the configured current key, origin =
 * that session. Without a usable current key it returns `TOTP_KEY_UNAVAILABLE` before drawing a
 * secret or reaching storage.
 */
export async function reenrolmentStart(
  deps: RecoveryDependencies,
  request: { readonly recoverySessionToken: string },
): Promise<ReenrolmentStartStepOutcome> {
  const recoveryTokenDigest = tokenDigest(request.recoverySessionToken);

  if (recoveryTokenDigest === null) {
    return RECOVERY_SESSION_INVALID;
  }

  const current = currentKey(deps);

  if (current === undefined) {
    return TOTP_KEY_UNAVAILABLE;
  }

  const { version, key } = current;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const started = await startRecoveryReenrolment(
    deps.db,
    { recoveryTokenDigest, factorId, seal: (administratorId) => sealTotpSecret(key, version, administratorId, secret) },
    deps.clock,
  );

  if (!started.ok) {
    return { code: "STORAGE_FAILURE", failure: started.failure };
  }

  return started.value.code === "REENROLMENT_STARTED"
    ? { code: "REENROLMENT_STARTED", factorId, secret }
    : started.value;
}

export type ReenrolmentCompletionStepOutcome =
  | { readonly code: "REENROLMENT_COMPLETED"; readonly recoveryCodes: readonly string[] }
  | Exclude<RecoveryReenrolmentCompletionOutcome, { readonly code: "REENROLMENT_COMPLETED" }>
  | StorageFailureOutcome;

/** Inside the same recovery session: confirm the new factor with a current code; ten fresh codes. */
export async function reenrolmentCompletion(
  deps: RecoveryDependencies,
  request: { readonly recoverySessionToken: string; readonly factorId: string; readonly code: string },
): Promise<ReenrolmentCompletionStepOutcome> {
  const recoveryTokenDigest = tokenDigest(request.recoverySessionToken);

  if (recoveryTokenDigest === null) {
    return RECOVERY_SESSION_INVALID;
  }

  const codes = generateRecoveryCodes(deps.randomForCodes);
  const completed = await completeRecoveryReenrolment(
    deps.db,
    {
      recoveryTokenDigest,
      factorId: request.factorId,
      verify: totpVerifierFor(deps.totpKeys, request.code),
      codeDigests: codes.map((code) => code.digest),
    },
    deps.clock,
  );

  if (!completed.ok) {
    return { code: "STORAGE_FAILURE", failure: completed.failure };
  }

  return completed.value.code === "REENROLMENT_COMPLETED"
    ? { code: "REENROLMENT_COMPLETED", recoveryCodes: codes.map((code) => code.code) }
    : completed.value;
}

export type RegenerationStepOutcome =
  | { readonly code: "RECOVERY_CODES_REGENERATED"; readonly recoveryCodes: readonly string[] }
  | Exclude<RecoveryCodeRegenerationOutcome, { readonly code: "RECOVERY_CODES_REGENERATED" }>
  | StorageFailureOutcome;

/** Inside a recovery session: replace the whole code set. The counter is not cleared (RA-9). */
export async function regeneration(
  deps: RecoveryDependencies,
  request: { readonly recoverySessionToken: string },
): Promise<RegenerationStepOutcome> {
  const recoveryTokenDigest = tokenDigest(request.recoverySessionToken);

  if (recoveryTokenDigest === null) {
    return RECOVERY_SESSION_INVALID;
  }

  const codes = generateRecoveryCodes(deps.randomForCodes);
  const regenerated = await regenerateRecoveryCodes(
    deps.db,
    { recoveryTokenDigest, codeDigests: codes.map((code) => code.digest) },
    deps.clock,
  );

  if (!regenerated.ok) {
    return { code: "STORAGE_FAILURE", failure: regenerated.failure };
  }

  return regenerated.value.code === "RECOVERY_CODES_REGENERATED"
    ? { code: "RECOVERY_CODES_REGENERATED", recoveryCodes: codes.map((code) => code.code) }
    : regenerated.value;
}
