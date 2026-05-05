/**
 * Static data for the /pricing page comparison table and FAQ.
 *
 * Extracted from `page.tsx` to keep the orchestrator under 400 lines
 * (CLAUDE.md component-first architecture requirement).
 *
 * Phase 6 update: rewritten for the two-tier (Pro + Growth) model after
 * the tier reconciliation in `.audit/styrby-fulltest.md`. The legacy
 * five-column table (Free / Solo / Team / Business / Enterprise) is now
 * a focused two-column comparison.
 *
 * @module components/pricing/pricing-data
 */

/**
 * Feature comparison data — Pro vs. Growth.
 *
 * Each category lists the rows that meaningfully differentiate the two
 * tiers. Cell values follow the convention used by {@link ComparisonTable}:
 *   - `true`     → included (rendered as a check icon)
 *   - `false`    → not included (rendered as a minus)
 *   - `string`   → text label (e.g. "Unlimited", "1 year")
 */
export const comparisonCategories = [
  {
    name: 'Usage and Limits',
    features: [
      { name: 'AI agents supported', pro: 'All 11 agents', growth: 'All 11 agents' },
      { name: 'Sessions per month', pro: 'Unlimited', growth: 'Unlimited' },
      { name: 'Connected machines', pro: 'Unlimited (single user)', growth: 'Unlimited per seat' },
      { name: 'Session history retention', pro: '1 year', growth: '1 year (longer on request)' },
      { name: 'Seats included', pro: '1', growth: '3 (add more at $19/seat/mo)' },
    ],
  },
  {
    name: 'Cost Management',
    features: [
      { name: 'Real-time cost tracking', pro: true as const, growth: true as const },
      { name: 'Per-message cost tracking', pro: true as const, growth: true as const },
      { name: 'Budget alerts', pro: 'Unlimited', growth: 'Unlimited' },
      { name: 'Auto-pause on budget exceeded', pro: true as const, growth: true as const },
      { name: 'Shared cost dashboards', pro: false as const, growth: true as const },
      { name: 'OTEL export (Grafana, Datadog, Honeycomb)', pro: true as const, growth: true as const },
    ],
  },
  {
    name: 'Sessions',
    features: [
      { name: 'Session replay', pro: true as const, growth: true as const },
      { name: 'Session checkpoints', pro: true as const, growth: true as const },
      { name: 'Session sharing', pro: true as const, growth: true as const },
      { name: 'Export and import', pro: true as const, growth: true as const },
      { name: 'On-demand session summary (skip the 200-message scroll)', pro: true as const, growth: true as const },
    ],
  },
  {
    name: 'Catch-up Digests',
    features: [
      { name: 'Weekly digest of your AI\'s work, every Sunday morning', pro: true as const, growth: true as const },
      { name: 'Daily digest, delivered before your 9am', pro: false as const, growth: true as const },
      { name: 'Team-wide rollup (who shipped what yesterday)', pro: false as const, growth: true as const },
    ],
  },
  {
    name: 'Team and Governance',
    features: [
      { name: 'Team workspace and member management', pro: false as const, growth: true as const },
      { name: 'Role-based access (owner / admin / member)', pro: false as const, growth: true as const },
      { name: 'Approval chains (CLI command sign-off)', pro: false as const, growth: true as const },
      { name: 'Full audit trail export', pro: false as const, growth: true as const },
      { name: 'Invite flow with seat-cap enforcement', pro: false as const, growth: true as const },
      { name: 'DPA available', pro: false as const, growth: true as const },
    ],
  },
  {
    name: 'Security',
    features: [
      { name: 'End-to-end encryption (TweetNaCl)', pro: true as const, growth: true as const },
      { name: 'Zero-knowledge architecture', pro: true as const, growth: true as const },
      { name: 'API key hashing (bcrypt)', pro: true as const, growth: true as const },
      { name: 'Audit log export', pro: false as const, growth: true as const },
    ],
  },
  {
    name: 'Support',
    features: [
      { name: 'Email support', pro: true as const, growth: true as const },
      { name: 'Priority support (one business day)', pro: false as const, growth: true as const },
    ],
  },
];

