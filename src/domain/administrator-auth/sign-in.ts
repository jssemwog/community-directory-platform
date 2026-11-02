/**
 * The server-side sign-in steps (`ADR-004`, `ADR-028`; issue #258).
 *
 * **No transport, no cookie and no route call these.** They compose the primitives and the `C9`
 * operations into the password step and the TOTP step, and in this unit only tests exercise
 * them; the journey slice wires them to a local-only surface later (issue #254).
 *
 * **The password step holds a failed verification's hash slot until its failure accounting has
 * committed** (`ADR-028` D-17). That ordering is what bounds the overshoot: every request that
 * acquires a slot re-checks the throttle with a fresh clock reading, and so sees every failure
 * whose slot it inherited. A success releases its slot before issuing the challenge, because a
 * success adds no failure.
 *
 * The outcomes carry internal reasons for tests and logs. A caller must still give every refusal
 * and failure **one generic response** (`ADR-004` P-5); nothing here is shown to a user.
 */

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";

import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import {
  completeTotpChallenge,
  findCredential,
  issuePasswordChallenge,
  readPasswordAdmission,
  recordPasswordFailure,
  type AuthenticationStorageFailure,
  type Clock,
  type SecondFactorOutcome,
  type StoredActiveFactor,
  type TotpVerdict,
} from "../../data/administrator-authentication";
import type { HashLimiter } from "./hash-limiter";
import { keyedDigest } from "./keyed-digest";
import { openTotpSecret } from "./secret-box";
import { generateToken, tokenDigest } from "./token";
import { matchTotpStep } from "./totp";
import { isProvisionableUsername, normalizeSubmittedUsername } from "./username";

export interface PasswordVerifier {
  verify(password: string, storedHash: string): Promise<boolean>;
}

export interface SignInDependencies {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly clock: Clock;
  /** One limiter per process (`ADR-004` P-7). */
  readonly limiter: HashLimiter;
  readonly passwords: PasswordVerifier;
  /** A hash nobody can match, for the dummy verification of an unknown account. */
  readonly dummyPasswordHash: string;
  /** The D-7 HMAC key: server-held, never in the database. */
  readonly throttleKey: Buffer;
  /** Available TOTP encryption keys by version (`ADR-004` P-3). */
  readonly totpKeys: ReadonlyMap<number, Buffer>;
}

export type PasswordStepOutcome =
  | { readonly code: "CHALLENGE_ISSUED"; readonly challengeToken: string; readonly expiresAt: number }
  /** Refused before any hashing: the source or the username is throttled. Uncounted. */
  | { readonly code: "THROTTLED" }
  /** The limiter's bound was reached: the generic "try again later". Uncounted. */
  | { readonly code: "OVERLOADED" }
  /** A wrong password or an unknown account, counted. */
  | { readonly code: "FAILED"; readonly consecutiveFailures: number }
  /** A correct password that is no longer current, or an account that cannot sign in (D-15). */
  | { readonly code: "REFUSED"; readonly reason: string }
  | { readonly code: "STORAGE_FAILURE"; readonly failure: AuthenticationStorageFailure };

