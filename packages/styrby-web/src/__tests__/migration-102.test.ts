/**
 * Migration 102 structural test — mcp_agent_log audit_action enum value.
 *
 * Validates that migration 102 adds the `mcp_agent_log` value to the
 * `audit_action` enum using the safe, idempotent, non-transactional-friendly
 * pattern (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) the codebase uses for all
 * enum extensions. This value backs the MCP `log_to_audit` tool and is the only
 * new action the /api/v1/audit forgery allowlist gained.
 *
 * WHY a structural test: a future edit that drops the IF NOT EXISTS guard would
 * make the migration fail on re-run; one that renames the value would silently
 * break the log_to_audit write path (the allowlist + handler hard-code the
 * string). Live apply is additionally proven by the Postgres migrations-apply CI.
 *
 * @module __tests__/migration-102
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 102: mcp_agent_log audit_action', () => {
  const sql = readMigration('102_mcp_agent_log_audit_action.sql');

  it('adds mcp_agent_log via ALTER TYPE ... ADD VALUE IF NOT EXISTS', () => {
    expect(sql).toMatch(
      /ALTER TYPE\s+audit_action\s+ADD VALUE\s+IF NOT EXISTS\s+'mcp_agent_log'/,
    );
  });

  it('does NOT use the new value in the same migration (PG same-tx restriction)', () => {
    // The value must not appear in any INSERT/comparison in this file — only the
    // ADD VALUE statement. Guard against a future edit adding a DO/assert that
    // would break apply.
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/=\s*'mcp_agent_log'/);
  });
});
