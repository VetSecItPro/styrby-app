'use client';

import { useState, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Github, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Footer } from '@/components/landing/footer';

/**
 * Login form component that uses useSearchParams.
 * Wrapped in Suspense for static generation compatibility.
 *
 * WHY magic link + GitHub: Passwordless auth reduces friction for developers
 * who already have GitHub accounts. Magic link is the fallback for email-only users.
 */
function LoginForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect') || '/dashboard';

  const supabase = createClient();

  /**
   * Sends a magic link to the user's email.
   */
  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?redirect=${redirect}`,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setMessage({
        type: 'success',
        text: 'Check your email for the login link!',
      });
    }

    setLoading(false);
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
        redirectTo: `${window.location.origin}/auth/callback?redirect=${redirect}`,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
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
                <div className="h-8 w-8 rounded-md bg-amber-500" />
                <span className="text-xl font-bold text-foreground">Styrby</span>
              </div>
              <h1 className="text-2xl font-bold text-foreground">Welcome back</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to your account to continue</p>
            </div>

            {/* Message display */}
            {message && (
              <div
                className={`mb-6 rounded-lg border p-4 text-sm ${
                  message.type === 'success'
                    ? 'border-green-500/20 bg-green-500/10 text-green-400'
                    : 'border-red-500/20 bg-red-500/10 text-red-400'
                }`}
              >
                {message.text}
              </div>
            )}

            {/* Email form */}
            <form onSubmit={handleMagicLink} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
                />
              </div>
              <Button
                type="submit"
                disabled={loading}
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

            {/* OAuth */}
            <Button
              variant="outline"
              onClick={handleGitHubLogin}
              disabled={loading}
              className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent"
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>

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
 * Required for useSearchParams in Next.js 14+ static generation.
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
