import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { publicReadSource } from "../../interface/public/public-read-persistence";
import styles from "./directory.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Local demonstration of the public directory. Every listing is fictional.",
};

/**
 * The public directory's shell for the **local demonstration** (issue #248).
 *
 * The whole `/directory` tree exists only when the local demo is configured
 * (`local-demo-persistence.ts`); otherwise it answers 404 as if absent. It links to nothing
 * outside the public surface — there is no route into the administrative zone (`docs/10`).
 *
 * **`E3-local` (issue #246, Scope Gate revision 4 §3.2).** This layout sits outside every loading
 * boundary, so it is where the pre-stream verification runs. It returns 404 when its own checkout
 * fails or when it sees the sticky refusal, **before** it renders anything; no render order with
 * the page is assumed. Under the demo it does no checkout and behaves exactly as before. `S1`
 * (`/directory`) never reaches here under `E3-local`: `src/proxy.ts` answers it with 404.
 */
export default async function DirectoryLayout({ children }: { children: ReactNode }) {
  const source = publicReadSource();

  if (source === undefined) {
    notFound();
  }

  if (source.kind === "e3-local" && (await source.e3.precheck()) === "refused") {
    notFound();
  }

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        Skip to main content
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <nav aria-label="Directory">
            <Link className={styles.siteLink} href="/directory">
              Community Directory
            </Link>
          </nav>
          <p className={styles.demoNote}>Local demonstration — every listing is fictional.</p>
        </div>
      </header>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
