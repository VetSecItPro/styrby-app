/**
 * Static data for the /pricing page comparison table and FAQ.
 *
 * Extracted from page.tsx to keep the page orchestrator under 400 lines
 * (CLAUDE.md component-first architecture requirement).
 *
 * WHY constants file (not in page.tsx): this data never re-renders — it is
 * fully static. Moving it here keeps the page file focused on state and
 * layout orchestration rather than data definition.
 *
 * @module components/pricing/pricing-data
 */

/**
 * Feature comparison data for all five tiers (Free, Solo, Team, Business, Enterprise).
 * Each category has a name and a list of feature rows.
 * Cell values: true = included, false = not included, string = text value.
 */
export const comparisonCategories = [
  {
    name: 'Usage and Limits',
    features: [
      { name: 'AI agents supported', free: '3 (Claude Code, Codex, Gemini CLI)', solo: 'All 11 agents', team: 'All 11 agents', business: 'All 11 agents', enterprise: 'All 11 agents' },
      { name: 'Sessions per month', free: '50', solo: 'Unlimited', team: 'Unlimited', business: 'Unlimited', enterprise: 'Unlimited' },
      { name: 'Connected machines', free: '1', solo: '9', team: 'Unlimited', business: 'Unlimited', enterprise: 'Unlimited' },
      { name: 'Session history retention', free: '7 days', solo: '1 year', team: 'Unlimited', business: 'Custom', enterprise: 'Custom' },
      { name: 'Team members / seats', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
    ],
  },
  {
    name: 'Cost Management',
    features: [
      { name: 'Real-time cost tracking', free: 'Basic', solo: 'Full', team: 'Full', business: 'Full', enterprise: 'Full' },
      { name: 'Per-message cost tracking', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Budget alerts', free: '1', solo: '5', team: 'Unlimited', business: 'Unlimited', enterprise: 'Unlimited' },
      { name: 'Auto-pause on budget exceeded', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Shared cost dashboards', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'OTEL export (Grafana, Datadog)', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
    ],
  },
  {
    name: 'Sessions',
    features: [
      { name: 'Session replay', free: true as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Session checkpoints', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Session sharing', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Export and import', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
    ],
  },
  {
    name: 'Team and Governance',
    features: [
      { name: 'Team member management', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Role-based access (owner/admin/member)', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Approval chains (CLI command sign-off)', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Full audit trail export', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Enterprise SSO (SAML / OIDC)', free: false as const, solo: false as const, team: false as const, business: false as const, enterprise: true as const },
      { name: 'Custom data residency', free: false as const, solo: false as const, team: false as const, business: false as const, enterprise: true as const },
    ],
  },
  {
    name: 'Security',
    features: [
      { name: 'End-to-end encryption (TweetNaCl)', free: true as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Zero-knowledge architecture', free: true as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'API key hashing (bcrypt)', free: true as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Audit log export', free: false as const, solo: false as const, team: true as const, business: true as const, enterprise: true as const },
    ],
  },
  {
    name: 'Support',
    features: [
      { name: 'Email support', free: false as const, solo: true as const, team: true as const, business: true as const, enterprise: true as const },
      { name: 'Priority support (4-hour SLA)', free: false as const, solo: false as const, team: false as const, business: true as const, enterprise: true as const },
      { name: 'Dedicated Slack channel', free: false as const, solo: false as const, team: false as const, business: false as const, enterprise: true as const },
      { name: 'Quarterly business reviews', free: false as const, solo: false as const, team: false as const, business: true as const, enterprise: true as const },
    ],
  },
];

/**
 * FAQ items for the pricing page accordion.
 * q = question, a = answer.
 */
export const faqs = [
  {
    q: 'What agents does Styrby support?',
    a: 'Styrby supports eleven CLI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. The Free plan includes the first three. Solo, Team, Business, and Enterprise plans unlock all eleven.',
  },
  {
    q: 'How does per-seat pricing work for Team and Business?',
    a: 'You pay per developer seat per month, with a minimum-seat floor enforced at checkout. Team starts at $19 per seat with a 3-seat minimum (so a $57 per month floor). Business starts at $39 per seat with a 10-seat minimum (so a $390 per month floor). Use the seat slider on this page to see your exact monthly cost before signing up.',
  },
  {
    q: 'Can I use my own API keys?',
    a: 'Yes. All paid plans support BYOK (bring your own key). Keys are hashed with bcrypt before storage and never stored in plaintext.',
  },
  {
    q: 'Is my data encrypted?',
    a: 'Yes. All session data is end-to-end encrypted using TweetNaCl with a zero-knowledge architecture. We never see your code or prompts. Only metadata (costs, timestamps, status) is processed on our servers.',
  },
  {
    q: 'What is an approval chain?',
    a: 'Approval chains (Team and above) let you require a team lead or admin to review and sign off on CLI commands before the agent executes them. This is especially useful for production deployments and database migrations.',
  },
  {
    q: 'Can I switch plans at any time?',
    a: 'Yes. Upgrades are prorated for the remainder of your billing cycle. Downgrades take effect at the next billing date so you retain full access through your current period.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes. Solo, Team, and Business plans include a 14-day free trial with full access to all features. No credit card required to start.',
  },
  {
    q: 'How does Enterprise pricing work?',
    a: 'Enterprise contracts start at around $15,000 per year. Final pricing depends on seat count, data residency, SLA, and contract length. Book a 30-minute call with a founder and a written proposal lands in your inbox within two business days.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes. Commands queue locally and sync automatically when your connection is restored. You will never lose a permission approval or cost record.',
  },
  {
    q: 'What is the ROI calculator based on?',
    a: 'The ROI calculator estimates the value of recovered developer time based on published research from GitHub Copilot studies, the McKinsey 2023 developer productivity survey, and the Stripe developer productivity report. All of those studies show 20-40% gains on repetitive coding tasks. We deliberately cap the slider at 40% and default to 25% - claims above 50% are not supported by independent research for typical engineering work.',
  },
];
