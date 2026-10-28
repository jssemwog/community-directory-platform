import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { listPubliclyAvailableListings } from "../../data/public-listing-read";
import { DIRECTORY_COPY, directoryStateOf } from "../../interface/public/directory-view";
import { localDemoPersistence } from "../../interface/public/local-demo-persistence";
import styles from "./directory.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Directory — local demonstration" };

/** `S1` — the directory: approved, publicly available listings only (`OP-1`, no criteria). */
export default async function DirectoryPage() {
  const persistence = localDemoPersistence();

  if (persistence === undefined) {
    notFound();
  }

  const state = directoryStateOf(await listPubliclyAvailableListings(persistence.db));

  return (
    <>
      <h1>Directory</h1>
      {state.kind === "results" && (
        <ul className={styles.list}>
          {state.entries.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <h2 className={styles.entryName}>
                <Link href={`/directory/${entry.id}`}>{entry.name}</Link>
              </h2>
              <p className={styles.entryMeta}>
                {[entry.category, entry.place].filter((part) => part !== undefined && part !== "").join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
      {state.kind === "empty-directory" && (
        <p className={styles.message} role="status">
          {DIRECTORY_COPY.emptyDirectory}
        </p>
      )}
      {state.kind === "error" && (
        <div className={styles.message} role="alert">
          <p>{DIRECTORY_COPY.directoryError}</p>
          <a href="/directory">Try again</a>
        </div>
      )}
    </>
  );
}
