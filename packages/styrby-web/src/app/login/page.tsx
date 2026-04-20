'use client';

import { useState, useRef, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Github, Mail, KeyRound } from 'lucide-react';
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
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [lastSentAt, setLastSentAt] = useState(0);
  const otpInputRef = useRef<HTMLInputElement>(null);

  const searchParams = useSearchParams();
  const redirect = sanitizeRedirect(searchParams.get('redirect'));
  const router = useRouter();

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
    <div className="flex min-h-screen flex-col">
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
                 * WHY passkey shown before GitHub:
                 * Passkeys are the preferred auth method — phishing-resistant, no
                 * password, no email round-trip. GitHub is kept as a fallback for
                 * users who haven't enrolled a passkey yet.
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
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
