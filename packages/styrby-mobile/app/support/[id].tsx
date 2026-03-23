/**
 * Support Ticket Detail Screen
 *
 * Displays a single support ticket with its full description and a threaded
 * conversation of replies. Users can add new replies via an input field at
 * the bottom. New replies from admins appear in real-time via Supabase
 * Realtime subscriptions.
 *
 * Route: /support/[id] (expo-router dynamic segment)
 */

import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { useSupport } from '../../src/hooks/useSupport';
import type { ValidatedSupportTicket, ValidatedSupportTicketReply } from '../../src/lib/schemas';

// ============================================================================
// Constants
// ============================================================================

/**
 * Status badge colors for the ticket header.
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

/**
 * Type labels with associated colors.
 */
const TYPE_CONFIG: Record<string, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  bug: { label: 'Bug Report', color: '#ef4444', icon: 'bug' },
  feature: { label: 'Feature Request', color: '#eab308', icon: 'bulb' },
  question: { label: 'Question', color: '#3b82f6', icon: 'help-circle' },
};

// ============================================================================
// Component
// ============================================================================

/**
 * Support ticket detail screen showing ticket info and threaded replies.
 *
 * Layout:
 * 1. Ticket header (type, subject, status, created date)
 * 2. Original description
 * 3. Replies thread (user replies aligned right, admin replies aligned left)
 * 4. Reply input at the bottom (disabled for closed tickets)
 *
 * Real-time updates: Subscribes to Supabase Realtime for INSERT events on
 * the support_ticket_replies table, filtered by ticket_id. New replies appear
 * immediately in the thread without polling.
 *
 * @returns The ticket detail screen JSX
 */
