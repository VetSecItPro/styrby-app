'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Github } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Footer } from '@/components/landing/footer';

/**
 * Sign up page - creates a new Styrby account.
 *
 * WHY email/password + GitHub: Unlike login (magic link), signup collects
 * a password for users who prefer credential-based auth. GitHub OAuth is
 * offered as an alternative for frictionless onboarding.
 */
export default function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const router = useRouter();
  const supabase = createClient();

  /**
   * Creates a new account with email and password.
   *
   * @param e - Form submit event
   */
  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();

    if (!agreed) {
      setMessage({ type: 'error', text: 'Please agree to the Terms of Service and Privacy Policy.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
        },
        emailRedirectTo: `${window.location.origin}/auth/callback?redirect=/dashboard`,
      },
    });

    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setMessage({
        type: 'success',
        text: 'Check your email to confirm your account!',
      });
    }

    setLoading(false);
  }

  /**
   * Initiates GitHub OAuth flow for signup.
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
        redirectTo: `${window.location.origin}/auth/callback?redirect=/dashboard`,
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
              <h1 className="text-2xl font-bold text-foreground">Create your account</h1>
              <p className="mt-1 text-sm text-muted-foreground">Start monitoring your AI agents today</p>
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

            {/* Sign up form */}
            <form onSubmit={handleSignUp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-foreground">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Smith"
                  required
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
                  className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-foreground">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a strong password"
                  required
                  minLength={8}
                  className="bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
                />
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="terms"
                  checked={agreed}
                  onCheckedChange={(checked) => setAgreed(checked === true)}
                  className="mt-1 border-border/60 data-[state=checked]:bg-amber-500 data-[state=checked]:text-background"
                />
                <Label htmlFor="terms" className="text-sm text-muted-foreground leading-relaxed">
                  I agree to the{' '}
                  <Link href="/terms" className="text-amber-500 hover:text-amber-400 transition-colors">Terms of Service</Link>
                  {' '}and{' '}
                  <Link href="/privacy" className="text-amber-500 hover:text-amber-400 transition-colors">Privacy Policy</Link>
                </Label>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium"
              >
                {loading ? 'Creating account...' : 'Create Account'}
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
              onClick={handleGitHubSignUp}
              disabled={loading}
              className="w-full gap-2 border-border/60 text-foreground bg-transparent hover:bg-accent"
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>

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
