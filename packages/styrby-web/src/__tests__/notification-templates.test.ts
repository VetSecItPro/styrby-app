/**
 * Notification templates test suite
 *
 * Unit tests for the pure logic in
 * `supabase/functions/_shared/notification-templates.ts`. The shared module
 * was extracted from `send-push-notification/index.ts` (1375 LOC, zero
 * existing tests) so its template/preference/priority logic could be tested
 * from Vitest without standing up a Deno test runner.
 *
 * Coverage focus:
 * - All 9 NotificationEventType cases produce a payload with the correct
 *   title, body, screen routing, sound, and priority.
 * - Default-fallback bodies fire when title/body overrides are absent.
 * - isTypeAllowed maps each event type to the correct preference column,
 *   in particular cloud_task_* reuse of session_complete / session_errors
 *   (the #97 PR-3 design choice that avoided a schema migration).
 * - BASE_PRIORITY_BY_EVENT has an entry for every event type with a
 *   semantically-correct value.
 * - VALID_EVENT_TYPES matches the NotificationEventType union exactly
 *   (drift here means a payload validator rejects events the templates
 *   actually handle, or vice versa).
 *
 * Pre-existing event types are tested too — this is the first test of the
 * function's logic, period, so we lock in current behavior as the
 * regression baseline.
 */

import { describe, expect, it } from 'vitest';

// Relative path to the shared module under supabase/functions/_shared/.
// Vitest resolves this fine from styrby-web's src/__tests__/ directory.
import {
  buildNotificationPayload,
  isTypeAllowed,
  BASE_PRIORITY_BY_EVENT,
  VALID_EVENT_TYPES,
  type NotificationEventType,
  type NotificationPreferences,
} from '../../../../supabase/functions/_shared/notification-templates';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a NotificationPreferences row with every column set to true unless
 * overridden. Use the override to flip a single field for negative tests.
 */
function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    push_permission_requests: true,
    push_session_errors: true,
    push_budget_alerts: true,
    push_session_complete: true,
    ...overrides,
  };
}

// ============================================================================
// VALID_EVENT_TYPES & BASE_PRIORITY_BY_EVENT — registry consistency
// ============================================================================

describe('Event type registry', () => {
  it('VALID_EVENT_TYPES contains every event type in NotificationEventType', () => {
    // The union has 9 members; the array must match exactly.
    expect(VALID_EVENT_TYPES.length).toBe(9);
    expect(VALID_EVENT_TYPES).toEqual([
      'permission_request',
      'session_started',
      'session_completed',
      'session_error',
      'budget_warning',
      'budget_exceeded',
      'approval_request',
      'cloud_task_completed',
      'cloud_task_failed',
    ]);
  });

  it('BASE_PRIORITY_BY_EVENT has an entry for every event type', () => {
    for (const t of VALID_EVENT_TYPES) {
      expect(BASE_PRIORITY_BY_EVENT[t]).toBeDefined();
      expect(typeof BASE_PRIORITY_BY_EVENT[t]).toBe('number');
    }
  });

  it('priority semantics: critical events have lower numbers than informational', () => {
    // Approval is the most urgent (1); session_started is the least (5).
    expect(BASE_PRIORITY_BY_EVENT.approval_request).toBe(1);
    expect(BASE_PRIORITY_BY_EVENT.budget_exceeded).toBe(1);
    expect(BASE_PRIORITY_BY_EVENT.session_started).toBe(5);

    // Cloud task priorities mirror their session counterparts (PR-3 design).
    expect(BASE_PRIORITY_BY_EVENT.cloud_task_completed).toBe(
      BASE_PRIORITY_BY_EVENT.session_completed,
    );
    expect(BASE_PRIORITY_BY_EVENT.cloud_task_failed).toBe(
      BASE_PRIORITY_BY_EVENT.session_error,
    );
  });
});

// ============================================================================
// isTypeAllowed — preference mapping
// ============================================================================

