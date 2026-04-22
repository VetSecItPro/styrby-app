/**
 * SessionPostmortemWidget - one-tap post-mortem widget shown on session-summary screen.
 *
 * Shows only when:
 *   - Session status = 'completed' (or 'ended')
 *   - Session duration > 10 minutes
 *   - User has not already submitted a post-mortem for this session
 *
 * Flow:
 *  1. Widget shows: "How did this session go?" with [Useful] [Not useful] [Tell us why]
 *  2. If user taps "Not useful" or "Tell us why", an inline text box expands
 *  3. On submit, inserts a session_postmortem record
 *  4. Widget collapses to a brief "Got it!" confirmation
 *
 * WHY inline widget not modal: The session summary screen already has context.
 * An inline widget is less disruptive - users can see the session details
 * while they give feedback.
 *
 * @module components/feedback/SessionPostmortemWidget
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for SessionPostmortemWidget.
 */
export interface SessionPostmortemWidgetProps {
  /** UUID of the session to rate */
  sessionId: string;
  /** Agent type of the session (for context_json, no PII) */
  agentType: string;
  /** Session duration in seconds (widget only shows if > 600) */
  durationSeconds: number;
  /** Current screen route name for context_json */
  currentRoute?: string;
}

/** Widget state machine. */
type WidgetState =
  | 'idle'
  | 'reason-input'
  | 'submitting'
  | 'submitted'
  | 'error';

// ============================================================================
// Component
// ============================================================================

/**
 * Session post-mortem feedback widget. See module doc.
 *
 * @param props - SessionPostmortemWidgetProps
 */
export function SessionPostmortemWidget({
  sessionId,
  agentType,
  durationSeconds,
  currentRoute,
}: SessionPostmortemWidgetProps) {
  const [state, setState] = useState<WidgetState>('idle');
  const [rating, setRating] = useState<'useful' | 'not_useful' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // WHY: Only show the widget for sessions longer than 10 minutes.
  // Short sessions (< 10 min) are often exploratory - the feedback signal
  // from them is noisy. 10 min is the threshold where users have enough
  // context to give meaningful post-mortem feedback.
  if (durationSeconds < 600) {
    return null;
  }

  /**
   * Submit the post-mortem to the API.
   *
   * @param chosenRating - 'useful' or 'not_useful'
   * @param chosenReason - optional free-text reason
   */
  const submit = useCallback(
    async (chosenRating: 'useful' | 'not_useful', chosenReason?: string) => {
      setState('submitting');
      setError(null);

      try {
        const { data: { session: authSession } } = await supabase.auth.getSession();

        if (!authSession) {
          setState('error');
          setError('Authentication error. Please try again.');
          return;
        }

        const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://www.styrbyapp.com';

        const body: Record<string, unknown> = {
          kind: 'session_postmortem',
          sessionId,
          rating: chosenRating,
          contextJson: {
            screen: currentRoute ?? '/session',
            agent: agentType,
          },
        };
        if (chosenReason?.trim()) {
          body.reason = chosenReason.trim();
        }

        const res = await fetch(`${appUrl}/api/feedback/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authSession.access_token}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }

        setState('submitted');
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : 'Submission failed.');
      }
    },
    [sessionId, agentType, currentRoute]
  );

  /** Handle "Useful" tap - immediate submit without reason. */
  const handleUseful = useCallback(() => {
    setRating('useful');
    void submit('useful');
  }, [submit]);

  /** Handle "Not useful" tap - show reason input. */
  const handleNotUseful = useCallback(() => {
    setRating('not_useful');
    setState('reason-input');
  }, []);

  /** Handle "Tell us why" tap - show reason input (deferred rating). */
  const handleTellUsWhy = useCallback(() => {
    setState('reason-input');
  }, []);

  /** Submit with reason from the expanded input. */
  const handleSubmitWithReason = useCallback(() => {
    void submit(rating ?? 'not_useful', reason);
  }, [submit, rating, reason]);

  if (state === 'submitted') {
    return (
      <View className="mx-4 my-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <Text className="text-center text-sm text-zinc-400">
          Got it - thanks for the feedback!
        </Text>
      </View>
    );
  }

  return (
    <View className="mx-4 my-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <Text className="mb-3 text-sm font-medium text-zinc-200">
        How did this session go?
      </Text>

      {/* Tap buttons */}
      {(state === 'idle' || state === 'reason-input') && (
        <View className="mb-3 flex-row gap-2">
          {/* Useful */}
          <Pressable
            onPress={handleUseful}
            disabled={false}
            className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border py-2.5 ${
              rating === 'useful'
                ? 'border-green-600 bg-green-900/30'
                : 'border-zinc-700 bg-zinc-800'
            } active:opacity-70`}
            accessibilityRole="button"
            accessibilityLabel="This session was useful"
          >
            <Ionicons
              name="thumbs-up-outline"
              size={16}
              color={rating === 'useful' ? '#4ade80' : '#71717a'}
            />
            <Text
              className={`text-sm ${
                rating === 'useful' ? 'text-green-300' : 'text-zinc-400'
              }`}
            >
              Useful
            </Text>
          </Pressable>

          {/* Not useful */}
          <Pressable
            onPress={handleNotUseful}
            disabled={false}
            className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border py-2.5 ${
              rating === 'not_useful'
                ? 'border-red-700 bg-red-900/30'
                : 'border-zinc-700 bg-zinc-800'
            } active:opacity-70`}
            accessibilityRole="button"
            accessibilityLabel="This session was not useful"
          >
            <Ionicons
              name="thumbs-down-outline"
              size={16}
              color={rating === 'not_useful' ? '#f87171' : '#71717a'}
            />
            <Text
              className={`text-sm ${
                rating === 'not_useful' ? 'text-red-300' : 'text-zinc-400'
              }`}
            >
              Not useful
            </Text>
          </Pressable>

          {/* Tell us why */}
          <Pressable
            onPress={handleTellUsWhy}
            disabled={state === 'reason-input'}
            className="flex-row items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Tell us why"
          >
            <Ionicons name="chatbubble-outline" size={16} color="#71717a" />
          </Pressable>
        </View>
      )}

      {/* Reason input (expanded when not_useful or tell-us-why) */}
      {state === 'reason-input' && (
        <View>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="What went wrong? (optional)"
            placeholderTextColor="#52525b"
            multiline
            numberOfLines={3}
            maxLength={500}
            className="mb-3 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100"
            style={{ minHeight: 72, textAlignVertical: 'top' }}
            autoFocus
          />

          <View className="flex-row gap-2">
            <Pressable
              onPress={handleSubmitWithReason}
              className="flex-1 items-center rounded-lg bg-indigo-600 py-2.5 active:bg-indigo-700"
              accessibilityRole="button"
              accessibilityLabel="Submit feedback"
            >
              <Text className="text-sm font-medium text-white">Submit</Text>
            </Pressable>
            <Pressable
              onPress={() => void submit(rating ?? 'not_useful')}
              className="items-center rounded-lg border border-zinc-700 px-4 py-2.5 active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Skip reason"
            >
              <Text className="text-sm text-zinc-400">Skip</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Submitting indicator */}
      {state === 'submitting' && (
        <View className="items-center py-2">
          <ActivityIndicator size="small" color="#818cf8" />
        </View>
      )}

      {/* Error display */}
      {state === 'error' && error && (
        <View className="mt-2">
          <Text className="text-center text-xs text-red-400">{error}</Text>
          <Pressable
            onPress={() => setState('idle')}
            className="mt-2 items-center"
          >
            <Text className="text-xs text-zinc-500">Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
