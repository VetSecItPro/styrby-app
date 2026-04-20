/**
 * POST /api/internal/test-push
 *
 * Admin-only endpoint to send a test push notification to a specific device
 * token. Used for verifying that the push delivery pipeline is working end-to-end:
 *
 *   Browser/Postman → this route → send-push-notification edge function → Expo Push API → APNs/FCM → device
 *
 * This is internal-only infrastructure and must NEVER be exposed to end users.
 *
 * @auth Required - Supabase Auth JWT (admin only, checked via isAdmin())
 *
 * @body {
 *   device_token_id: string  // UUID of a row in device_tokens table
 * }
 *
 * @returns 200 {
 *   success: boolean,
 *   message: string,
 *   edgeFunctionResponse: object  // raw response from send-push-notification
 * }
 *
 * @error 400 { error: string }  // missing/invalid device_token_id
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }  // not admin
 * @error 404 { error: 'Device token not found' }
 * @error 500 { error: string }
 *
 * ----------------------------------------------------------------------------
 * PUSH CREDENTIAL REQUIREMENTS (read before testing in production):
 *
 * iOS (APNs) — handled by Expo Push Service:
 *   Expo abstracts direct APNs communication. You register your APNs key with
 *   Expo via: https://expo.dev → Project → Credentials → iOS
 *   Required: APNs Auth Key (.p8), Key ID, Team ID, Bundle ID.
 *   These are stored in Expo's credential vault, NOT in this repo's env vars.
 *
 * Android (FCM) — handled by Expo Push Service:
 *   Expo abstracts direct FCM communication. Register your FCM v1 service
 *   account with Expo via: https://expo.dev → Project → Credentials → Android
 *   Required: google-services.json or FCM V1 service account JSON.
 *   These are stored in Expo's credential vault, NOT in this repo's env vars.
 *
 * If you need to bypass Expo and send direct APNs/FCM, you would need:
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY (iOS)
 *   FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_KEY (Android)
 *   However, the current architecture uses Expo Push which abstracts both.
 *   See docs/infrastructure/apns-fcm.md for credential setup instructions.
 *
 * SUPABASE EDGE FUNCTION URL:
 *   The edge function URL is constructed from SUPABASE_URL env var.
 *   Format: <SUPABASE_URL>/functions/v1/send-push-notification
 *   The function requires the SUPABASE_SERVICE_ROLE_KEY as Bearer token.
 *
 * SOC2 REFERENCE:
 *   Admin test actions logged to audit_log → SOC2 CC7.2 (system monitoring)
 * ----------------------------------------------------------------------------
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { z } from 'zod';

// ============================================================================
// Request Schema
// ============================================================================

/**
 * Zod schema for the request body.
 * Validates that device_token_id is a valid UUID.
 *
 * WHY UUID validation: Prevents SQL injection and ensures we look up
 * a real row rather than sending arbitrary strings to the DB query.
 */
