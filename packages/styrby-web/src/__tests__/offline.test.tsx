/**
 * Tests for offline-related PWA features.
 *
 * Covers:
 * - Offline fallback page rendering
 * - usePWAInstall hook states (canInstall, isDismissed, isInstalled)
 * - Install prompt dismiss persistence via localStorage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Mock next/navigation for the offline page (if it uses router).
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/offline',
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Helper component that renders the usePWAInstall hook output for testing.
 */
function createHookTestComponent() {
  // We import dynamically inside the test to avoid hoisting issues
  let hookModule: any;

  /**
   * Wrapper component that exposes hook state via data attributes
   * for easy test assertions.
   */
  function HookTestComponent() {
    const { canInstall, isInstalled, isDismissed, install, dismiss } = hookModule.usePWAInstall();

    return (
      <div>
        <span data-testid="canInstall">{String(canInstall)}</span>
        <span data-testid="isInstalled">{String(isInstalled)}</span>
        <span data-testid="isDismissed">{String(isDismissed)}</span>
        <button data-testid="install-btn" onClick={install}>
          Install
        </button>
        <button data-testid="dismiss-btn" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  return {
    HookTestComponent,
    setModule: (mod: unknown) => {
      hookModule = mod;
    },
  };
}

// ---------------------------------------------------------------------------
// Offline Page Tests
// ---------------------------------------------------------------------------

describe('Offline fallback page', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the offline message heading', async () => {
    // The offline page is a server component, but we can still render it
    // as a regular React component in tests (it does not use server-only APIs).
    const { default: OfflinePage } = await import('@/app/offline/page');

    render(<OfflinePage />);

    expect(
      screen.getByRole('heading', { name: /you are offline/i })
    ).toBeInTheDocument();
  });

  it('renders the main content area with correct id for skip-link targeting', async () => {
    const { default: OfflinePage } = await import('@/app/offline/page');

    render(<OfflinePage />);

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  it('renders a link back to the dashboard', async () => {
    const { default: OfflinePage } = await import('@/app/offline/page');

    render(<OfflinePage />);

    const link = screen.getByRole('link', { name: /back to my dashboard/i });
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('renders a "Try Again" button for refreshing the page', async () => {
    const { RefreshButton } = await import('@/app/offline/refresh-button');

    render(<RefreshButton />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('displays a message about queued commands syncing', async () => {
    const { default: OfflinePage } = await import('@/app/offline/page');

    render(<OfflinePage />);

    expect(
      screen.getByText(/queued actions sync automatically/i)
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// usePWAInstall Hook Tests
// ---------------------------------------------------------------------------

describe('usePWAInstall hook', () => {
  let originalMatchMedia: typeof window.matchMedia;
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    mockLocalStorage = {};

    // jsdom localStorage can be unreliable; provide a mock that always works.
    const storageMock = {
      getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
      clear: vi.fn(() => {
        mockLocalStorage = {};
      }),
      get length() {
        return Object.keys(mockLocalStorage).length;
      },
      key: vi.fn((index: number) => Object.keys(mockLocalStorage)[index] ?? null),
    };

    Object.defineProperty(window, 'localStorage', {
      value: storageMock,
      writable: true,
      configurable: true,
    });

    // Default: not in standalone mode
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)' ? false : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 4A.3.1: Default states
  // -----------------------------------------------------------------------
  it('starts with canInstall=false when no beforeinstallprompt has fired', async () => {
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(await import('@/hooks/usePWAInstall'));

    render(<HookTestComponent />);

    expect(screen.getByTestId('canInstall').textContent).toBe('false');
  });

  it('starts with isInstalled=false when not in standalone mode', async () => {
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(await import('@/hooks/usePWAInstall'));

    render(<HookTestComponent />);

    expect(screen.getByTestId('isInstalled').textContent).toBe('false');
  });

  it('starts with isDismissed=false when localStorage has no dismissal', async () => {
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(await import('@/hooks/usePWAInstall'));

    render(<HookTestComponent />);

    expect(screen.getByTestId('isDismissed').textContent).toBe('false');
  });

  // -----------------------------------------------------------------------
  // 4A.3.2: isInstalled=true when in standalone mode
  // -----------------------------------------------------------------------
  it('sets isInstalled=true when display-mode is standalone', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    // Re-import to pick up the new matchMedia
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    render(<HookTestComponent />);

    expect(screen.getByTestId('isInstalled').textContent).toBe('true');
  });

  // -----------------------------------------------------------------------
  // 4A.3.3: isDismissed=true when localStorage has dismissal
  // -----------------------------------------------------------------------
  it('sets isDismissed=true when localStorage has pwa-install-dismissed=true', async () => {
    window.localStorage.setItem('pwa-install-dismissed', 'true');

    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    render(<HookTestComponent />);

    expect(screen.getByTestId('isDismissed').textContent).toBe('true');
  });

  // -----------------------------------------------------------------------
  // 4A.3.4: canInstall becomes true when beforeinstallprompt fires
  // -----------------------------------------------------------------------
  it('sets canInstall=true when beforeinstallprompt event fires', async () => {
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    render(<HookTestComponent />);

    expect(screen.getByTestId('canInstall').textContent).toBe('false');

    // Simulate the browser firing beforeinstallprompt
    const promptEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(promptEvent, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });

    await act(async () => {
      window.dispatchEvent(promptEvent);
    });

    expect(screen.getByTestId('canInstall').textContent).toBe('true');
  });

  // -----------------------------------------------------------------------
  // 4A.3.5: dismiss() stores dismissal in localStorage
  // -----------------------------------------------------------------------
  it('stores dismissal in localStorage when dismiss() is called', async () => {
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    const user = userEvent.setup();
    render(<HookTestComponent />);

    expect(screen.getByTestId('isDismissed').textContent).toBe('false');

    await user.click(screen.getByTestId('dismiss-btn'));

    expect(screen.getByTestId('isDismissed').textContent).toBe('true');
    expect(window.localStorage.getItem('pwa-install-dismissed')).toBe('true');
  });

  // -----------------------------------------------------------------------
  // 4A.3.6: install() calls prompt and returns outcome
  // -----------------------------------------------------------------------
  it('calls prompt() and sets isInstalled=true when user accepts', async () => {
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    const user = userEvent.setup();
    render(<HookTestComponent />);

    // Fire beforeinstallprompt to make canInstall=true
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const promptEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(promptEvent, {
      prompt: mockPrompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });

    await act(async () => {
      window.dispatchEvent(promptEvent);
    });

    expect(screen.getByTestId('canInstall').textContent).toBe('true');

    // Click install
    await user.click(screen.getByTestId('install-btn'));

    expect(mockPrompt).toHaveBeenCalled();
    expect(screen.getByTestId('isInstalled').textContent).toBe('true');
    expect(screen.getByTestId('canInstall').textContent).toBe('false');
  });

  // -----------------------------------------------------------------------
  // 4A.3.7: install() returns false when user dismisses
  // -----------------------------------------------------------------------
  it('sets canInstall=false but isInstalled remains false when user dismisses prompt', async () => {
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    const user = userEvent.setup();
    render(<HookTestComponent />);

    // Fire beforeinstallprompt
    const promptEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(promptEvent, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    });

    await act(async () => {
      window.dispatchEvent(promptEvent);
    });

    await user.click(screen.getByTestId('install-btn'));

    expect(screen.getByTestId('isInstalled').textContent).toBe('false');
    expect(screen.getByTestId('canInstall').textContent).toBe('false');
  });

  // -----------------------------------------------------------------------
  // 4A.3.8: appinstalled event sets isInstalled=true
  // -----------------------------------------------------------------------
  it('sets isInstalled=true when appinstalled event fires', async () => {
    vi.resetModules();
    const mod = await import('@/hooks/usePWAInstall');
    const { HookTestComponent, setModule } = createHookTestComponent();
    setModule(mod);

    render(<HookTestComponent />);

    expect(screen.getByTestId('isInstalled').textContent).toBe('false');

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(screen.getByTestId('isInstalled').textContent).toBe('true');
    expect(screen.getByTestId('canInstall').textContent).toBe('false');
  });
});
