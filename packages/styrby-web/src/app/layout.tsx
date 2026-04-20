import type { Metadata, Viewport } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { CookieConsent } from '@/components/cookie-consent';
import { SWRegister } from '@/components/sw-register';
import { getEnvOr } from '@/lib/env';

/**
 * WHY Outfit: geometric sans-serif with tight tracking and optical weight that
 * reads as premium at large display sizes. Space Grotesk was too neutral for
 * the luxury-developer positioning; Outfit has stronger personality at 8xl+.
 */
/**
 * WHY display: 'swap': Next.js google fonts default to `display: optional`
 * which causes invisible text during loading (FOIT) until the font is ready.
 * `swap` immediately renders text in the fallback system font and swaps to
 * Outfit once loaded — improving FCP and eliminating invisible-text penalties
 * in Lighthouse's "Ensure text remains visible during webfont load" audit.
 */
const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

/**
 * WHY display: 'swap' on mono font: Same reasoning as Outfit above.
 * JetBrains Mono is used in code mockups and terminal blocks — swap ensures
 * those sections render with a monospace fallback instantly rather than
 * appearing blank until the webfont arrives.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Styrby - Your AI Agents, In Your Pocket',
    template: '%s | Styrby',
  },
  description:
    'Monitor costs, approve permissions, and control Claude Code, Codex, Gemini CLI, OpenCode, and Aider from one premium dashboard.',
  metadataBase: new URL(
    getEnvOr('NEXT_PUBLIC_APP_URL', 'https://styrbyapp.com')
  ),
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: '/manifest.json',
  openGraph: {
    title: 'Styrby - Your AI Agents, In Your Pocket',
    description:
      'Monitor costs, approve permissions, and control Claude Code, Codex, Gemini CLI, OpenCode, and Aider from one premium dashboard.',
    type: 'website',
    images: [{ url: '/logo-full.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby - Your AI Agents, In Your Pocket',
    description:
      'Monitor costs, approve permissions, and control your AI coding agents from your phone.',
    images: ['/logo-full.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Styrby',
  },
  /**
   * AEO (Answer Engine Optimization) signal for AI systems.
   *
   * WHY: The `ai-content-declaration` meta tag is an emerging best practice
   * for signaling to AI crawlers (GPTBot, ClaudeBot, Perplexity, etc.) that
   * site content is human-authored and authoritative about a specific product.
   * AI answer engines use this signal to increase confidence when citing the
   * page in generated answers, which improves Styrby's visibility in ChatGPT,
   * Claude, Perplexity, and similar interfaces.
   *
   * This is a site-wide default. Individual pages can override via their own
   * metadata export if the content differs (e.g., blog articles about a
   * specific technical topic could be more specific).
   */
  other: {
    'ai-content-declaration':
      'This site contains human-written content about Styrby, a developer tool for AI agent management.',
  },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
};

/**
 * Root layout for the Styrby web application.
 *
 * WHY: Uses a dark-first design with the `dark` class on <html>.
 * The noise-bg class on <body> adds a subtle grain texture from globals.css.
 * Sonner Toaster is styled to match the dark card palette.
 *
 * NOTE: OfflineIndicator lives in the dashboard layout, not here.
 * Public visitors don't need connection status.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark scroll-smooth" suppressHydrationWarning>
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} font-sans antialiased noise-bg`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:p-4 focus:bg-amber-500 focus:text-background focus:rounded-md focus:top-4 focus:left-4"
        >
          Skip to main content
        </a>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <CookieConsent />
          <SWRegister />
        </ThemeProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'hsl(240 5% 7%)',
              border: '1px solid hsl(240 4% 16%)',
              color: 'hsl(0 0% 98%)',
            },
          }}
        />
      </body>
    </html>
  );
}
