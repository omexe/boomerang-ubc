import type { Metadata } from "next";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const superior = localFont({
  src: [
    { path: "./fonts/SuperiorSerif-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/SuperiorSerif-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/SuperiorSerif-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-superior",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Boomerang — the crowdfund that pays you to go first",
  description:
    "Back a community campaign early. If it hits its goal, your money builds the thing. If it misses, you get your money back plus a bonus.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${superior.variable} ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body>
        {children}
        <div className="grain" aria-hidden />
      </body>
    </html>
  );
}
