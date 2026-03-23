/**
 * Zod Schema Test Suite
 *
 * Tests runtime validation schemas for all Supabase table data consumed by
 * the mobile hooks. Verifies that valid data passes, invalid data is rejected,
 * and the helper functions (safeParseArray, safeParseSingle) handle edge cases
 * gracefully.
 */

import {
  ProfileSchema,
  SessionSchema,
  CostRecordSchema,
  BudgetAlertSchema,
  NotificationPreferencesSchema,
  SupportTicketSchema,
  SupportTicketReplySchema,
  CreateTicketInputSchema,
  TeamSchema,
  TeamMemberSchema,
  TeamInvitationSchema,
  UserTeamRowSchema,
  DeviceTokenSchema,
  SubscriptionTierRowSchema,
  safeParseArray,
  safeParseSingle,
} from '../schemas';

// ============================================================================
// Test Data Factories
// ============================================================================

/**
 * Creates a valid profile object for testing.
 * Override individual fields by passing a partial object.
 */
function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-123',
    display_name: 'Test User',
    avatar_url: null,
    timezone: 'UTC',
    referral_code: 'ABC123',
    tos_accepted_at: '2024-01-01T00:00:00Z',
    onboarding_completed_at: null,
    last_active_at: null,
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Creates a valid session object for testing.
 */
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    user_id: 'user-123',
    machine_id: 'machine-456',
    agent_type: 'claude',
    status: 'running',
    title: 'Test Session',
    summary: null,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cost_usd: 0.05,
    started_at: '2024-01-01T00:00:00Z',
    ended_at: null,
    tags: ['test'],
    updated_at: '2024-01-01T00:10:00Z',
    message_count: 5,
    ...overrides,
  };
}

/**
 * Creates a valid cost record object for testing.
 */
function makeCostRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_date: '2024-01-15',
    agent_type: 'claude',
    cost_usd: 1.25,
    input_tokens: 5000,
    output_tokens: 2000,
    ...overrides,
  };
}

/**
 * Creates a valid budget alert object for testing.
 */
function makeBudgetAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    user_id: 'user-123',
    name: 'Daily Limit',
    threshold_usd: 10.0,
    period: 'daily',
    action: 'notify',
    is_enabled: true,
    last_triggered_at: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a valid notification preferences object for testing.
 */
