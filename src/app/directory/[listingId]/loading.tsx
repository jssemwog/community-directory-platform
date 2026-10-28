import { DIRECTORY_COPY } from "../../../interface/public/directory-view";

/** `S2` loading: announced, and unlike the not-available or error states. */
export default function ListingLoading() {
  return (
    <p role="status" aria-live="polite">
      {DIRECTORY_COPY.loadingListing}
    </p>
  );
}
