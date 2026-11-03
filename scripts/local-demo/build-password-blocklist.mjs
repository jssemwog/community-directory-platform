/**
 * Rebuild the offline password blocklist (`ADR-004` L-2, issue #260 §2 and OD-2).
 *
 * **Offline and explicit.** It fetches nothing: the source files are downloaded by a person, at
 * the pinned SecLists commit recorded in `src/domain/administrator-auth/PASSWORD-BLOCKLIST.md`,
 * and passed as arguments. It runs only when someone decides to refresh the list.
 *
 *     node scripts/local-demo/build-password-blocklist.mjs <output> <source> [<source> ...]
 *
 * Each entry is NFC-normalized and lower-cased, so matching is case-insensitive (OD-2), and only
 * entries of 15 to 128 code points are kept: shorter ones can never match a password the policy
 * accepts. The output is deduplicated, sorted by code unit and newline-terminated, so a rebuild
 * from the same sources is byte-identical. The SHA-256 of every input and of the output is
 * printed for the provenance note.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const MIN_CODE_POINTS = 15;
export const MAX_CODE_POINTS = 128;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The blocklist text for the given source texts. Pure, so a test can reproduce it. */
export function blocklistOf(sourceTexts) {
  const entries = new Set();

  for (const text of sourceTexts) {
    for (const line of text.split("\n")) {
      const entry = line.replace(/\r$/, "").normalize("NFC").toLowerCase();
      const length = [...entry].length;

      if (length >= MIN_CODE_POINTS && length <= MAX_CODE_POINTS) {
        entries.add(entry);
      }
    }
  }

  return [...entries].sort().map((entry) => `${entry}\n`).join("");
}

function main(argv) {
  const [output, ...sources] = argv;

  if (output === undefined || sources.length === 0) {
    process.stderr.write("Usage: build-password-blocklist.mjs <output> <source> [<source> ...]\n");
    return 1;
  }

  const buffers = sources.map((source) => readFileSync(source));
  const text = blocklistOf(buffers.map((buffer) => buffer.toString("utf8")));

  writeFileSync(output, text, "utf8");

  for (const [index, source] of sources.entries()) {
    process.stdout.write(`source ${basename(source)} sha256 ${sha256(buffers[index])}\n`);
  }

  process.stdout.write(`output ${basename(output)} entries ${text === "" ? 0 : text.split("\n").length - 1} sha256 ${sha256(Buffer.from(text, "utf8"))}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