describe('isTypeAllowed()', () => {
  it('permission_request honors push_permission_requests', () => {
    expect(isTypeAllowed(prefs({ push_permission_requests: true }), 'permission_request')).toBe(true);
    expect(isTypeAllowed(prefs({ push_permission_requests: false }), 'permission_request')).toBe(false);
  });

  it('session_error honors push_session_errors', () => {
    expect(isTypeAllowed(prefs({ push_session_errors: true }), 'session_error')).toBe(true);
    expect(isTypeAllowed(prefs({ push_session_errors: false }), 'session_error')).toBe(false);
  });

  it('session_completed honors push_session_complete', () => {
    expect(isTypeAllowed(prefs({ push_session_complete: true }), 'session_completed')).toBe(true);
    expect(isTypeAllowed(prefs({ push_session_complete: false }), 'session_completed')).toBe(false);
  });

  it('budget events honor push_budget_alerts', () => {
    expect(isTypeAllowed(prefs({ push_budget_alerts: true }), 'budget_warning')).toBe(true);
    expect(isTypeAllowed(prefs({ push_budget_alerts: false }), 'budget_warning')).toBe(false);
    expect(isTypeAllowed(prefs({ push_budget_alerts: true }), 'budget_exceeded')).toBe(true);
    expect(isTypeAllowed(prefs({ push_budget_alerts: false }), 'budget_exceeded')).toBe(false);
  });

  it('session_started is always allowed (no dedicated toggle)', () => {
    // Even with every other toggle off, session_started fires.
    const allOff: NotificationPreferences = {
      push_permission_requests: false,
      push_session_errors: false,
      push_budget_alerts: false,
      push_session_complete: false,
    };
    expect(isTypeAllowed(allOff, 'session_started')).toBe(true);
  });

  it('approval_request is always allowed (SOC2 CC6.3 governance non-bypassable)', () => {
    // Approval pushes cannot be opted out at the type level — disabling
    // them would let an approver dodge governance reviews.
    const allOff: NotificationPreferences = {
      push_permission_requests: false,
      push_session_errors: false,
      push_budget_alerts: false,
      push_session_complete: false,
    };
    expect(isTypeAllowed(allOff, 'approval_request')).toBe(true);
  });

  describe('cloud_task_* preference reuse (#97 PR-3 design)', () => {
    it('cloud_task_completed reuses push_session_complete (default false in DB)', () => {
      expect(isTypeAllowed(prefs({ push_session_complete: true }), 'cloud_task_completed')).toBe(true);
      expect(isTypeAllowed(prefs({ push_session_complete: false }), 'cloud_task_completed')).toBe(false);
    });

    it('cloud_task_failed reuses push_session_errors (default true in DB)', () => {
      expect(isTypeAllowed(prefs({ push_session_errors: true }), 'cloud_task_failed')).toBe(true);
      expect(isTypeAllowed(prefs({ push_session_errors: false }), 'cloud_task_failed')).toBe(false);
    });

    it('cloud_task_completed and session_completed share the same gate', () => {
      // Drift here would mean toggling "Session complete pushes" in the
      // settings UI no longer affects cloud-task pushes — broken UX.
      const off = prefs({ push_session_complete: false });
      expect(isTypeAllowed(off, 'session_completed')).toBe(false);
      expect(isTypeAllowed(off, 'cloud_task_completed')).toBe(false);
    });

    it('cloud_task_failed and session_error share the same gate', () => {
      const off = prefs({ push_session_errors: false });
      expect(isTypeAllowed(off, 'session_error')).toBe(false);
      expect(isTypeAllowed(off, 'cloud_task_failed')).toBe(false);
    });
  });
});

// ============================================================================
// buildNotificationPayload — template rendering per event type
// ============================================================================

