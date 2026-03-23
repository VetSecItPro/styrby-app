/**
 * Support Tickets Hook
 *
 * Provides CRUD operations for support tickets and real-time reply subscriptions.
 * Users can list their tickets, create new ones, view individual tickets with
 * threaded replies, and reply to existing tickets.
 *
 * Uses the support_tickets and support_ticket_replies tables created in
 * migration 012_support_tickets.sql. RLS policies restrict access to the
 * authenticated user's own tickets.
 *
 * Real-time subscriptions use Supabase Realtime to receive new replies
 * on the detail view without polling.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {
  SupportTicketSchema,
  SupportTicketReplySchema,
  CreateTicketInputSchema,
  safeParseArray,
  safeParseSingle,
} from '../lib/schemas';
import type {
  ValidatedSupportTicket,
  ValidatedSupportTicketReply,
  CreateTicketInput,
} from '../lib/schemas';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

/**
 * Return type for the useSupport hook.
 */
export interface UseSupportReturn {
  /** List of the user's support tickets, sorted by newest first */
  tickets: ValidatedSupportTicket[];
  /** Whether the ticket list is currently loading */
  isLoading: boolean;
  /** Whether a new ticket is being submitted */
  isSubmitting: boolean;
  /** Error message from the most recent operation, or null */
  error: string | null;
  /** Fetches a single ticket with its replies by ID */
  getTicket: (id: string) => Promise<TicketWithReplies | null>;
  /** Creates a new support ticket */
  createTicket: (input: CreateTicketInput) => Promise<ValidatedSupportTicket | null>;
  /** Adds a reply to an existing ticket */
  replyToTicket: (ticketId: string, message: string) => Promise<ValidatedSupportTicketReply | null>;
  /** Subscribes to real-time replies for a specific ticket. Returns an unsubscribe function. */
  subscribeToReplies: (ticketId: string, onNewReply: (reply: ValidatedSupportTicketReply) => void) => () => void;
  /** Refreshes the ticket list */
  refresh: () => Promise<void>;
}

/**
 * Represents a support ticket along with its threaded replies.
 * Used by the ticket detail screen.
 */
export interface TicketWithReplies {
  /** The support ticket data */
  ticket: ValidatedSupportTicket;
  /** Chronologically ordered replies */
  replies: ValidatedSupportTicketReply[];
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing support ticket operations.
 *
 * Loads the user's ticket list on mount and provides functions for creating
 * tickets, fetching ticket details with replies, replying to tickets, and
 * subscribing to real-time reply updates.
 *
 * @returns Support ticket data, loading states, and action functions
 *
 * @example
 * const {
 *   tickets, isLoading, error, createTicket,
 *   getTicket, replyToTicket, subscribeToReplies,
 * } = useSupport();
 *
 * // Create a new ticket
 * const ticket = await createTicket({
 *   type: 'bug',
 *   subject: 'App crashes on launch',
 *   description: 'Detailed description of the issue...',
 * });
 */
export function useSupport(): UseSupportReturn {
  const [tickets, setTickets] = useState<ValidatedSupportTicket[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WHY: Track active Realtime channels so we can clean up on unmount.
  // Without cleanup, channels would leak and accumulate WebSocket connections.
  const activeChannelsRef = useRef<RealtimeChannel[]>([]);

  // --------------------------------------------------------------------------
  // Ticket List
  // --------------------------------------------------------------------------

  /**
   * Fetches all support tickets for the authenticated user.
   * Tickets are sorted by created_at descending (newest first).
   * RLS policies ensure only the user's own tickets are returned.
   *
   * @throws Sets error state if the user is not authenticated or the query fails
   */
  const loadTickets = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to view support tickets.');
        setIsLoading(false);
        return;
      }

      const { data, error: queryError } = await supabase
        .from('support_tickets')
        .select('id, user_id, type, subject, description, status, created_at, updated_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (queryError) {
        throw new Error(queryError.message);
      }

      const validated = safeParseArray(SupportTicketSchema, data, 'support_tickets');
      setTickets(validated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load support tickets';
      setError(message);
      if (__DEV__) {
        console.error('[useSupport] Error loading tickets:', err);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load tickets on mount
  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  // Clean up Realtime channels on unmount
  useEffect(() => {
    return () => {
      for (const channel of activeChannelsRef.current) {
        supabase.removeChannel(channel);
      }
      activeChannelsRef.current = [];
    };
  }, []);

  // --------------------------------------------------------------------------
  // Get Single Ticket with Replies
  // --------------------------------------------------------------------------

  /**
   * Fetches a single support ticket and its threaded replies.
   * Replies are ordered chronologically (oldest first) for display
   * as a conversation thread.
   *
   * @param id - The ticket UUID to fetch
   * @returns The ticket with its replies, or null if not found
   *
   * @example
   * const result = await getTicket('abc-123');
   * if (result) {
   *   console.log(result.ticket.subject, result.replies.length);
   * }
   */
  const getTicket = useCallback(async (id: string): Promise<TicketWithReplies | null> => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to view a support ticket.');
        return null;
      }

      const [ticketResult, repliesResult] = await Promise.all([
        supabase
          .from('support_tickets')
          .select('id, user_id, type, subject, description, status, created_at, updated_at')
          .eq('id', id)
          .single(),
        supabase
          .from('support_ticket_replies')
          .select('*')
          .eq('ticket_id', id)
          .order('created_at', { ascending: true }),
      ]);

      if (ticketResult.error) {
        throw new Error(ticketResult.error.message);
      }

      const ticket = safeParseSingle(SupportTicketSchema, ticketResult.data, 'support_ticket');
      if (!ticket) {
        return null;
      }

      const replies = safeParseArray(
        SupportTicketReplySchema,
        repliesResult.data,
        'support_ticket_replies',
      );

      return { ticket, replies };
    } catch (err) {
      if (__DEV__) {
        console.error('[useSupport] Error fetching ticket:', err);
      }
      return null;
    }
  }, []);

