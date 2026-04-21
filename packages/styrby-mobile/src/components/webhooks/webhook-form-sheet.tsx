/**
 * WebhookFormSheet
 *
 * Bottom-sheet modal for creating a new webhook. Owns its own form state
 * (name, URL, selected events) and validates with Zod before invoking the
 * caller-supplied `onSave` handler.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CreateWebhookInput, WebhookEvent } from '../../types/webhooks';
import { EVENT_OPTIONS, WebhookFormSchema } from './webhook-helpers';

interface FormSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** Close the sheet without saving */
  onClose: () => void;
  /** Save the form data */
  onSave: (input: CreateWebhookInput) => Promise<void>;
  /** Whether a save is in progress */
  isSaving: boolean;
}

/**
 * Renders the create-webhook form.
 *
 * WHY local state (not lifted to the orchestrator):
 * The form values only matter while the sheet is open; lifting them would
 * pollute the orchestrator with transient input state. On close we reset, so
 * the next "New Webhook" tap always starts clean.
 *
 * @param props - Form sheet props
 * @returns React element
 */
export function WebhookFormSheet({ visible, onClose, onSave, isSaving }: FormSheetProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<Set<WebhookEvent>>(
    new Set(['session.started'])
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * Resets the form to empty state.
   */
  const resetForm = useCallback(() => {
    setName('');
    setUrl('');
    setSelectedEvents(new Set(['session.started']));
    setValidationError(null);
  }, []);

  /**
   * Toggles an event type in the selected set.
   *
   * @param event - The event type to toggle
   */
  const toggleEvent = useCallback((event: WebhookEvent) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) {
        next.delete(event);
      } else {
        next.add(event);
      }
      return next;
    });
  }, []);

  /**
   * Validates the form and triggers the save callback.
   */
  const handleSave = useCallback(async () => {
    setValidationError(null);

    const result = WebhookFormSchema.safeParse({
      name: name.trim(),
      url: url.trim(),
      events: Array.from(selectedEvents),
    });

    if (!result.success) {
      setValidationError(result.error.issues[0]?.message ?? 'Invalid form data');
      return;
    }

    await onSave({
      name: result.data.name,
      url: result.data.url,
      events: result.data.events as WebhookEvent[],
    });

    resetForm();
  }, [name, url, selectedEvents, onSave, resetForm]);

  /**
   * Closes the sheet and resets the form.
   */
  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 bg-zinc-950"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-4 border-b border-zinc-800">
          <Pressable
            onPress={handleClose}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Cancel and close form"
          >
            <Text className="text-zinc-400 text-base">Cancel</Text>
          </Pressable>
          <Text className="text-white font-semibold text-lg">New Webhook</Text>
          <Pressable
            onPress={handleSave}
            disabled={isSaving}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Save webhook"
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#f97316" />
            ) : (
              <Text className="text-brand font-semibold text-base">Save</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          className="flex-1 px-4 pt-4"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Validation Error */}
          {validationError && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
              <Text className="text-red-400 text-sm">{validationError}</Text>
            </View>
          )}

          {/* Name */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="My Webhook"
            placeholderTextColor="#52525b"
            className="bg-zinc-900 text-white rounded-xl px-4 py-3 mb-4"
            autoCapitalize="words"
            returnKeyType="next"
            accessibilityLabel="Webhook name"
          />

          {/* URL */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Endpoint URL
          </Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://your-server.com/hooks/styrby"
            placeholderTextColor="#52525b"
            className="bg-zinc-900 text-white rounded-xl px-4 py-3 mb-1"
            autoCapitalize="none"
            keyboardType="url"
            returnKeyType="done"
            autoCorrect={false}
            accessibilityLabel="Webhook endpoint URL"
          />
          <Text className="text-zinc-500 text-xs mb-4">Must be an HTTPS URL</Text>

          {/* Event Types */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Events
          </Text>
          <View className="bg-zinc-900 rounded-2xl mb-8 overflow-hidden">
            {EVENT_OPTIONS.map((option, index) => {
              const isSelected = selectedEvents.has(option.value);
              return (
                <Pressable
                  key={option.value}
                  onPress={() => toggleEvent(option.value)}
                  className={`flex-row items-center px-4 py-3 active:bg-zinc-800 ${
                    index < EVENT_OPTIONS.length - 1 ? 'border-b border-zinc-800' : ''
                  }`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`${option.label}: ${option.description}`}
                >
                  <View
                    className="w-5 h-5 rounded border-2 items-center justify-center mr-3"
                    style={{
                      borderColor: isSelected ? '#f97316' : '#3f3f46',
                      backgroundColor: isSelected ? '#f97316' : 'transparent',
                    }}
                  >
                    {isSelected && <Ionicons name="checkmark" size={12} color="white" />}
                  </View>
                  <View className="flex-1">
                    <Text className="text-white font-medium text-sm">{option.label}</Text>
                    <Text className="text-zinc-500 text-xs">{option.description}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
