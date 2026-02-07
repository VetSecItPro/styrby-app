'use client';

import { useState, useEffect } from 'react';
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

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only show if user hasn't dismissed before
    const dismissed = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!dismissed) {
      setVisible(true);
    }
  }, []);

  function handleDismiss() {
    localStorage.setItem(COOKIE_CONSENT_KEY, 'true');
    setVisible(false);
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
