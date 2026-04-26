/**
 * Signup Page Tests
 *
 * Tests the three-path sign-up flow:
 * - Step 1 (info): form rendering, disposable email rejection, terms-of-service
 *   gate, OTP cooldown enforcement, plan-param headline variants
 * - Step 2 (otp): numeric-only input, length validation, successful verification
 *   → router.push, error handling for invalid code
 * - GitHub OAuth: terms gate (must accept first), provider call, error display
 * - "Use a different email" navigation
 *
 * WHY: The signup page is the main acquisition funnel entry point. Any regression
 * here directly reduces sign-up conversion and revenue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * WHY: The Radix UI Checkbox uses ResizeObserver internally. jsdom does not
 * implement ResizeObserver, so we provide a minimal stub to prevent the
 * "ResizeObserver is not defined" error that would crash all signup tests.
 */
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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

import SignUpPage from '../page';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const user = userEvent.setup();
  const utils = render(<SignUpPage />);
  return { user, ...utils };
}

/**
 * Fills in name + email, checks the ToS box, and advances to the OTP step.
 * Callers should set mockSignInWithOtp.mockResolvedValue() before calling this.
 */
async function advanceToOtpStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
  await user.type(screen.getByLabelText('Email'), 'valid@example.com');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /continue with email/i }));
  await screen.findByRole('heading', { name: 'Verify your email' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignUpPage — info step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
  });

  it('renders name, email, ToS checkbox, and submit button', () => {
    setup();

    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with email/i })).toBeInTheDocument();
  });

  it('shows "Create your free account" when no plan param is set', () => {
    setup();

    expect(
      screen.getByRole('heading', { name: 'Create your free account' })
    ).toBeInTheDocument();
  });

  it('shows "Create your Pro account" when plan=pro', () => {
    mockSearchParams.get.mockImplementation((key: string) =>
      key === 'plan' ? 'pro' : null
    );
    setup();

    expect(
      screen.getByRole('heading', { name: 'Create your Pro account' })
    ).toBeInTheDocument();
  });

  it('shows "Create your Power account" when plan=power', () => {
    mockSearchParams.get.mockImplementation((key: string) =>
      key === 'plan' ? 'power' : null
    );
    setup();

    expect(
      screen.getByRole('heading', { name: 'Create your Power account' })
    ).toBeInTheDocument();
  });

  it('blocks submission when ToS is not accepted', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    // Do NOT check the checkbox
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/agree to the terms/i);
  });

  it('rejects disposable email domains', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
    await user.type(screen.getByLabelText('Email'), 'test@mailinator.com');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('advances to OTP step on successful send', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null });

    const { user } = setup();
    await advanceToOtpStep(user);

    expect(screen.getByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
    expect(screen.getByText(/sent a 6-digit code to valid@example.com/i)).toBeInTheDocument();
  });

  it('passes full_name in OTP data options', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null });

    const { user } = setup();
    await advanceToOtpStep(user);

    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          data: expect.objectContaining({ full_name: 'Alex Morgan' }),
        }),
      })
    );
  });

  it('shows error message when OTP send fails', async () => {
    mockSignInWithOtp.mockResolvedValue({
      error: { message: 'Too many requests' },
    });

    const { user } = setup();

    await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
    await user.type(screen.getByLabelText('Email'), 'valid@example.com');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue with email/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  });
});

describe('SignUpPage — OTP step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
    mockSignInWithOtp.mockResolvedValue({ error: null });
  });

  it('renders the 6-digit code input', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
  });

  it('strips non-numeric characters from the OTP input', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    const input = screen.getByLabelText('6-digit code');
    await user.type(input, 'a1b2c3d4e5f6');

    expect((input as HTMLInputElement).value).toBe('123456');
  });

  it('keeps Create Account button disabled until 6 digits entered', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    const btn = screen.getByRole('button', { name: /create account/i });
    expect(btn).toBeDisabled();

    await user.type(screen.getByLabelText('6-digit code'), '12345');
    expect(btn).toBeDisabled();

    await user.type(screen.getByLabelText('6-digit code'), '6');
    expect(btn).not.toBeDisabled();
  });

  it('redirects to /dashboard on success (no plan)', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('redirects to /dashboard?plan=pro when plan=pro', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    mockSearchParams.get.mockImplementation((key: string) =>
      key === 'plan' ? 'pro' : null
    );

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard?plan=pro');
    });
  });

  it('shows error on invalid OTP code', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'Token expired' } });

    const { user } = setup();
    await advanceToOtpStep(user);

    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/that code did not match/i);
  });

  it('"Use a different email" returns to the info step', async () => {
    const { user } = setup();
    await advanceToOtpStep(user);

    await user.click(screen.getByRole('button', { name: /use a different email/i }));

    expect(screen.getByRole('heading', { name: 'Create your free account' })).toBeInTheDocument();
  });
});

describe('SignUpPage — GitHub OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.get.mockReturnValue(null);
  });

  it('blocks GitHub OAuth if ToS not accepted', async () => {
    const { user } = setup();

    // Do NOT check the checkbox
    await user.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/agree to the terms/i);
  });

  it('calls signInWithOAuth with github provider when ToS accepted', async () => {
    mockSignInWithOAuth.mockResolvedValue({ error: null });

    const { user } = setup();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github' })
    );
  });

  it('shows error when OAuth fails', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      error: { message: 'OAuth callback error' },
    });

    const { user } = setup();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('OAuth callback error');
  });
});
