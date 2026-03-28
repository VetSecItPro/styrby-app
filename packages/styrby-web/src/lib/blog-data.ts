/**
 * Central blog article metadata for the Styrby blog.
 *
 * Each article's full content lives in src/lib/blog-articles/<slug>.tsx.
 * This file contains only metadata used for listing, filtering, and SEO.
 */

/** Valid blog post categories. */
export type BlogCategory =
  | "comparison"
  | "deep-dive"
  | "use-case"
  | "technical"
  | "company";

/** Display labels for each category. */
export const categoryLabels: Record<BlogCategory, string> = {
  comparison: "Comparison",
  "deep-dive": "Deep Dive",
  "use-case": "Use Case",
  technical: "Technical",
  company: "Company",
};

/** Color classes for category badges. */
export const categoryColors: Record<BlogCategory, string> = {
  comparison: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "deep-dive": "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "use-case": "bg-green-500/10 text-green-400 border-green-500/20",
  technical: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  company: "bg-rose-500/10 text-rose-400 border-rose-500/20",
};

/** Metadata for a single blog article. */
export interface BlogArticle {
  /** URL slug, must match the filename in blog-articles/ */
  slug: string;
  /** Article title */
  title: string;
  /** ISO 8601 date string (YYYY-MM-DD) */
  date: string;
  /** Article category for filtering */
  category: BlogCategory;
  /** One-line description shown on the listing page */
  description: string;
  /** Estimated read time in minutes */
  readTime: number;
}

/**
 * All blog articles sorted by date descending (newest first).
 *
 * When adding a new article:
 * 1. Add metadata here
 * 2. Create the content file in src/lib/blog-articles/<slug>.tsx
 */
