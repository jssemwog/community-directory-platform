"use client";

import styles from "./directory.module.css";

/**
 * The fallback for an unexpected failure under `/directory`. It renders fixed text only: the
 * error object is never shown, so no diagnostic, identifier or record content reaches the page
 * (`docs/10` *Error states*, `NFR-SEC-02`).
 */
export default function DirectoryError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className={styles.message} role="alert">
      <p>Something went wrong. Please try again.</p>
      <button type="button" className={styles.retry} onClick={reset}>
        Try again
      </button>
    </div>
  );
}
