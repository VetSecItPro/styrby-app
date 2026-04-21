/**
 * Tests for useWebPush.
 *
 * WHY: This hook is the seam between the settings UI and the Push API. The
 * critical invariants:
 *   1. On an unsupported browser, `supported` becomes false and we never
 *      attempt to subscribe.
 *   2. Subscribe posts to /api/push/subscribe with the subscription JSON.
 *   3. Unsubscribe hits the SERVER first, then the browser — otherwise the
 *      browser forgets the subscription but the server keeps sending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebPush } from '../use-web-push';

type WritableNav = Navigator & { serviceWorker?: unknown };

describe('useWebPush', () => {
  const originalPushManager = (globalThis as unknown as { PushManager?: unknown })
    .PushManager;
  const originalNotification = (globalThis as unknown as { Notification?: unknown })
    .Notification;

  beforeEach(() => {
    // Clean slate for each test
    delete (globalThis as unknown as { PushManager?: unknown }).PushManager;
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
  });

  afterEach(() => {
    (globalThis as unknown as { PushManager?: unknown }).PushManager =
      originalPushManager;
    (globalThis as unknown as { Notification?: unknown }).Notification =
      originalNotification;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).serviceWorker;
  });

  it('reports unsupported when PushManager is absent', async () => {
    const { result } = renderHook(() => useWebPush());
    // Effect runs synchronously for the support check
    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.subscribed).toBe(false);
  });

  it('subscribe posts subscription JSON to /api/push/subscribe and sets subscribed=true', async () => {
    // Arrange a supported environment
    (globalThis as unknown as { PushManager: unknown }).PushManager = class {};
    const subscriptionJson = { endpoint: 'https://push.example/e1', keys: {} };
    const fakeSubscription = {
      endpoint: subscriptionJson.endpoint,
      toJSON: () => subscriptionJson,
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(fakeSubscription),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).serviceWorker = {
      ready: Promise.resolve({ pushManager }),
    };
    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useWebPush({ fetchImpl, getVapidKey: () => 'SGVsbG8' })
    );

    await waitFor(() => expect(result.current.supported).toBe(true));
    await act(async () => {
      await result.current.subscribe();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({ method: 'POST' })
    );
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.parse(call.body)).toEqual(subscriptionJson);
    expect(result.current.subscribed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('unsubscribe calls server BEFORE local unsubscribe; local remains subscribed if server fails', async () => {
    (globalThis as unknown as { PushManager: unknown }).PushManager = class {};
    const localUnsub = vi.fn().mockResolvedValue(true);
    const existing = {
      endpoint: 'https://push.example/existing',
      toJSON: () => ({ endpoint: 'https://push.example/existing' }),
      unsubscribe: localUnsub,
    };
    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue(existing),
      subscribe: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).serviceWorker = {
      ready: Promise.resolve({ pushManager }),
    };
    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission: 'granted',
      requestPermission: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'server boom' }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useWebPush({ fetchImpl }));
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.objectContaining({ method: 'DELETE' })
    );
    // WHY: server failed => local must NOT unsubscribe, otherwise ghost subs.
    expect(localUnsub).not.toHaveBeenCalled();
    expect(result.current.error).toBe('server boom');
  });

  it('subscribe surfaces a missing-VAPID-key as an error without calling fetch', async () => {
    (globalThis as unknown as { PushManager: unknown }).PushManager = class {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).serviceWorker = {
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
      }),
    };
    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useWebPush({ fetchImpl, getVapidKey: () => undefined })
    );
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/configuration is missing/i);
  });
});
