/**
 * Support Settings Sub-Screen
 *
 * Owns: feedback form, help link, privacy/terms legal links, support tickets.
 * Submits feedback to the `user_feedback` table in Supabase.
 *
 * WHY a sub-screen: the feedback form was previously an inline modal inside the
 * 2,720-LOC settings monolith. Promoting it to a full screen gives it dedicated
 * space, removes the modal stack from settings.tsx, and is easier to deep-link.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 7
 */

import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Linking,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/lib/supabase';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { SectionHeader, SettingRow } from '../../src/components/ui';
import { SITE_URLS } from '../../src/lib/config';

// ============================================================================
// Constants
// ============================================================================

/**
 * External URLs for support and legal pages.
 * WHY import from SITE_URLS: single source of truth for prod/staging URLs.
 */
const HELP_URL = SITE_URLS.help;
const PRIVACY_URL = SITE_URLS.privacy;
const TERMS_URL = SITE_URLS.terms;

/**
 * Maximum character count for user feedback messages.
 * WHY: The `user_feedback.message` column has a CHECK constraint limiting
 * message length. Enforcing the limit client-side avoids a 400 from Supabase
 * and gives the user a real-time character counter.
 */
const MAX_FEEDBACK_LENGTH = 2000;

// ============================================================================
// Component
// ============================================================================

/**
 * Support sub-screen.
 *
 * Data flow:
 * - On feedback submit: INSERT into user_feedback (user_id, feedback_type, message, platform)
 * - All other rows open external URLs or navigate to the support route
 *
 * @returns React element
 */
export default function SupportScreen() {
  const router = useRouter();
  const { user } = useCurrentUser();

  /** The text content of the feedback being composed */
  const [feedbackText, setFeedbackText] = useState('');

  /** Whether the feedback is currently being submitted to Supabase */
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Submits user feedback to the user_feedback table in Supabase.
   * Clears the text and shows a success alert on completion.
   *
   * WHY we use feedback_type='general': user_feedback.feedback_type is a NOT NULL
   * enum column. 'general' is the catch-all type for in-app feedback from the
   * settings screen. Specific feedback types (bug, feature request) are future work.
   */
  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = feedbackText.trim();
    if (!trimmed || !user) return;

    setIsSubmittingFeedback(true);
    try {
      const { error } = await supabase
        .from('user_feedback')
        .insert({
          user_id: user.id,
          feedback_type: 'general',
          message: trimmed,
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
        });

      if (error) {
        Alert.alert('Error', 'Failed to submit feedback. Please try again.');
        if (__DEV__) {
          console.error('[Support] Failed to submit feedback:', error);
        }
      } else {
        setFeedbackText('');
        Alert.alert('Thank You', 'Your feedback has been submitted.');
      }
    } catch (error) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Support] Feedback submission error:', error);
      }
    } finally {
      setIsSubmittingFeedback(false);
    }
  }, [feedbackText, user]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <ScrollView
        className="flex-1 bg-background"
        keyboardShouldPersistTaps="handled"
      >
        {/* Help & Tickets */}
        <SectionHeader title="Get Help" />
        <View className="bg-background-secondary">
          <SettingRow
            icon="ticket"
            iconColor="#f97316"
            title="Support Tickets"
            subtitle="View or create support tickets"
            onPress={() => router.push('/support')}
          />
          <SettingRow
            icon="help-circle"
            iconColor="#71717a"
            title="Help & FAQ"
            subtitle="Browse the knowledge base"
            onPress={() => Linking.openURL(HELP_URL)}
          />
        </View>

        {/* Feedback Form */}
        <SectionHeader title="Send Feedback" />
        <View className="bg-background-secondary px-4 py-4">
          <Text className="text-zinc-400 text-sm mb-3">
            Tell us what you think, report a bug, or suggest a feature.
          </Text>

          <TextInput
            className="bg-zinc-800 text-white rounded-xl p-4 text-base mb-2"
            style={{ minHeight: 120, textAlignVertical: 'top' }}
            placeholder="Your feedback..."
            placeholderTextColor="#71717a"
            multiline
            value={feedbackText}
            onChangeText={setFeedbackText}
            maxLength={MAX_FEEDBACK_LENGTH}
            accessibilityLabel="Feedback text input"
          />

          {/* Character count */}
          <Text className="text-zinc-600 text-xs text-right mb-4">
            {feedbackText.length}/{MAX_FEEDBACK_LENGTH}
          </Text>

          {/* Submit Button */}
          <Pressable
            className={`py-3 rounded-xl items-center ${
              feedbackText.trim().length > 0 && !isSubmittingFeedback
                ? 'bg-brand active:opacity-80'
                : 'bg-zinc-700'
            }`}
            onPress={() => void handleSubmitFeedback()}
            disabled={feedbackText.trim().length === 0 || isSubmittingFeedback}
            accessibilityRole="button"
            accessibilityLabel="Submit feedback"
          >
            {isSubmittingFeedback ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text className="text-white font-semibold">Submit Feedback</Text>
            )}
          </Pressable>
        </View>

        {/* Legal */}
        <SectionHeader title="Legal" />
        <View className="bg-background-secondary">
          <SettingRow
            icon="document-text"
            iconColor="#71717a"
            title="Privacy Policy"
            onPress={() => Linking.openURL(PRIVACY_URL)}
          />
          <SettingRow
            icon="document-text"
            iconColor="#71717a"
            title="Terms of Service"
            onPress={() => Linking.openURL(TERMS_URL)}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