function makeNotificationPrefs(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    user_id: 'user-123',
    push_enabled: true,
    email_enabled: false,
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_timezone: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a valid support ticket object for testing.
 */
function makeSupportTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    user_id: 'user-123',
    type: 'bug',
    subject: 'App crashes on launch',
    description: 'The app crashes every time I open it on iOS 17',
    priority: 'high',
    status: 'open',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a valid team object for testing.
 */
function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 'team-1',
    name: 'Engineering',
    description: 'The engineering team',
    owner_id: 'user-123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a valid team member object for testing.
 */
function makeTeamMember(overrides: Record<string, unknown> = {}) {
  return {
    member_id: 'member-1',
    user_id: 'user-456',
    role: 'member',
    display_name: 'Jane Doe',
    email: 'jane@example.com',
    avatar_url: null,
    joined_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a valid team invitation object for testing.
 */
function makeTeamInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    team_id: 'team-1',
    email: 'newuser@example.com',
    invited_by: 'user-123',
    role: 'member',
    status: 'pending',
    expires_at: '2024-02-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// ProfileSchema Tests
// ============================================================================

describe('ProfileSchema', () => {
  it('accepts a valid profile', () => {
    const result = ProfileSchema.safeParse(makeProfile());
    expect(result.success).toBe(true);
  });

  it('accepts a profile with is_admin flag', () => {
    const result = ProfileSchema.safeParse(makeProfile({ is_admin: true }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_admin).toBe(true);
    }
  });

  it('accepts a profile without is_admin flag', () => {
    const profile = makeProfile();
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_admin).toBeUndefined();
    }
  });

  it('rejects a profile with missing id', () => {
    const { id, ...noId } = makeProfile();
    const result = ProfileSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it('rejects a profile with invalid id type', () => {
    const result = ProfileSchema.safeParse(makeProfile({ id: 123 }));
    expect(result.success).toBe(false);
  });

  it('accepts profile with all optional fields omitted', () => {
    const minimal = {
      id: 'user-123',
      display_name: null,
      avatar_url: null,
      referral_code: null,
      tos_accepted_at: null,
      onboarding_completed_at: null,
      last_active_at: null,
      deleted_at: null,
    };
    const result = ProfileSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SessionSchema Tests
// ============================================================================

describe('SessionSchema', () => {
  it('accepts a valid session', () => {
    const result = SessionSchema.safeParse(makeSession());
    expect(result.success).toBe(true);
  });

  it('rejects a session with missing required fields', () => {
    const result = SessionSchema.safeParse({ id: 'session-1' });
    expect(result.success).toBe(false);
  });

  it('rejects a session with invalid status', () => {
    const result = SessionSchema.safeParse(makeSession({ status: 'invalid_status' }));
    expect(result.success).toBe(false);
  });

  it('accepts valid status values', () => {
    const validStatuses = ['starting', 'running', 'idle', 'paused', 'stopped', 'error', 'expired'];
    for (const status of validStatuses) {
      const result = SessionSchema.safeParse(makeSession({ status }));
      expect(result.success).toBe(true);
    }
  });

  it('accepts session with optional team_id', () => {
    const result = SessionSchema.safeParse(makeSession({ team_id: 'team-1' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.team_id).toBe('team-1');
    }
  });

  it('accepts session with null team_id', () => {
    const result = SessionSchema.safeParse(makeSession({ team_id: null }));
    expect(result.success).toBe(true);
  });

  it('accepts any string agent_type for forward-compatibility', () => {
    const result = SessionSchema.safeParse(makeSession({ agent_type: 'future_agent' }));
    expect(result.success).toBe(true);
  });

  it('rejects session with non-array tags', () => {
    const result = SessionSchema.safeParse(makeSession({ tags: 'not-an-array' }));
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// CostRecordSchema Tests
// ============================================================================

describe('CostRecordSchema', () => {
  it('accepts a valid cost record', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord());
    expect(result.success).toBe(true);
  });

  it('coerces string cost_usd to number', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord({ cost_usd: '3.14' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cost_usd).toBe(3.14);
    }
  });

  it('accepts null cost_usd', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord({ cost_usd: null }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cost_usd).toBeNull();
    }
  });

  it('accepts any string agent_type', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord({ agent_type: 'aider' }));
    expect(result.success).toBe(true);
  });

  it('rejects cost record with missing record_date', () => {
    const { record_date, ...noDdate } = makeCostRecord();
    const result = CostRecordSchema.safeParse(noDdate);
    expect(result.success).toBe(false);
  });

  it('defaults is_pending to false when missing', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_pending).toBe(false);
    }
  });

  it('accepts is_pending when provided', () => {
    const result = CostRecordSchema.safeParse(makeCostRecord({ is_pending: true }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_pending).toBe(true);
    }
  });
});

// ============================================================================
// BudgetAlertSchema Tests
// ============================================================================

describe('BudgetAlertSchema', () => {
  it('accepts a valid budget alert', () => {
    const result = BudgetAlertSchema.safeParse(makeBudgetAlert());
    expect(result.success).toBe(true);
  });

  it('rejects invalid action enum value', () => {
    const result = BudgetAlertSchema.safeParse(makeBudgetAlert({ action: 'invalid' }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid action values', () => {
    const validActions = ['notify', 'warn_and_slowdown', 'hard_stop'];
    for (const action of validActions) {
      const result = BudgetAlertSchema.safeParse(makeBudgetAlert({ action }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid period enum value', () => {
    const result = BudgetAlertSchema.safeParse(makeBudgetAlert({ period: 'yearly' }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid period values', () => {
    const validPeriods = ['daily', 'weekly', 'monthly'];
    for (const period of validPeriods) {
      const result = BudgetAlertSchema.safeParse(makeBudgetAlert({ period }));
      expect(result.success).toBe(true);
    }
  });

  it('coerces string threshold_usd to number', () => {
    const result = BudgetAlertSchema.safeParse(makeBudgetAlert({ threshold_usd: '25.50' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threshold_usd).toBe(25.5);
    }
  });

  it('rejects missing required fields', () => {
    const result = BudgetAlertSchema.safeParse({ id: 'alert-1' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// NotificationPreferencesSchema Tests
// ============================================================================

describe('NotificationPreferencesSchema', () => {
  it('accepts valid notification preferences', () => {
    const result = NotificationPreferencesSchema.safeParse(makeNotificationPrefs());
    expect(result.success).toBe(true);
  });

  it('accepts notification preferences with quiet hours', () => {
    const result = NotificationPreferencesSchema.safeParse(
      makeNotificationPrefs({
        quiet_hours_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        quiet_hours_timezone: 'America/New_York',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects invalid quiet hours (non-string)', () => {
    const result = NotificationPreferencesSchema.safeParse(
      makeNotificationPrefs({ quiet_hours_start: 2200 }),
    );
    expect(result.success).toBe(false);
  });

  it('defaults priority_threshold to 3', () => {
    const result = NotificationPreferencesSchema.safeParse(makeNotificationPrefs());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority_threshold).toBe(3);
    }
  });

  it('accepts all optional boolean toggles', () => {
    const result = NotificationPreferencesSchema.safeParse(
      makeNotificationPrefs({
        push_permission_requests: true,
        push_session_errors: false,
        push_budget_alerts: true,
        push_session_complete: false,
        email_weekly_summary: true,
        email_budget_alerts: false,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = NotificationPreferencesSchema.safeParse({ id: 'pref-1' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// SupportTicketSchema Tests
// ============================================================================

describe('SupportTicketSchema', () => {
  it('accepts a valid support ticket', () => {
    const result = SupportTicketSchema.safeParse(makeSupportTicket());
    expect(result.success).toBe(true);
  });

  it('rejects invalid ticket type', () => {
    const result = SupportTicketSchema.safeParse(makeSupportTicket({ type: 'complaint' }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid ticket types', () => {
    const validTypes = ['bug', 'feature', 'question'];
    for (const type of validTypes) {
      const result = SupportTicketSchema.safeParse(makeSupportTicket({ type }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid priority', () => {
    const result = SupportTicketSchema.safeParse(makeSupportTicket({ priority: 'critical' }));
    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const result = SupportTicketSchema.safeParse(makeSupportTicket({ status: 'deleted' }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid statuses', () => {
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    for (const status of validStatuses) {
      const result = SupportTicketSchema.safeParse(makeSupportTicket({ status }));
      expect(result.success).toBe(true);
    }
  });

  it('defaults screenshot_urls to empty array when missing', () => {
    const result = SupportTicketSchema.safeParse(makeSupportTicket());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.screenshot_urls).toEqual([]);
    }
  });
});

// ============================================================================
// SupportTicketReplySchema Tests
// ============================================================================

describe('SupportTicketReplySchema', () => {
  it('accepts a valid reply', () => {
    const result = SupportTicketReplySchema.safeParse({
      id: 'reply-1',
      ticket_id: 'ticket-1',
      author_type: 'user',
      author_id: 'user-123',
      message: 'Thanks for looking into this.',
      created_at: '2024-01-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts admin author type', () => {
    const result = SupportTicketReplySchema.safeParse({
      id: 'reply-2',
      ticket_id: 'ticket-1',
      author_type: 'admin',
      author_id: 'admin-1',
      message: 'We are investigating this issue.',
      created_at: '2024-01-02T12:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid author_type', () => {
    const result = SupportTicketReplySchema.safeParse({
      id: 'reply-3',
      ticket_id: 'ticket-1',
      author_type: 'bot',
      author_id: 'bot-1',
      message: 'Auto response.',
      created_at: '2024-01-02T12:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// CreateTicketInputSchema Tests
// ============================================================================

describe('CreateTicketInputSchema', () => {
  it('accepts valid input', () => {
    const result = CreateTicketInputSchema.safeParse({
      type: 'bug',
      subject: 'App crashes',
      description: 'The app crashes when I tap the settings button.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects subject shorter than 3 characters', () => {
    const result = CreateTicketInputSchema.safeParse({
      type: 'bug',
      subject: 'Hi',
      description: 'The app crashes when I tap the settings button.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects description shorter than 10 characters', () => {
    const result = CreateTicketInputSchema.safeParse({
      type: 'feature',
      subject: 'Dark mode',
      description: 'Please.',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional priority', () => {
    const result = CreateTicketInputSchema.safeParse({
      type: 'question',
      subject: 'How to pair',
      description: 'How do I pair my device with the CLI tool?',
      priority: 'low',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe('low');
    }
  });
});

// ============================================================================
// TeamSchema Tests
// ============================================================================

describe('TeamSchema', () => {
  it('accepts a valid team', () => {
    const result = TeamSchema.safeParse(makeTeam());
    expect(result.success).toBe(true);
  });

  it('accepts team with null description', () => {
    const result = TeamSchema.safeParse(makeTeam({ description: null }));
    expect(result.success).toBe(true);
  });

  it('rejects team with missing name', () => {
    const { name, ...noName } = makeTeam();
    const result = TeamSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it('rejects team with missing owner_id', () => {
    const { owner_id, ...noOwner } = makeTeam();
    const result = TeamSchema.safeParse(noOwner);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TeamMemberSchema Tests
// ============================================================================

describe('TeamMemberSchema', () => {
  it('accepts a valid team member', () => {
    const result = TeamMemberSchema.safeParse(makeTeamMember());
    expect(result.success).toBe(true);
  });

  it('accepts all valid roles', () => {
    const validRoles = ['owner', 'admin', 'member'];
    for (const role of validRoles) {
      const result = TeamMemberSchema.safeParse(makeTeamMember({ role }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid role', () => {
    const result = TeamMemberSchema.safeParse(makeTeamMember({ role: 'superadmin' }));
    expect(result.success).toBe(false);
  });

  it('accepts null display_name', () => {
    const result = TeamMemberSchema.safeParse(makeTeamMember({ display_name: null }));
    expect(result.success).toBe(true);
  });

  it('rejects missing email', () => {
    const { email, ...noEmail } = makeTeamMember();
    const result = TeamMemberSchema.safeParse(noEmail);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TeamInvitationSchema Tests
// ============================================================================

describe('TeamInvitationSchema', () => {
  it('accepts a valid invitation', () => {
    const result = TeamInvitationSchema.safeParse(makeTeamInvitation());
    expect(result.success).toBe(true);
  });

  it('accepts all valid invitation statuses', () => {
    const validStatuses = ['pending', 'accepted', 'declined', 'expired', 'revoked'];
    for (const status of validStatuses) {
      const result = TeamInvitationSchema.safeParse(makeTeamInvitation({ status }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid status', () => {
    const result = TeamInvitationSchema.safeParse(makeTeamInvitation({ status: 'cancelled' }));
    expect(result.success).toBe(false);
  });

  it('accepts only admin and member roles', () => {
    expect(TeamInvitationSchema.safeParse(makeTeamInvitation({ role: 'admin' })).success).toBe(true);
    expect(TeamInvitationSchema.safeParse(makeTeamInvitation({ role: 'member' })).success).toBe(true);
    expect(TeamInvitationSchema.safeParse(makeTeamInvitation({ role: 'owner' })).success).toBe(false);
  });

  it('accepts optional token field', () => {
    const result = TeamInvitationSchema.safeParse(
      makeTeamInvitation({ token: 'abc123def456' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe('abc123def456');
    }
  });
});

// ============================================================================
// UserTeamRowSchema Tests
// ============================================================================

describe('UserTeamRowSchema', () => {
  it('accepts a valid user team row', () => {
    const result = UserTeamRowSchema.safeParse({
      team_id: 'team-1',
      team_name: 'Engineering',
      team_description: 'The engineering team',
      owner_id: 'user-123',
      role: 'member',
      member_count: 5,
      joined_at: '2024-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing team_name', () => {
    const result = UserTeamRowSchema.safeParse({
      team_id: 'team-1',
      team_description: null,
      owner_id: 'user-123',
      role: 'member',
      member_count: 5,
      joined_at: '2024-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// DeviceTokenSchema Tests
// ============================================================================

describe('DeviceTokenSchema', () => {
  it('accepts a valid device token', () => {
    const result = DeviceTokenSchema.safeParse({
      id: 'token-1',
      user_id: 'user-123',
      token: 'ExponentPushToken[abc123]',
      platform: 'ios',
      created_at: '2024-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional fields', () => {
    const result = DeviceTokenSchema.safeParse({
      id: 'token-1',
      user_id: 'user-123',
      token: 'ExponentPushToken[abc123]',
      platform: 'ios',
      created_at: '2024-01-01T00:00:00Z',
      device_name: 'iPhone 15',
      app_version: '1.0.0',
      last_used_at: '2024-01-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SubscriptionTierRowSchema Tests
// ============================================================================

describe('SubscriptionTierRowSchema', () => {
  it('accepts any string tier', () => {
    const result = SubscriptionTierRowSchema.safeParse({ tier: 'pro' });
    expect(result.success).toBe(true);
  });

  it('rejects missing tier', () => {
    const result = SubscriptionTierRowSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-string tier', () => {
    const result = SubscriptionTierRowSchema.safeParse({ tier: 42 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// safeParseArray Tests
// ============================================================================

describe('safeParseArray', () => {
  it('returns only valid items from mixed array', () => {
    const data = [
      makeSession(),
      { id: 'bad' }, // missing required fields
      makeSession({ id: 'session-2', status: 'idle' }),
    ];

    const result = safeParseArray(SessionSchema, data, 'sessions');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('session-1');
    expect(result[1].id).toBe('session-2');
  });

  it('returns empty array for null input', () => {
    const result = safeParseArray(SessionSchema, null, 'sessions');
    expect(result).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    const result = safeParseArray(SessionSchema, undefined, 'sessions');
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    const result = safeParseArray(SessionSchema, 'not-an-array' as unknown as unknown[], 'sessions');
    expect(result).toEqual([]);
  });

  it('returns all items when all are valid', () => {
    const data = [makeSession(), makeSession({ id: 'session-2' })];
    const result = safeParseArray(SessionSchema, data, 'sessions');
    expect(result).toHaveLength(2);
  });

  it('returns empty array when all items are invalid', () => {
    const data = [{ id: 'bad-1' }, { id: 'bad-2' }];
    const result = safeParseArray(SessionSchema, data, 'sessions');
    expect(result).toEqual([]);
  });

  it('logs invalid items in __DEV__ mode', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    safeParseArray(SessionSchema, [{ id: 'bad' }], 'sessions');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Zod] Invalid sessions at index 0:'),
      expect.any(Array),
    );

    warnSpy.mockRestore();
  });
});

// ============================================================================
// safeParseSingle Tests
// ============================================================================

describe('safeParseSingle', () => {
  it('returns validated data for valid input', () => {
    const result = safeParseSingle(SessionSchema, makeSession(), 'session');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('session-1');
  });

  it('returns null for invalid data', () => {
    const result = safeParseSingle(SessionSchema, { id: 'bad' }, 'session');
    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    const result = safeParseSingle(SessionSchema, null, 'session');
    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = safeParseSingle(SessionSchema, undefined, 'session');
    expect(result).toBeNull();
  });

  it('logs invalid data in __DEV__ mode', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    safeParseSingle(SessionSchema, { id: 'bad' }, 'session');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Zod] Invalid session:'),
      expect.any(Array),
    );

    warnSpy.mockRestore();
  });
});
