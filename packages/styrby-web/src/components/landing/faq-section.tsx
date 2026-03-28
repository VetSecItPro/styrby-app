import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

const faqs = [
  {
    q: "Can you see my code or prompts?",
    a: "No. Styrby uses end-to-end encryption (TweetNaCl) with a zero-knowledge architecture. Your code and prompts are encrypted on your machine before anything leaves it. Our servers only process metadata: costs, timestamps, and session status. We cannot read your data, even if compelled to. Exported sessions remain encrypted, and shared session links require a separate key you control.",
  },
  {
    q: "What agents does Styrby support?",
    a: "Eleven CLI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. The Free plan includes the first three (Claude Code, Codex, Gemini CLI). Pro unlocks eight agents. Power unlocks all eleven.",
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
    a: "Yes. Code review from mobile is a Power tier feature. Submit a review request from your phone, monitor progress, and receive push notifications when the review completes.",
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
    a: "The Pro plan ($24/mo) supports up to 3 team members with shared dashboards and per-developer cost attribution. The Power plan ($49/mo) adds team-level budget alerts and OTEL export for full observability across your team.",
  },
  {
    q: "How is this different from checking my API provider's dashboard?",
    a: "API dashboards show you total spend after the fact, across all usage. Styrby shows you per-agent, per-session, per-message, and per-model cost breakdowns with per-file context breakdown. Tag sessions by client or project to get a cost-by-tag breakdown for invoicing. You can also set budget limits that automatically stop runaway sessions, and it works across all eleven agents in one place. No provider dashboard does that.",
  },
]

export function FAQSection() {
  return (
    <section className="py-16">
      <div className="mx-auto max-w-3xl px-6">
        <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Questions You Should Ask Before Trusting Any Tool With Your Agent Data
        </h2>

        <Accordion type="single" collapsible className="mt-12">
          {faqs.map((faq, i) => (
            <AccordionItem key={i} value={`faq-${i}`} className="border-border/40">
              <AccordionTrigger className="text-left text-foreground hover:text-amber-500 hover:no-underline">
                {faq.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground leading-relaxed">
                {faq.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  )
}
