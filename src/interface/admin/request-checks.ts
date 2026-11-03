/**
 * The checks every state-changing administrator request passes **before any storage call**
 * (`ADR-004` P-1 *Cross-site requests*, issue #260 §3.3 and OD-5).
 *
 * - `Origin` must be present and exactly the canonical origin. A missing `Origin` is refused,
 *   because Next.js lets such a request through with only a warning.
 * - `Sec-Fetch-Site`, when present, must be `same-origin`: stricter than `ADR-004`'s minimum,
 *   since another port on `127.0.0.1` is `same-site`.
 * - The body must be `application/x-www-form-urlencoded`, at most 4 KiB, and carry each expected
 *   field exactly once and nothing else.
 *
 * `SameSite=Strict` is defence in depth only. A refusal says nothing about which check failed.
 */

export const MAX_FORM_BYTES = 4096;

export type FormCheck =
  | { readonly ok: true; readonly fields: ReadonlyMap<string, string> }
  | { readonly ok: false };

const REFUSED: FormCheck = { ok: false };

function isFormContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const [type = "", ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
  return type === "application/x-www-form-urlencoded" && parameters.every((p) => p === "" || p === "charset=utf-8");
}

/**
 * The body as text, or `undefined` once it would exceed `MAX_FORM_BYTES`. Never reads past it.
 *
 * A body that fails while being read (an aborted upload, a stream error) or whose cancellation
 * fails is a refusal like any other, never a thrown error, and the reader is always released.
 */
async function boundedText(request: Request): Promise<string | undefined> {
  const declared = request.headers.get("content-length");

  if (declared !== null && !(/^[0-9]+$/.test(declared) && Number(declared) <= MAX_FORM_BYTES)) {
    return undefined;
  }

  if (request.body === null) {
    return "";
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;

  try {
    reader = request.body.getReader();
  } catch {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > MAX_FORM_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }

      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}

/** Whether the request's origin headers satisfy the check; reads no body. */
export function originAllowed(request: Request, origin: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === origin && (fetchSite === null || fetchSite === "same-origin");
}

/** Run every check and return exactly the expected fields, or a refusal. */
export async function checkForm(
  request: Request,
  origin: string,
  expected: readonly string[],
): Promise<FormCheck> {
  if (request.method !== "POST" || !originAllowed(request, origin) || !isFormContentType(request.headers.get("content-type"))) {
    return REFUSED;
  }

  const text = await boundedText(request);

  if (text === undefined) {
    return REFUSED;
  }

  const parameters = new URLSearchParams(text);
  const names = [...parameters.keys()];
  const fields = new Map<string, string>();

  if (names.length !== expected.length) {
    return REFUSED;
  }

  for (const name of expected) {
    const values = parameters.getAll(name);

    if (values.length !== 1) {
      return REFUSED;
    }

    fields.set(name, values[0] ?? "");
  }

  return { ok: true, fields };
}
