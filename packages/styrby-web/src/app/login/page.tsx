'use client';

import { useState, useRef, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Github, Mail, KeyRound } from 'lucide-react';

/**
 * Google logo SVG icon.
 * WHY inline: lucide-react does not include Google as an icon.
 * We use a minimal, accessible SVG matching Google brand guidelines.
 */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isDisposableEmail, DISPOSABLE_EMAIL_ERROR } from '@/lib/disposable-emails';
import { Label } from '@/components/ui/label';
import { Footer } from '@/components/landing/footer';
import { startAuthentication } from '@simplewebauthn/browser';

/**
 * Validates a redirect path to prevent open redirect attacks.
 *
 * @param path - The redirect path from the query string
 * @returns A safe, relative redirect path (defaults to /dashboard)
 */
function sanitizeRedirect(path: string | null): string {
  if (!path) return '/dashboard';
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\')) {
    return '/dashboard';
  }
  return path;
}

/**
 * Minimum milliseconds between OTP requests.
 * WHY: Prevents rapid-fire sends that could abuse the email provider quota.
 */
const OTP_COOLDOWN_MS = 30_000;

/**
 * Login form with email OTP (6-digit code), passkey, and GitHub OAuth.
 *
 * WHY OTP instead of magic link: Magic links open a new browser tab,
 * breaking the user's context. On mobile, they open in the email app's
 * embedded browser instead of the real browser. OTP keeps the user in
 * the same tab: enter email, check email for 6-digit code, type it in, done.
 *
 * WHY passkey: Passkeys are phishing-resistant (NIST AAL3) and provide a
 * seamless biometric login experience. Users who have enrolled a passkey
 * should prefer it over OTP for day-to-day access.
 */
