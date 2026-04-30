-- Migration 069: MCP approval lifecycle audit_action enum values
--
-- WHY: packages/styrby-cli/src/mcp/approvalHandler.ts records the lifecycle of
-- MCP tool-call approvals (the wedge that records request → decision → timeout
-- in audit_log instead of a dedicated mcp_approvals table). The current code
-- writes columns `event_type` / `severity` / `machine_id` which DO NOT EXIST on
-- audit_log (initial schema 001 defines: user_id, action, resource_type,
-- resource_id, metadata, created_at). Every call has been silently failing
-- with "column does not exist" since the wedge shipped — a latent bug that
-- only surfaces when MCP approval flow is exercised against the real DB.
--
-- This migration adds the three enum values so the CLI can write the correct
-- `action` column with semantically-distinct identifiers. Naming follows the
-- snake_case enum convention already established by team_command_approved /
-- team_command_denied / team_command_timeout (migration 032), with `mcp_`
-- prefix so it's easy to grep for MCP-specific approvals separately from
-- team-tier command approvals.
--
-- WHY no data migration: no rows exist with these values today (the broken
-- INSERTs never landed any rows). Adding enum values is forward-only.
--
-- WHY no rollback: ENUM values cannot be removed in PostgreSQL without
-- recreating the type and rewriting every dependent column — a heavyweight
-- operation. The CLI swap to use these values lands in the same PR; if the
-- migration applies but the CLI rolls back, no harm (the values are simply
-- unused).
--
-- @security SOC 2 CC7.2 (System Monitoring) — restores audit-log integrity
--   for MCP approval lifecycle events.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'mcp_approval_requested';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'mcp_approval_decided';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'mcp_approval_timeout';
