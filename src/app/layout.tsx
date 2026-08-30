import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Community Directory Platform",
  description: "Application scaffold. No directory content exists yet.",
};

/**
 * Root layout — the single deployable application's outermost shell
 * (ADR-001: modular monolith).
 *
 * Holds no product content and no navigation between the public and
 * administrative surfaces. The surfaces are separate trust contexts
 * (docs/07, TB-3); linking them from a shared shell is how that separation
 * quietly becomes cosmetic.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