function LoginForm() {
  const searchParams = useSearchParams();
  const redirect = sanitizeRedirect(searchParams.get('redirect'));
  const router = useRouter();

  // WHY: Show a contextual error if redirected from auth callback with sso_required.
  // This happens when a user tries password/magic-link auth on a team with require_sso=true.
  const errorParam = searchParams.get('error');
  const initialMessage: { type: 'success' | 'error'; text: string } | null =
    errorParam === 'sso_required'
      ? {
          type: 'error',
          text: 'This team requires Google SSO sign-in. Please use "Continue with Google" to access your account.',
        }
      : errorParam === 'auth_failed'
      ? { type: 'error', text: 'Sign-in failed. Please try again.' }
      : null;

  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(initialMessage);
  const [lastSentAt, setLastSentAt] = useState(0);
  const otpInputRef = useRef<HTMLInputElement>(null);

  const supabase = createClient();

  /**
   * Step 1: Send OTP code to the user's email.
   */
  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();

    if (isDisposableEmail(email)) {
      setMessage({ type: 'error', text: DISPOSABLE_EMAIL_ERROR });
      return;
    }

    const now = Date.now();
    if (now - lastSentAt < OTP_COOLDOWN_MS) {
      const secsLeft = Math.ceil((OTP_COOLDOWN_MS - (now - lastSentAt)) / 1000);
      setMessage({ type: 'error', text: `Please wait ${secsLeft}s before requesting another code.` });
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setLastSentAt(Date.now());
      setStep('otp');
      setMessage({
        type: 'success',
        text: 'Check your email for a 6-digit sign-in code.',
      });
      // Auto-focus the OTP input after a tick
      setTimeout(() => otpInputRef.current?.focus(), 100);
    }

    setLoading(false);
  }

  /**
   * Step 2: Verify the 6-digit OTP code.
   */
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();

    if (otpCode.length !== 6) {
      setMessage({ type: 'error', text: 'Please enter the full 6-digit code.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.verifyOtp({
      email,
      token: otpCode,
      type: 'email',
    });

    if (error) {
      setMessage({ type: 'error', text: 'Invalid or expired code. Please try again.' });
      setLoading(false);
    } else {
      // Success: redirect to dashboard
      router.push(redirect);
    }
  }

  /**
   * Resend the OTP code (same as initial send but with feedback).
   */
  async function handleResendOtp() {
    const now = Date.now();
    if (now - lastSentAt < OTP_COOLDOWN_MS) {
      const secsLeft = Math.ceil((OTP_COOLDOWN_MS - (now - lastSentAt)) / 1000);
      setMessage({ type: 'error', text: `Please wait ${secsLeft}s before requesting another code.` });
      return;
    }

    setMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setLastSentAt(Date.now());
      setOtpCode('');
      setMessage({ type: 'success', text: 'New code sent. Check your email.' });
    }
  }

  /**
   * Initiates GitHub OAuth flow.
   */
  async function handleGitHubLogin() {
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
    }
  }

  /**
   * Initiates Google OAuth flow.
   *
   * WHY queryParams hd: We pass `hd` as an empty string to *not* restrict to a
   * specific domain at the OAuth prompt level — team-level domain enforcement
   * happens server-side in the auth callback. If we hardcoded a domain here,
   * solo users (non-Workspace) could not use Google sign-in at all.
   *
   * The auth callback extracts the `hd` claim from the verified session metadata
   * after Google populates it, giving us the authoritative domain per team.
   */
  async function handleGoogleLogin() {
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
        // access_type=offline ensures we get a refresh token (needed for session persistence)
        queryParams: { access_type: 'offline', prompt: 'select_account' },
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
    }
  }

  /**
   * Passkey authentication flow.
   *
   * WHY we send email for challenge-login even if unknown:
   * The edge function returns an empty allow-list for unknown emails instead
   * of a 404. This is intentional account-enumeration resistance per
   * WebAuthn L3 spec — an attacker cannot distinguish "no account" from
   * "account exists but no passkeys registered" via the challenge response.
   * If the challenge succeeds but the allow-list is empty the device's
   * passkey manager will naturally prompt for any available credential.
   *
   * If the user has no passkeys registered at all, @simplewebauthn/browser
   * will throw NotAllowedError (user cancels or device has nothing), and we
   * show a graceful message directing them to Settings > Passkeys.
   */
  async function handlePasskeyLogin() {
    setPasskeyLoading(true);
    setMessage(null);

    try {
      // 1. Request a challenge (sends email for allow-list resolution)
      const challengeRes = await fetch('/api/auth/passkey/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge-login', email: email || undefined }),
      });

      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Failed to get passkey challenge');
      }

      const challengeData = await challengeRes.json();

      // 2. Invoke the browser WebAuthn API via @simplewebauthn/browser
      const assertionResponse = await startAuthentication({ optionsJSON: challengeData });

      // 3. Verify the assertion on the server
      const verifyRes = await fetch('/api/auth/passkey/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify-login',
          response: assertionResponse,
          email: email || undefined,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Passkey verification failed');
      }

      const verifyData = await verifyRes.json();

      // 4. Set the Supabase session from the tokens the edge function returns
      if (verifyData.access_token && verifyData.refresh_token) {
        await supabase.auth.setSession({
          access_token: verifyData.access_token,
          refresh_token: verifyData.refresh_token,
        });
      }

      router.push(redirect);
    } catch (err) {
      if (err instanceof Error) {
        // NotAllowedError = user cancelled or no passkey available on device
        if (err.name === 'NotAllowedError') {
          setMessage({
            type: 'error',
            text: 'No passkey registered yet. Add one in Settings - Passkeys.',
          });
        } else {
          setMessage({ type: 'error', text: err.message });
        }
      } else {
        setMessage({ type: 'error', text: 'Passkey sign-in failed. Try again.' });
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <div className="flex flex-1 items-center justify-center px-4">
        {/* Background effects */}
        <div className="fixed inset-0 -z-10" />
        <div className="fixed left-1/2 top-1/3 -z-10 h-[400px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500/5 blur-[120px]" />

        <div className="w-full max-w-md">
          <div className="gradient-border rounded-xl glass p-8 amber-glow">
            {/* Logo */}
            <div className="mb-8 flex flex-col items-center">
              <div className="mb-4 flex items-center gap-2">
                <Image src="/icon-512.png" alt="Styrby" width={32} height={32} className="h-8 w-8 rounded-md" />
                <span className="text-xl font-bold text-foreground">Styrby</span>
              </div>
              <h1 className="text-2xl font-bold text-foreground">
                {step === 'email' ? 'Welcome back' : 'Enter your code'}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {step === 'email'
                  ? 'Sign in to your account to continue'
                  : `We sent a 6-digit code to ${email}`}
              </p>
            </div>

            {/* Message display */}
            {message && (
              <div
                role="alert"
                className={`mb-6 rounded-lg border p-4 text-sm ${
                  message.type === 'success'
                    ? 'border-green-500/20 bg-green-500/10 text-green-400'
                    : 'border-red-500/20 bg-red-500/10 text-red-400'
                }`}
              >
                {message.text}
              </div>
            )}

            {step === 'email' ? (
              <>
                {/* Email form */}
                <form onSubmit={handleSendOtp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-foreground">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      autoFocus
                      autoComplete="email"
                      className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={loading || passkeyLoading}
                    className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium gap-2"
                  >
                    <Mail className="h-4 w-4" />
                    {loading ? 'Sending...' : 'Continue with Email'}
                  </Button>
                </form>

                {/* Divider */}
                <div className="my-6 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/40" />
                  <span className="text-xs text-muted-foreground">or continue with</span>
                  <div className="h-px flex-1 bg-border/40" />
                </div>

                {/* Passkey button */}
                {/*
                 * WHY passkey shown before Google:
                 * Passkeys are the preferred auth method - phishing-resistant, no
                 * password, no email round-trip. Google and GitHub are kept as fallbacks
                 * for users who have not enrolled a passkey yet.
                 */}
                <Button
                  variant="outline"
                  onClick={handlePasskeyLogin}
                  disabled={loading || passkeyLoading}
                  className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent mb-3"
                  aria-label="Sign in with passkey (biometric or device PIN)"
                >
                  <KeyRound className="h-4 w-4" />
                  {passkeyLoading ? 'Waiting for passkey...' : 'Continue with Passkey'}
                </Button>

                {/* Google OAuth */}
                <Button
                  variant="outline"
                  onClick={handleGoogleLogin}
                  disabled={loading || passkeyLoading}
                  className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent mb-3"
                  aria-label="Sign in with Google"
                >
                  <GoogleIcon className="h-4 w-4" />
                  Continue with Google
                </Button>

                {/* GitHub OAuth */}
                <Button
                  variant="outline"
                  onClick={handleGitHubLogin}
                  disabled={loading || passkeyLoading}
                  className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent"
                >
                  <Github className="h-4 w-4" />
                  Continue with GitHub
                </Button>
              </>
            ) : (
              <>
                {/* OTP verification form */}
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="otp" className="text-foreground">6-digit code</Label>
                    <Input
                      ref={otpInputRef}
                      id="otp"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      required
                      autoComplete="one-time-code"
                      className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500 text-center text-2xl font-mono tracking-[0.3em]"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={loading || otpCode.length !== 6}
                    className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium"
                  >
                    {loading ? 'Verifying...' : 'Sign In'}
                  </Button>
                </form>

                {/* Resend + back */}
                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => { setStep('email'); setOtpCode(''); setMessage(null); }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Use a different email
                  </button>
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    className="text-sm text-amber-500 hover:text-amber-400 transition-colors"
                  >
                    Resend code
                  </button>
                </div>
              </>
            )}

            {/* Bottom links */}
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="font-medium text-amber-500 hover:text-amber-400 transition-colors">
                Start Free
              </Link>
            </p>

            <p className="mt-3 text-center text-xs text-muted-foreground">
              By signing in, you agree to our{' '}
              <Link href="/terms" className="text-amber-500 hover:underline">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="text-amber-500 hover:underline">
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}

/**
 * Login page wrapper with Suspense boundary.
 * Required for useSearchParams in Next.js static generation.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[100dvh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
