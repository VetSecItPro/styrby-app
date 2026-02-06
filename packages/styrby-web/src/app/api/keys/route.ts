/**
 * API Keys Management Route
 *
 * Provides CRUD operations for API keys. Power tier only.
 * Keys are hashed with bcrypt before storage - plaintext is never stored.
 *
 * GET    /api/keys - List user's API keys (without hashes)
 * POST   /api/keys - Create a new API key (returns plaintext once)
 * DELETE /api/keys - Revoke an API key
 *
 * @rateLimit 30 requests per minute
 *
 * Security Notes:
 * - Plaintext key is returned ONCE on creation, then never again
 * - Keys are hashed with bcrypt (cost factor 12)
 * - Revoked keys remain in database for audit trail
 * - All key operations are logged to audit_log
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { hashApiKey } from '@/lib/api-keys';
import { generateApiKey } from '@styrby/shared';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse, getClientIp } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for creating a new API key.
 */
const CreateKeySchema = z.object({
  name: z
    .string()
    .min(1, 'API key name is required')
    .max(100, 'API key name must be 100 characters or less'),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1, 'At least one scope is required')
    .optional()
    .default(['read']),
  expires_in_days: z
    .number()
    .int()
    .positive()
    .max(365, 'Expiration cannot exceed 365 days')
    .optional(),
});

/**
 * Schema for revoking an API key.
 */