export const blogArticles: BlogArticle[] = [
  {
    slug: "eleven-agents-checkpoints-voice-otel",
    title:
      "Styrby Now Supports 11 CLI Coding Agents with Session Checkpoints, Voice Commands, and Enterprise OTEL Export",
    date: "2026-03-27",
    category: "company",
    description:
      "Four new agents (Crush, Kilo, Kiro, Droid) bring the total to 11. Plus session checkpoints, voice commands, per-message cost tracking, mobile code review, and OpenTelemetry export for Grafana, Datadog, and Honeycomb.",
    readTime: 8,
  },
  {
    slug: "managing-ai-costs-dev-team",
    title: "Managing AI Agent Costs Across a Dev Team",
    date: "2026-03-20",
    category: "use-case",
    description:
      "Shared dashboards, per-developer attribution, and team budget alerts for the Power tier.",
    readTime: 7,
  },
  {
    slug: "understanding-ai-token-costs",
    title: "Understanding AI Agent Token Costs: Input, Output, and Cache",
    date: "2026-03-18",
    category: "technical",
    description:
      "How token-based pricing works, input vs. output cost differences, and why cache tokens matter.",
    readTime: 8,
  },
  {
    slug: "styrby-vs-claude-code-channels",
    title: "Styrby vs. Claude Code Channels: What's Actually Different",
    date: "2026-03-17",
    category: "comparison",
    description:
      "Claude Channels are free and native. Styrby adds multi-agent support, E2E encryption, and cost tracking. Here is what matters.",
    readTime: 7,
  },
  {
    slug: "overnight-agent-sessions-remote-monitoring",
    title: "Running AI Agents Overnight: Remote Monitoring for Long Sessions",
    date: "2026-03-14",
    category: "use-case",
    description:
      "Leave agents running, get push notifications, approve permissions from your phone, and use budget alerts as safety nets.",
    readTime: 6,
  },
  {
    slug: "e2e-encryption-ai-coding-sessions",
    title: "End-to-End Encryption for AI Coding Sessions",
    date: "2026-03-13",
    category: "deep-dive",
    description:
      "TweetNaCl box encryption, key exchange, and zero-knowledge architecture for code sessions.",
    readTime: 9,
  },
  {
    slug: "tweetnacl-in-production",
    title: "TweetNaCl in Production: Building E2E Encrypted Messaging",
    date: "2026-03-11",
    category: "technical",
    description:
      "Engineering decisions, key generation, performance characteristics, and lessons learned.",
    readTime: 9,
  },
  {
    slug: "styrby-vs-dispatch",
    title: "Styrby vs. Dispatch: Remote Agent Control Compared",
    date: "2026-03-10",
    category: "comparison",
    description:
      "Two different approaches to controlling AI agents remotely. Architecture, encryption, and agent coverage compared.",
    readTime: 7,
  },
  {
    slug: "tracking-ai-spend-per-project",
    title: "Tracking AI Spend Per Project With Session Tags",
    date: "2026-03-08",
    category: "use-case",
    description:
      "Freelancers and agencies billing AI costs to clients. Use session tags and project paths for cost attribution, then export for invoicing.",
    readTime: 6,
  },
  {
    slug: "budget-alerts-prevent-runaway-spend",
    title: "How Budget Alerts Prevent Runaway AI Spend",
    date: "2026-03-06",
    category: "deep-dive",
    description:
      "Setting up daily, weekly, and monthly limits with three graduated actions: notify, slow down, and hard stop.",
    readTime: 7,
  },
  {
    slug: "offline-first-react-native-expo-sqlite",
    title: "Building Offline-First React Native Apps with Expo SQLite",
    date: "2026-03-05",
    category: "technical",
    description:
      "SQLite setup, queue pattern, sync on reconnect. Tutorial-style with code examples.",
    readTime: 10,
  },
  {
    slug: "ai-coding-agent-cost-comparison-2026",
    title: "How Five AI Coding Agents Compare on Cost (2026)",
    date: "2026-03-04",
    category: "comparison",
    description:
      "Real pricing for Claude, GPT-4o, Gemini Pro, and more. Per-token costs, typical session costs, and how to track them.",
    readTime: 8,
  },
  {
    slug: "quiet-hours-notification-management",
    title: "Setting Up Quiet Hours for AI Agent Notifications",
    date: "2026-03-01",
    category: "use-case",
    description:
      "Why 24/7 notifications cause fatigue. Configuring time windows and critical alert bypass.",
    readTime: 5,
  },
  {
    slug: "remote-permission-approval",
    title:
      "Remote Permission Approval: Why Your AI Agent Shouldn't Have Root Access",
    date: "2026-02-28",
    category: "deep-dive",
    description:
      "The security case for mobile approval. Risk badges, blocked tool lists, and real examples of dangerous commands.",
    readTime: 8,
  },
  {
    slug: "claude-code-permissions-built-in-vs-remote",
    title: "AI Agent Permissions: Built-in Controls vs. Remote Approval",
    date: "2026-02-26",
    category: "comparison",
    description:
      "How AI coding agents handle permissions differently, from Claude's allowlists to Codex's sandbox. Plus: when remote mobile approval makes sense.",
    readTime: 7,
  },
  {
    slug: "rate-limiting-saas-apis",
    title: "Rate Limiting Strategies for SaaS APIs",
    date: "2026-02-25",
    category: "technical",
    description:
      "Token bucket, sliding window, fixed window. Per-endpoint vs. per-user limits with Upstash Redis.",
    readTime: 8,
  },
  {
    slug: "session-replay-review-agent-work",
    title: "Session Replay: Reviewing What Your AI Agent Did",
    date: "2026-02-23",
    category: "deep-dive",
    description:
      "How encrypted replay works. Filtering by cost, agent, and project. Bookmarking sessions for later.",
    readTime: 6,
  },
  {
    slug: "five-terminals-to-one-dashboard",
    title: "From Five Terminals to One Dashboard",
    date: "2026-02-21",
    category: "use-case",
    description:
      "Before: checking each agent separately. After: unified view with live status. Practical workflow changes.",
    readTime: 6,
  },
  {
    slug: "tracking-ai-costs-spreadsheets-vs-automation",
    title: "Managing AI Agent Costs: Spreadsheets vs. Budget Alerts",
    date: "2026-02-19",
    category: "comparison",
    description:
      "The manual way vs. automated real-time tracking with threshold alerts. A practical comparison.",
    readTime: 6,
  },
  {
    slug: "why-supabase-over-firebase",
    title: "Why We Chose Supabase Over Firebase",
    date: "2026-02-18",
    category: "technical",
    description:
      "Postgres vs. Firestore, row-level security vs. Firestore rules, realtime subscriptions, and the self-host option.",
    readTime: 7,
  },
  {
    slug: "offline-first-architecture",
    title: "Offline-First Architecture: How Styrby Handles Lost Connections",
    date: "2026-02-16",
    category: "deep-dive",
    description:
      "SQLite on mobile, IndexedDB on web, and the sync protocol that ties them together.",
    readTime: 8,
  },
  {
    slug: "designing-budget-alert-systems",
    title: "Designing Budget Alert Systems That Don't Cry Wolf",
    date: "2026-02-12",
    category: "technical",
    description:
      "Threshold tuning, graduated actions, and the tradeoffs between period-based and rolling windows.",
    readTime: 7,
  },
  {
    slug: "error-attribution-agent-build-network",
    title: "Error Attribution: Agent, Build Tool, or Network?",
    date: "2026-02-10",
    category: "deep-dive",
    description:
      "Color-coded error classification that saves debugging time by identifying the real source of failures.",
    readTime: 6,
  },
  {
    slug: "true-cost-ai-coding-assistants-2026",
    title: "The True Cost of AI Coding Assistants in 2026",
    date: "2026-02-06",
    category: "technical",
    description:
      "Annual cost analysis, hidden costs like context window usage and retry loops, and how to estimate monthly spend.",
    readTime: 8,
  },
  {
    slug: "multi-agent-dashboard-one-view",
    title:
      "Five Agents, One Dashboard: Why Context Switching Kills Productivity",
    date: "2026-02-04",
    category: "deep-dive",
    description:
      "The problem with five different terminals. Unified status, cost aggregation, and color-coded agents.",
    readTime: 7,
  },
  {
    slug: "security-model-open-review",
    title: "Our Security Model: An Open Technical Review",
    date: "2026-02-02",
    category: "company",
    description:
      "Full security architecture published for peer review. Encryption, auth, data handling, and what we would change.",
    readTime: 9,
  },
  {
    slug: "ai-agent-security-what-to-worry-about",
    title: "AI Agent Security: What Developers Should Worry About",
    date: "2026-01-29",
    category: "technical",
    description:
      "Real risks vs. overhyped fears. Unauthorized file access, credential exposure, and practical security measures.",
    readTime: 7,
  },
  {
    slug: "styrby-roadmap-2026",
    title: "Styrby Roadmap: What's Coming in 2026",
    date: "2026-01-26",
    category: "company",
    description:
      "iOS app timeline, Android plans, upcoming features, and what we are deliberately not building.",
    readTime: 5,
  },
  {
    slug: "five-agents-one-workflow",
    title: "How Developers Actually Use Multiple AI Coding Tools",
    date: "2026-01-22",
    category: "company",
    description:
      "Usage patterns across Claude, Codex, Gemini, and more. Why developers don't pick just one, and the overhead that creates.",
    readTime: 7,
  },
  {
    slug: "veteran-owned-building-software-after-service",
    title: "Styrby is Veteran-Owned: Building Software After Service",
    date: "2026-01-19",
    category: "company",
    description:
      "Military background brings discipline to software engineering. Steel Motion LLC and the tools we build.",
    readTime: 3,
  },
  {
    slug: "why-we-built-styrby",
    title: "Why We Built Styrby",
    date: "2026-01-12",
    category: "company",
    description:
      "The problem: multiple AI agents with no unified cost or permission visibility. The solution we built.",
    readTime: 6,
  },
];

/**
 * Finds a blog article by its slug.
 *
 * @param slug - The URL slug to search for
 * @returns The matching article metadata, or undefined if not found
 */
export function getArticleBySlug(slug: string): BlogArticle | undefined {
  return blogArticles.find((a) => a.slug === slug);
}

/**
 * Returns all unique categories that have at least one article.
 *
 * @returns Array of category strings in display order
 */
export function getCategories(): BlogCategory[] {
  const cats = new Set(blogArticles.map((a) => a.category));
  const order: BlogCategory[] = [
    "comparison",
    "deep-dive",
    "use-case",
    "technical",
    "company",
  ];
  return order.filter((c) => cats.has(c));
}
