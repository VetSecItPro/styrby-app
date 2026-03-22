/**
 * Admin authorization utilities.
 *
 * WHY hardcoded emails: Styrby does not yet have a full RBAC system. Rather
 * than adding an is_admin column to profiles (which would require a migration
 * and UI for managing admins), we use a simple allowlist of admin email
 * addresses stored in an environment variable. This is secure because the
 * check runs server-side only, and the list can be updated via Vercel env
 * vars without a code deploy.
 *
 * Format of ADMIN_EMAILS env var: comma-separated email addresses.
 * Example: "admin@styrbyapp.com,founder@styrbyapp.com"
 */

/**
 * Checks whether the given email belongs to an admin user.
 *
 * @param email - The user's email address to check
 * @returns True if the email is in the admin allowlist
 */
export function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;

  const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((e) => e.trim().toLowerCase()) || [];

  // Fallback: if ADMIN_EMAILS is not set, no one is an admin.
  // This prevents accidental admin access in misconfigured environments.
  if (adminEmails.length === 0) return false;

  return adminEmails.includes(email.toLowerCase());
}