const TestPushBodySchema = z.object({
  device_token_id: z
    .string()
    .uuid({ message: 'device_token_id must be a valid UUID' }),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Row shape returned from device_tokens lookup.
 */
interface DeviceTokenRow {
  id: string;
  user_id: string;
  token: string;
  platform: string;
  is_active: boolean;
}

/**
 * Response shape from the send-push-notification edge function.
 */
interface EdgeFunctionResponse {
  success: boolean;
  message: string;
  deviceCount: number;
  successCount: number;
  failureCount: number;
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * POST /api/internal/test-push
 *
 * Sends a test push notification to the device identified by device_token_id.
 * Calls the send-push-notification edge function with a test payload.
 *
 * @param request - The incoming HTTP request
 * @returns JSON response with delivery result
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ──────────────────────────────────────────
  // Step 1: Authenticate
  // ──────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ──────────────────────────────────────────
  // Step 2: Admin authorization
  // ──────────────────────────────────────────
  const adminCheck = await isAdmin(user.id);
  if (!adminCheck) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ──────────────────────────────────────────
  // Step 3: Parse and validate request body
  // ──────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const parseResult = TestPushBodySchema.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors[0]?.message ?? 'Invalid request body' },
      { status: 400 }
    );
  }

  const { device_token_id } = parseResult.data;

  // ──────────────────────────────────────────
  // Step 4: Look up the device token
  // ──────────────────────────────────────────
  const adminClient = createAdminClient();

  const { data: deviceToken, error: tokenError } = await adminClient
    .from('device_tokens')
    .select('id, user_id, token, platform, is_active')
    .eq('id', device_token_id)
    .single();

  if (tokenError || !deviceToken) {
    return NextResponse.json(
      { error: 'Device token not found' },
      { status: 404 }
    );
  }

  const token = deviceToken as DeviceTokenRow;

  // ──────────────────────────────────────────
  // Step 5: Build edge function URL + service role key
  // ──────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[test-push] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return NextResponse.json(
      { error: 'Server configuration error: missing Supabase env vars' },
      { status: 500 }
    );
  }

  const edgeFnUrl = `${supabaseUrl}/functions/v1/send-push-notification`;

  // ──────────────────────────────────────────
  // Step 6: Call the edge function with a test payload
  //
  // WHY use the edge function rather than calling Expo directly here:
  //   All push delivery logic (quiet hours, dead-letter, audit logging)
  //   lives in the edge function. Calling it from here exercises the
  //   entire pipeline, not just the Expo HTTP call.
  //
  // WHY 'session_started' event type for test:
  //   It's low-priority (won't interrupt the user's quiet hours if set),
  //   has a clear "test" implication when displayed, and doesn't require
  //   special data fields like sessionId for permission_request.
  // ──────────────────────────────────────────
  const testPayload = {
    type: 'session_started',
    userId: token.user_id,
    data: {
      title: 'Styrby Push Test',
      body: `Test notification sent by admin to ${token.platform} device`,
      agentType: 'claude',
    },
  };

  let edgeFnResult: EdgeFunctionResponse;

  try {
    const edgeResponse = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify(testPayload),
    });

    if (!edgeResponse.ok) {
      const errorText = await edgeResponse.text();
      console.error('[test-push] Edge function returned non-OK status:', edgeResponse.status, errorText);
      return NextResponse.json(
        {
          error: `Edge function returned ${edgeResponse.status}`,
          details: errorText,
        },
        { status: 502 }
      );
    }

    edgeFnResult = (await edgeResponse.json()) as EdgeFunctionResponse;
  } catch (fetchError) {
    console.error('[test-push] Failed to call edge function:', fetchError);
    return NextResponse.json(
      { error: 'Failed to call push notification edge function' },
      { status: 500 }
    );
  }

  // ──────────────────────────────────────────
  // Step 7: Log admin test action to audit_log
  //
  // WHY log admin test sends:
  //   Test sends demonstrate that an admin can push to any user's device.
  //   This is privileged access that must be auditable.
  //   Governing standard: SOC2 CC7.2 (system monitoring and audit trails).
  // ──────────────────────────────────────────
  const { error: auditError } = await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: 'settings_updated',
    resource_type: 'push_notification_test',
    metadata: {
      admin_user_id: user.id,
      target_user_id: token.user_id,
      device_token_id: device_token_id,
      platform: token.platform,
      is_active: token.is_active,
      result: edgeFnResult,
      control_ref: 'SOC2 CC7.2',
    },
  });

  if (auditError) {
    // WHY log but not fail: Audit failure should not block the response.
    // The test already ran; we can't un-send it. Log and proceed.
    console.error('[test-push] Failed to write audit log entry:', auditError);
  }

  // ──────────────────────────────────────────
  // Step 8: Return result
  // ──────────────────────────────────────────
  return NextResponse.json({
    success: edgeFnResult.success,
    message: edgeFnResult.message,
    edgeFunctionResponse: edgeFnResult,
  });
}
