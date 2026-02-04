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
  openGraph: {
    title: 'Styrby - Mobile Remote for AI Coding Agents',
    description:
      'Control Claude Code, Codex, and Gemini CLI from your phone. Track costs, approve permissions, manage sessions.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby - Mobile Remote for AI Coding Agents',
    description:
      'Control Claude Code, Codex, and Gemini CLI from your phone.',
  },
  robots: {
    index: true,
    follow: true,
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
