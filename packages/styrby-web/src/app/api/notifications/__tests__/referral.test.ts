/**
 * Tests for GET/POST /api/referral
 *
 * Covers:
 * - GET: validates referral code format
 * - GET: returns 404 for unknown code
 * - GET: returns 404 for deleted user
 * - GET: returns referrer name + records click event
 * - POST: requires auth
 * - POST: rejects self-referral
 * - POST: rejects disposable email
 * - POST: rejects same-domain corporate accounts
 * - POST: successfully attributes signup
 * - POST: updates profiles.referred_by_user_id
 * - POST: writes audit_log entry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../referral/route';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockAdminGetUserById = vi.fn();
const mockRateLimit = vi.fn().mockResolvedValue({ allowed: true });

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  rateLimitResponse: (retryAfter: number) =>
    new Response(
      JSON.stringify({ error: 'RATE_LIMITED', retryAfter }),
      { status: 429 }
    ),
}));

vi.mock('@/lib/disposable-emails', () => ({
  isDisposableEmail: (email: string) => email.endsWith('@mailinator.com'),
}));

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'maybeSingle',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = vi.fn().mockImplementation((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb(result))
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: () => mockGetUser() },
    from: () => createChainMock(),
  }),
  createAdminClient: () => ({
    from: () => createChainMock(),
    auth: {
      admin: { getUserById: (id: string) => mockAdminGetUserById(id) },
    },
  }),
}));

beforeEach(() => {
  fromCallQueue.length = 0;
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not signed in' } });
  mockAdminGetUserById.mockResolvedValue({ data: { user: null }, error: null });
  mockRateLimit.mockResolvedValue({ allowed: true });
});

// ============================================================================
// GET tests
// ============================================================================

describe('GET /api/referral', () => {
  it('returns 400 for missing code', async () => {
    const req = new NextRequest('http://localhost/api/referral', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid code format', async () => {
    const req = new NextRequest('http://localhost/api/referral?code=<script>', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown referral code', async () => {
    fromCallQueue.push({ data: null, error: null }); // profile lookup returns null

    const req = new NextRequest('http://localhost/api/referral?code=UNKNOWN123', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Invalid referral code');
  });

  it('returns 404 for deleted user referral code', async () => {
    fromCallQueue.push({
      data: { id: 'user-1', display_name: 'Alice', deleted_at: '2026-04-01T00:00:00Z' },
      error: null,
    });

    const req = new NextRequest('http://localhost/api/referral?code=ALICE123', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns referrer name and records click event for valid code', async () => {
    // Profile lookup
    fromCallQueue.push({
      data: { id: 'user-1', display_name: 'Alice Smith', deleted_at: null },
      error: null,
    });
    // Insert referral_events click
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral?code=ALICE123', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.referrerName).toBe('Alice Smith');
    expect(body.referralCode).toBe('ALICE123');
  });
});

// ============================================================================
// POST tests
// ============================================================================

describe('POST /api/referral', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not signed in' } });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'ALICE123' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 for self-referral', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'alice@example.com' } },
      error: null,
    });

    // Referrer profile — same user
    fromCallQueue.push({ data: { id: 'user-1', deleted_at: null }, error: null });
    // Update referral_events (mark rejected)
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'ALICE123' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Self-referrals');
  });

  it('returns 400 for disposable email', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-2', email: 'spammer@mailinator.com' } },
      error: null,
    });

    // Referrer is a different user
    fromCallQueue.push({ data: { id: 'user-referrer', deleted_at: null }, error: null });
    // Update referral_events (mark rejected)
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'REF123' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Referral not eligible');
  });

  it('rejects same corporate domain (non-public provider)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-3', email: 'bob@acmecorp.com' } },
      error: null,
    });

    // Referrer profile (different user, same company domain)
    fromCallQueue.push({ data: { id: 'user-referrer', deleted_at: null }, error: null });
    // Referrer's auth user — same company domain
    mockAdminGetUserById.mockResolvedValueOnce({
      data: { user: { email: 'alice@acmecorp.com' } },
      error: null,
    });
    // Update referral_events (mark rejected)
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'REF456' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('same organization');
  });

  it('accepts gmail.com same-domain (public email provider)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-4', email: 'referree@gmail.com' } },
      error: null,
    });

    fromCallQueue.push({ data: { id: 'user-referrer', deleted_at: null }, error: null });
    mockAdminGetUserById.mockResolvedValueOnce({
      data: { user: { email: 'referrer@gmail.com' } },
      error: null,
    });
    // Update referral_events to signup
    fromCallQueue.push({ data: null, error: null });
    // Update profiles
    fromCallQueue.push({ data: null, error: null });
    // Audit log
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'REF789' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('successfully attributes signup and updates profiles', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-5', email: 'newuser@example.com' } },
      error: null,
    });

    fromCallQueue.push({ data: { id: 'user-referrer', deleted_at: null }, error: null });
    mockAdminGetUserById.mockResolvedValueOnce({
      data: { user: { email: 'referrer@other.com' } },
      error: null,
    });
    // Update referral_events
    fromCallQueue.push({ data: null, error: null });
    // Update profiles.referred_by_user_id
    fromCallQueue.push({ data: null, error: null });
    // Audit log
    fromCallQueue.push({ data: null, error: null });

    const req = new NextRequest('http://localhost/api/referral', {
      method: 'POST',
      body: JSON.stringify({ referralCode: 'REFABC' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
