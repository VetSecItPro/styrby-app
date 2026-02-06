'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { type ThemeProviderProps } from 'next-themes';

/**
 * Theme provider component that wraps next-themes for the Styrby app.
 *
 * WHY: next-themes handles all the complexity of theme switching:
 * - Persists theme preference to localStorage
 * - Respects system preference when set to "system"
 * - Adds/removes the "dark" class on <html> for Tailwind
 * - Prevents flash of wrong theme on page load
 *
 * @param props - ThemeProvider props from next-themes
 * @returns Provider component that enables theme switching throughout the app
 *
 * @example
 * // In layout.tsx
 * <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
 *   {children}
 * </ThemeProvider>
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