  // --------------------------------------------------------------------------
  // Create Ticket
  // --------------------------------------------------------------------------

  /**
   * Creates a new support ticket after validating input with Zod.
   * Updates the local ticket list on success so the new ticket appears
   * immediately without a re-fetch.
   *
   * @param input - The ticket type, subject, and description
   * @returns The created ticket, or null on failure
   * @throws Sets error state with a validation or database error message
   *
   * @example
   * const ticket = await createTicket({
   *   type: 'feature',
   *   subject: 'Add dark mode',
   *   description: 'It would be great to have a dark mode option...',
   * });
   */
  const createTicket = useCallback(async (
    input: CreateTicketInput,
  ): Promise<ValidatedSupportTicket | null> => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Validate input with Zod before sending to Supabase
      const parseResult = CreateTicketInputSchema.safeParse(input);
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        setError(firstIssue?.message ?? 'Invalid ticket data');
        return null;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to create a support ticket.');
        return null;
      }

      const { data, error: insertError } = await supabase
        .from('support_tickets')
        .insert({
          user_id: user.id,
          type: parseResult.data.type,
          subject: parseResult.data.subject,
          description: parseResult.data.description,
          priority: parseResult.data.priority ?? 'medium',
        })
        .select('*')
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      const validated = safeParseSingle(SupportTicketSchema, data, 'support_ticket');
      if (validated) {
        // Prepend to local list so the new ticket appears immediately
        setTickets((prev) => [validated, ...prev]);
      }

      return validated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create support ticket';
      setError(message);
      if (__DEV__) {
        console.error('[useSupport] Error creating ticket:', err);
      }
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Reply to Ticket
  // --------------------------------------------------------------------------

  /**
   * Adds a user reply to an existing support ticket.
   *
   * @param ticketId - The ticket UUID to reply to
   * @param message - The reply message content (1-5000 characters)
   * @returns The created reply, or null on failure
   *
   * @example
   * const reply = await replyToTicket('ticket-id', 'Thanks for the update!');
   */
  const replyToTicket = useCallback(async (
    ticketId: string,
    message: string,
  ): Promise<ValidatedSupportTicketReply | null> => {
    try {
      if (message.trim().length === 0) {
        setError('Reply message cannot be empty.');
        return null;
      }

      if (message.length > 5000) {
        setError('Reply message must be at most 5000 characters.');
        return null;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to reply.');
        return null;
      }

      const { data, error: insertError } = await supabase
        .from('support_ticket_replies')
        .insert({
          ticket_id: ticketId,
          author_type: 'user',
          author_id: user.id,
          message: message.trim(),
        })
        .select('*')
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      return safeParseSingle(SupportTicketReplySchema, data, 'support_ticket_reply');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : 'Failed to submit reply';
      setError(errMessage);
      if (__DEV__) {
        console.error('[useSupport] Error replying to ticket:', err);
      }
      return null;
    }
  }, []);

  // --------------------------------------------------------------------------
  // Real-time Subscription
  // --------------------------------------------------------------------------

  /**
   * Subscribes to real-time INSERT events on the support_ticket_replies table
   * for a specific ticket. Calls the provided callback whenever a new reply
   * is inserted (by the user or an admin).
   *
   * WHY: We use Supabase Realtime instead of polling so that admin replies
   * appear instantly in the user's detail view. The channel is cleaned up
   * when the returned unsubscribe function is called or on hook unmount.
   *
   * @param ticketId - The ticket UUID to subscribe to
   * @param onNewReply - Callback invoked with the validated new reply data
   * @returns An unsubscribe function to stop receiving updates
   *
   * @example
   * useEffect(() => {
   *   const unsub = subscribeToReplies(ticketId, (reply) => {
   *     setReplies(prev => [...prev, reply]);
   *   });
   *   return unsub;
   * }, [ticketId]);
   */
  const subscribeToReplies = useCallback(
    (ticketId: string, onNewReply: (reply: ValidatedSupportTicketReply) => void): (() => void) => {
      const channel = supabase
        .channel(`ticket-replies-${ticketId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'support_ticket_replies',
            filter: `ticket_id=eq.${ticketId}`,
          },
          (payload) => {
            const validated = safeParseSingle(
              SupportTicketReplySchema,
              payload.new,
              'realtime_reply',
            );
            if (validated) {
              onNewReply(validated);
            }
          },
        )
        .subscribe();

      activeChannelsRef.current.push(channel);

      return () => {
        supabase.removeChannel(channel);
        activeChannelsRef.current = activeChannelsRef.current.filter((c) => c !== channel);
      };
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    tickets,
    isLoading,
    isSubmitting,
    error,
    getTicket,
    createTicket,
    replyToTicket,
    subscribeToReplies,
    refresh: loadTickets,
  };
}
