/**
 * Digest content generator (OpenRouter / gpt-4o-mini).
 *
 * Takes a user's sessions in the digest window and returns a 2-3 sentence
 * narrative ("Yesterday you ran 12 sessions; main work was X, Y, Z").
 * Voice: warm + conversational, not robotic. See marketing voice guide.
 *
 * WHY OpenRouter (not direct OpenAI/Anthropic): single API surface, cheap
 * model (gpt-4o-mini), keeps pricing predictable, lets us swap models
 * without code changes by editing the constant below.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';

/** Minimal session shape we feed to the LLM. */
export interface DigestSession {
  id: string;
  title: string | null;
  agent_type: string;
  status: string;
  total_cost_usd: number | string;
  message_count: number;
  created_at: string;
}

interface GenerateArgs {
  period: 'daily' | 'weekly';
  sessions: DigestSession[];
}

/**
 * Generate a 2-3 sentence digest from session data.
 *
 * Returns a plain-string digest. Returns null if the LLM call fails — the
 * cron caller still inserts the row (so the dashboard panel knows the
 * period was processed) but skips the email.
 */
export async function generateDigestContent(args: GenerateArgs): Promise<string | null> {
  const { period, sessions } = args;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Configuration error in deploy — return null so the cron records the
    // attempt without crashing the entire batch.
    console.warn('[digest] OPENROUTER_API_KEY missing; skipping LLM call.');
    return null;
  }

  const systemPrompt =
    period === 'weekly'
      ? "You are Styrby's friendly weekly digest writer. Summarize the user's coding week in exactly 2-3 sentences. Mention the main themes of their work, not raw counts. Warm and conversational, never robotic. No emojis."
      : "You are Styrby's friendly daily digest writer. Summarize the user's coding day in exactly 2-3 sentences. Mention what they worked on, not raw counts. Warm and conversational, never robotic. No emojis.";

  // Compact context for the LLM. We send titles + agent + cost, no message
  // bodies (those are E2E encrypted and we don't decrypt server-side).
  const sessionLines = sessions
    .slice(0, 30)
    .map((s) => {
      const title = s.title ?? '(untitled session)';
      const cost = typeof s.total_cost_usd === 'string' ? s.total_cost_usd : s.total_cost_usd.toFixed(2);
      return `- [${s.agent_type}] ${title} (${s.message_count} msgs, $${cost})`;
    })
    .join('\n');

  const userPrompt = `Here are this user's ${sessions.length} session${sessions.length === 1 ? '' : 's'}:\n${sessionLines}\n\nWrite the digest now.`;

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Optional but recommended OpenRouter analytics headers.
        'HTTP-Referer': 'https://www.styrbyapp.com',
        'X-Title': 'Styrby Digest',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.warn('[digest] OpenRouter non-OK:', resp.status, body.slice(0, 200));
      return null;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[digest] OpenRouter fetch failed:', (err as Error).message);
    return null;
  }
}
