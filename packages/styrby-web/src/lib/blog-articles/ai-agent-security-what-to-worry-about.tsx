/**
 * Article: AI Agent Security: What Developers Should Worry About
 * Category: technical
 */
export default function AiAgentSecurityWhatToWorryAbout() {
  return (
    <>
      <p>
        AI coding agents have real security risks. They also have overhyped
        risks that dominate media coverage but rarely materialize in practice.
        This article separates the two so you can focus your security efforts
        on what actually matters.
      </p>

      <h2>Real Risks</h2>

      <h3>1. Unauthorized File Access</h3>
      <p>
        AI agents can read any file their process has access to. If you run
        an agent as your user, it can read <code>~/.ssh/id_rsa</code>,{" "}
        <code>~/.aws/credentials</code>, <code>.env</code> files, and anything
        else your user can access. This is not theoretical. Agents routinely
        read <code>.env</code> files to understand project configuration. When
        they include those values in their context window, the credentials are
        sent to the AI provider&apos;s API.
      </p>
      <p>
        <strong>Mitigation:</strong> Use agent configuration to restrict file
        access to the project directory. Claude Code&apos;s{" "}
        <code>.claude/settings.json</code> can deny read access to sensitive
        paths. Set up <code>.gitignore</code> patterns that exclude credential
        files from the agent&apos;s file listing.
      </p>

      <h3>2. Credential Exposure in Context</h3>
      <p>
        Even without reading credential files directly, agents encounter
        secrets in code: hardcoded API keys, database connection strings in
        config files, tokens in test fixtures. These become part of the
        agent&apos;s context and are transmitted to the AI provider.
      </p>
      <p>
        <strong>Mitigation:</strong> Never hardcode secrets. Use environment
        variables. Run credential scanning tools (like <code>gitleaks</code>)
        as part of your CI pipeline. Consider Styrby&apos;s E2E encryption for
        sessions that might include sensitive context.
      </p>

      <h3>3. Unintended Network Requests</h3>
      <p>
        Agents can execute <code>curl</code>, <code>wget</code>, and other
        network tools. An agent that decides to &quot;test the API
        endpoint&quot; might send a POST request to a production server. An
        agent installing dependencies pulls packages from the internet, which
        could include malicious packages if the agent hallucinates a package
        name.
      </p>
      <p>
        <strong>Mitigation:</strong> Restrict network access through permission
        controls. Deny <code>curl</code> and <code>wget</code> by default.
        Review <code>npm install</code> commands before approving. Use a
        lockfile (<code>package-lock.json</code>) to prevent the agent from
        installing arbitrary packages.
      </p>

      <h3>4. Destructive File Operations</h3>
      <p>
        Agents interpret instructions literally. &quot;Clean up the
        project&quot; can result in <code>rm -rf</code> on important
        directories. &quot;Reset the database&quot; might mean dropping tables
        in production if the agent has the connection string.
      </p>
      <p>
        <strong>Mitigation:</strong> Block destructive commands in the
        permission configuration. Never give agents access to production
        credentials. Use a separate database for development with no production
        access.
      </p>

      <h3>5. Supply Chain Attacks via Generated Code</h3>
      <p>
        Agents can generate code that imports malicious packages. If an agent
        suggests <code>npm install some-package</code> and that package is
        typosquatting on a popular library, you end up with malware in your
        project.
      </p>
      <p>
        <strong>Mitigation:</strong> Review all dependency additions. Run{" "}
        <code>npm audit</code> after installs. Consider using a package
        allowlist for your project.
      </p>

      <h2>Overhyped Risks</h2>

      <h3>1. AI &quot;Going Rogue&quot;</h3>
      <p>
        The idea that an AI agent will deliberately sabotage your project is
        not a realistic near-term concern. Current AI coding agents are
        stateless between sessions and have no persistent goals. They do what
        they are prompted to do, sometimes incorrectly, but not maliciously.
      </p>
      <p>
        The real risk is not intent but incompetence. An agent does not need to
        be malicious to delete your files. It just needs to misinterpret
        &quot;clean up.&quot;
      </p>

      <h3>2. AI Stealing Your Code</h3>
      <p>
        Your code is sent to the AI provider&apos;s API for processing. This
        is the same as using any cloud service. The providers have data
        handling policies. Anthropic, OpenAI, and Google all state that API
        data is not used for training (for paid API access, not free tiers).
      </p>
      <p>
        If this is a concern for your organization, review the provider&apos;s
        data processing agreement. For highly sensitive code, use E2E
        encryption (Styrby) or run local models.
      </p>

      <h3>3. Prompt Injection via Code</h3>
      <p>
        The concern that malicious comments in code could hijack the agent is
        theoretically possible but has not been a practical attack vector for
        coding agents. A comment saying &quot;ignore previous
        instructions&quot; in a codebase is unlikely to override the
        agent&apos;s system prompt. That said, prompt injection is an active
        research area. Keep an eye on it, but do not spend security budget on
        it today.
      </p>

      <h2>Practical Security Checklist</h2>
      <p>
        Focus your effort on these concrete actions:
      </p>
      <ol>
        <li>
          <strong>Restrict file access</strong> to the project directory. Deny
          reads to <code>~/.ssh</code>, <code>~/.aws</code>,{" "}
          <code>~/.config</code>, and other sensitive paths.
        </li>
        <li>
          <strong>Block network commands</strong> by default. Approve{" "}
          <code>curl</code> and <code>wget</code> only when you understand
          the destination.
        </li>
        <li>
          <strong>Block destructive commands.</strong> Deny{" "}
          <code>rm -rf</code>, <code>chmod 777</code>, and writes to system
          paths.
        </li>
        <li>
          <strong>Never expose production credentials.</strong> Use separate
          development environments. Keep production connection strings out of
          files the agent can access.
        </li>
        <li>
          <strong>Review dependency changes.</strong> Every{" "}
          <code>npm install</code> or <code>pip install</code> should be
          checked.
        </li>
        <li>
          <strong>Use version control.</strong> Git is your safety net. If an
          agent makes a destructive change, <code>git checkout</code> reverts
          it. Commit frequently during agent sessions.
        </li>
        <li>
          <strong>Audit sessions.</strong> Review what agents did, especially
          for unattended sessions. Permission audit trails help.
        </li>
      </ol>

      <h2>How Styrby Helps</h2>
      <p>
        Styrby&apos;s security features address the real risks: remote
        permission approval prevents unauthorized operations, risk
        classification helps you make faster approval decisions, blocked tool
        lists act as a hard safety net, and the audit trail provides
        visibility into what happened during sessions. E2E encryption protects
        session data from server-side breaches.
      </p>
      <p>
        These are practical measures for practical risks. Not a solution to
        hypothetical AI threats.
      </p>
    </>
  );
}
