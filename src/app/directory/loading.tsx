import { DIRECTORY_COPY } from "../../interface/public/directory-view";

/** `S1` loading: announced, and unlike the empty or error states (`docs/10` *Loading states*). */
export default function DirectoryLoading() {
  return (
    <p role="status" aria-live="polite">
      {DIRECTORY_COPY.loadingDirectory}
    </p>
  );
}
