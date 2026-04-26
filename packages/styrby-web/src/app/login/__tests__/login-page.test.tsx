/**
 * Login Page Tests
 *
 * Tests the two-step OTP login flow:
 * - Step 1 (email): form rendering, disposable email rejection,
 *   OTP cooldown enforcement, successful OTP send → advances to step 2
 * - Step 2 (otp): code input filtering, length validation, successful
 *   verification → router.push, invalid code error
 * - GitHub OAuth button rendering and click handler
 * - Resend OTP cooldown enforcement
 * - "Use a different email" resets back to email step
 * - Open-redirect protection in sanitizeRedirect (via ?redirect= param)
 *
 * WHY: The login page is the primary auth entry point. Broken auth means
 * zero users can access the dashboard — it is the most critical user path
 * in the entire application.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
const mockSearchParams = {
  get: vi.fn().mockReturnValue(null),
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub replacing next/image itself; circular to use Image here
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock('@/components/landing/footer', () => ({
  Footer: () => <footer data-testid="footer" />,
}));

// Mutable supabase mock — individual tests override signInWithOtp / verifyOtp
const mockSignInWithOtp = vi.fn();
const mockVerifyOtp = vi.fn();
const mockSignInWithOAuth = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
      verifyOtp: mockVerifyOtp,
      signInWithOAuth: mockSignInWithOAuth,
    },
  }),
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

// Import AFTER mocks are registered
import LoginPage from '../page';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders the login page and returns userEvent helpers. */
function setup() {
  const user = userEvent.setup();
  const utils = render(<LoginPage />);
  return { user, ...utils };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginPage — email step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
  });

  it('renders the email form by default', () => {
    setup();

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with email/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeInTheDocument();
  });

  it('renders the sign-up link', () => {
    setup();

    const link = screen.getByRole('link', { name: 'Start Free' });
    expect(link).toHaveAttribute('href', '/signup');
  });

  it('rejects disposable email addresses', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Email'), 'test@mailinator.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    // Supabase should NOT be called for disposable emails
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    // Error message should appear
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('advances to OTP step on successful send', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
    });
    expect(screen.getByText(/sent a 6-digit code to valid@example.com/i)).toBeInTheDocument();
  });

  it('shows error message when Supabase OTP send fails', async () => {
    mockSignInWithOtp.mockResolvedValue({
      error: { message: 'Email rate limit exceeded' },
    });

    const { user } = setup();

    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email rate limit exceeded');
  });

  it('enforces OTP cooldown on rapid re-submission', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null });

    const { user } = setup();

    // First send — succeeds
    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));
    await screen.findByRole('heading', { name: 'Enter your code' });

    // Immediately go back to email step and try again
    await user.click(screen.getByRole('button', { name: /use a different email/i }));
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    // Second send within the 30s cooldown window should show a wait message
    expect(await screen.findByRole('alert')).toHaveTextContent(/please wait/i);
  });
});

describe('LoginPage — OTP step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
    mockSignInWithOtp.mockResolvedValue({ error: null });
  });

  /**
   * Navigates the UI to the OTP step.
   */
  async function advanceToOtpStep(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('button', { name: /continue with email/i }));
    await screen.findByRole('heading', { name: 'Enter your code' });
  }

  it('renders the 6-digit code input', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
  });

  it('only accepts numeric characters in the OTP input', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    const input = screen.getByLabelText('6-digit code');
    await user.type(input, 'abc123def456');

    // Non-numeric chars are stripped; only "123456" should remain
    expect((input as HTMLInputElement).value).toBe('123456');
  });

  it('keeps Sign In button disabled until 6 digits are entered', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    const submitBtn = screen.getByRole('button', { name: /sign in/i });
    expect(submitBtn).toBeDisabled();

    await user.type(screen.getByLabelText('6-digit code'), '12345');
    expect(submitBtn).toBeDisabled();

    await user.type(screen.getByLabelText('6-digit code'), '6');
    expect(submitBtn).not.toBeDisabled();
  });

  it('redirects to /dashboard on successful OTP verify', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('shows error message on invalid OTP code', async () => {
    mockVerifyOtp.mockResolvedValue({
      error: { message: 'Invalid token' },
    });

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/that code did not match/i);
  });

  it('respects the ?redirect= query param on success', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    mockSearchParams.get.mockReturnValue('/dashboard/sessions');

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '654321');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard/sessions');
    });
  });

  it('falls back to /dashboard for unsafe redirect paths', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    // Attacker tries //evil.com
    mockSearchParams.get.mockReturnValue('//evil.com');

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('"Use a different email" resets to email step', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    await user.click(screen.getByRole('button', { name: /use a different email/i }));

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

describe('LoginPage — GitHub OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
  });

  it('calls signInWithOAuth with github provider', async () => {
    mockSignInWithOAuth.mockResolvedValue({ error: null });

    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github' })
    );
  });

  it('shows error when OAuth fails', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      error: { message: 'OAuth provider error' },
    });

    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('OAuth provider error');
  });
});
