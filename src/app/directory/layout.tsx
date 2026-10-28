import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { localDemoPersistence } from "../../interface/public/local-demo-persistence";
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
 */
export default function DirectoryLayout({ children }: { children: ReactNode }) {
  if (localDemoPersistence() === undefined) {
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