export async function passwordStep(
  deps: SignInDependencies,
  request: { readonly username: string; readonly password: string; readonly sourceAddress: string },
): Promise<PasswordStepOutcome> {
  const username = normalizeSubmittedUsername(request.username);
  const usernameDigest = keyedDigest(deps.throttleKey, "password-username", username);
  const sourceDigest = keyedDigest(deps.throttleKey, "source-address", request.sourceAddress);
  const digests = { sourceDigest, usernameDigest };

  const admission = await readPasswordAdmission(deps.db, digests, deps.clock());

  if (!admission.ok) {
    return { code: "STORAGE_FAILURE", failure: admission.failure };
  }

  if (admission.value.sourceLimited || admission.value.waitActive) {
    return { code: "THROTTLED" };
  }

  const slot = await deps.limiter.acquire();

  if (slot === "overloaded") {
    return { code: "OVERLOADED" };
  }

  try {
    const recheck = await readPasswordAdmission(deps.db, digests, deps.clock());

    if (!recheck.ok) {
      return { code: "STORAGE_FAILURE", failure: recheck.failure };
    }

    if (recheck.value.sourceLimited || recheck.value.waitActive) {
      return { code: "THROTTLED" };
    }

    const credential = isProvisionableUsername(username)
      ? await findCredential(deps.db, username)
      : ({ ok: true, value: undefined } as const);

    if (!credential.ok) {
      return { code: "STORAGE_FAILURE", failure: credential.failure };
    }

    const stored = credential.value;
    const verified = await deps.passwords.verify(
      request.password,
      stored?.passwordHash ?? deps.dummyPasswordHash,
    );

    if (stored === undefined || !verified) {
      // The slot is still held, and only `finally` releases it, after this has committed.
      const counted = await recordPasswordFailure(
        deps.db,
        { administratorId: stored?.administratorId, usernameDigest, sourceDigest },
        deps.clock,
      );

      return counted.ok
        ? { code: "FAILED", consecutiveFailures: counted.value.consecutiveFailures }
        : { code: "STORAGE_FAILURE", failure: counted.failure };
    }

    slot.release();

    const challenge = generateToken();
    const issued = await issuePasswordChallenge(
      deps.db,
      {
        administratorId: stored.administratorId,
        verifiedPasswordHash: stored.passwordHash,
        usernameDigest,
        challengeDigest: challenge.digest,
      },
      deps.clock,
    );

    if (!issued.ok) {
      return { code: "STORAGE_FAILURE", failure: issued.failure };
    }

    return issued.value.code === "CHALLENGE_ISSUED"
      ? { code: "CHALLENGE_ISSUED", challengeToken: challenge.token, expiresAt: issued.value.expiresAt }
      : { code: "REFUSED", reason: issued.value.reason };
  } finally {
    slot.release();
  }
}

export type TotpStepOutcome =
  | { readonly code: "SESSION_ISSUED"; readonly sessionToken: string; readonly absoluteExpiresAt: number }
  | Exclude<SecondFactorOutcome, { readonly code: "SESSION_ISSUED" }>
  | { readonly code: "STORAGE_FAILURE"; readonly failure: AuthenticationStorageFailure };

/** The TOTP verifier handed to the locked transaction (issue #258 S-6). */
export function totpVerifierFor(
  totpKeys: ReadonlyMap<number, Buffer>,
  code: string,
): (factor: StoredActiveFactor, now: number) => TotpVerdict {
  return (factor, now) => {
    const secret = openTotpSecret(totpKeys, factor.administratorId, factor);

    if (secret === null) {
      return { kind: "unreadable" };
    }

    const step = matchTotpStep(secret, code, now);
    return step === null ? { kind: "mismatch" } : { kind: "match", step };
  };
}

/** The TOTP step. It takes no hash slot: its throttle is enforced under the lock instead. */
export async function totpStep(
  deps: SignInDependencies,
  request: { readonly challengeToken: string; readonly code: string; readonly sourceAddress: string },
): Promise<TotpStepOutcome> {
  const challengeDigest = tokenDigest(request.challengeToken);

  if (challengeDigest === null) {
    return { code: "REFUSED", reason: "UNKNOWN_CHALLENGE" };
  }

  const session = generateToken();
  const completed = await completeTotpChallenge(
    deps.db,
    {
      challengeDigest,
      sourceDigest: keyedDigest(deps.throttleKey, "source-address", request.sourceAddress),
      totpSubjectDigestFor: (administratorId) =>
        keyedDigest(deps.throttleKey, "totp-administrator", administratorId),
      verify: totpVerifierFor(deps.totpKeys, request.code),
      sessionTokenDigest: session.digest,
      sessionId: randomUUID(),
    },
    deps.clock,
  );

  if (!completed.ok) {
    return { code: "STORAGE_FAILURE", failure: completed.failure };
  }

  const outcome = completed.value;

  return outcome.code === "SESSION_ISSUED"
    ? { code: "SESSION_ISSUED", sessionToken: session.token, absoluteExpiresAt: outcome.absoluteExpiresAt }
    : outcome;
}
