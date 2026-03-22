import type { Metadata } from "next";
import "./globals.css";

/** Avoid static page data collection hanging on any subtree that touches request-only behavior. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mineral Intelligence AI",
  description: "Find mineral ownership opportunities near drilling activity",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
