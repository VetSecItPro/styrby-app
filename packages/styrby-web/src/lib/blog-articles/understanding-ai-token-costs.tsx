/**
 * Article: Understanding AI Agent Token Costs: Input, Output, and Cache
 * Category: technical
 */
export default function UnderstandingAiTokenCosts() {
  return (
    <>
      <p>
        The per-token prices on provider pricing pages are not what you
        actually pay. What you pay depends on how many tokens you send, how
        many you receive, and how much of that repeated context the model
        serves from cache. This article explains the mechanics so you can
        estimate session costs before they show up on your bill.
      </p>

      <h2>What Is a Token?</h2>
      <p>
        A token is a chunk of text, roughly 3-4 characters in English. The
        word &quot;function&quot; is typically two tokens. A line of code like{" "}
        <code>const x = 42;</code> is about 5-6 tokens. A 100-line TypeScript
        file is roughly 800-1,200 tokens depending on verbosity.
      </p>
      <p>
        Tokenization varies by model. Claude and GPT use different tokenizers,
        so the same text produces slightly different token counts. The
        difference is usually under 10% for code. A practical rule of thumb:
        1,000 tokens is approximately 750 words of English text, or about
        40-60 lines of code.
      </p>

      <h2>Input vs. Output Pricing</h2>
      <p>
        Every AI model charges differently for tokens you send (input) and
        tokens you receive (output). Output tokens are more expensive because
        they require more computation: the model generates them one at a time,
        each requiring a forward pass through the neural network.
      </p>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Input (per 1M tokens)</th>
            <th>Output (per 1M tokens)</th>
            <th>Output/Input Ratio</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Opus 4</td>
            <td>$15.00</td>
            <td>$75.00</td>
            <td>5x</td>
          </tr>
          <tr>
            <td>Claude Sonnet 4</td>
            <td>$3.00</td>
            <td>$15.00</td>
            <td>5x</td>
          </tr>
          <tr>
            <td>GPT-4o</td>
            <td>$2.50</td>
            <td>$10.00</td>
            <td>4x</td>
          </tr>
          <tr>
            <td>Gemini 2.5 Pro</td>
            <td>$1.25</td>
            <td>$10.00</td>
            <td>8x</td>
          </tr>
        </tbody>
      </table>
      <p>
        The ratio matters more than the headline rate. Claude models charge 5x
        more for output than input. Gemini charges 8x more. A verbose agent
        that generates long explanations alongside code costs significantly
        more than one that produces concise output.
      </p>

      <h2>What Counts as Input Tokens</h2>
      <p>
        In a coding agent session, input tokens include everything the model
        receives:
      </p>
      <ul>
        <li>
          <strong>System prompt.</strong> The agent&apos;s instructions. For
          Claude Code, this is substantial: tool definitions, safety rules,
          and behavioral guidelines.
        </li>
        <li>
          <strong>Your prompt.</strong> The task you asked the agent to do.
        </li>
        <li>
          <strong>Code context.</strong> Files the agent reads to understand
          your codebase. This is often the largest component.
        </li>
        <li>
          <strong>Conversation history.</strong> In multi-turn sessions, all
          previous exchanges are sent as context for each new turn.
        </li>
        <li>
          <strong>Tool results.</strong> Output from commands the agent ran
          (test results, build output, file contents).
        </li>
      </ul>
      <p>
        In a typical 20-turn session, conversation history grows with each
        turn. By turn 20, the input includes 19 previous exchanges. This is
        why long sessions are disproportionately expensive compared to short
        ones, even when the task itself is simple.
      </p>

      <h2>Cache Tokens: The Discount Mechanism</h2>
      <p>
        When the model receives the same input text in consecutive requests,
        the provider serves it from cache. Cached tokens are charged at a
        fraction of the input price:
      </p>
      <ul>
        <li>Claude: 10% of input price for cache reads</li>
        <li>GPT-4o: 50% of input price for cache reads</li>
      </ul>
      <p>
        In a multi-turn session, most of the input is repeated context: the
        system prompt, codebase files, and previous conversation turns. Only
        the new turn is fresh input. This means effective input costs are much
        lower than the headline rate.
      </p>
      <p>
        Example: A session with 100K input tokens per turn, where 90K are
        cached:
      </p>
      <ul>
        <li>Without cache: 100K tokens at $3.00/M = $0.30 per turn</li>
        <li>With cache: 10K fresh at $3.00/M + 90K cached at $0.30/M = $0.057 per turn</li>
      </ul>
      <p>
        Caching reduces the input cost by over 80% in this scenario. This is
        why multi-turn sessions are not as expensive as naive token math
        suggests.
      </p>

      <h2>Estimating Session Costs</h2>
      <p>
        A formula for rough estimates:
      </p>
      <pre>
        <code>{`Session cost ≈
  (fresh_input_tokens × input_price) +
  (cached_input_tokens × cache_price) +
  (output_tokens × output_price)

For a 20-turn Sonnet 4 session:
  Fresh input per turn: ~10K tokens
  Cached input per turn: ~90K tokens (grows over session)
  Output per turn: ~3K tokens

  Total fresh input: 20 × 10K = 200K → 200K × $3/M = $0.60
  Total cached: 20 × 90K = 1.8M → 1.8M × $0.30/M = $0.54
  Total output: 20 × 3K = 60K → 60K × $15/M = $0.90

  Estimated session cost: ~$2.04`}</code>
      </pre>

      <h2>Cost Reduction Strategies</h2>
      <ul>
        <li>
          <strong>Use cheaper models for simple tasks.</strong> Sonnet handles
          most implementation work. Reserve Opus for complex architecture
          decisions and difficult debugging.
        </li>
        <li>
          <strong>Keep sessions focused.</strong> Shorter sessions with less
          context are cheaper. Start a new session for a new task instead of
          continuing an existing one with accumulated history.
        </li>
        <li>
          <strong>Be selective with context.</strong> Sending your entire
          codebase as context is expensive. Point the agent at specific files.
        </li>
        <li>
          <strong>Watch for retry loops.</strong> An agent retrying the same
          approach costs tokens without progress. Intervene early with better
          context.
        </li>
      </ul>

      <h2>Where Styrby Fits</h2>
      <p>
        Styrby records input, output, and cache tokens per message and
        calculates costs using current model pricing. The dashboard shows these
        breakdowns per session and per agent. Tag sessions by client or project
        to see where your spend is going.
      </p>
    </>
  );
}
