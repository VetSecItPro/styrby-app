/**
 * Admin authorization utilities.
 *
 * WHY is_admin column: The previous approach checked the JWT email claim
 * against an allowlist of admin emails. This was vulnerable because email
 * is a mutable, user-controlled attribute. If an attacker registered with
 * an admin email address, they could gain admin access. The is_admin column
 * on profiles is server-set (no RLS UPDATE policy allows users to change it),
 * making it an immutable authorization anchor.
 *
 * The is_admin column is set via service role only (direct DB or admin panel).
 * See migration 013_security_fixes.sql for the column definition.
 */

import { createAdminClient } from '@/lib/supabase/server';

/**
 * Checks whether the given user ID belongs to an admin.
 *
 * Queries the profiles table for the is_admin flag, which is a server-set
 * boolean that users cannot modify via RLS.
 *
 * @param userId - The authenticated user's ID (from supabase.auth.getUser())
 * @returns True if the user has is_admin = true in their profile
 */
export async function isAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;

  const supabase = createAdminClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .single();

  return profile?.is_admin === true;
}

