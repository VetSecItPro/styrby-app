/**
 * Feedback Submission API
 *
 * POST /api/feedback/submit
 *
 * Handles all user-submitted feedback kinds:
 *   - 'nps' (NPS survey response from 7d or 30d prompt)
 *   - 'general' (in-app feedback button on web and mobile)
 *   - 'session_postmortem' (session summary screen widget)
 *
 * On submission:
 *   1. Validates input with Zod
 *   2. Inserts into user_feedback
 *   3. For NPS: links to user_feedback_prompts (sets response_id)
 *   4. For general: forwards to founder email via Resend
 *   5. For negative post-mortem: sends founder alert email
 *   6. Writes audit_log row (SOC2 CC7.2)
 *
 * WHY one route for all kinds: Reduces surface area; the kind field
 * determines the processing path. A unified submission point also makes
 * rate limiting consistent (one token bucket per user across all feedback).
 *
 * @auth Required - Supabase Auth JWT (cookie or Authorization header)
 * @rateLimit 10 submissions per user per 15 minutes
 *
 * @body {
 *   kind: 'nps' | 'general' | 'session_postmortem',
 *   score?: number,         // 0-10 (NPS)
 *   followup?: string,      // NPS follow-up free text (max 2000 chars)
 *   window?: '7d' | '30d', // NPS window
 *   promptId?: string,      // UUID of user_feedback_prompts row (NPS)
 *   message?: string,       // General feedback text (max 2000 chars)
 *   replyEmail?: string,    // Optional reply-to for general feedback
 *   sessionId?: string,     // UUID of session (post-mortem)
 *   rating?: 'useful' | 'not_useful', // Post-mortem tap
 *   reason?: string,        // Post-mortem reason (max 500 chars)
 *   contextJson?: Record<string, unknown>, // Route / screen context (no PII)
 * }
 *
 * @returns 201 { success: true, feedbackId: string }
 *
 * @error 400 { error: 'VALIDATION_ERROR', details: ZodError }
 * @error 401 { error: 'UNAUTHORIZED' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { sendEmail } from '@/lib/resend';
import * as React from 'react';
import FeedbackAlertEmail from '@/emails/feedback-alert';
import NegativePostmortemEmail from '@/emails/negative-postmortem';

// ============================================================================
// Validation Schema
// ============================================================================

/**
 * Context JSON schema — only permits non-PII structural fields.
 *
 * WHY: GDPR data minimisation (Art. 5(1)(c)). We want route/screen for
 * debugging and product insights, NOT user content or identifiers.
 */
const ContextJsonSchema = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .transform((val) => {
    if (!val) return {};
    // Strip any keys that look like PII identifiers
    const stripped: Record<string, unknown> = {};
    const allowedKeys = ['screen', 'route', 'agent', 'tab', 'section', 'from'];
    for (const key of allowedKeys) {
      if (key in val) stripped[key] = val[key];
    }
    return stripped;
  });

/** Input validation schema for all feedback kinds. */
const FeedbackSubmitSchema = z
  .discriminatedUnion('kind', [
    // NPS survey response
    z.object({
      kind: z.literal('nps'),
      score: z.number().int().min(0).max(10),
      followup: z.string().max(2000).optional(),
      window: z.enum(['7d', '30d']),
      promptId: z.string().uuid().optional(),
      contextJson: ContextJsonSchema,
    }),
    // In-app general feedback
    z.object({
      kind: z.literal('general'),
      message: z.string().min(1).max(2000),
      replyEmail: z.string().email().optional(),
      contextJson: ContextJsonSchema,
    }),
    // Session post-mortem widget
    z.object({
      kind: z.literal('session_postmortem'),
      sessionId: z.string().uuid(),
      rating: z.enum(['useful', 'not_useful']),
      reason: z.string().max(500).optional(),
      contextJson: ContextJsonSchema,
    }),
  ]);

type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

// ============================================================================
// Founder email address
// ============================================================================

