import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";

import "./globals.css";
import styles from "./layout.module.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Providers } from "./providers";

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ppv2-tsc-test",
  description:
    "Contribute your randomness to strengthen a trusted setup ceremony.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${mono.variable} ${styles.body}`}>
        <Providers>
          <ErrorBoundary>{children}</ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