const RevokeKeySchema = z.object({
  id: z.string().uuid('Invalid API key ID'),
  reason: z.string().max(500, 'Reason must be 500 characters or less').optional(),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The authenticated user's ID
 * @returns The user's tier ID (defaults to 'free' if no subscription found)
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<TierId> {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return (subscription?.tier as TierId) || 'free';
}

/**
 * Logs an audit event for API key operations.
 *
 * @param userId - The user performing the action
 * @param action - The audit action type
 * @param keyId - The API key ID involved
 * @param metadata - Additional metadata to log
 * @param ipAddress - Client IP address
 * @param userAgent - Client user agent
 */
async function logAuditEvent(
  userId: string,
  action: 'api_key_created' | 'api_key_revoked',
  keyId: string,
  metadata: Record<string, unknown>,
  ipAddress: string | null,
  userAgent: string | null
): Promise<void> {
  const supabase = createAdminClient();

  await supabase.from('audit_log').insert({
    user_id: userId,
    action,
    resource_type: 'api_key',
    resource_id: keyId,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// GET /api/keys
// ---------------------------------------------------------------------------

/**
 * GET /api/keys
 *
 * Lists all API keys for the authenticated user.
 * Returns key metadata only - never returns the hash or plaintext key.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   keys: ApiKey[],
 *   tier: TierId,
 *   keyLimit: number,
 *   keyCount: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch API keys' }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch keys and subscription tier in parallel
    const [keysResult, tier] = await Promise.all([
      supabase
        .from('api_keys')
        .select(
          `
          id,
          name,
          key_prefix,
          scopes,
          last_used_at,
          last_used_ip,
          request_count,
          expires_at,
          revoked_at,
          revoked_reason,
          created_at
        `
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      getUserTier(supabase, user.id),
    ]);

    if (keysResult.error) {
      console.error('Failed to fetch API keys:', keysResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch API keys' },
        { status: 500 }
      );
    }

    const keys = keysResult.data || [];
    const keyLimit = TIERS[tier]?.limits.apiKeys ?? 0;
    const activeKeys = keys.filter((k) => !k.revoked_at);

    return NextResponse.json({
      keys,
      tier,
      keyLimit,
      keyCount: activeKeys.length,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'API keys GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch API keys' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/keys
// ---------------------------------------------------------------------------

/**
 * POST /api/keys
 *
 * Creates a new API key. Power tier only.
 * Returns the plaintext key ONCE - it cannot be retrieved again.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   name: string,
 *   scopes?: ('read' | 'write')[],
 *   expires_in_days?: number
 * }
 *
 * @returns 201 {
 *   key: ApiKeyMetadata,
 *   secret: string  // The plaintext key - show once, warn user to save it
 * }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not Power tier or limit reached
 * @error 500 { error: 'Failed to create API key' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'api-keys');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = CreateKeySchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier and limit
    const [tier, countResult] = await Promise.all([
      getUserTier(supabase, user.id),
      supabase
        .from('api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('revoked_at', null),
    ]);

    const keyLimit = TIERS[tier]?.limits.apiKeys ?? 0;
    const currentCount = countResult.count ?? 0;

    // Check if Power tier
    if (keyLimit === 0) {
      return NextResponse.json(
        {
          error: 'API access is only available on the Power plan. Upgrade to create API keys.',
          upgrade: true,
        },
        { status: 403 }
      );
    }

    // Check limit
    if (currentCount >= keyLimit) {
      return NextResponse.json(
        {
          error: `You have reached your limit of ${keyLimit} API keys on the ${tier} plan.`,
        },
        { status: 403 }
      );
    }

    // Generate the API key
    const { key: plaintextKey, prefix } = generateApiKey();

    // Hash the key with bcrypt
    const keyHash = await hashApiKey(plaintextKey);

    // Calculate expiration if specified
    let expiresAt: string | null = null;
    if (parseResult.data.expires_in_days) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + parseResult.data.expires_in_days);
      expiresAt = expDate.toISOString();
    }

    // Insert the key
    const { data: keyRecord, error: insertError } = await supabase
      .from('api_keys')
      .insert({
        user_id: user.id,
        name: parseResult.data.name,
        key_prefix: prefix,
        key_hash: keyHash,
        scopes: parseResult.data.scopes,
        expires_at: expiresAt,
      })
      .select('id, name, key_prefix, scopes, expires_at, created_at')
      .single();

    if (insertError) {
      console.error('Failed to create API key:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    // Log the audit event
    const ipAddress = getClientIp(request);
    const userAgent = request.headers.get('user-agent');

    await logAuditEvent(
      user.id,
      'api_key_created',
      keyRecord.id,
      {
        name: parseResult.data.name,
        scopes: parseResult.data.scopes,
        expires_in_days: parseResult.data.expires_in_days || null,
      },
      ipAddress !== 'unknown' ? ipAddress : null,
      userAgent
    );

    // Return the key record and the plaintext key (shown once)
    return NextResponse.json(
      {
        key: keyRecord,
        secret: plaintextKey,
      },
      { status: 201 }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'API keys POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/keys
// ---------------------------------------------------------------------------

/**
 * DELETE /api/keys
 *
 * Revokes an API key. The key remains in the database for audit purposes
 * but can no longer be used for authentication.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   id: string (UUID),
 *   reason?: string
 * }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'API key not found' }
 * @error 500 { error: 'Failed to revoke API key' }
 */
export async function DELETE(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'api-keys');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const parseResult = RevokeKeySchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check if key exists and belongs to user
    const { data: existing } = await supabase
      .from('api_keys')
      .select('id, name')
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id)
      .is('revoked_at', null)
      .single();

    if (!existing) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      );
    }

    // Revoke the key (soft delete)
    const { error: updateError } = await supabase
      .from('api_keys')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_reason: parseResult.data.reason || null,
      })
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Failed to revoke API key:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to revoke API key' },
        { status: 500 }
      );
    }

    // Log the audit event
    const ipAddress = getClientIp(request);
    const userAgent = request.headers.get('user-agent');

    await logAuditEvent(
      user.id,
      'api_key_revoked',
      parseResult.data.id,
      {
        name: existing.name,
        reason: parseResult.data.reason || null,
      },
      ipAddress !== 'unknown' ? ipAddress : null,
      userAgent
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'API keys DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to revoke API key' },
      { status: 500 }
    );
  }
}
