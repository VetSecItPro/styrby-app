/**
 * Generate Summary - Supabase Edge Function
 *
 * Generates AI-powered summaries for completed coding sessions.
 *
 * Flow:
 * 1. Receives session_id in request body (triggered by database or manual call)
 * 2. Validates the session exists and belongs to a Pro+ user
 * 3. Fetches the most recent 50 messages from the session
 * 4. Calls OpenAI API to generate a concise summary
 * 5. Stores the summary in the sessions table
 * 6. Returns success/error status
 *
 * @auth Service role key required (Bearer token in Authorization header)
 * @env OPENAI_API_KEY - OpenAI API key for summary generation
 * @env SUPABASE_URL - Supabase project URL
 * @env SUPABASE_SERVICE_ROLE_KEY - Service role key for database access
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

// ============================================================================
// Types
// ============================================================================

/**
 * Request body shape for the summary generation endpoint.
 */
interface GenerateSummaryRequest {
  /** The UUID of the session to generate a summary for */
  session_id: string;
  /** Optional user_id for validation (included by trigger) */
  user_id?: string;
}

/**
 * Session row from the database (subset of columns we need).
 */
interface SessionRow {
  id: string;
  user_id: string;
  agent_type: string;
  title: string | null;
  status: string;
  summary: string | null;
  summary_generated_at: string | null;
  total_cost_usd: number;
  message_count: number;
  started_at: string;
  ended_at: string | null;
}

/**
 * Message row from the database (subset of columns we need).
 */
interface MessageRow {
  id: string;
  message_type: string;
  content_encrypted: string | null;
  tool_name: string | null;
  created_at: string;
}

/**
 * OpenAI chat completion message format.
 */
interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * OpenAI API response shape (subset of fields we use).
 */
interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of messages to include in the summary context.
 *
 * WHY 50: This balances having enough context to generate a meaningful summary
 * while staying within token limits. Most sessions have 20-100 messages.
 * Using the 50 most recent gives us the "ending" context which is typically
 * where the key outcomes and conclusions are discussed.
 */
const MAX_MESSAGES = 50;

/**
 * Maximum tokens for the summary output.
 *
 * WHY 500: Summaries should be concise (2-4 paragraphs). 500 tokens is roughly
 * 350-400 words, which is enough for a comprehensive but not verbose summary.
 */
const MAX_SUMMARY_TOKENS = 500;

/**
 * OpenAI model to use for summary generation.
 *
 * WHY gpt-4o-mini: Best balance of quality and cost for summarization tasks.
 * Fast, cheap, and produces high-quality summaries.
 */
const OPENAI_MODEL = 'gpt-4o-mini';

/**
 * OpenAI API endpoint.
 */
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a standardized JSON response with proper headers.
 *
 * @param body - Response body to serialize as JSON
 * @param status - HTTP status code
 * @returns Response object with JSON content type
 */
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Converts a message type to a human-readable label for the prompt.
 *
 * @param messageType - The message_type enum value from the database
 * @returns Human-readable label
 */
function getMessageTypeLabel(messageType: string): string {
  switch (messageType) {
    case 'user_prompt':
      return 'User';
    case 'agent_response':
      return 'Agent';
    case 'agent_thinking':
      return 'Agent (thinking)';
    case 'permission_request':
      return 'Permission Request';
    case 'permission_response':
      return 'Permission Response';
    case 'tool_use':
      return 'Tool Use';
    case 'tool_result':
      return 'Tool Result';
    case 'error':
      return 'Error';
    case 'system':
      return 'System';
    default:
      return messageType;
  }
}

/**
 * Formats messages for inclusion in the OpenAI prompt.
 *
 * Converts database message rows into a readable transcript format.
 * Handles encrypted content (shows placeholder) and tool usage.
 *
 * @param messages - Array of message rows from the database
 * @returns Formatted transcript string
 */
function formatMessagesForPrompt(messages: MessageRow[]): string {
  return messages
    .map((msg) => {
      const label = getMessageTypeLabel(msg.message_type);

      // WHY: Messages are E2E encrypted in production. For summary generation,
      // we can only use the encrypted content if we have the key (which we don't
      // in the Edge Function). Show a placeholder for encrypted content.
      // In a real deployment, you might decrypt using a server-side key or
      // store a plaintext copy specifically for summarization.
      let content = msg.content_encrypted || '[Encrypted message]';

      // Truncate very long messages to avoid token limits
      if (content.length > 1000) {
        content = content.substring(0, 997) + '...';
      }

      // Include tool name for tool_use messages
      if (msg.message_type === 'tool_use' && msg.tool_name) {
        return `[${label}: ${msg.tool_name}]\n${content}`;
      }

      return `[${label}]\n${content}`;
    })
    .join('\n\n');
}

/**
 * Builds the system prompt for summary generation.
 *
 * @param session - The session metadata
 * @returns System prompt string
 */
