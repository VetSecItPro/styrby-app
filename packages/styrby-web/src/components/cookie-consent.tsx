'use client';

import { useState, useSyncExternalStore, useCallback } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Minimal cookie consent banner for ePrivacy/GDPR transparency.
 *
 * WHY: Even though Styrby only uses functional cookies (auth + sidebar state),
 * the ePrivacy Directive requires informing EU users about all cookies.
 * This banner provides transparency without blocking the user since all
 * cookies are strictly necessary or functional — no consent gate is needed.
 *
 * Cookies used:
 * 1. `sb-{ref}-auth-token` — Supabase authentication (strictly necessary)
 * 2. `sidebar:state` — sidebar open/closed preference (functional, 7-day)
 */

const COOKIE_CONSENT_KEY = 'styrby-cookie-notice-dismissed';

/**
 * Read localStorage outside of React render to avoid setState-in-effect.
 * WHY: React's react-hooks/set-state-in-effect rule prohibits calling
 * setState synchronously inside useEffect. useSyncExternalStore with
 * getSnapshot avoids this by reading the value during render.
 */
function subscribeToStorage(callback: () => void) {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

export function CookieConsent() {
  const dismissed = useSyncExternalStore(
    subscribeToStorage,
    () => localStorage.getItem(COOKIE_CONSENT_KEY),
    () => 'true' // SSR: assume dismissed to avoid hydration flash
  );
  const [manuallyDismissed, setManuallyDismissed] = useState(false);
  const visible = !dismissed && !manuallyDismissed;

  function handleDismiss() {
    localStorage.setItem(COOKIE_CONSENT_KEY, 'true');
    setManuallyDismissed(true);
  }

  if (!visible) return null;

  return (
    <div
      role="alert"
      aria-label="Cookie notice"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-lg rounded-lg border border-border bg-card p-4 shadow-lg md:left-auto md:right-6 md:mx-0"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 text-sm text-muted-foreground">
          <p>
            This site uses essential cookies for authentication and a preference
            cookie for sidebar state. No tracking or analytics cookies are used.{' '}
            <a
              href="/privacy"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Privacy Policy
            </a>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          aria-label="Dismiss cookie notice"
          className="shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
