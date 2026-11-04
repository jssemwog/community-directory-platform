import { unsupportedEntry } from "../../../../interface/admin/entry-points";
import { recoverySignOutEntry } from "../../../../interface/admin/recovery-entry-points";

/**
 * `POST /admin/recovery/sign-out`: end the recovery session (issue #268 §3.4, RJ-D5 and RJ-D12). A thin adapter: the gate, the request checks and the outcome mapping live in
 * `src/interface/admin/recovery-entry-points.ts`. Every other method is exported too, so it passes
 * through the same closed-gate refusal instead of the framework's automatic `405` (issue #260 §12
 * qualification 8).
 */

export const dynamic = "force-dynamic";

export const POST = (request: Request) => recoverySignOutEntry(request);
export const GET = (request: Request) => unsupportedEntry(request);
export const HEAD = (request: Request) => unsupportedEntry(request);
export const PUT = (request: Request) => unsupportedEntry(request);
export const PATCH = (request: Request) => unsupportedEntry(request);
export const DELETE = (request: Request) => unsupportedEntry(request);
export const OPTIONS = (request: Request) => unsupportedEntry(request);
