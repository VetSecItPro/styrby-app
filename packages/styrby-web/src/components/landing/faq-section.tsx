import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

const faqs = [
  {
    q: "Is my code data encrypted?",
    a: "Yes, all data is end-to-end encrypted using TweetNaCl. We use a zero-knowledge architecture, meaning we never see your code or prompts. Only metadata (costs, timestamps, status) is processed on our servers.",
  },
  {
    q: "Which AI agents are supported?",
    a: "Styrby supports five AI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, and Aider. All five are available on Pro and Power plans.",
  },
  {
    q: "Does it work offline?",
    a: "Yes! Commands queue offline and sync automatically when your connection is restored. You'll never lose a permission approval or cost record.",
  },
  {
    q: "Can I use it with my team?",
    a: "Absolutely. The Power plan supports up to 5 team members with shared dashboards, cost attribution, and team-level budget alerts.",
  },
  {
    q: "What happens if I hit my message limit?",
    a: "You'll receive a notification well before hitting the limit. If you do reach it, monitoring continues in read-only mode. You can upgrade anytime to increase your limit.",
  },
  {
    q: "Is there a mobile app?",
    a: "Our iOS app is launching soon. In the meantime, the web dashboard is fully responsive and works beautifully on mobile browsers. Android app is on the roadmap.",
  },
]

export function FAQSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-3xl px-6">
        <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Frequently Asked Questions
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
