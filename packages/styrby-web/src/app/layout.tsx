import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: {
    default: 'Styrby - Mobile Remote for AI Coding Agents',
    template: '%s | Styrby',
  },
  description:
    'Control Claude Code, Codex, and Gemini CLI from your phone. Track costs, approve permissions, manage sessions — all from your pocket.',
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
    title: 'Styrby - Mobile Remote for AI Coding Agents',
    description:
      'Control Claude Code, Codex, and Gemini CLI from your phone. Track costs, approve permissions, manage sessions.',
    type: 'website',
    images: [{ url: '/logo-full.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby - Mobile Remote for AI Coding Agents',
    description:
      'Control Claude Code, Codex, and Gemini CLI from your phone.',
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased min-h-screen bg-zinc-950 text-zinc-50`}
      >
        {children}
      </body>
    </html>
  );
}
