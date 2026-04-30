-- Migration 070: RLS INSERT policy for mobile-issued MCP approval decisions
--
-- WHY: Migration 001 left audit_log INSERTs as service-role-only. The mobile
-- MCP approval UX (D-02 closure) writes a `mcp_approval_decided` row directly
-- from the user's authenticated mobile session so the polling CLI handler
-- (packages/styrby-cli/src/mcp/approvalHandler.ts) sees the decision in real
-- time without round-tripping through an edge function. Without an INSERT
-- policy the write fails with `new row violates row-level security policy`,
-- and the entire MCP approval loop stays broken.
--
-- WHY scoped to mcp_approval_decided only: the audit_log is the system-wide
-- forensic record. Allowing arbitrary client-side INSERTs would let a
-- compromised mobile session forge any audit event (login, payment, admin
-- action). Scoping the policy to one specific action keeps the blast radius
-- to the MCP approval contract while still satisfying the D-02 requirement.
--
-- WHY user_id = auth.uid(): RLS enforces row ownership server-side regardless
-- of what the client sends. A user cannot write a decision attributed to
-- another user.
--
-- WHY no metadata schema check at the policy layer: Postgres RLS policies
-- run before triggers but cannot easily validate JSONB structure without
-- expensive jsonb_path_query calls on every INSERT. The CLI's poll loop
-- only consumes rows whose metadata.decision is 'approved' | 'denied';
-- malformed metadata simply gets ignored downstream. The trade-off favors
-- write-path performance over policy-layer validation.
--
-- @security SOC 2 CC6.1 (Logical Access — least privilege) — narrowest
--   feasible INSERT grant; the user can only write decisions for their own
--   approval requests, and only the one action enum value the CLI polls for.

CREATE POLICY "audit_log_insert_mcp_decision_own"
  ON audit_log FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND action = 'mcp_approval_decided'
    AND resource_type = 'mcp_approval'
  );
