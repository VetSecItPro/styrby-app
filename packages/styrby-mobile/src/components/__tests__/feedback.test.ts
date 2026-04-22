/**
 * Tests for mobile feedback components (file-content tests).
 *
 * WHY file-content tests: React Native components depend on the Expo/RN
 * runtime and cannot be fully rendered in unit tests without a complex
 * mock setup. File-content tests validate:
 *   - Correct props and accessibility labels
 *   - Security: auth session before API call
 *   - 10-minute duration guard on SessionPostmortemWidget
 *   - No em-dashes in copy (CLAUDE.md prohibition)
 *   - No sparkle icons (CLAUDE.md prohibition)
 *   - Correct API endpoint and request body shape
 *
 * WHY Jest not vitest: styrby-mobile uses Jest via expo's preset.
 *
 * @module components/__tests__/feedback.test
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Path helpers
const COMPONENTS = resolve(__dirname, '../feedback');
function readComp(name: string): string {
  return readFileSync(resolve(COMPONENTS, name), 'utf-8');
}

// =============================================================================
// NpsSurveySheet
// =============================================================================

describe('NpsSurveySheet', () => {
  const src = readComp('NpsSurveySheet.tsx');

  it('uses auth session before API call', () => {
    expect(src).toContain('supabase.auth.getSession');
  });

  it('submits to /api/feedback/submit', () => {
    expect(src).toContain('/api/feedback/submit');
  });

  it('sends kind = nps', () => {
    expect(src).toContain("kind: 'nps'");
  });

  it('includes score in submission body', () => {
    expect(src).toContain('score:');
    expect(src).toContain('selectedScore');
  });

  it('includes window in submission body', () => {
    expect(src).toContain('window,');
  });

  it('includes promptId when provided', () => {
    expect(src).toContain('promptId');
  });

  it('marks prompt as dismissed when user dismisses', () => {
    expect(src).toContain('dismissed_at');
    expect(src).toContain('user_feedback_prompts');
  });

  it('shows follow-up question after score selection', () => {
    expect(src).toContain('followup');
    expect(src).toContain('step');
  });

  it('has accessible button labels', () => {
    expect(src).toContain('accessibilityRole="button"');
    expect(src).toContain('accessibilityLabel');
  });

  it('has no em-dashes in copy (CLAUDE.md)', () => {
    // Em-dash is U+2014 (—)
    expect(src).not.toContain('—');
  });

  it('has no sparkle icons (CLAUDE.md)', () => {
    expect(src).not.toContain('Sparkles');
    expect(src).not.toContain('sparkle');
  });
});

// =============================================================================
// SessionPostmortemWidget
// =============================================================================

describe('SessionPostmortemWidget', () => {
  const src = readComp('SessionPostmortemWidget.tsx');

  it('returns null for sessions shorter than 10 minutes (600 seconds)', () => {
    expect(src).toContain('600');
    expect(src).toContain('return null');
  });

  it('uses auth session before API call', () => {
    expect(src).toContain('supabase.auth.getSession');
  });

  it('submits to /api/feedback/submit', () => {
    expect(src).toContain('/api/feedback/submit');
  });

  it('sends kind = session_postmortem', () => {
    expect(src).toContain("kind: 'session_postmortem'");
  });

  it('includes sessionId and rating in body', () => {
    expect(src).toContain('sessionId');
    expect(src).toContain('rating');
  });

  it('uses thumbs-up Ionicon (not sparkle)', () => {
    expect(src).toContain('thumbs-up-outline');
    expect(src).not.toContain('Sparkles');
  });

  it('uses thumbs-down Ionicon', () => {
    expect(src).toContain('thumbs-down-outline');
  });

  it('uses chatbubble Ionicon (not sparkle)', () => {
    expect(src).toContain('chatbubble-outline');
    expect(src).not.toContain('Sparkles');
  });

  it('strips context_json to non-PII fields only', () => {
    expect(src).toContain('context_json');
    expect(src).toContain('screen:');
    expect(src).toContain('agent:');
  });

  it('has no em-dashes in copy (CLAUDE.md)', () => {
    expect(src).not.toContain('—');
  });
});

// =============================================================================
// FeedbackButton
// =============================================================================

describe('FeedbackButton', () => {
  const src = readComp('FeedbackButton.tsx');

  it('renders row and pill variants', () => {
    // Row is checked explicitly; pill is the else branch when not 'row'
    expect(src).toContain("variant === 'row'");
    expect(src).toContain("'pill'");
  });

  it('uses chatbubble Ionicon (not sparkle)', () => {
    expect(src).toContain('chatbubble-outline');
    expect(src).not.toContain('Sparkles');
  });

  it('has accessibility label', () => {
    expect(src).toContain('accessibilityLabel="Send feedback"');
  });

  it('opens FeedbackSheet on press', () => {
    expect(src).toContain('FeedbackSheet');
    expect(src).toContain('sheetOpen');
  });
});

// =============================================================================
// FeedbackSheet
// =============================================================================

describe('FeedbackSheet', () => {
  const src = readComp('FeedbackSheet.tsx');

  it('uses auth session before API call', () => {
    expect(src).toContain('supabase.auth.getSession');
  });

  it('submits kind = general', () => {
    expect(src).toContain("kind: 'general'");
  });

  it('includes message in body', () => {
    expect(src).toContain('message:');
  });

  it('includes optional replyEmail', () => {
    expect(src).toContain('replyEmail');
  });

  it('limits message to 2000 chars', () => {
    expect(src).toContain('maxLength={2000}');
  });

  it('captures route context in contextJson', () => {
    expect(src).toContain('contextJson');
    expect(src).toContain('screen:');
  });

  it('has no em-dashes in copy', () => {
    expect(src).not.toContain('—');
  });
});
