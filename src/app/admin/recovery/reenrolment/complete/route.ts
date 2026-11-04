import { unsupportedEntry } from "../../../../../interface/admin/entry-points";
import { recoveryCompleteEntry } from "../../../../../interface/admin/recovery-entry-points";

/**
 * `POST /admin/recovery/reenrolment/complete`: activate it; ten fresh codes shown once (issue #268 §3.4). A thin adapter: the gate, the request checks and the outcome mapping live in
 * `src/interface/admin/recovery-entry-points.ts`. Every other method is exported too, so it passes
 * through the same closed-gate refusal instead of the framework's automatic `405` (issue #260 §12
 * qualification 8).
 */

export const dynamic = "force-dynamic";

export const POST = (request: Request) => recoveryCompleteEntry(request);
export const GET = (request: Request) => unsupportedEntry(request);
export const HEAD = (request: Request) => unsupportedEntry(request);
export const PUT = (request: Request) => unsupportedEntry(request);
export const PATCH = (request: Request) => unsupportedEntry(request);
export const DELETE = (request: Request) => unsupportedEntry(request);
export const OPTIONS = (request: Request) => unsupportedEntry(request);
