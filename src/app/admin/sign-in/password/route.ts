import { passwordEntry, unsupportedEntry } from "../../../../interface/admin/entry-points";

/**
 * `POST /admin/sign-in/password`: the password step (issue #260 §3.2). A thin adapter: the gate, the request checks
 * and the outcome mapping live in `src/interface/admin/entry-points.ts`. Every other method is
 * exported too, so it passes through the same closed-gate refusal instead of the framework's
 * automatic `405` (§12 qualification 8).
 */

export const dynamic = "force-dynamic";

export const POST = (request: Request) => passwordEntry(request);
export const GET = (request: Request) => unsupportedEntry(request);
export const HEAD = (request: Request) => unsupportedEntry(request);
export const PUT = (request: Request) => unsupportedEntry(request);
export const PATCH = (request: Request) => unsupportedEntry(request);
export const DELETE = (request: Request) => unsupportedEntry(request);
export const OPTIONS = (request: Request) => unsupportedEntry(request);
