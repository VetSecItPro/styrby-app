'use client';

import { useState, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import Image from 'next/image';
import { Github, Mail } from 'lucide-react';

/**
 * Google logo SVG icon.
 * WHY inline: lucide-react does not include Google as an icon.
 */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Footer } from '@/components/landing/footer';
import { isDisposableEmail, DISPOSABLE_EMAIL_ERROR } from '@/lib/disposable-emails';

/**
 * Sign up page wrapper with Suspense boundary for useSearchParams().
 */
export default function SignUpPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-[100dvh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    }>
      <SignUpPageInner />
    </Suspense>
  );
}

/**
 * Minimum milliseconds between OTP requests.
 */
const OTP_COOLDOWN_MS = 30_000;

/**
 * Sign up page with OTP-based account creation.
 *
 * WHY OTP instead of password: Login uses OTP (6-digit code via email).
 * If signup collected a password, it would never be used again since
 * login is passwordless. Removing the password field reduces friction
 * and keeps one consistent auth pattern across the app.
 *
 * Flow: enter name + email, agree to terms, receive OTP, type code, done.
 */
function SignUpPageInner() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [step, setStep] = useState<'info' | 'otp'>('info');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastSentAt, setLastSentAt] = useState(0);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);

  const searchParams = useSearchParams();
  const plan = searchParams.get('plan');
  const refCode = searchParams.get('ref');
  const invitedBy = searchParams.get('invited_by');
  const redirectPath = plan ? `/dashboard?plan=${plan}` : '/dashboard';
  const router = useRouter();
  const supabase = createClient();

  /**
   * Step 1: Send OTP to create the account.
   * Uses signInWithOtp with shouldCreateUser: true.
   */
  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();

    if (isDisposableEmail(email)) {
      setMessage({ type: 'error', text: DISPOSABLE_EMAIL_ERROR });
      return;
    }

    if (!agreed) {
      setMessage({ type: 'error', text: 'Please agree to the Terms of Service and Privacy Policy.' });
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
        data: {
          full_name: name,
        },
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setLastSentAt(Date.now());
      setStep('otp');
      setMessage({
        type: 'success',
        text: 'Check your email for a 6-digit verification code.',
      });
      setTimeout(() => otpInputRef.current?.focus(), 100);
    }

    setLoading(false);
  }

  /**
   * Step 2: Verify the OTP code to complete account creation.
   */
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();

    if (otpCode.length !== 6) {
      setMessage({ type: 'error', text: 'Enter all 6 digits to verify your email.' });
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
      setMessage({ type: 'error', text: 'That code did not match. Check the latest email or tap "Resend code".' });
      setLoading(false);
    } else {
      // Attribute the referral if a referral code was present in the URL.
      // WHY fire-and-forget: Referral attribution is non-blocking. A failure
      // here should never prevent the user from reaching their dashboard.
      // The server reads the styrby_referral_code HttpOnly cookie for
      // additional abuse protection even if the URL param is tampered with.
      if (refCode) {
        fetch('/api/referral', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ referralCode: refCode }),
        }).catch(() => {
          // Intentionally swallowed — attribution failure is non-fatal
        });
      }

      router.push(redirectPath);
    }
  }

  /**
   * Resend the OTP code.
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
        data: { full_name: name },
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
   * GitHub OAuth signup.
   */
  async function handleGitHubSignUp() {
    if (!agreed) {
      setMessage({ type: 'error', text: 'Please agree to the Terms of Service and Privacy Policy.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirectPath)}`,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
    }
  }

  /**
   * Google OAuth signup.
   *
   * WHY hd not set: Same reasoning as login page - domain enforcement happens
   * server-side in the auth callback using the verified hd claim from Google.
   * Not restricting at the prompt level allows both personal and Workspace
   * Google accounts to sign up. The team auto-enroll only fires for accounts
   * whose hd matches a configured team sso_domain.
   */
  async function handleGoogleSignUp() {
    if (!agreed) {
      setMessage({ type: 'error', text: 'Please agree to the Terms of Service and Privacy Policy.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirectPath)}`,
        queryParams: { access_type: 'offline', prompt: 'select_account' },
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <div className="flex flex-1 items-center justify-center px-4">
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
                {step === 'otp'
                  ? 'Verify your email'
                  : plan === 'pro'
                  ? 'Create your Pro account'
                  : plan === 'growth'
                  ? 'Create your Growth account'
                  : 'Create your free account'}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground text-center">
                {step === 'otp'
                  ? `We sent a 6-digit code to ${email}`
                  : plan
                  ? 'Verify your email, then complete checkout.'
                  : 'Free on one machine. Upgrade to a paid tier whenever you outgrow it.'}
              </p>
              {plan && step === 'info' && (
                <span className="mt-2 inline-flex items-center rounded-full bg-amber-500/10 border border-amber-500/20 px-3 py-0.5 text-xs font-medium text-amber-500">
                  {plan.charAt(0).toUpperCase() + plan.slice(1)} Plan
                </span>
              )}
            </div>

            {/* Referral banner — shown when arriving via a referral link */}
            {invitedBy && refCode && step === 'info' && (
              <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/8 p-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-4-4m0 0l-4 4m4-4v12" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-400">
                    {decodeURIComponent(invitedBy)} invited you to Styrby
                  </p>
                  <p className="mt-0.5 text-xs text-amber-500/70">
                    Create your free account and pair your first agent in under a minute.
                  </p>
                </div>
              </div>
            )}

            {/* Message */}
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

            {step === 'info' ? (
              <>
                {/* Name + Email form */}
                <form onSubmit={handleSendOtp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-foreground">Full name</Label>
                    <Input
                      id="name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Alex Morgan"
                      required
                      autoFocus
                      autoComplete="name"
                      className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
                    />
                  </div>
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

                  <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-secondary/30 p-3">
                    <Checkbox
                      id="terms"
                      checked={agreed}
                      onCheckedChange={(checked) => setAgreed(checked === true)}
                      className="mt-0.5 h-5 w-5 border-2 border-zinc-500 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500 data-[state=checked]:text-background"
                    />
                    <Label htmlFor="terms" className="text-sm text-muted-foreground leading-relaxed cursor-pointer">
                      I agree to the{' '}
                      <Link href="/terms" className="text-amber-500 hover:text-amber-400 transition-colors">Terms of Service</Link>
                      {' '}and{' '}
                      <Link href="/privacy" className="text-amber-500 hover:text-amber-400 transition-colors">Privacy Policy</Link>
                    </Label>
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium gap-2"
                  >
                    <Mail className="h-4 w-4" />
                    {loading ? 'Sending...' : 'Continue with Email'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground mt-2">
                    No credit card required
                  </p>
                </form>

                {/* Divider */}
                <div className="my-6 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/40" />
                  <span className="text-xs text-muted-foreground">or continue with</span>
                  <div className="h-px flex-1 bg-border/40" />
                </div>

                {/* Google OAuth */}
                <Button
                  variant="outline"
                  onClick={handleGoogleSignUp}
                  disabled={loading}
                  className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent mb-3"
                  aria-label="Sign up with Google"
                >
                  <GoogleIcon className="h-4 w-4" />
                  Continue with Google
                </Button>

                {/* GitHub OAuth */}
                <Button
                  variant="outline"
                  onClick={handleGitHubSignUp}
                  disabled={loading}
                  className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent"
                >
                  <Github className="h-4 w-4" />
                  Continue with GitHub
                </Button>
              </>
            ) : (
              <>
                {/* OTP verification */}
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
                    {loading ? 'Verifying...' : 'Create Account'}
                  </Button>
                </form>

                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => { setStep('info'); setOtpCode(''); setMessage(null); }}
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

            {/* Bottom link */}
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="font-medium text-amber-500 hover:text-amber-400 transition-colors">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
