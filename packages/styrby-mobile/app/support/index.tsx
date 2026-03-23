/**
 * Support Tickets Screen
 *
 * Displays the user's existing support tickets in a scrollable list and
 * provides a floating action button (FAB) to create new tickets. New ticket
 * creation uses a bottom-sheet modal with a type picker, subject input,
 * and description textarea.
 *
 * Uses the useSupport hook for data fetching and ticket creation.
 * Navigation to ticket details uses expo-router dynamic routes.
 */

import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useState, useCallback } from 'react';
import { router, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSupport } from '../../src/hooks/useSupport';
import type { CreateTicketInput } from '../../src/lib/schemas';

// ============================================================================
// Constants
// ============================================================================

/**
 * Support ticket type options with display labels and icons.
 */
const TICKET_TYPES: Array<{
  value: CreateTicketInput['type'];
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}> = [
  { value: 'bug', label: 'Bug Report', icon: 'bug', color: '#ef4444' },
  { value: 'feature', label: 'Feature Request', icon: 'bulb', color: '#eab308' },
  { value: 'question', label: 'Question', icon: 'help-circle', color: '#3b82f6' },
];

/**
 * Status badge colors for ticket status display.
 */
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  open: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  in_progress: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  resolved: { bg: 'bg-green-500/15', text: 'text-green-400' },
  closed: { bg: 'bg-zinc-500/15', text: 'text-zinc-400' },
};

/**
 * Display-friendly status labels.
 */
const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

// ============================================================================
// Component
// ============================================================================

/**
 * Support tickets list screen with new ticket creation modal.
 *
 * Layout:
 * 1. Screen header with "Support" title
 * 2. Scrollable list of existing tickets (newest first)
 * 3. Empty state when no tickets exist
 * 4. FAB (floating action button) to open new ticket modal
 * 5. Bottom-sheet modal with ticket creation form
 *
 * @returns The support screen JSX
 */
