/**
 * FeedbackSheet - general in-app feedback bottom sheet for mobile.
 *
 * Simple free-text form with an optional reply email field.
 * Submits to /api/feedback/submit with kind='general'.
 *
 * WHY bottom sheet: Consistent with NpsSurveySheet. Dismissible with
 * a tap on the backdrop - minimal disruption to the user's flow.
 *
 * @module components/feedback/FeedbackSheet
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
 * Props for FeedbackSheet.
 */
export interface FeedbackSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** Current route for context capture (no PII) */
  currentRoute?: string;
  /** Called when the sheet should close */
  onClose: () => void;
}

type SheetState = 'idle' | 'submitting' | 'submitted' | 'error';

// ============================================================================
// Component
// ============================================================================

/**
 * General feedback sheet. See module doc.
 *
 * @param props - FeedbackSheetProps
 */
export function FeedbackSheet({
  visible,
  currentRoute,
  onClose,
}: FeedbackSheetProps) {
  const [message, setMessage] = useState('');
  const [replyEmail, setReplyEmail] = useState('');
  const [state, setState] = useState<SheetState>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (state !== 'submitting') {
      setMessage('');
      setReplyEmail('');
      setState('idle');
      setError(null);
      onClose();
    }
  }, [state, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!message.trim()) return;

    setState('submitting');
    setError(null);

    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();

      if (!authSession) {
        setState('error');
        setError('Please sign in to submit feedback.');
        return;
      }

      const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://www.styrbyapp.com';

      const body: Record<string, unknown> = {
        kind: 'general',
        message: message.trim(),
        contextJson: { screen: currentRoute ?? '/settings' },
      };
      if (replyEmail.trim()) {
        body.replyEmail = replyEmail.trim();
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
      setTimeout(handleClose, 2000);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Submission failed. Please try again.');
    }
  }, [message, replyEmail, currentRoute, handleClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-end"
      >
        <Pressable className="absolute inset-0 bg-black/60" onPress={handleClose} />

        <View className="rounded-t-2xl bg-zinc-900 px-5 pb-10 pt-4">
          <View className="mx-auto mb-5 h-1 w-10 rounded-full bg-zinc-700" />

          <ScrollView showsVerticalScrollIndicator={false}>
            {state === 'submitted' ? (
              <View className="py-10 items-center">
                <Text className="mb-2 text-4xl">🙌</Text>
                <Text className="text-lg font-bold text-zinc-100">Feedback sent!</Text>
                <Text className="mt-1 text-sm text-zinc-400">We read every submission.</Text>
              </View>
            ) : (
              <>
                <Text className="mb-1 text-lg font-bold text-zinc-100">Send feedback</Text>
                <Text className="mb-5 text-sm text-zinc-400">
                  Tell us what you think - we read everything.
                </Text>

                <TextInput
                  value={message}
                  onChangeText={setMessage}
                  placeholder="What's on your mind?"
                  placeholderTextColor="#71717a"
                  multiline
                  numberOfLines={5}
                  maxLength={2000}
                  className="mb-4 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100"
                  style={{ minHeight: 120, textAlignVertical: 'top' }}
                  autoFocus
                />

                <TextInput
                  value={replyEmail}
                  onChangeText={setReplyEmail}
                  placeholder="Reply email (optional)"
                  placeholderTextColor="#71717a"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={254}
                  className="mb-4 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100"
                />

                {error && (
                  <Text className="mb-3 text-center text-sm text-red-400">{error}</Text>
                )}

                <Pressable
                  onPress={handleSubmit}
                  disabled={state === 'submitting' || !message.trim()}
                  className={`items-center rounded-xl py-3 ${
                    message.trim()
                      ? 'bg-indigo-600 active:bg-indigo-700'
                      : 'bg-zinc-700'
                  }`}
                  accessibilityRole="button"
                  accessibilityLabel="Submit feedback"
                >
                  {state === 'submitting' ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text
                      className={`text-sm font-semibold ${
                        message.trim() ? 'text-white' : 'text-zinc-500'
                      }`}
                    >
                      Send feedback
                    </Text>
                  )}
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