/** WHY constant: Prevents typo bugs and makes it easy to update. */
const FOUNDER_EMAIL =
  process.env.FOUNDER_EMAIL ?? 'vetsecitpro@gmail.com';

// ============================================================================
// POST handler
// ============================================================================

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  // WHY: Feedback endpoint is public-facing (no CRON_SECRET). Rate limit
  // prevents abuse — e.g. flooding the founder email inbox.
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.FEEDBACK_SUBMIT, 'feedback-submit');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // ── Parse & validate body ─────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parsed = FeedbackSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const adminSupabase = createAdminClient();

  try {
    // ── Insert user_feedback row ───────────────────────────────────────────
    const feedbackRow = buildFeedbackRow(user.id, input);

    const { data: feedbackInserted, error: fbErr } = await adminSupabase
      .from('user_feedback')
      .insert(feedbackRow)
      .select('id')
      .single();

    if (fbErr || !feedbackInserted) {
      console.error('[feedback/submit] insert error:', fbErr);
      return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    }

    const feedbackId = feedbackInserted.id;

    // ── Kind-specific post-processing ─────────────────────────────────────
    if (input.kind === 'nps') {
      await handleNpsPostProcess(adminSupabase, user.id, feedbackId, input);
    } else if (input.kind === 'general') {
      await handleGeneralFeedbackEmail(user.id, feedbackId, input);
    } else if (input.kind === 'session_postmortem') {
      await handlePostmortemAlert(adminSupabase, user.id, feedbackId, input);
    }

    // ── Audit log (SOC2 CC7.2) ────────────────────────────────────────────
    await adminSupabase.from('audit_log').insert({
      user_id: user.id,
      event_type: 'feedback_submitted',
      metadata: {
        feedback_id: feedbackId,
        kind: input.kind,
        ...(input.kind === 'nps' && { window: input.window, score: input.score }),
        ...(input.kind === 'session_postmortem' && {
          rating: input.rating,
          session_id: input.sessionId,
        }),
      },
    });

    return NextResponse.json({ success: true, feedbackId }, { status: 201 });
  } catch (err) {
    console.error('[feedback/submit] unexpected error:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the user_feedback insert row from validated input.
 *
 * Maps discriminated union fields to the flat DB schema.
 * WHY helper: keeps the POST handler readable and the mapping testable.
 *
 * @param userId - Authenticated user ID
 * @param input - Validated and parsed input
 * @returns Object ready for Supabase insert
 */
function buildFeedbackRow(
  userId: string,
  input: FeedbackSubmitInput
): Record<string, unknown> {
  const base = {
    user_id: userId,
    kind: input.kind,
    platform: 'web' as const,
    context_json: input.contextJson ?? {},
  };

  if (input.kind === 'nps') {
    return {
      ...base,
      feedback_type: 'nps',
      score: input.score,
      followup: input.followup ?? null,
      window: input.window,
      prompt_id: input.promptId ?? null,
      // Backwards compat: also set rating INT for old queries
      rating: input.score,
    };
  }

  if (input.kind === 'general') {
    return {
      ...base,
      feedback_type: 'general',
      message: input.message,
    };
  }

  // session_postmortem
  return {
    ...base,
    feedback_type: 'general', // closest legacy mapping
    session_id: input.sessionId,
    rating: input.rating,
    reason: input.reason ?? null,
    message: input.reason ?? null,
  };
}

/**
 * NPS post-processing:
 *  - Links the feedback row back to the prompt via response_id
 *  - Marks prompt as responded
 *
 * @param supabase - Admin client
 * @param userId - Submitting user's ID
 * @param feedbackId - Newly created feedback UUID
 * @param input - NPS-kind validated input
 */
async function handleNpsPostProcess(
  supabase: ReturnType<typeof createAdminClient>,
  _userId: string,
  feedbackId: string,
  input: Extract<FeedbackSubmitInput, { kind: 'nps' }>
): Promise<void> {
  if (!input.promptId) return;

  // Link the response to the prompt
  const { error } = await supabase
    .from('user_feedback_prompts')
    .update({ response_id: feedbackId })
    .eq('id', input.promptId);

  if (error) {
    // WHY non-fatal: The feedback row was already inserted. Failing to link
    // the prompt is a data quality issue, not a blocking error for the user.
    console.warn('[feedback/submit] failed to link NPS prompt:', error);
  }
}

/**
 * General feedback post-processing: forward to founder email via Resend.
 *
 * WHY: Founders need to see every general feedback submission. The Resend
 * notification is a "founder alert" pattern — you get an email for every
 * submission so nothing falls through the cracks. At scale, this would
 * be rate-limited or batched, but at launch volume (< 100/day) it's fine.
 *
 * @param userId - Submitting user's ID (for the email)
 * @param feedbackId - Newly created feedback UUID
 * @param input - general-kind validated input
 */
async function handleGeneralFeedbackEmail(
  userId: string,
  feedbackId: string,
  input: Extract<FeedbackSubmitInput, { kind: 'general' }>
): Promise<void> {
  const result = await sendEmail({
    to: FOUNDER_EMAIL,
    subject: `New Styrby feedback: ${input.message.slice(0, 80)}${input.message.length > 80 ? '...' : ''}`,
    react: React.createElement(FeedbackAlertEmail, {
      userId,
      message: input.message,
      replyEmail: input.replyEmail,
      feedbackId,
      screen: String(input.contextJson?.screen ?? ''),
    }),
    replyTo: input.replyEmail ?? FOUNDER_EMAIL,
  });

  if (!result.success) {
    // WHY non-fatal: Email delivery is best-effort. The feedback was stored
    // in the DB. Founder can see it in the dashboard.
    console.warn('[feedback/submit] founder email failed:', result.error);
  }
}

/**
 * Negative post-mortem alert: send founder email when rating = 'not_useful'
 * AND reason has more than 20 characters.
 *
 * WHY threshold of 20 chars: Short reasons ("bad") provide no actionable
 * signal. The 20-char threshold ensures the email contains useful context.
 *
 * WHY anonymized: The user_id is hashed (SHA-256 prefix) in the email. We
 * don't expose the actual user ID to protect privacy, but we include enough
 * context to correlate with Supabase if needed.
 *
 * @param supabase - Admin client (to look up session agent details)
 * @param userId - Submitting user's ID
 * @param feedbackId - Newly created feedback UUID
 * @param input - session_postmortem-kind validated input
 */
async function handlePostmortemAlert(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  feedbackId: string,
  input: Extract<FeedbackSubmitInput, { kind: 'session_postmortem' }>
): Promise<void> {
  if (input.rating !== 'not_useful') return;
  if (!input.reason || input.reason.length <= 20) return;

  // Fetch session context for the email (agent type, duration)
  const { data: session } = await supabase
    .from('sessions')
    .select('agent_type, started_at, ended_at')
    .eq('id', input.sessionId)
    .single();

  // Hash user_id for anonymization in the email (partial SHA-256 prefix)
  const { createHash } = await import('crypto');
  const userIdHash = createHash('sha256')
    .update(userId)
    .digest('hex')
    .slice(0, 12);

  const durationMin =
    session?.started_at && session?.ended_at
      ? Math.round(
          (new Date(session.ended_at).getTime() -
            new Date(session.started_at).getTime()) /
            60000
        )
      : null;

  const result = await sendEmail({
    to: FOUNDER_EMAIL,
    subject: `[Styrby] Negative session feedback - ${session?.agent_type ?? 'unknown'} - ${durationMin != null ? durationMin + ' min' : '?'}`,
    react: React.createElement(NegativePostmortemEmail, {
      userIdHash,
      agentType: session?.agent_type ?? 'unknown',
      durationMin,
      reason: input.reason,
      sessionId: input.sessionId,
      feedbackId,
    }),
  });

  if (!result.success) {
    console.warn('[feedback/submit] negative postmortem email failed:', result.error);
  }
}
