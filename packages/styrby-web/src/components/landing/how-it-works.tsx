import { Terminal, QrCode, Rocket } from "lucide-react"

const steps = [
  {
    number: "01",
    title: "Install the CLI",
    description: "One command to connect your machine to Styrby.",
    icon: Terminal,
    code: "npm install -g @styrby/cli",
  },
  {
    number: "02",
    title: "Scan the QR Code",
    description: "Pair your phone or browser in seconds. No account setup needed.",
    icon: QrCode,
    code: null,
  },
  {
    number: "03",
    title: "Start Coding",
    description: "Your dashboard lights up with live agent activity, costs, and controls.",
    icon: Rocket,
    code: null,
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 py-24">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Up and Running in 90 Seconds
        </h2>

        <div className="mt-16 grid gap-8 md:grid-cols-3">
          {steps.map((step, i) => (
            <div key={step.number} className="relative text-center">
              {/* Connecting line */}
              {i < steps.length - 1 && (
                <div className="absolute right-0 top-10 hidden h-px w-full translate-x-1/2 bg-gradient-to-r from-border to-transparent md:block" />
              )}

              <span className="font-mono text-5xl font-bold text-amber-500/20">{step.number}</span>
              <div className="mx-auto mt-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary">
                <step.icon className="h-7 w-7 text-amber-500" />
              </div>
              <h3 className="mt-6 text-xl font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{step.description}</p>

              {step.code && (
                <div className="mx-auto mt-4 max-w-xs rounded-lg border border-border/60 bg-secondary/60 px-4 py-3">
                  <code className="font-mono text-xs text-amber-400">{step.code}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
