/**
 * Article: Error Attribution: Agent, Build Tool, or Network?
 * Category: deep-dive
 */
export default function ErrorAttributionAgentBuildNetwork() {
  return (
    <>
      <p>
        When an AI agent session fails, the first question is: what broke? Was
        it the agent producing bad code, the build tool rejecting valid code,
        or a network issue interrupting the session? Getting this wrong is
        expensive. Telling the agent to &quot;fix the error&quot; when the
        problem is a stale cache sends it on a goose chase that costs tokens
        and time.
      </p>

      <h2>The Three Error Sources</h2>

      <h3>Agent Errors (Red)</h3>
      <p>
        The agent produced output that is incorrect. Examples:
      </p>
      <ul>
        <li>Generated code that does not compile or type-check</li>
        <li>Hallucinated an API that does not exist</li>
        <li>Produced a solution that does not match the requirements</li>
        <li>Entered a retry loop, repeating the same failing approach</li>
      </ul>
      <p>
        Agent errors are the most common category. They require prompt
        adjustment, additional context, or switching to a more capable model.
      </p>

      <h3>Build Tool Errors (Yellow)</h3>
      <p>
        The agent&apos;s code is logically correct, but the build environment
        rejects it. Examples:
      </p>
      <ul>
        <li>TypeScript strict mode catches a valid but loosely typed pattern</li>
        <li>ESLint rules reject a coding style the agent uses</li>
        <li>Dependency version conflicts after an install</li>
        <li>Build cache is stale and needs clearing</li>
      </ul>
      <p>
        Build tool errors often look like agent errors but have different
        solutions. Clearing the cache manually and letting the agent continue
        takes 10 seconds. Asking the agent to debug a caching issue takes 10
        minutes and several dollars in tokens.
      </p>

      <h3>Network Errors (Blue)</h3>
      <p>
        The connection between components failed. Examples:
      </p>
      <ul>
        <li>API rate limit from the AI provider</li>
        <li>WebSocket disconnection during a long session</li>
        <li>DNS resolution failure</li>
        <li>Styrby server maintenance (rare, but it happens)</li>
      </ul>
      <p>
        Network errors are transient. The correct response is usually to wait
        and retry, not to change the prompt or the code.
      </p>

      <h2>How Styrby Classifies Errors</h2>
      <p>
        Styrby uses pattern matching on the error output to classify errors
        into the three categories. The classifier runs on the CLI side before
        the error is sent to your mobile device.
      </p>
      <p>Patterns for agent errors:</p>
      <ul>
        <li>
          Compiler errors in agent-generated files (tracked by which files the
          agent recently modified)
        </li>
        <li>Test failures in newly written tests</li>
        <li>Repeated identical error outputs (retry loop detection)</li>
      </ul>
      <p>Patterns for build tool errors:</p>
      <ul>
        <li>Errors in files the agent did not modify</li>
        <li>Dependency resolution failures</li>
        <li>Cache-related error messages</li>
        <li>Linter/formatter errors on pre-existing code</li>
      </ul>
      <p>Patterns for network errors:</p>
      <ul>
        <li>HTTP status codes (429, 502, 503, 504)</li>
        <li>Connection timeout messages</li>
        <li>DNS and TLS error strings</li>
        <li>WebSocket close codes</li>
      </ul>

      <h2>The Color-Coded Display</h2>
      <p>
        In the Styrby mobile app and web dashboard, errors appear with a
        colored badge next to the error message:
      </p>
      <table>
        <thead>
          <tr>
            <th>Color</th>
            <th>Source</th>
            <th>Suggested Action</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Red</td>
            <td>Agent</td>
            <td>Adjust prompt, add context, or switch model</td>
          </tr>
          <tr>
            <td>Yellow</td>
            <td>Build tool</td>
            <td>Fix toolchain config, clear cache, or update deps</td>
          </tr>
          <tr>
            <td>Blue</td>
            <td>Network</td>
            <td>Wait and retry, check provider status page</td>
          </tr>
        </tbody>
      </table>
      <p>
        The classification is a best guess, not a guarantee. Some errors are
        ambiguous. A TypeScript error could be the agent writing bad types
        (agent error) or a misconfigured tsconfig (build tool error). When the
        classifier is not confident, it shows a gray badge with
        &quot;Unclassified&quot; and lets you assign it manually.
      </p>

      <h2>Retry Loop Detection</h2>
      <p>
        Styrby specifically detects retry loops: when the agent encounters an
        error, attempts a fix, and hits the same error again. After three
        identical error cycles, Styrby notifies you with a summary:
      </p>
      <pre>
        <code>{`⚠ Retry loop detected (3 cycles)
  Agent: claude (sonnet-4)
  Error: TypeError: Cannot read property 'map' of undefined
  File: src/components/Dashboard.tsx:47
  Tokens spent on retries: 45,000 (~$0.67)
  Suggestion: Provide additional context about the data shape`}</code>
      </pre>
      <p>
        This notification lets you intervene before the agent spends more
        tokens on a failing approach. You can provide clarifying context,
        switch to a different model, or take over the fix manually.
      </p>

      <h2>Improving Classification Over Time</h2>
      <p>
        When you manually reclassify an error (changing gray/unclassified to
        the correct color), that feedback improves the classifier for your
        project. The patterns are stored locally and applied to future errors
        from the same project and agent combination.
      </p>
    </>
  );
}
