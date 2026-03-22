/**
 * Onboarding Completion Route
 *
 * Marks the authenticated user's onboarding as complete by setting
 * the `onboarding_completed_at` timestamp on their profile. Called
 * automatically when all onboarding steps are finished, or when the
 * user manually dismisses the onboarding banner.
 *
 * POST /api/onboarding/complete
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 { success: true }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to complete onboarding' }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to mark onboarding complete:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to complete onboarding' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Onboarding complete POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to complete onboarding' },
      { status: 500 }
    );
  }
}
