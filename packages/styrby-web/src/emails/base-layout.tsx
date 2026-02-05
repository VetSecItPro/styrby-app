/**
 * Base email layout with Styrby branding.
 * All email templates extend this for consistent styling.
 */

import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface BaseLayoutProps {
  preview: string;
  children: React.ReactNode;
}

export function BaseLayout({ preview, children }: BaseLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind
        config={{
          theme: {
            extend: {
              colors: {
                brand: '#f97316',
                'brand-dark': '#ea580c',
                zinc: {
                  50: '#fafafa',
                  100: '#f4f4f5',
                  200: '#e4e4e7',
                  300: '#d4d4d8',
                  400: '#a1a1aa',
                  500: '#71717a',
                  600: '#52525b',
                  700: '#3f3f46',
                  800: '#27272a',
                  900: '#18181b',
                  950: '#09090b',
                },
              },
            },
          },
        }}
      >
        <Body className="bg-black font-sans">
          <Container className="mx-auto max-w-[560px] px-4 py-8">
            {/* Header */}
            <Section className="mb-8 text-center">
              <Link href="https://www.styrbyapp.com">
                <Img
                  src="https://www.styrbyapp.com/logo-full.png"
                  width="200"
                  height="60"
                  alt="Styrby"
                  className="mx-auto"
                />
              </Link>
            </Section>

            {/* Content */}
            <Section className="rounded-xl bg-zinc-900 p-8">
              {children}
            </Section>

            {/* Footer */}
            <Section className="mt-8 text-center">
              <Text className="text-xs text-zinc-500">
                Styrby - Mobile Remote for AI Coding Agents
              </Text>
              <Text className="mt-2 text-xs text-zinc-600">
                <Link
                  href="https://www.styrbyapp.com/settings"
                  className="text-zinc-500 underline"
                >
                  Manage preferences
                </Link>
                {' · '}
                <Link
                  href="https://www.styrbyapp.com/privacy"
                  className="text-zinc-500 underline"
                >
                  Privacy
                </Link>
                {' · '}
                <Link
                  href="https://www.styrbyapp.com/terms"
                  className="text-zinc-500 underline"
                >
                  Terms
                </Link>
              </Text>
              <Text className="mt-4 text-xs text-zinc-600">
                © {new Date().getFullYear()} Styrby. All rights reserved.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

export function Button({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-block rounded-lg bg-brand px-6 py-3 text-center text-sm font-semibold text-white no-underline"
    >
      {children}
    </Link>
  );
}

export function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Text className="m-0 mb-4 text-2xl font-bold text-zinc-100">{children}</Text>
  );
}

export function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text className="m-0 mb-4 text-sm leading-6 text-zinc-300">{children}</Text>;
}

export function Divider() {
  return <hr className="my-6 border-zinc-800" />;
}
