import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { findPubliclyAvailableListing } from "../../../data/public-listing-read";
import { DIRECTORY_COPY, listingDetailStateOf } from "../../../interface/public/directory-view";
import { localDemoPersistence } from "../../../interface/public/local-demo-persistence";
import styles from "../directory.module.css";

export const dynamic = "force-dynamic";

/** Fixed, so the title cannot differ between a present and an unavailable listing. */
export const metadata: Metadata = { title: "Listing — local demonstration" };

/**
 * `S2` — one listing in the public projection (`OP-2`).
 *
 * Every non-public or malformed identity renders the same fixed `NotAvailable` content through
 * the same path (`BI-4`, `UP-4`). It is rendered inline rather than through `notFound()`: inside
 * the streamed loading boundary, `notFound()` switches to client rendering, which takes a
 * different path and, in development, embeds a server stack trace in the page. This is
 * equivalence of the rendered response only; timing is not addressed and `BI-4` stays pending
 * (#246). Because the response is streamed, its HTTP status is 200 in every case.
 */
export default async function ListingPage({ params }: { params: Promise<{ listingId: string }> }) {
  const persistence = localDemoPersistence();

  if (persistence === undefined) {
    notFound();
  }

  const { listingId } = await params;
  const state = listingDetailStateOf(await findPubliclyAvailableListing(persistence.db, listingId));

  return (
    <>
      <Link className={styles.backLink} href="/directory">
        ← Back to the directory
      </Link>
      {state.kind === "present" && (
        <article>
          <h1>{state.listing.name}</h1>
          <p className={styles.description}>{state.listing.description}</p>
          <dl className={styles.fields}>
            {state.listing.fields.map((field) => (
              <div key={field.label} className={styles.field}>
                <dt>{field.label}</dt>
                <dd>
                  {field.href === undefined ? (
                    field.value
                  ) : (
                    <a href={field.href} rel="noopener noreferrer nofollow">
                      {field.value}
                    </a>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </article>
      )}
      {state.kind === "not-available" && <NotAvailable />}
      {state.kind === "error" && (
        <div className={styles.message} role="alert">
          <p>{DIRECTORY_COPY.listingError}</p>
          <a href={`/directory/${encodeURIComponent(listingId)}`}>Try again</a>
        </div>
      )}
    </>
  );
}

/**
 * The one not-available response. It takes no input, so it cannot vary by case. The wording is
 * proposed and is security-relevant text (`docs/10` `DU-7`).
 */
function NotAvailable() {
  return (
    <>
      <h1>Not available</h1>
      <p className={styles.message}>{DIRECTORY_COPY.notAvailable}</p>
    </>
  );
}
