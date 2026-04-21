/**
 * Supabase Client Helper Tests
 *
 * Tests the thin wrapper functions (getCurrentUser, signInWithEmail, signOut)
 * that sit on top of the Supabase client singleton in src/lib/supabase.ts.
 *
 * WHY jest.isolateModules + mock-then-import:
 * src/lib/supabase.ts calls createClient() at module-load time. A top-level
 * jest.mock('@supabase/supabase-js') is hoisted BEFORE that import, so the
 * createClient factory receives our mock and populates supabase.auth with
 * our jest.fn() instances. Tests then spy directly on the exported `supabase`
 * object for assertions.
 *
 * WHY we do NOT mock '../../lib/supabase' itself:
 * We want to exercise the real getCurrentUser/signInWithEmail/signOut
 * implementations. We only mock the underlying Supabase SDK.
 */

// ============================================================================
// Mock the Supabase SDK (hoisted before any imports)
// ============================================================================

const mockGetUser = jest.fn();
const mockSignInWithOtp = jest.fn();
const mockSignOut = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: mockGetUser,
      signInWithOtp: mockSignInWithOtp,
      signOut: mockSignOut,
    },
    from: jest.fn(),
  })),
}));

// ============================================================================
// Import helpers AFTER mock is in place
// ============================================================================

// WHY: We need `supabase` exported object to spy/patch in tests where the
// module-level mock needs per-test behaviour.
let getCurrentUser: typeof import('../supabase').getCurrentUser;
let signInWithEmail: typeof import('../supabase').signInWithEmail;
let signOut: typeof import('../supabase').signOut;
let supabase: typeof import('../supabase').supabase;

beforeAll(() => {
  // Fresh import after jest.mock has been registered
  const mod = require('../supabase') as typeof import('../supabase');
  getCurrentUser = mod.getCurrentUser;
  signInWithEmail = mod.signInWithEmail;
  signOut = mod.signOut;
  supabase = mod.supabase;
});

// ============================================================================
// Test Suite
// ============================================================================

describe('Supabase helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // getCurrentUser()
  // --------------------------------------------------------------------------

  describe('getCurrentUser()', () => {
    it('returns the user when authenticated', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      mockGetUser.mockResolvedValueOnce({
        data: { user: mockUser },
        error: null,
      });

      const result = await getCurrentUser();

      expect(result).toEqual(mockUser);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
    });

    it('returns null when no user is authenticated (data.user is null)', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const result = await getCurrentUser();

      expect(result).toBeNull();
    });

    it('returns null and logs error when getUser returns an auth error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'JWT expired' },
      });

      const result = await getCurrentUser();

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error getting user:',
        'JWT expired',
      );
      consoleSpy.mockRestore();
    });

    it('returns null when error message is a network error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Failed to fetch' },
      });

      const result = await getCurrentUser();

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error getting user:',
        'Failed to fetch',
      );
      consoleSpy.mockRestore();
    });

    it('does not log when no error (successful response)', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockGetUser.mockResolvedValueOnce({
        data: { user: { id: 'u1' } },
        error: null,
      });

      await getCurrentUser();

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // signInWithEmail()
  // --------------------------------------------------------------------------

  describe('signInWithEmail()', () => {
    it('calls signInWithOtp with the email and magic link redirect', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null });

      const result = await signInWithEmail('user@example.com');

      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: 'user@example.com',
        options: {
          emailRedirectTo: 'styrby://auth/callback',
        },
      });
      expect(result.error).toBeNull();
    });

    it('returns the error from Supabase when OTP sending fails', async () => {
      const mockError = { message: 'Rate limit exceeded' };
      mockSignInWithOtp.mockResolvedValueOnce({ error: mockError });

      const result = await signInWithEmail('user@example.com');

      expect(result.error).toBe(mockError);
    });

    it('uses the correct styrby deep link callback URL', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null });

      await signInWithEmail('another@example.com');

      const callArgs = mockSignInWithOtp.mock.calls[0][0] as {
        email: string;
        options: { emailRedirectTo: string };
      };
      expect(callArgs.options.emailRedirectTo).toBe('styrby://auth/callback');
    });

    it('passes through email without modification', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null });

      await signInWithEmail('CAPS@Example.COM');

      const callArgs = mockSignInWithOtp.mock.calls[0][0] as { email: string };
      // WHY: Email normalisation is Supabase's responsibility
      expect(callArgs.email).toBe('CAPS@Example.COM');
    });

    it('handles empty string email (Supabase validates)', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({
        error: { message: 'Invalid email' },
      });

      const result = await signInWithEmail('');

      expect(mockSignInWithOtp).toHaveBeenCalledWith(
        expect.objectContaining({ email: '' }),
      );
      expect(result.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // signOut()
  // --------------------------------------------------------------------------

  describe('signOut()', () => {
    it('calls supabase.auth.signOut and returns the result', async () => {
      mockSignOut.mockResolvedValueOnce({ error: null });

      const result = await signOut();

      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(result.error).toBeNull();
    });

    it('returns the error object when sign out fails', async () => {
      const mockError = { message: 'Session already invalidated' };
      mockSignOut.mockResolvedValueOnce({ error: mockError });

      const result = await signOut();

      expect(result.error).toBe(mockError);
    });

    it('is a pure pass-through — calls no other auth methods', async () => {
      mockSignOut.mockResolvedValueOnce({ error: null });

      await signOut();

      // Confirm no unintended side effects (e.g., getUser is not called)
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockSignInWithOtp).not.toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // supabase singleton is exported
  // --------------------------------------------------------------------------

  describe('supabase singleton', () => {
    it('exports a supabase client object with auth methods', () => {
      // WHY: Verifying the export contract so consumers can import the singleton
      // directly without re-instantiating.
      expect(supabase).toBeDefined();
      expect(supabase.auth).toBeDefined();
      expect(typeof supabase.auth.getUser).toBe('function');
    });
  });
});
