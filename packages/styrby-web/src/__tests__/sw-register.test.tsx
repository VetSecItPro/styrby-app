/**
 * Tests for the SWRegister component.
 *
 * Validates the full service worker lifecycle managed by the component:
 * registration, update detection, SKIP_WAITING message flow, event listener
 * cleanup on unmount, and graceful degradation when SW is not supported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { SWRegister } from '@/components/sw-register';

// ---------------------------------------------------------------------------
// Mock offlineQueue (imported by sw-register)
// ---------------------------------------------------------------------------
/**
 * The offlineQueue.processQueue() is called with .catch() chained in the
 * source code, so the mock must return a real Promise (not just a resolved
 * value). vi.fn().mockResolvedValue handles this correctly since it returns
 * a proper Promise.
 */
vi.mock('@/lib/offlineQueue', () => ({
  offlineQueue: {
    processQueue: vi.fn(() => Promise.resolve()),
  },
}));

// ---------------------------------------------------------------------------
// Helpers for building mock ServiceWorker / Registration objects
// ---------------------------------------------------------------------------

type SWStateChangeListener = () => void;
type EventCallback = (...args: unknown[]) => void;

/**
 * Creates a mock ServiceWorker object with controllable state.
 */
function createMockServiceWorker(
  initialState: string = 'installing'
): ServiceWorker & { _stateChangeListeners: SWStateChangeListener[] } {
  const listeners: SWStateChangeListener[] = [];
  return {
    state: initialState,
    scriptURL: 'http://localhost/sw.js',
    onstatechange: null,
    onerror: null,
    postMessage: vi.fn(),
    addEventListener: vi.fn((_event: string, cb: EventCallback) => {
      if (_event === 'statechange') listeners.push(cb as SWStateChangeListener);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    _stateChangeListeners: listeners,
  } as unknown as ServiceWorker & { _stateChangeListeners: SWStateChangeListener[] };
}

/**
 * Creates a mock ServiceWorkerRegistration.
 */
function createMockRegistration(overrides: Partial<ServiceWorkerRegistration> = {}) {
  const listeners = new Map<string, EventCallback[]>();
  return {
    scope: '/',
    active: null,
    installing: null,
    waiting: null,
    navigationPreload: {} as NavigationPreloadManager,
    pushManager: {} as PushManager,
    updateViaCache: 'none' as ServiceWorkerUpdateViaCache,
    onupdatefound: null,
    unregister: vi.fn(),
    update: vi.fn(),
    showNotification: vi.fn(),
    getNotifications: vi.fn(),
    addEventListener: vi.fn((type: string, cb: EventCallback) => {
      const existing = listeners.get(type) || [];
      existing.push(cb);
      listeners.set(type, existing);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    _listeners: listeners,
    ...overrides,
  } as unknown as ServiceWorkerRegistration & {
    _listeners: Map<string, EventCallback[]>;
  };
}

// ---------------------------------------------------------------------------
// Mock navigator.serviceWorker
// ---------------------------------------------------------------------------

let swContainerListeners: Map<string, EventCallback[]>;
let mockRegistration: ReturnType<typeof createMockRegistration>;
let mockRegisterFn: ReturnType<typeof vi.fn>;

function setupServiceWorkerMock(opts: { supported?: boolean; controller?: boolean } = {}) {
  const { supported = true, controller = true } = opts;
  swContainerListeners = new Map();
  mockRegistration = createMockRegistration();
  mockRegisterFn = vi.fn().mockResolvedValue(mockRegistration);

  if (!supported) {
    // Simulate browser without SW support by deleting the property entirely.
    // The `in` operator checks property existence, so setting to undefined
    // is not sufficient; we must actually remove it from the prototype chain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).serviceWorker;
    return;
  }

  const swContainer = {
    register: mockRegisterFn,
    controller: controller ? { scriptURL: '/sw.js' } : null,
    ready: Promise.resolve(mockRegistration),
    oncontrollerchange: null,
    onmessage: null,
    onmessageerror: null,
    startMessages: vi.fn(),
    addEventListener: vi.fn((type: string, cb: EventCallback) => {
      const existing = swContainerListeners.get(type) || [];
      existing.push(cb);
      swContainerListeners.set(type, existing);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    getRegistration: vi.fn(),
    getRegistrations: vi.fn(),
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    value: swContainer,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SWRegister', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupServiceWorkerMock();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 4A.1.1: Registers SW on mount
  // -----------------------------------------------------------------------
  it('registers the service worker on mount', async () => {
    await act(async () => {
      render(<SWRegister />);
    });

    expect(mockRegisterFn).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      type: 'classic',
    });
  });

  // -----------------------------------------------------------------------
  // 4A.1.2: Shows update banner when SW update is already waiting
  // -----------------------------------------------------------------------
  it('shows update banner when a waiting worker exists on registration', async () => {
    const waitingWorker = createMockServiceWorker('installed');
    mockRegistration = createMockRegistration({ waiting: waitingWorker });
    mockRegisterFn.mockResolvedValue(mockRegistration);

    await act(async () => {
      render(<SWRegister />);
    });

    const banner = screen.getByRole('alert');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('A new version of Styrby is available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // 4A.1.3: Shows update banner when updatefound fires and new worker installs
  // -----------------------------------------------------------------------
  it('shows update banner when updatefound event detects a new installed worker', async () => {
    setupServiceWorkerMock({ controller: true });

    await act(async () => {
      render(<SWRegister />);
    });

    // No banner initially
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Simulate updatefound: the registration gets an installing worker
    const newWorker = createMockServiceWorker('installing');
    (mockRegistration as unknown as { installing: ServiceWorker }).installing = newWorker;

    await act(async () => {
      const updateFoundCbs = mockRegistration._listeners.get('updatefound') || [];
      for (const cb of updateFoundCbs) cb();
    });

    // Simulate the new worker transitioning to 'installed'
    (newWorker as unknown as { state: string }).state = 'installed';

    await act(async () => {
      for (const cb of newWorker._stateChangeListeners) cb();
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Update now')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // 4A.1.4: SKIP_WAITING message flow
  // -----------------------------------------------------------------------
  it('sends SKIP_WAITING to the waiting worker when Update is clicked', async () => {
    const waitingWorker = createMockServiceWorker('installed');
    mockRegistration = createMockRegistration({ waiting: waitingWorker });
    mockRegisterFn.mockResolvedValue(mockRegistration);

    await act(async () => {
      render(<SWRegister />);
    });

    const updateButton = screen.getByRole('button', { name: 'Update now' });

    await act(async () => {
      fireEvent.click(updateButton);
    });

    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Button should show "Updating..." and be disabled
    expect(screen.getByRole('button', { name: /Updating/i })).toBeDisabled();
  });

  // -----------------------------------------------------------------------
  // 4A.1.5: Cleans up event listeners on unmount
  // -----------------------------------------------------------------------
  it('removes the message event listener on unmount', async () => {
    const { unmount } = await act(async () => {
      return render(<SWRegister />);
    });

    const swContainer = navigator.serviceWorker!;

    // After mount, a 'message' listener should have been added
    expect(swContainer.addEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function)
    );

    unmount();

    // After unmount, the same listener should be removed
    expect(swContainer.removeEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function)
    );
  });

  // -----------------------------------------------------------------------
  // 4A.1.6: Does nothing when SW not supported
  // -----------------------------------------------------------------------
  it('renders nothing and does not throw when serviceWorker is not supported', async () => {
    setupServiceWorkerMock({ supported: false });

    await act(async () => {
      render(<SWRegister />);
    });

    // Should render null (no banner, no errors)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // 4A.1.7: Handles SYNC_OFFLINE_QUEUE message from SW
  // -----------------------------------------------------------------------
  it('calls offlineQueue.processQueue when SW sends SYNC_OFFLINE_QUEUE message', async () => {
    const { offlineQueue } = await import('@/lib/offlineQueue');

    await act(async () => {
      render(<SWRegister />);
    });

    // Find the message listener that was registered
    const messageCbs = swContainerListeners.get('message') || [];
    expect(messageCbs.length).toBeGreaterThan(0);

    // Simulate the SW sending a SYNC_OFFLINE_QUEUE message
    await act(async () => {
      for (const cb of messageCbs) {
        cb({ data: { type: 'SYNC_OFFLINE_QUEUE' } });
      }
    });

    expect(offlineQueue.processQueue).toHaveBeenCalled();
  });
});