describe('buildNotificationPayload()', () => {
  describe('permission_request', () => {
    it('routes to chat screen with sessionId + permissions channel', () => {
      const p = buildNotificationPayload('permission_request', {
        sessionId: 'sess-1',
        agentType: 'Claude',
        permissionType: 'write files',
      });
      expect(p.title).toBe('Permission Required');
      expect(p.body).toContain('Claude');
      expect(p.body).toContain('write files');
      expect(p.data.screen).toBe('chat');
      expect(p.data.sessionId).toBe('sess-1');
      expect(p.priority).toBe('high');
      expect(p.channelId).toBe('permissions');
    });

    it('honors title/body overrides', () => {
      const p = buildNotificationPayload('permission_request', {
        title: 'Custom title',
        body: 'Custom body',
      });
      expect(p.title).toBe('Custom title');
      expect(p.body).toBe('Custom body');
    });

    it('falls back when agentType/permissionType absent', () => {
      const p = buildNotificationPayload('permission_request', {});
      expect(p.body).toBe('Agent wants to perform an action');
    });
  });

  describe('session_started', () => {
    it('routes to dashboard with default priority', () => {
      const p = buildNotificationPayload('session_started', {
        sessionId: 'sess-2',
        agentType: 'Codex',
      });
      expect(p.title).toBe('Codex Session Started');
      expect(p.data.screen).toBe('dashboard');
      expect(p.priority).toBe('default');
    });
  });

  describe('session_completed', () => {
    it('shows cost in body when costUsd present', () => {
      const p = buildNotificationPayload('session_completed', {
        sessionId: 'sess-3',
        costUsd: 0.1234,
      });
      expect(p.body).toBe('Cost: $0.1234');
      expect(p.data.screen).toBe('sessions');
    });

    it('falls back to "Session finished" when costUsd absent', () => {
      const p = buildNotificationPayload('session_completed', {});
      expect(p.body).toBe('Session finished');
    });
  });

  describe('session_error', () => {
    it('routes to chat with high priority', () => {
      const p = buildNotificationPayload('session_error', {
        agentType: 'Gemini',
        sessionId: 'sess-4',
      });
      expect(p.title).toBe('Session Error');
      expect(p.body).toBe('Gemini encountered an error');
      expect(p.data.screen).toBe('chat');
      expect(p.priority).toBe('high');
    });
  });

  describe('cloud_task_completed (#97 PR-3)', () => {
    it('routes to /cloud-tasks with taskId + default priority', () => {
      const p = buildNotificationPayload('cloud_task_completed', {
        taskId: 'task-99',
        agentType: 'Claude Code',
        prompt: 'echo hello',
      });
      expect(p.title).toBe('Cloud Task Complete');
      expect(p.data.screen).toBe('cloud-tasks');
      expect(p.data.taskId).toBe('task-99');
      expect(p.data.type).toBe('cloud_task_completed');
      expect(p.priority).toBe('default');
    });

    it('body shows agent + prompt preview when prompt present', () => {
      const p = buildNotificationPayload('cloud_task_completed', {
        agentType: 'Codex',
        prompt: 'list open issues',
      });
      expect(p.body).toBe('Codex: list open issues');
    });

    it('body falls back to cost when prompt absent and costUsd present', () => {
      const p = buildNotificationPayload('cloud_task_completed', {
        costUsd: 0.0567,
      });
      expect(p.body).toBe('Task finished — cost $0.0567');
    });

    it('body falls back to generic message when both prompt and cost absent', () => {
      const p = buildNotificationPayload('cloud_task_completed', {});
      expect(p.body).toBe('Cloud task finished');
    });
  });

  describe('cloud_task_failed (#97 PR-3)', () => {
    it('routes to /cloud-tasks with high priority', () => {
      const p = buildNotificationPayload('cloud_task_failed', {
        taskId: 'task-100',
        agentType: 'Aider',
        prompt: 'refactor auth',
      });
      expect(p.title).toBe('Cloud Task Failed');
      expect(p.body).toBe('Aider failed on: refactor auth');
      expect(p.data.screen).toBe('cloud-tasks');
      expect(p.data.taskId).toBe('task-100');
      expect(p.priority).toBe('high');
    });

    it('body falls back to "{agent} encountered an error" when prompt absent', () => {
      const p = buildNotificationPayload('cloud_task_failed', {
        agentType: 'Goose',
      });
      expect(p.body).toBe('Goose encountered an error');
    });

    it('body uses "Agent" when agentType also absent', () => {
      const p = buildNotificationPayload('cloud_task_failed', {});
      expect(p.body).toBe('Agent encountered an error');
    });
  });

  describe('budget_warning', () => {
    it('shows percentage when costUsd + budgetThreshold present', () => {
      const p = buildNotificationPayload('budget_warning', {
        costUsd: 75,
        budgetThreshold: 100,
      });
      expect(p.body).toBe('Spending at 75% of $100.00');
      expect(p.data.screen).toBe('costs');
      expect(p.priority).toBe('high');
    });

    it('falls back when costUsd absent', () => {
      const p = buildNotificationPayload('budget_warning', {
        budgetThreshold: 100,
      });
      expect(p.body).toBe('Approaching budget threshold of $100.00');
    });
  });

  describe('budget_exceeded', () => {
    it('shows the threshold in body', () => {
      const p = buildNotificationPayload('budget_exceeded', {
        budgetThreshold: 50,
      });
      expect(p.title).toBe('Budget Exceeded');
      expect(p.body).toBe('Spending exceeded $50.00');
      expect(p.priority).toBe('high');
    });
  });

  describe('approval_request (Phase 2.4)', () => {
    it('routes to approvals with default actions array + permissions channel', () => {
      const p = buildNotificationPayload('approval_request', {
        approvalId: 'apr-1',
        toolName: 'bash',
        riskLevel: 'high',
        requesterUserId: 'user-2',
      });
      expect(p.title).toBe('Approval Required: bash');
      expect(p.body).toContain('Approve, Deny, or View diff');
      expect(p.data.screen).toBe('approvals');
      expect(p.data.approvalId).toBe('apr-1');
      expect(p.data.actions).toEqual(['approve', 'deny', 'view_diff']);
      expect(p.channelId).toBe('permissions');
    });

    it('honors caller-supplied actions array', () => {
      const p = buildNotificationPayload('approval_request', {
        approvalId: 'apr-2',
        actions: ['approve', 'view_diff'],
      });
      expect(p.data.actions).toEqual(['approve', 'view_diff']);
    });
  });

  describe('exhaustiveness', () => {
    it('throws for unhandled type (compile-time guard but defensive runtime check)', () => {
      // The cast bypasses TS narrowing so we can hit the default branch at
      // runtime. The exhaustive `never` check inside the function is the
      // compile-time guard; this proves the runtime safety net also works.
      expect(() =>
        buildNotificationPayload('not_a_real_type' as NotificationEventType, {}),
      ).toThrow(/Unhandled notification type/);
    });
  });
});
