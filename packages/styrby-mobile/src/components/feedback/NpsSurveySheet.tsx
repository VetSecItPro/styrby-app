/**
 * NpsSurveySheet - Bottom-sheet NPS survey for mobile.
 *
 * Presented when the user taps an NPS prompt in the notification feed
 * or opens a deep link from the push notification.
 *
 * Flow:
 *  1. User sees the 0-10 scale ("How likely are you to recommend Styrby?")
 *  2. User taps a score button
 *  3. Sheet expands to show follow-up: "What's the #1 thing we could do to raise that score?"
 *  4. User submits (or skips the follow-up)
 *  5. Sheet dismisses with a brief thank-you
 *
 * WHY bottom sheet not full modal: Bottom sheets are the standard mobile
 * survey pattern (Airbnb, Uber, Notion all use them). They don't interrupt
 * the user's context as aggressively as full-screen modals.
 *
 * WHY no em-dash in copy (CLAUDE.md): Dashes used instead.
 *
 * @module components/feedback/NpsSurveySheet
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ScrollView,
} from 'react-native';
import { supabase } from '../../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for NpsSurveySheet.
 */
export interface NpsSurveySheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** NPS window: 7d or 30d */
  window: '7d' | '30d';
  /** UUID of the user_feedback_prompts row (links response back to prompt) */
  promptId?: string;
  /** Called when the sheet should close (submitted or dismissed) */
  onClose: () => void;
}

/** Survey state machine steps. */
type Step = 'score' | 'followup' | 'thankyou';

// ============================================================================
// Constants
// ============================================================================

/** NPS score labels for context hints on the low/high ends. */
const SCALE_LABELS = { low: 'Not likely', high: 'Very likely' };

// ============================================================================
// Component
// ============================================================================

/**
 * NPS survey bottom sheet. See module doc.
 *
 * @param props - NpsSurveySheetProps
 */
