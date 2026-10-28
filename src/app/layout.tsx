/**
 * The root shell. Deliberately NOT gated, and it is the one file where that is
 * the right answer: it wraps the sign-in page too, so a gate here would shut
 * the only way in. `N14` names it, so this is a decision on the record.
 *
 * IT READS ONE THING (0067): how the signed-in person wants the screen to
 * look. Nobody signed in means the defaults, so it is not an oracle for
 * anything — the answer for a stranger and for a person who never changed it
 * are the same two words. It is read HERE rather than in a script in the
 * browser because the alternative is every page arriving in one palette and
 * changing to the other while somebody watches.
 */
import type { Metadata } from "next";
import type { CSSProperties } from 'react'
import { APP_NAME } from '@/lib/app-name'
import { currentUser } from '@/lib/gate'
import { DEFAULT_APPEARANCE, type Appearance } from '@/lib/appearance'
import { Inter, Source_Serif_4, Geist_Mono } from "next/font/google";
import "./globals.css";

/*
 * Three faces, and a reason for each (owner, 2026-09-07: 「字体换个更顺眼的」).
 *
 * `next/font` is part of Next and self-hosts what it downloads at build time,
 * so this adds no dependency and makes no request to anybody's server when a
 * page is opened — which matters here, where the books are on one machine on
 * purpose.
 */
const ui = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  // Figures the same width in every weight, so a column of money lines up
  // whether or not something happens to be bold.
  axes: [],
});

/** Kept for paper layouts; the screen workspace now uses the UI sans. */
const display = Source_Serif_4({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700"],
});

/** Account codes, hashes, and anything a person compares character by character. */
const figures = Geist_Mono({
  variable: "--font-figures",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // A default and a template: a page that sets its own title gets
  // "<page> · Banyan", and one that does not gets the name alone. The
  // company's own name comes from the ledger layout, because with several
  // companies open the tab is how a person tells them apart.
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Books for a handful of companies, on one machine.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const me = await currentUser()
  const look: Appearance = me
    ? { theme: me.theme, mode: me.appearance_mode, liquidTint: me.liquid_tint }
    : DEFAULT_APPEARANCE

  return (
    <html
      lang="en"
      data-theme={look.theme}
      data-mode={look.mode}
      style={{ '--liquid-tint': look.liquidTint } as CSSProperties}
      className={`${ui.variable} ${display.variable} ${figures.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
