/**
 * Local HTTPS for the administrator journey (`ADR-004` L-3, issue #260 OD-3).
 *
 * The L-3 probe found that WebKit stores a `__Host-` cookie over `http://127.0.0.1` but never sends
 * it back, so the journey runs on local HTTPS and **the cookie keeps every production attribute**.
 * The certificate is self-signed for `IP:127.0.0.1` only, valid for 30 days, and made by the
 * OpenSSL already on the machine (Git for Windows ships one) into a git-ignored directory.
 *
 * **No certificate authority is installed and no trust store is changed.** A person using the
 * journey by hand sees the browser's certificate warning and must accept it; the automated
 * browser harness alone sets `ignoreHTTPSErrors` (§12 qualification 5). `next dev
 * --experimental-https` is always given both the key and the certificate, because without them
 * Next.js downloads `mkcert` and installs its root certificate machine-wide.
 */

import { spawn } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CERTIFICATE_HOST = "127.0.0.1";
export const CERTIFICATE_DAYS = 30;
/** A certificate this close to expiry is replaced rather than reused. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

export interface LocalCertificate {
  readonly keyPath: string;
  readonly certPath: string;
}

const CONFIG = [
  "[req]",
  "prompt = no",
  "distinguished_name = dn",
  "x509_extensions = ext",
  "[dn]",
  `CN = ${CERTIFICATE_HOST}`,
  "[ext]",
  "basicConstraints = critical, CA:FALSE",
  "keyUsage = critical, digitalSignature, keyEncipherment",
  "extendedKeyUsage = serverAuth",
  `subjectAltName = IP:${CERTIFICATE_HOST}`,
  "",
].join("\n");

/** Where to look for OpenSSL: `PATH` first, then Git for Windows' bundled copies. */
export function opensslCandidates(environment: Readonly<Record<string, string | undefined>>): string[] {
  const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
  return [
    "openssl",
    join(programFiles, "Git", "mingw64", "bin", "openssl.exe"),
    join(programFiles, "Git", "usr", "bin", "openssl.exe"),
  ];
}

/** Whether the pair is usable: the certificate names the IP, is in date and matches the key. */
export function certificateUsable(certificate: LocalCertificate, now: number): boolean {
  try {
    const cert = new X509Certificate(readFileSync(certificate.certPath));
    const key = createPrivateKey(readFileSync(certificate.keyPath));

    return (
      cert.checkIP(CERTIFICATE_HOST) !== undefined &&
      Date.parse(cert.validFrom) <= now &&
      Date.parse(cert.validTo) - RENEW_BEFORE_MS > now &&
      cert.checkPrivateKey(key)
    );
  } catch {
    return false;
  }
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });

    child.once("error", () => resolve(-1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** The `next dev` arguments that serve this certificate, and never let Next.js make its own. */
export function httpsArgumentsFor(certificate: LocalCertificate): string[] {
  return [
    "--experimental-https",
    "--experimental-https-key",
    certificate.keyPath,
    "--experimental-https-cert",
    certificate.certPath,
  ];
}

/**
 * A usable certificate in `directory`, reusing the existing one when it is still usable and
 * otherwise generating a new one. Throws if no OpenSSL produced a usable pair.
 */
export async function ensureLocalCertificate(
  directory: string,
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly now?: () => number;
    readonly runCommand?: (command: string, args: readonly string[]) => Promise<number>;
  } = {},
): Promise<LocalCertificate> {
  const now = options.now ?? Date.now;
  const certificate: LocalCertificate = { keyPath: join(directory, "localhost-key.pem"), certPath: join(directory, "localhost.pem") };

  if (existsSync(certificate.keyPath) && existsSync(certificate.certPath) && certificateUsable(certificate, now())) {
    return certificate;
  }

  mkdirSync(directory, { recursive: true });

  const configPath = join(directory, "openssl.cnf");
  writeFileSync(configPath, CONFIG, "utf8");

  try {
    for (const openssl of opensslCandidates(options.environment ?? process.env)) {
      const code = await (options.runCommand ?? run)(openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        String(CERTIFICATE_DAYS),
        "-keyout",
        certificate.keyPath,
        "-out",
        certificate.certPath,
        "-config",
        configPath,
      ]);

      if (code === 0 && certificateUsable(certificate, now())) {
        return certificate;
      }
    }
  } finally {
    rmSync(configPath, { force: true });
  }

  throw new Error("A local HTTPS certificate could not be made: no usable OpenSSL was found. Nothing else was changed.");
}