export function NpsSurveySheet({
  visible,
  window,
  promptId,
  onClose,
}: NpsSurveySheetProps) {
  const [step, setStep] = useState<Step>('score');
  const [selectedScore, setSelectedScore] = useState<number | null>(null);
  const [followup, setFollowup] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reset state when sheet closes. */
  const handleClose = useCallback(() => {
    setStep('score');
    setSelectedScore(null);
    setFollowup('');
    setError(null);
    onClose();
  }, [onClose]);

  /**
   * Handle score tap.
   * Advances to follow-up step immediately.
   */
  const handleScorePress = useCallback((score: number) => {
    setSelectedScore(score);
    setStep('followup');
  }, []);

  /**
   * Submit the NPS response to /api/feedback/submit.
   *
   * Uses Supabase session for auth (the JWT is sent via the Authorization header).
   */
  const handleSubmit = useCallback(async () => {
    if (selectedScore === null) return;

    setSubmitting(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        setError('Please sign in to submit feedback.');
        return;
      }

      // WHY: Use the web API route for submission so the logic (email sending,
      // audit log, prompt linking) is centralised in one place and not
      // duplicated in a mobile-specific Supabase call.
      const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://www.styrbyapp.com';

      const body: Record<string, unknown> = {
        kind: 'nps',
        score: selectedScore,
        window,
        contextJson: { screen: '/nps/' + window },
      };
      if (promptId) body.promptId = promptId;
      if (followup.trim()) body.followup = followup.trim();

      const res = await fetch(`${appUrl}/api/feedback/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      setStep('thankyou');

      // Auto-close after 2 seconds
      setTimeout(handleClose, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [selectedScore, followup, window, promptId, handleClose]);

  /**
   * Handle dismiss without answering (dismisses and marks the prompt as dismissed).
   */
  const handleDismiss = useCallback(async () => {
    if (promptId) {
      // Best-effort: mark the prompt row as dismissed so it doesn't re-appear.
      // WHY try/catch: Supabase client returns a PromiseLike that doesn't expose
      // .catch() after .then() chaining. try/catch is the safer pattern.
      try {
        await supabase
          .from('user_feedback_prompts')
          .update({ dismissed_at: new Date().toISOString() })
          .eq('id', promptId);
      } catch {
        // Non-fatal - user can dismiss even if the DB update fails
      }
    }
    handleClose();
  }, [promptId, handleClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleDismiss}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-end"
      >
        <Pressable className="absolute inset-0 bg-black/60" onPress={handleDismiss} />

        <View className="rounded-t-2xl bg-zinc-900 px-5 pb-8 pt-4">
          {/* Drag handle */}
          <View className="mx-auto mb-5 h-1 w-10 rounded-full bg-zinc-700" />

          <ScrollView showsVerticalScrollIndicator={false}>
            {step === 'score' && (
              <ScoreStep onScorePress={handleScorePress} />
            )}

            {step === 'followup' && selectedScore !== null && (
              <FollowupStep
                score={selectedScore}
                followup={followup}
                onFollowupChange={setFollowup}
                onSubmit={handleSubmit}
                onSkip={handleSubmit}
                submitting={submitting}
                error={error}
              />
            )}

            {step === 'thankyou' && (
              <ThankyouStep />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Step 1: 0-10 score scale.
 */
function ScoreStep({ onScorePress }: { onScorePress: (s: number) => void }) {
  return (
    <View>
      <Text className="mb-1 text-center text-lg font-bold text-zinc-100">
        How likely are you to recommend Styrby?
      </Text>
      <Text className="mb-6 text-center text-sm text-zinc-400">
        To a friend or colleague - 0 to 10
      </Text>

      {/* Score grid: 0-6 then 7-8 then 9-10 */}
      <View className="mb-3 flex-row flex-wrap justify-center gap-2">
        {Array.from({ length: 11 }, (_, i) => (
          <ScoreButton key={i} score={i} onPress={onScorePress} />
        ))}
      </View>

      {/* Labels */}
      <View className="flex-row justify-between px-1">
        <Text className="text-xs text-zinc-500">{SCALE_LABELS.low}</Text>
        <Text className="text-xs text-zinc-500">{SCALE_LABELS.high}</Text>
      </View>
    </View>
  );
}

/**
 * Individual score tap button.
 */
function ScoreButton({
  score,
  onPress,
}: {
  score: number;
  onPress: (s: number) => void;
}) {
  const color =
    score <= 6 ? 'bg-red-900/50 border-red-700' :
    score <= 8 ? 'bg-yellow-900/50 border-yellow-700' :
    'bg-green-900/50 border-green-700';

  const textColor =
    score <= 6 ? 'text-red-300' :
    score <= 8 ? 'text-yellow-300' :
    'text-green-300';

  return (
    <Pressable
      onPress={() => onPress(score)}
      className={`h-12 w-12 items-center justify-center rounded-xl border ${color} active:opacity-70`}
      accessibilityRole="button"
      accessibilityLabel={`Score ${score}`}
    >
      <Text className={`text-base font-semibold ${textColor}`}>{score}</Text>
    </Pressable>
  );
}

/**
 * Step 2: follow-up question.
 */
function FollowupStep({
  score,
  followup,
  onFollowupChange,
  onSubmit,
  onSkip,
  submitting,
  error,
}: {
  score: number;
  followup: string;
  onFollowupChange: (t: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const prompt =
    score >= 9
      ? "What do you love most about Styrby?"
      : score >= 7
      ? "What would make Styrby even better for you?"
      : "What's the #1 thing we could do to improve?";

  return (
    <View>
      <Text className="mb-1 text-center text-base font-bold text-zinc-100">
        {prompt}
      </Text>
      <Text className="mb-4 text-center text-xs text-zinc-500">
        Optional - your score was {score}
      </Text>

      <TextInput
        value={followup}
        onChangeText={onFollowupChange}
        placeholder="Share your thoughts..."
        placeholderTextColor="#71717a"
        multiline
        numberOfLines={4}
        maxLength={2000}
        className="mb-4 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100"
        style={{ minHeight: 96, textAlignVertical: 'top' }}
      />

      {error && (
        <Text className="mb-3 text-center text-sm text-red-400">{error}</Text>
      )}

      <Pressable
        onPress={onSubmit}
        disabled={submitting}
        className="mb-3 items-center rounded-xl bg-indigo-600 py-3 active:bg-indigo-700"
        accessibilityRole="button"
        accessibilityLabel="Submit feedback"
      >
        {submitting ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text className="text-sm font-semibold text-white">Submit</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onSkip}
        disabled={submitting}
        className="items-center py-2"
        accessibilityRole="button"
        accessibilityLabel="Skip follow-up"
      >
        <Text className="text-sm text-zinc-500">Skip follow-up</Text>
      </Pressable>
    </View>
  );
}

/**
 * Step 3: thank-you confirmation.
 */
function ThankyouStep() {
  return (
    <View className="py-8 items-center">
      <Text className="mb-2 text-4xl">🎉</Text>
      <Text className="text-center text-lg font-bold text-zinc-100">
        Thank you!
      </Text>
      <Text className="mt-1 text-center text-sm text-zinc-400">
        Your feedback helps shape Styrby.
      </Text>
    </View>
  );
}
