import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

const faqs = [
  {
    q: "Can you see my code or prompts?",
    a: "No. Styrby uses end-to-end encryption (TweetNaCl) with a zero-knowledge architecture. Your code and prompts are encrypted on your machine before anything leaves it. Our servers only process metadata: costs, timestamps, and session status. We literally cannot read your data, even if compelled to.",
  },
  {
    q: "Which AI agents are supported?",
    a: "Five today: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, and Aider. The Free plan includes one agent. Pro and Power plans unlock all five. We add new agents as the ecosystem grows.",
  },
  {
    q: "Does it work offline?",
    a: "Yes. Commands queue locally and sync the moment your connection returns. Permission approvals, cost records, session data: nothing is lost. This matters because agents do not wait for stable WiFi, and neither should your workflow.",
  },
  {
    q: "Can I use it with my team?",
    a: "The Power plan ($49/mo) supports up to 3 team members with shared dashboards, per-developer cost attribution, and team-level budget alerts. You will know exactly who spent what and whether they stayed within budget.",
  },
  {
    q: "What happens if I hit my message limit?",
    a: "You get a warning well before the limit. If you do hit it, monitoring continues in read-only mode so you never lose visibility. Upgrading is instant, takes effect immediately, and does not require restarting your agents.",
  },
  {
    q: "Is there a mobile app?",
    a: "The iOS app launches soon. Until then, the web dashboard is fully responsive and optimized for mobile browsers. You can approve permissions, check costs, and monitor agents from any phone today. Android is on the roadmap.",
  },
  {
    q: "How is this different from checking my API provider's dashboard?",
    a: "API dashboards show you total spend after the fact, across all usage. Styrby shows you per-agent, per-session, and per-model cost breakdowns. Tag sessions by client or project to see a Cost by Tag breakdown you can use for invoicing. Charts update on each page load. You can also set budget limits that automatically stop runaway sessions, and it works across five different agents in one place. No provider dashboard does that.",
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
