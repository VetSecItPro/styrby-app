/**
 * Article: Styrby Roadmap: What's Coming in 2026
 * Category: company
 */
export default function StyrbyRoadmap2026() {
  return (
    <>
      <p>
        This is our public roadmap for 2026. It covers what we are building,
        when we expect to ship it, and what we have decided not to build.
        Timelines are estimates. We ship when features are ready.
      </p>

      <h2>Q2 2026: iOS App Launch</h2>
      <p>
        The iOS app is the primary mobile interface for Styrby. Built with Expo
        (React Native), it is currently in private beta. Expected features at
        launch:
      </p>
      <ul>
        <li>Live session monitoring for all eleven supported agents</li>
        <li>Remote permission approval with risk badges</li>
        <li>Push notifications for budget alerts, errors, and permission requests</li>
        <li>Session replay with encrypted content</li>
        <li>Cost dashboard with daily, weekly, and monthly views</li>
        <li>Offline support with sync-on-reconnect</li>
        <li>Quiet hours configuration</li>
      </ul>
      <p>
        The app requires iOS 16+ and is designed for iPhone. iPad layout
        optimization will follow.
      </p>

      <h2>Q3 2026: Android App</h2>
      <p>
        Android is on the roadmap using the same Expo codebase. We are building
        iOS first because our beta users are predominantly iOS users (78% based
        on signup surveys). Android will have feature parity with iOS at launch.
      </p>
      <p>
        The Expo codebase shares approximately 85% of code between iOS and
        Android. Platform-specific work is mainly push notification
        configuration (APNs vs. FCM) and keychain integration.
      </p>

      <h2>Q2-Q3 2026: Onboarding Flow</h2>
      <p>
        The current CLI setup requires manual configuration steps. We are
        building a guided onboarding flow:
      </p>
      <ol>
        <li>Install CLI via npm</li>
        <li>Run <code>styrby onboard</code>, which opens a browser for authentication</li>
        <li>CLI auto-detects installed agents and offers to connect them</li>
        <li>Guided budget alert setup with recommendations based on typical usage</li>
        <li>QR code pairing between CLI and mobile app</li>
      </ol>
      <p>
        Target: from <code>npm install</code> to fully connected in under 5
        minutes.
      </p>

      <h2>Q3-Q4 2026: Additional Integrations</h2>
      <p>
        We plan to support additional agents as they gain traction:
      </p>
      <ul>
        <li>
          <strong>Windsurf CLI</strong> (if Codeium releases a CLI interface)
        </li>
        <li>
          <strong>Amazon Q Developer CLI</strong>
        </li>
      </ul>
      <p>
        New agent integrations depend on the agent providing a CLI interface
        with parseable output. We do not support IDE-only agents because Styrby
        operates at the terminal level.
      </p>

      <h2>Ongoing: Web Dashboard Improvements</h2>
      <p>
        The web dashboard receives continuous updates:
      </p>
      <ul>
        <li>Cost trend visualization (charts and graphs)</li>
        <li>Session comparison view (compare costs and token usage across similar sessions)</li>
        <li>Team management features (Power tier)</li>
        <li>Export improvements (PDF reports for client billing)</li>
      </ul>

      <h2>What We Are Not Building</h2>

      <h3>Not Building: An AI Agent</h3>
      <p>
        We will not build or host an AI coding agent. There are enough agents.
        We build the management layer. This keeps us vendor-neutral and avoids
        competing with the platforms we integrate with.
      </p>

      <h3>Not Building: IDE Integration</h3>
      <p>
        Styrby works at the terminal/CLI level. IDE plugins (VS Code extensions,
        JetBrains plugins) would duplicate functionality that agent-specific IDE
        integrations already provide. We focus on what those integrations do not
        do: cross-agent management.
      </p>

      <h3>Not Building: Code Analysis</h3>
      <p>
        Styrby does not analyze, review, or evaluate the code your agents
        produce. We handle session management, costs, and permissions. Code
        quality is between you and your agents.
      </p>

      <h3>Not Building: Enterprise SSO (Yet)</h3>
      <p>
        SAML/OIDC enterprise SSO is not in the 2026 roadmap. If enterprise
        demand materializes, we will reconsider. For now, Supabase Auth with
        email/password and OAuth handles our user base.
      </p>

      <h2>How We Prioritize</h2>
      <p>
        Features are prioritized by: (1) how many users request them, (2) how
        much they improve the core workflow (cost tracking, permissions, session
        management), and (3) implementation complexity relative to value.
      </p>
      <p>
        We maintain a public feature request board. If you want something that
        is not on this roadmap, submit it there. Requests with more votes get
        prioritized higher.
      </p>

      <h2>Updates</h2>
      <p>
        This roadmap will be updated quarterly. Check the blog for progress
        reports and announcements when features ship.
      </p>
    </>
  );
}