export default function SupportScreen() {
  const {
    tickets,
    isLoading,
    isSubmitting,
    error,
    createTicket,
    refresh,
  } = useSupport();

  const [showNewTicketModal, setShowNewTicketModal] = useState(false);
  const [selectedType, setSelectedType] = useState<CreateTicketInput['type']>('bug');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Handles pull-to-refresh by reloading the ticket list.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  /**
   * Submits a new support ticket and resets the form on success.
   * Validates input through the useSupport hook (which uses Zod).
   */
  const handleSubmit = useCallback(async () => {
    const ticket = await createTicket({
      type: selectedType,
      subject: subject.trim(),
      description: description.trim(),
    });

    if (ticket) {
      // Reset form and close modal
      setSubject('');
      setDescription('');
      setSelectedType('bug');
      setShowNewTicketModal(false);
    }
  }, [createTicket, selectedType, subject, description]);

  /**
   * Navigates to the ticket detail screen.
   *
   * @param ticketId - The UUID of the ticket to view
   */
  const handleTicketPress = useCallback((ticketId: string) => {
    router.push(`/support/${ticketId}`);
  }, []);

  /**
   * Closes the new ticket modal and resets form state.
   */
  const handleCloseModal = useCallback(() => {
    setShowNewTicketModal(false);
    setSubject('');
    setDescription('');
    setSelectedType('bug');
  }, []);

  const isFormValid = subject.trim().length >= 3 && description.trim().length >= 10;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: 'Support',
          headerStyle: { backgroundColor: '#09090b' },
          headerTintColor: '#fff',
        }}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#f97316"
            accessibilityLabel="Pull to refresh support tickets"
          />
        }
      >
        {/* Error banner */}
        {error && (
          <View className="mx-4 mt-4 bg-red-500/10 rounded-xl px-4 py-3">
            <Text className="text-red-400 text-sm">{error}</Text>
          </View>
        )}

        {/* Loading state */}
        {isLoading ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" color="#f97316" accessibilityLabel="Loading tickets" />
          </View>
        ) : tickets.length === 0 ? (
          /* Empty state */
          <View className="items-center justify-center py-16 px-8">
            <View className="w-16 h-16 rounded-2xl bg-zinc-800 items-center justify-center mb-4">
              <Ionicons name="chatbubble-ellipses" size={32} color="#71717a" />
            </View>
            <Text className="text-zinc-300 text-lg font-semibold text-center mb-2">
              No support tickets
            </Text>
            <Text className="text-zinc-500 text-sm text-center">
              Need help? Tap the button below to create a support ticket.
            </Text>
          </View>
        ) : (
          /* Ticket list */
          <View className="px-4 pt-4" accessibilityRole="list" accessibilityLabel="Support tickets">
            {tickets.map((ticket) => {
              const statusStyle = STATUS_COLORS[ticket.status] ?? STATUS_COLORS.open;
              const statusLabel = STATUS_LABELS[ticket.status] ?? ticket.status;
              const typeConfig = TICKET_TYPES.find((t) => t.value === ticket.type);
              const createdDate = new Date(ticket.created_at).toLocaleDateString();

              return (
                <Pressable
                  key={ticket.id}
                  onPress={() => handleTicketPress(ticket.id)}
                  className="bg-background-secondary rounded-xl p-4 mb-3 active:opacity-80"
                  accessibilityRole="button"
                  accessibilityLabel={`${ticket.subject}, status: ${statusLabel}`}
                >
                  <View className="flex-row items-start justify-between mb-2">
                    <View className="flex-row items-center flex-1">
                      {typeConfig && (
                        <Ionicons
                          name={typeConfig.icon}
                          size={16}
                          color={typeConfig.color}
                          style={{ marginRight: 8 }}
                        />
                      )}
                      <Text className="text-zinc-100 font-medium text-base flex-1" numberOfLines={1}>
                        {ticket.subject}
                      </Text>
                    </View>
                    <View className={`px-2 py-0.5 rounded-full ml-2 ${statusStyle.bg}`}>
                      <Text className={`text-xs font-medium ${statusStyle.text}`}>
                        {statusLabel}
                      </Text>
                    </View>
                  </View>
                  <Text className="text-zinc-500 text-sm" numberOfLines={2}>
                    {ticket.description}
                  </Text>
                  <Text className="text-zinc-600 text-xs mt-2">
                    {createdDate}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* FAB - New Ticket */}
      <Pressable
        onPress={() => setShowNewTicketModal(true)}
        className="absolute bottom-8 right-6 w-14 h-14 rounded-full bg-brand items-center justify-center shadow-lg active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Create new support ticket"
        style={{
          shadowColor: '#f97316',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
          elevation: 8,
        }}
      >
        <Ionicons name="add" size={28} color="white" />
      </Pressable>

      {/* New Ticket Modal */}
      <Modal
        visible={showNewTicketModal}
        animationType="slide"
        transparent
        onRequestClose={handleCloseModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1 justify-end"
        >
          <Pressable
            className="flex-1"
            onPress={handleCloseModal}
            accessibilityLabel="Close new ticket modal"
          />
          <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
            {/* Drag indicator */}
            <View className="items-center mb-4">
              <View className="w-10 h-1 rounded-full bg-zinc-700" />
            </View>

            {/* Header */}
            <View className="flex-row items-center justify-between mb-5">
              <Text className="text-white text-lg font-semibold">New Support Ticket</Text>
              <Pressable
                onPress={handleCloseModal}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={24} color="#71717a" />
              </Pressable>
            </View>

            {/* Type Picker */}
            <Text className="text-zinc-400 text-sm font-medium mb-2">TYPE</Text>
            <View className="flex-row mb-5">
              {TICKET_TYPES.map((typeOption) => (
                <Pressable
                  key={typeOption.value}
                  onPress={() => setSelectedType(typeOption.value)}
                  className={`flex-1 py-2.5 mx-1 rounded-lg items-center flex-row justify-center ${
                    selectedType === typeOption.value ? 'bg-brand/20 border border-brand/40' : 'bg-zinc-800'
                  }`}
                  accessibilityRole="radio"
                  accessibilityLabel={typeOption.label}
                  accessibilityState={{ selected: selectedType === typeOption.value }}
                >
                  <Ionicons
                    name={typeOption.icon}
                    size={14}
                    color={selectedType === typeOption.value ? '#f97316' : '#71717a'}
                  />
                  <Text
                    className={`text-xs font-medium ml-1 ${
                      selectedType === typeOption.value ? 'text-orange-400' : 'text-zinc-400'
                    }`}
                  >
                    {typeOption.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Subject Input */}
            <Text className="text-zinc-400 text-sm font-medium mb-2">SUBJECT</Text>
            <TextInput
              className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-4"
              placeholder="Brief summary of your issue"
              placeholderTextColor="#71717a"
              value={subject}
              onChangeText={setSubject}
              maxLength={200}
              accessibilityLabel="Ticket subject"
            />

            {/* Description Input */}
            <Text className="text-zinc-400 text-sm font-medium mb-2">DESCRIPTION</Text>
            <TextInput
              className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-1 min-h-[100px]"
              placeholder="Describe your issue in detail..."
              placeholderTextColor="#71717a"
              multiline
              textAlignVertical="top"
              value={description}
              onChangeText={setDescription}
              maxLength={5000}
              accessibilityLabel="Ticket description"
            />
            <Text className="text-zinc-600 text-xs text-right mb-4">
              {description.length}/5000
            </Text>

            {/* Submit Button */}
            <Pressable
              onPress={handleSubmit}
              disabled={!isFormValid || isSubmitting}
              className={`py-3.5 rounded-xl items-center ${
                isFormValid && !isSubmitting ? 'bg-brand active:opacity-80' : 'bg-zinc-700'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Submit support ticket"
              accessibilityState={{ disabled: !isFormValid || isSubmitting }}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text
                  className={`font-semibold text-base ${isFormValid ? 'text-white' : 'text-zinc-500'}`}
                >
                  Submit Ticket
                </Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