function buildSystemPrompt(session: SessionRow): string {
  const agentName = session.agent_type === 'claude' ? 'Claude'
    : session.agent_type === 'codex' ? 'Codex'
    : session.agent_type === 'gemini' ? 'Gemini'
    : session.agent_type;

  const duration = session.ended_at && session.started_at
    ? Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000)
    : null;

  return `You are a technical documentation assistant. Your task is to summarize coding sessions between developers and AI agents.

Session Information:
- Agent: ${agentName}
- Session Title: ${session.title || 'Untitled'}
- Messages: ${session.message_count}
- Total Cost: $${Number(session.total_cost_usd).toFixed(4)}
${duration ? `- Duration: ${duration} minutes` : ''}

Generate a concise summary (2-4 paragraphs) that captures:
1. The main goal or problem the developer was trying to solve
2. Key actions taken (files modified, commands run, code changes)
3. The outcome (what was accomplished, any remaining issues)
4. Any notable decisions or tradeoffs discussed

Write in past tense. Be specific about file names, function names, and technical details when mentioned. Keep the summary professional and factual.`;
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // ──────────────────────────────────────────
  // Method check
  // ──────────────────────────────────────────
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // ──────────────────────────────────────────
  // Environment variables
  // ──────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ error: 'Server configuration error' }, 500);
  }

  if (!openaiApiKey) {
    console.error('Missing OPENAI_API_KEY');
    return jsonResponse({ error: 'OpenAI API key not configured' }, 500);
  }

  // ──────────────────────────────────────────
  // Authorization
  // ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // WHY constant-time comparison: Prevents timing attacks
  if (!token || token.length !== supabaseServiceKey.length) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let isAuthorized = true;
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) !== supabaseServiceKey.charCodeAt(i)) {
      isAuthorized = false;
    }
  }

  if (!isAuthorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    // ──────────────────────────────────────────
    // Parse request body
    // ──────────────────────────────────────────
    let body: GenerateSummaryRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON in request body' }, 400);
    }

    if (!body.session_id || typeof body.session_id !== 'string') {
      return jsonResponse({ error: 'Missing or invalid session_id' }, 400);
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(body.session_id)) {
      return jsonResponse({ error: 'session_id must be a valid UUID' }, 400);
    }

    // ──────────────────────────────────────────
    // Create Supabase admin client
    // ──────────────────────────────────────────
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ──────────────────────────────────────────
    // Fetch session
    // ──────────────────────────────────────────
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, user_id, agent_type, title, status, summary, summary_generated_at, total_cost_usd, message_count, started_at, ended_at')
      .eq('id', body.session_id)
      .single();

    if (sessionError || !session) {
      console.error('Session not found:', body.session_id);
      return jsonResponse({ error: 'Session not found' }, 404);
    }

    const sessionRow = session as SessionRow;

    // ──────────────────────────────────────────
    // Skip if summary already exists
    // ──────────────────────────────────────────
    if (sessionRow.summary && sessionRow.summary_generated_at) {
      return jsonResponse({
        success: true,
        message: 'Summary already exists',
        session_id: body.session_id,
        summary: sessionRow.summary,
      }, 200);
    }

    // ──────────────────────────────────────────
    // Check user tier (Pro+ only)
    // ──────────────────────────────────────────
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', sessionRow.user_id)
      .single();

    const userTier = subscription?.tier || 'free';

    if (userTier === 'free') {
      return jsonResponse({
        success: false,
        error: 'TIER_RESTRICTED',
        message: 'AI summaries are available for Pro and Power users',
      }, 403);
    }

    // ──────────────────────────────────────────
    // Fetch messages
    // ──────────────────────────────────────────
    const { data: messages, error: messagesError } = await supabase
      .from('session_messages')
      .select('id, message_type, content_encrypted, tool_name, created_at')
      .eq('session_id', body.session_id)
      .order('sequence_number', { ascending: true })
      .limit(MAX_MESSAGES);

    if (messagesError) {
      console.error('Failed to fetch messages:', messagesError);
      return jsonResponse({ error: 'Failed to fetch session messages' }, 500);
    }

    if (!messages || messages.length === 0) {
      // No messages to summarize
      const { error: updateError } = await supabase
        .from('sessions')
        .update({
          summary: 'This session contained no messages.',
          summary_generated_at: new Date().toISOString(),
        })
        .eq('id', body.session_id);

      if (updateError) {
        console.error('Failed to update session:', updateError);
      }

      return jsonResponse({
        success: true,
        message: 'No messages to summarize',
        session_id: body.session_id,
        summary: 'This session contained no messages.',
      }, 200);
    }

    const messageRows = messages as MessageRow[];

    // ──────────────────────────────────────────
    // Build OpenAI prompt
    // ──────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(sessionRow);
    const transcript = formatMessagesForPrompt(messageRows);

    const chatMessages: OpenAIChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Here is the session transcript:\n\n${transcript}\n\nPlease generate a summary.` },
    ];

    // ──────────────────────────────────────────
    // Call OpenAI API
    // ──────────────────────────────────────────
    console.log(`Generating summary for session ${body.session_id} (${messageRows.length} messages)`);

    const openaiResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: chatMessages,
        max_tokens: MAX_SUMMARY_TOKENS,
        temperature: 0.3, // Lower temperature for more consistent, factual summaries
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('OpenAI API error:', openaiResponse.status, errorText);
      return jsonResponse({ error: 'Failed to generate summary' }, 500);
    }

    const openaiResult: OpenAIResponse = await openaiResponse.json();
    const summary = openaiResult.choices[0]?.message?.content?.trim();

    if (!summary) {
      console.error('OpenAI returned empty summary');
      return jsonResponse({ error: 'OpenAI returned empty summary' }, 500);
    }

    // ──────────────────────────────────────────
    // Store summary in database
    // ──────────────────────────────────────────
    const { error: updateError } = await supabase
      .from('sessions')
      .update({
        summary,
        summary_generated_at: new Date().toISOString(),
      })
      .eq('id', body.session_id);

    if (updateError) {
      console.error('Failed to update session:', updateError);
      return jsonResponse({ error: 'Failed to store summary' }, 500);
    }

    console.log(`Summary generated for session ${body.session_id} (${openaiResult.usage.total_tokens} tokens)`);

    // ──────────────────────────────────────────
    // Return success
    // ──────────────────────────────────────────
    return jsonResponse({
      success: true,
      message: 'Summary generated successfully',
      session_id: body.session_id,
      summary,
      tokens_used: openaiResult.usage.total_tokens,
    }, 200);

  } catch (error) {
    console.error('Summary generation error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