/**
 * FAQ items for the pricing page.
 *
 * Phase 6 rewrite: drops references to the retired Free/Power/Solo/Team/Business
 * tier names and adds team-billing questions appropriate to the new Growth plan.
 */
export const faqs = [
  {
    q: 'What agents does Styrby support?',
    a: 'Styrby supports eleven CLI coding agents on every paid plan: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. Pro and Growth both unlock all eleven.',
  },
  {
    q: 'How does seat billing work on Growth?',
    a: 'Growth is $99/month and includes 3 seats. Each additional seat (up to 25 total) is $19/month. Polar bills the whole subscription as one line item using tiered seat-based pricing — no separate add-on charge to manage. Adjust seat count anytime from your team dashboard. The base $99 covers the team workspace, audit trail, approval chains, and shared dashboards regardless of seat count.',
  },
  {
    q: 'Can I add seats mid-month?',
    a: 'Yes. New seats are prorated to the day for the rest of the current billing cycle. Removing seats takes effect on the next billing date so the team retains access through the period they have already paid for. All changes happen self-serve from the admin console; no support ticket required.',
  },
  {
    q: 'What happens when I cancel a Growth subscription?',
    a: 'You keep full access through the end of the period you have paid for, then the workspace converts to a read-only view of your existing sessions and audit log. You can re-activate anytime with the same data intact. Your encrypted session content is retained for 90 days after cancellation, then deleted.',
  },
  {
    q: 'Can I use my Claude.ai, ChatGPT, or Google subscription instead of API keys?',
    a: 'Yes. Styrby transparently passes through your existing AI provider subscriptions — sign in to Claude Code, Codex, or Gemini CLI with the account you already pay for, and we route the work through that subscription rather than charging you again at API rates. You can also bring your own API keys (BYOK) on any agent that supports them; keys are hashed with bcrypt before storage and never stored in plaintext. Either way, your provider relationship stays yours.',
  },
  {
    q: 'Is my data encrypted?',
    a: 'Yes. All session data is end-to-end encrypted using TweetNaCl with a zero-knowledge architecture. We never see your code or prompts. Only metadata (costs, timestamps, status) is processed on our servers.',
  },
  {
    q: 'What is an approval chain?',
    a: 'Approval chains (Growth only) let you require a team lead or admin to review and sign off on CLI commands before the agent executes them. This is especially useful for production deployments and database migrations.',
  },
  {
    q: 'Can I switch between Pro and Growth?',
    a: 'Yes. Upgrades from Pro to Growth are prorated for the remainder of your billing cycle. Downgrades from Growth to Pro take effect at the next billing date so the team retains full access through the current period.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Not currently — pick Pro ($39/mo) or Growth ($99/mo for 3 seats) and you can cancel anytime from the dashboard with no penalty. Refunds for the unused portion of your current billing period are available within the first 7 days.',
  },
  {
    q: 'Will I actually know what my AI did all week?',
    a: 'Yes. Open any session and hit summarize - you get the rundown in plain English, no scrolling through 200 messages. Pro subscribers also get a weekly digest emailed Sunday morning: 47 commits, the auth refactor landed Thursday, three sessions caught a regression. Growth teams add a daily morning digest with a per-developer rollup so the manager walks into standup with the picture already loaded.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes. Commands queue locally and sync automatically when your connection is restored. Permission approvals, cost records, and session data are never lost.',
  },
  {
    q: 'What is the ROI calculator based on?',
    a: 'The ROI estimator models the value of recovered developer time using published research from GitHub Copilot studies, the McKinsey 2023 developer productivity survey, and the Stripe developer productivity report. All three show 20-40% gains on repetitive coding tasks. We cap the slider at 40% and default to a conservative 25% — claims above 50% are not supported by independent research for typical engineering work.',
  },
  {
    q: 'What if my team needs more than 25 seats or a custom contract?',
    a: 'For larger orgs, custom data residency, dedicated SLAs, or procurement-driven purchasing, email hello@styrbyapp.com or use the "Talk to founders" link on the Growth card. We will reply within one business day with a written proposal.',
  },
];
