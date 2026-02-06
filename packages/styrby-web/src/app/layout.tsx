import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: {
    default: 'Styrby - Your AI Agents, In Your Pocket',
    template: '%s | Styrby',
  },
  description:
    'Monitor costs, approve permissions, and control Claude Code, Codex, Gemini CLI, OpenCode, and Aider from one premium dashboard.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || 'https://styrbyapp.com'
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
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased noise-bg`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
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
