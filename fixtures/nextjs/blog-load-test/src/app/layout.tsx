import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Load test blog fixture",
  description: "Next.js fixture app used by loadtest/nextjs/nextjs-load-test.ts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
