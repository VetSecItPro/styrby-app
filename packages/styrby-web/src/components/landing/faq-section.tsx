"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * FAQ data - all questions and answers for the landing page.
 *
 * WHY no accordion: The two-column layout gives visitors a scannable
 * question list on the left and an immediately readable answer on the
 * right. This is faster than the expand/collapse rhythm of accordions
 * and keeps the page feel premium rather than generic.
 */
const faqs = [
  {
    q: "Can you see my code or prompts?",
    a: "No. Styrby uses end-to-end encryption (TweetNaCl) with a zero-knowledge architecture. Your code and prompts are encrypted on your machine before anything leaves it. Our servers only process metadata: costs, timestamps, and session status. We cannot read your data, even if compelled to. Exported sessions remain encrypted, and shared session links require a separate key you control.",
  },
  {
    q: "What agents does Styrby support?",
    a: "Eleven CLI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. The Free plan includes the first three. Pro unlocks eight agents. Power unlocks all eleven.",
  },
  {
    q: "Can I use my own API keys?",
    a: "Yes. Droid supports BYOK (bring your own key), so you can connect your own API credentials directly rather than routing through a provider. Your keys are hashed with bcrypt before storage and never stored in plaintext.",
  },
  {
    q: "Does it work offline?",
    a: "Yes. Commands queue locally and sync the moment your connection returns. Permission approvals, cost records, session data: nothing is lost. This matters because agents do not wait for stable WiFi, and neither should your workflow.",
  },
  {
    q: "Can I use voice commands?",
    a: "Yes, voice commands are available on the Power tier. Dictate approvals, queries, or commands hands-free from your phone or browser.",
  },
  {
    q: "Can I review code from my phone?",
    a: "Yes. Code review from mobile is a Power tier feature. Submit a review request from your phone, monitor progress, and receive a push notification when the review completes.",
  },
  {
    q: "What are session checkpoints?",
    a: "Session checkpoints are named save points within a session. You can mark a point in a long session as a checkpoint to return to it later, compare progress, or share a specific moment in the conversation. Available on Pro and above.",
  },
  {
    q: "Can I share session replays?",
    a: "Yes, on Pro and above you can generate a share link for any session replay. The session data remains end-to-end encrypted, and the recipient needs a separate decryption key that you provide. Styrby never has access to the plaintext content.",
  },
  {
    q: "What is OTEL export?",
    a: "OpenTelemetry (OTEL) export lets you send your agent session metrics, cost data, and trace events to any compatible observability platform: Grafana, Datadog, Honeycomb, and others. Available on the Power tier.",
  },
  {
    q: "How does cloud monitoring work?",
    a: "Submit a cloud monitoring job from the dashboard or mobile app, track its progress in real time, and receive a push notification when it finishes or encounters an error. Available on the Power tier.",
  },
  {
    q: "Can I use it with my team?",
    a: "The Pro plan ($24/mo) supports up to 3 team members with shared dashboards and per-developer cost attribution. The Power plan ($59/mo) adds team-level budget alerts and OTEL export for full observability across your team.",
  },
  {
    q: "How is this different from checking my API dashboard?",
    a: "API dashboards show you total spend after the fact, across all usage. Styrby shows per-agent, per-session, per-message, and per-model cost breakdowns with per-file context detail. Tag sessions by client or project for cost-by-tag reporting. Set budget limits that automatically pause runaway sessions. Works across all eleven agents in one place.",
  },
]

/**
 * FAQ section - two-column layout with clickable questions on the left
 * and the selected answer on the right.
 *
 * @returns The full FAQ section with interactive question selection
 */
export function FAQSection() {
  const [active, setActive] = useState(0)

  return (
    <section className="py-24">
      <div className="mx-auto max-w-7xl px-6">

        {/* Section header */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
            FAQ
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Questions you should ask before trusting any tool with your agent data
          </h2>
        </div>

        {/* Two-column layout */}
        <div className="mt-16 grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-12">

          {/* Left: question list */}
          <nav aria-label="FAQ questions" className="flex flex-col gap-1">
            {faqs.map((faq, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActive(i)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-lg px-4 py-3.5 text-left transition-colors duration-150",
                  i === active
                    ? "bg-zinc-900 text-foreground"
                    : "text-muted-foreground hover:bg-zinc-900/50 hover:text-foreground"
                )}
              >
                {/* Active indicator bar */}
                <span
                  className={cn(
                    "mt-1.5 h-3 w-0.5 shrink-0 rounded-full transition-colors duration-150",
                    i === active ? "bg-amber-500" : "bg-transparent"
                  )}
                  aria-hidden="true"
                />
                <span className="text-sm font-medium leading-snug">{faq.q}</span>
              </button>
            ))}
          </nav>

          {/* Right: answer panel */}
          <div className="lg:sticky lg:top-24">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-8 lg:p-10">
              {/* Question */}
              <h3 className="text-lg font-semibold leading-snug text-foreground">
                {faqs[active].q}
              </h3>

              {/* Amber divider */}
              <div className="mt-4 h-px w-12 bg-amber-500/40" />

              {/* Answer */}
              <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                {faqs[active].a}
              </p>
            </div>

            {/* Mobile fallback: show all Q&A below the list on small screens */}
            <p className="mt-4 text-xs text-muted-foreground/50 lg:hidden">
              Tap a question above to read the answer here.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
