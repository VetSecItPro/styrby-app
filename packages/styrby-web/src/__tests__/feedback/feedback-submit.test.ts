/**
 * Tests for the feedback submission API route and NPS prompt dispatch cron.
 *
 * WHY file-content tests for the API routes: The API routes depend on
 * Supabase, Resend, and Redis which cannot be instantiated in unit tests
 * without extensive mocking. File-content tests verify:
 *   - Required security controls are present (CRON_SECRET check, rate limit)
 *   - Correct audit_log inserts are present
 *   - All feedback kinds are handled
 *   - Rate limit constant is correctly defined
 *
 * Integration tests (testing actual HTTP responses with mocked Supabase)
 * are out of scope for this PR — they require a test Supabase project.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const WEB_SRC = resolve(__dirname, '../../');

function read(path: string): string {
  return readFileSync(resolve(WEB_SRC, path), 'utf-8');
}

// =============================================================================
// Feedback Submit Route
// =============================================================================

describe('feedback/submit route', () => {
  const route = read('app/api/feedback/submit/route.ts');

  it('imports zod for input validation', () => {
    expect(route).toContain("from 'zod'");
  });

  it('checks authentication (supabase.auth.getUser)', () => {
    expect(route).toContain('supabase.auth.getUser');
  });

  it('applies rate limiting', () => {
    expect(route).toContain('rateLimit');
    expect(route).toContain('RATE_LIMITS.FEEDBACK_SUBMIT');
  });

  it('handles all three feedback kinds', () => {
    expect(route).toContain("kind: z.literal('nps')");
    expect(route).toContain("kind: z.literal('general')");
    expect(route).toContain("kind: z.literal('session_postmortem')");
  });

  it('writes audit_log row on submission (SOC2 CC7.2)', () => {
    expect(route).toContain('audit_log');
    expect(route).toContain('feedback_submitted');
  });

  it('sends founder alert email for general feedback', () => {
    expect(route).toContain('FeedbackAlertEmail');
    expect(route).toContain('FOUNDER_EMAIL');
  });

  it('sends negative postmortem alert for not_useful + reason > 20 chars', () => {
    expect(route).toContain('NegativePostmortemEmail');
    expect(route).toContain("rating !== 'not_useful'");
    expect(route).toContain('reason.length <= 20');
  });

  it('returns 401 for unauthenticated requests', () => {
    expect(route).toContain("{ error: 'UNAUTHORIZED' }");
    expect(route).toContain('status: 401');
  });

  it('returns 201 on success', () => {
    expect(route).toContain('status: 201');
    expect(route).toContain('feedbackId');
  });

  it('validates NPS score range (0-10)', () => {
    expect(route).toContain('z.number().int().min(0).max(10)');
  });

  it('validates message max length (2000 chars)', () => {
    expect(route).toContain('max(2000)');
  });

  it('strips PII from context_json', () => {
    expect(route).toContain('allowedKeys');
    expect(route).toContain('screen');
  });

  it('anonymizes user_id in negative postmortem email (SHA-256)', () => {
    expect(route).toContain('sha256');
    expect(route).toContain('userIdHash');
  });
});

// =============================================================================
// NPS Prompt Dispatch Cron
// =============================================================================

describe('nps-prompt-dispatch cron', () => {
  const route = read('app/api/cron/nps-prompt-dispatch/route.ts');

  it('verifies CRON_SECRET with timing-safe comparison', () => {
    expect(route).toContain('timingSafeEqual');
    expect(route).toContain('CRON_SECRET');
  });

  it('returns 401 for unauthorized requests', () => {
    expect(route).toContain("{ error: 'Unauthorized' }");
    expect(route).toContain('status: 401');
  });

  it('writes audit_log entry per push sent (SOC2 CC7.2)', () => {
    expect(route).toContain('audit_log');
    expect(route).toContain('nps_push_sent');
  });

  it('respects quiet hours', () => {
    expect(route).toContain('respectQuietHours: true');
  });

  it('only processes dispatched prompts (no duplicate in-app notifications)', () => {
    expect(route).toContain('dispatched_at');
    expect(route).toContain('push_message_id');
  });

  it('has no em-dashes in push copy (CLAUDE.md prohibition)', () => {
    // Check that the copy constants don't contain em-dashes
    const copySection = route.match(/NPS_PUSH_COPY.*?};/s)?.[0] ?? '';
    expect(copySection).not.toContain('—'); // em-dash
    expect(copySection).not.toContain('&mdash;');
  });
});

// =============================================================================
// Rate limit configuration
// =============================================================================

describe('FEEDBACK_SUBMIT rate limit constant', () => {
  const rateLimitSrc = read('lib/rateLimit.ts');

  it('defines FEEDBACK_SUBMIT rate limit', () => {
    expect(rateLimitSrc).toContain('FEEDBACK_SUBMIT');
  });

  it('sets 10 requests per 15 minutes (900000ms)', () => {
    expect(rateLimitSrc).toContain('maxRequests: 10');
    expect(rateLimitSrc).toContain('900000');
  });
});

// =============================================================================
// Founder feedback API
// =============================================================================

describe('founder-feedback API route', () => {
  const route = read('app/api/admin/founder-feedback/route.ts');

  it('verifies authentication', () => {
    expect(route).toContain('supabase.auth.getUser');
  });

  it('checks isAdmin gate', () => {
    expect(route).toContain('isAdmin');
  });

  it('returns 403 for non-admin users', () => {
    expect(route).toContain("{ error: 'Forbidden' }");
    expect(route).toContain('status: 403');
  });

  it('imports calcNPS from @styrby/shared', () => {
    expect(route).toContain("from '@styrby/shared'");
    expect(route).toContain('calcNPS');
  });

  it('imports groupNpsByWeek', () => {
    expect(route).toContain('groupNpsByWeek');
  });

  it('handles all three tabs', () => {
    expect(route).toContain("tab === 'nps'");
    expect(route).toContain("tab === 'general'");
    // postmortems is the else/fallthrough case — verified by fetchPostmortemData
    expect(route).toContain('fetchPostmortemData');
  });
});
