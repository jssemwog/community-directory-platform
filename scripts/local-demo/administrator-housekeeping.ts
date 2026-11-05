/**
 * **Housekeeping** of expired authentication rows for the local demo (Unit HK Scope Gate,
 * revision 4, issue #274), run through `npm run demo:local:admin -- housekeeping`.
 *
 * Like the other operator commands it runs explicitly, **with the demo stopped**, under the
 * launcher lock (RV-D1, HK-D4). It is never imported by the application server and never runs on
 * the request path. It removes only expired pending challenges, expired consumed-challenge records
 * and sessions dead by time (HK-D1); every abuse-control row is left alone (HK-D2). It takes no
 * username (HK-D5), asks for no confirmation beyond the launch refusals (HK-D6), and reads no key.
 *
 * The refusal stages are §3.3's: the launcher wrapper refuses a non-interactive terminal or
 * production mode before startup (R1) and writes its outcome line with `housekeepingOutcomeLine`;
 * after startup, `runHousekeeping` checks both again and the loopback database (R3), and on a
 * refusal sends **no housekeeping statement**. Every outcome is one four-field line (`event`,
 * `entry`, `outcome`, `at`; RV-D8, HK-D7). Only acknowledged deletion counts are printed as
 * numbers, and nothing here says "nothing was changed" once housekeeping has started.
 */

import type { Kysely } from "kysely";

import {
  removeExpiredAuthenticationRows,
  type Clock,
  type HousekeepingReport,
  type HousekeepingResult,
} from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { isLoopbackDatabaseUrl, launchRefusalOf, type ProvisioningTerminal } from "./administrator-provisioning";

export const HOUSEKEEPING_SUBCOMMAND = "housekeeping";
const ENTRY = "housekeeping";

export const HOUSEKEEPING_NOTICE =
  "Removing expired sign-in challenges, expired replay records and ended sessions; nothing else.";
export const HOUSEKEEPING_INCOMPLETE_MESSAGE =
  "Housekeeping did not complete. Rows already removed stay removed; any result shown as unknown may or may not have been applied. Run it again.";
export const NOT_LOCAL_DATABASE_MESSAGE = "This command acts only on the local demo's loopback database; nothing was changed.";

/** The four-field outcome line (RV-D8), shared with the launcher wrapper's R1 refusal. */
export function housekeepingOutcomeLine(outcome: string, at: number): string {
  return JSON.stringify({ event: "administrator-authentication", entry: ENTRY, outcome, at: new Date(at).toISOString() });
}

export interface HousekeepingDependencies {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly clock: Clock;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The launcher's own loopback cluster; checked again here (R3). */
  readonly databaseUrl: string;
}

export type HousekeepingRunResult = { readonly ok: boolean; readonly outcome: string };

/** One report line. Only `deleted` prints a number (§3.3). */
export function describeResult(name: string, result: HousekeepingResult): string {
  switch (result.status) {
    case "deleted":
      return `${name}: deleted ${result.count}`;
    case "rolled-back":
      return `${name}: rolled back, nothing deleted`;
    case "unknown":
      return `${name}: unknown`;
    case "not-run":
      return `${name}: not run`;
  }
}

function reportLines(report: HousekeepingReport): string[] {
  return [
    describeResult("pending challenges", report.pendingChallenges),
    describeResult("consumed records", report.consumedChallenges),
    describeResult("sessions", report.sessions),
  ];
}

/** R3, then the run. Sends no housekeeping statement unless every R3 check passed. */
export async function runHousekeeping(terminal: ProvisioningTerminal, deps: HousekeepingDependencies): Promise<HousekeepingRunResult> {
  const finish = (ok: boolean, outcome: string): HousekeepingRunResult => {
    terminal.say(housekeepingOutcomeLine(outcome, deps.clock()));
    return { ok, outcome };
  };

  const refusal = launchRefusalOf(terminal, deps.environment);

  if (refusal !== undefined) {
    terminal.say(refusal.message);
    return finish(false, refusal.reason);
  }

  if (!isLoopbackDatabaseUrl(deps.databaseUrl)) {
    terminal.say(NOT_LOCAL_DATABASE_MESSAGE);
    return finish(false, "NOT_LOCAL_DATABASE");
  }

  terminal.say(HOUSEKEEPING_NOTICE);
  const report = await removeExpiredAuthenticationRows(deps.db, deps.clock);

  for (const line of reportLines(report)) {
    terminal.say(line);
  }

  if (!report.completed) {
    terminal.say(HOUSEKEEPING_INCOMPLETE_MESSAGE);
    return finish(false, "HOUSEKEEPING_INCOMPLETE");
  }

  const results = [report.pendingChallenges, report.consumedChallenges, report.sessions];
  const total = results.reduce((sum, result) => sum + (result.status === "deleted" ? result.count : 0), 0);
  terminal.say(`Removed ${total} expired rows.`);
  return finish(true, "HOUSEKEEPING_COMPLETED");
}