export default function TicketDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const { getTicket, replyToTicket, subscribeToReplies } = useSupport();

  // Validate the ticket ID is a valid UUID before using it in queries
  const parsedId = z.string().uuid().safeParse(rawId);
  const id = parsedId.success ? parsedId.data : null;

  const [ticket, setTicket] = useState<ValidatedSupportTicket | null>(null);
  const [replies, setReplies] = useState<ValidatedSupportTicketReply[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  // --------------------------------------------------------------------------
  // Data Loading
  // --------------------------------------------------------------------------

  /**
   * Fetches the ticket and its replies from Supabase.
   * Called on mount and can be called to refresh.
   */
  const loadTicketData = useCallback(async () => {
    if (!id) return;

    setIsLoading(true);
    const result = await getTicket(id);
    if (result) {
      setTicket(result.ticket);
      setReplies(result.replies);
    }
    setIsLoading(false);
  }, [id, getTicket]);

  // Load ticket data on mount
  useEffect(() => {
    loadTicketData();
  }, [loadTicketData]);

  // --------------------------------------------------------------------------
  // Real-time Subscription
  // --------------------------------------------------------------------------

  /**
   * WHY: We subscribe to real-time reply events so that admin responses
   * appear instantly in the conversation thread. Without this, the user
   * would need to manually refresh to see new admin replies.
   */
  useEffect(() => {
    if (!id) return;

    const unsubscribe = subscribeToReplies(id, (newReply) => {
      setReplies((prev) => {
        // Avoid duplicates (e.g., if the user's own reply is echoed back)
        if (prev.some((r) => r.id === newReply.id)) return prev;
        return [...prev, newReply];
      });

      // Auto-scroll to the new reply
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });

    return unsubscribe;
  }, [id, subscribeToReplies]);

  // --------------------------------------------------------------------------
  // Reply Handler
  // --------------------------------------------------------------------------

  /**
   * Submits a new reply to the ticket and adds it to the local reply list.
   * The reply also arrives via the real-time subscription, so we de-duplicate
   * in the subscription handler.
   */
  const handleSendReply = useCallback(async () => {
    if (!id || replyText.trim().length === 0) return;

    setIsSendingReply(true);
    const reply = await replyToTicket(id, replyText.trim());
    if (reply) {
      setReplies((prev) => {
        if (prev.some((r) => r.id === reply.id)) return prev;
        return [...prev, reply];
      });
      setReplyText('');

      // Scroll to the new reply
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
    setIsSendingReply(false);
  }, [id, replyText, replyToTicket]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // WHY: Early returns for error/loading states must come after all hooks
  // to satisfy React's rules-of-hooks (hooks cannot be called conditionally).
  if (!parsedId.success) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-8">
        <Stack.Screen
          options={{
            title: 'Ticket',
            headerStyle: { backgroundColor: '#09090b' },
            headerTintColor: '#fff',
          }}
        />
        <Ionicons name="alert-circle" size={48} color="#71717a" />
        <Text className="text-zinc-400 text-lg mt-4 text-center">
          Invalid ticket ID
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Stack.Screen
          options={{
            title: 'Ticket',
            headerStyle: { backgroundColor: '#09090b' },
            headerTintColor: '#fff',
          }}
        />
        <ActivityIndicator size="large" color="#f97316" accessibilityLabel="Loading ticket" />
      </View>
    );
  }

  if (!ticket) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-8">
        <Stack.Screen
          options={{
            title: 'Ticket',
            headerStyle: { backgroundColor: '#09090b' },
            headerTintColor: '#fff',
          }}
        />
        <Ionicons name="alert-circle" size={48} color="#71717a" />
        <Text className="text-zinc-400 text-lg mt-4 text-center">
          Ticket not found
        </Text>
      </View>
    );
  }

  const statusStyle = STATUS_COLORS[ticket.status] ?? STATUS_COLORS.open;
  const statusLabel = STATUS_LABELS[ticket.status] ?? ticket.status;
  const typeConfig = TYPE_CONFIG[ticket.type] ?? TYPE_CONFIG.question;
  const isClosed = ticket.status === 'closed' || ticket.status === 'resolved';
  const createdDate = new Date(ticket.created_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <Stack.Screen
        options={{
          title: 'Ticket',
          headerStyle: { backgroundColor: '#09090b' },
          headerTintColor: '#fff',
        }}
      />

      <ScrollView
        ref={scrollViewRef}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 16 }}
      >
        {/* Ticket Header */}
        <View className="px-4 pt-4 pb-3 border-b border-zinc-800">
          <View className="flex-row items-center mb-2">
            <Ionicons name={typeConfig.icon} size={16} color={typeConfig.color} />
            <Text className="text-zinc-500 text-xs ml-1.5 mr-3">{typeConfig.label}</Text>
            <View className={`px-2 py-0.5 rounded-full ${statusStyle.bg}`}>
              <Text className={`text-xs font-medium ${statusStyle.text}`}>
                {statusLabel}
              </Text>
            </View>
          </View>
          <Text className="text-white text-lg font-semibold mb-1">
            {ticket.subject}
          </Text>
          <Text className="text-zinc-600 text-xs">
            {createdDate}
          </Text>
        </View>

        {/* Original Description */}
        <View className="px-4 py-4 border-b border-zinc-800">
          <Text className="text-zinc-300 text-sm leading-6">
            {ticket.description}
          </Text>
        </View>

        {/* Replies Thread */}
        {replies.length > 0 && (
          <View
            className="px-4 pt-4"
            accessibilityRole="list"
            accessibilityLabel="Ticket replies"
          >
            <Text className="text-zinc-500 text-xs font-medium mb-3">REPLIES</Text>
            {replies.map((reply) => {
              const isUser = reply.author_type === 'user';
              const replyDate = new Date(reply.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <View
                  key={reply.id}
                  className={`mb-3 ${isUser ? 'items-end' : 'items-start'}`}
                  accessible
                  accessibilityLabel={`${isUser ? 'Your' : 'Support'} reply`}
                >
                  <View
                    className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                      isUser
                        ? 'bg-brand/20 rounded-br-sm'
                        : 'bg-zinc-800 rounded-bl-sm'
                    }`}
                  >
                    <View className="flex-row items-center mb-1">
                      <Ionicons
                        name={isUser ? 'person' : 'shield-checkmark'}
                        size={12}
                        color={isUser ? '#f97316' : '#22c55e'}
                      />
                      <Text
                        className={`text-xs font-medium ml-1 ${
                          isUser ? 'text-orange-400' : 'text-green-400'
                        }`}
                      >
                        {isUser ? 'You' : 'Support'}
                      </Text>
                    </View>
                    <Text className="text-zinc-200 text-sm leading-5">
                      {reply.message}
                    </Text>
                    <Text className="text-zinc-600 text-xs mt-1.5">
                      {replyDate}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* No replies yet */}
        {replies.length === 0 && (
          <View className="items-center py-8">
            <Text className="text-zinc-600 text-sm">No replies yet</Text>
          </View>
        )}
      </ScrollView>

      {/* Reply Input */}
      {!isClosed ? (
        <View className="px-4 py-3 border-t border-zinc-800 bg-zinc-900">
          <View className="flex-row items-end">
            <TextInput
              className="flex-1 bg-zinc-800 text-white rounded-xl px-4 py-2.5 text-sm max-h-[100px] mr-2"
              placeholder="Write a reply..."
              placeholderTextColor="#71717a"
              multiline
              value={replyText}
              onChangeText={setReplyText}
              maxLength={5000}
              accessibilityLabel="Reply message input"
            />
            <Pressable
              onPress={handleSendReply}
              disabled={replyText.trim().length === 0 || isSendingReply}
              className={`w-10 h-10 rounded-full items-center justify-center ${
                replyText.trim().length > 0 && !isSendingReply ? 'bg-brand' : 'bg-zinc-700'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Send reply"
              accessibilityState={{ disabled: replyText.trim().length === 0 || isSendingReply }}
            >
              {isSendingReply ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Ionicons name="send" size={16} color="white" />
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="px-4 py-3 border-t border-zinc-800 bg-zinc-900 items-center">
          <Text className="text-zinc-500 text-sm">
            This ticket is {statusLabel.toLowerCase()}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
