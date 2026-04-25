# Admin Operations Runbook

This runbook covers operator procedures for the Styrby site-admin surface area.
Each section maps to a security or operational finding tracked in
`styrby-backlog.md` so the rationale is auditable.

---

## Removing a `site_admin` (SEC-ADV-006)

**Finding:** when a row in the `site_admins` table is deleted (or the user's
`is_site_admin` flag is otherwise revoked), any JWT issued to that user **before**
the revocation remains valid until it expires. Supabase Auth issues access
tokens with a default TTL of ~1 hour. During that window the revoked admin can
still call admin RPCs that gate on the JWT's `aud` / role claim, even though
the database row that authorizes them is gone.

This matches Supabase Auth's own session model — JWT validity is independent
of any application-level authorization table — and is consistent with how
every JWT-based system behaves (no central revocation list at the auth layer).

### Operational expectation

When removing a site admin you have **two acceptable paths**:

1. **Force-revoke within the JWT TTL window (preferred for high-trust roles).**
   - Open the Supabase dashboard → Authentication → Users.
   - Locate the user being demoted.
   - Click "Sign out" / "Revoke sessions" on their record.
   - This invalidates the refresh token and forces re-auth on the next access
     token rotation. Within ~1 hour the access token will expire and cannot be
     refreshed.
   - Verify by tailing `admin_audit_log` for the next hour to confirm no admin
     actions are recorded under that `granted_by` UUID.

2. **Treat the TTL window as accepted residual risk (acceptable for low-risk
   demotions, e.g., role rotation between trusted staff).**
   - Delete the `site_admins` row.
   - Do NOT force-revoke.
   - Document the demotion timestamp in the team's ops log so any actions
     within the next hour can be reviewed retroactively.
   - This is the path used for routine staff rotations where the demoted user
     is not adversarial.

### Why we do not auto-revoke

Auto-revoking on every demotion would require either:

- Polling Supabase Auth's admin API on every admin RPC call (latency cost,
  rate-limit risk), or
- Maintaining a server-side allowlist of valid JWTs (complex, error-prone,
  defeats the stateless nature of JWT auth).

The 1-hour residual window is the same tradeoff Supabase Auth itself makes
for every authenticated user across the platform. Documenting it explicitly
here turns a hidden assumption into an operational expectation.

### Related

- See `supabase/migrations/040_*` for the `admin_audit_log` table schema.
- See `packages/styrby-web/src/lib/admin/guard.ts` for the JWT-side admin
  gate.
- Backlog item: SEC-ADV-006.
