/**
 * Tests for lib/config.ts — getAppUrl helper.
 *
 * WHY: Two route files previously used different hardcoded domain fallbacks.
 * getAppUrl() centralises the canonical URL. These tests lock in the fallback
 * behaviour and warn-not-throw contract so a future refactor cannot silently
 * change the canonical domain or start throwing on a missing env var.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };
const originalNodeEnv = process.env.NODE_ENV;

/**
 * WHY Object.defineProperty: NODE_ENV is typed as read-only in TypeScript's
 * NodeJS.ProcessEnv. We need to override it per-test to exercise the production
 * vs. development code path in getAppUrl(). defineProperty bypasses the
 * TS readonly constraint without casting and is the standard testing pattern.
 */
function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', { value, writable: true, configurable: true });
}

describe('getAppUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setNodeEnv(originalNodeEnv);
  });

  it('returns the env var value when NEXT_PUBLIC_APP_URL is set', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://custom.styrby.dev';
    const { getAppUrl } = await import('../config');
    expect(getAppUrl()).toBe('https://custom.styrby.dev');
  });

  it('falls back to https://styrbyapp.com in production when env var is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    setNodeEnv('production');
    const { getAppUrl } = await import('../config');
    expect(getAppUrl()).toBe('https://styrbyapp.com');
  });

  it('falls back to https://styrbyapp.com in development and emits a console.warn', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    setNodeEnv('development');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getAppUrl } = await import('../config');
    const result = getAppUrl();

    expect(result).toBe('https://styrbyapp.com');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_APP_URL'));
    warnSpy.mockRestore();
  });

  it('does NOT emit console.warn in production when env var is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    setNodeEnv('production');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getAppUrl } = await import('../config');
    getAppUrl();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns value without trailing slash when env var has no slash', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.styrby.com';
    const { getAppUrl } = await import('../config');
    expect(getAppUrl()).not.toMatch(/\/$/);
  });
});
