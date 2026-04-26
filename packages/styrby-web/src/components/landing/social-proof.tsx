/**
 * Social Proof Section
 *
 * Shows all eleven supported AI coding agents with their brand colors
 * and logos. Builds trust by showing compatibility with tools
 * developers already use.
 */

function AnthropicLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.14 0h-3.4l6.86 16h3.4L17.14 0ZM6.86 0 0 16h3.47l1.4-3.39h7.26L13.53 16H17L10.14 0H6.86Zm-.41 9.87 2.1-5.05 2.1 5.05h-4.2Z" />
    </svg>
  )
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M22.28 9.37a5.99 5.99 0 0 0-.52-4.93 6.07 6.07 0 0 0-6.54-2.9A5.99 5.99 0 0 0 10.7 0a6.07 6.07 0 0 0-5.8 4.24 5.99 5.99 0 0 0-4 2.91 6.07 6.07 0 0 0 .75 7.12 5.99 5.99 0 0 0 .52 4.93 6.07 6.07 0 0 0 6.54 2.9A5.99 5.99 0 0 0 13.3 24a6.07 6.07 0 0 0 5.8-4.24 5.99 5.99 0 0 0 4-2.91 6.07 6.07 0 0 0-.75-7.12l-.06-.36ZM13.3 22.34a4.5 4.5 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.78.78 0 0 0 .39-.67v-6.74l2.02 1.17a.07.07 0 0 1 .04.06v5.58a4.52 4.52 0 0 1-4.5 4.48ZM3.6 18.23a4.49 4.49 0 0 1-.54-3.02l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.83-3.37v2.33a.07.07 0 0 1-.03.06l-4.83 2.79a4.52 4.52 0 0 1-6.13-1.64ZM2.34 7.88a4.49 4.49 0 0 1 2.35-1.98v5.69a.78.78 0 0 0 .39.67l5.83 3.37-2.02 1.17a.07.07 0 0 1-.07 0L4 13.99a4.52 4.52 0 0 1-1.66-6.12Zm17.2 4.01-5.84-3.37 2.03-1.17a.07.07 0 0 1 .07 0l4.83 2.79a4.51 4.51 0 0 1-.7 8.1V12.56a.78.78 0 0 0-.39-.67Zm2.01-3.03-.14-.09-4.78-2.76a.77.77 0 0 0-.78 0l-5.83 3.37V7.05a.07.07 0 0 1 .03-.06l4.83-2.79a4.51 4.51 0 0 1 6.67 4.66ZM7.75 12.56l-2.02-1.17a.07.07 0 0 1-.04-.06V5.75a4.51 4.51 0 0 1 7.38-3.47l-.14.08-4.78 2.76a.78.78 0 0 0-.39.67l-.01 6.77Zm1.1-2.37 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5v-3Z" />
    </svg>
  )
}

function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
    </svg>
  )
}

/** OpenCode uses a terminal-bracket style mark */
function OpenCodeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

/** Aider uses a git-branch style mark (reflects its git-based workflow) */
function AiderLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

/** Goose uses a feather/quill style mark */
function GooseLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5l6.74-6.76Z" />
      <line x1="16" y1="8" x2="2" y2="22" />
    </svg>
  )
}

/** Amp uses a lightning-bolt style mark */
function AmpLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8Z" />
    </svg>
  )
}

/** Crush uses a compact C-bracket style mark */
function CrushLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M18 4a9 9 0 1 0 0 16" />
    </svg>
  )
}

/** Kilo uses a minimal K-letterform */
function KiloLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="6" y1="4" x2="6" y2="20" />
      <path d="M18 4 6 12l12 8" />
    </svg>
  )
}

/** Kiro uses a compass-direction style mark */
function KiroLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}

/** Droid uses a robot-face style mark */
function DroidLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M8 8V6a4 4 0 0 1 8 0v2" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="15" cy="14" r="1" fill="currentColor" />
    </svg>
  )
}

const agents = [
  { name: "Claude Code", Logo: AnthropicLogo, color: "text-orange-400" },
  { name: "Codex", Logo: OpenAILogo, color: "text-green-400" },
  { name: "Gemini CLI", Logo: GeminiLogo, color: "text-blue-400" },
  { name: "OpenCode", Logo: OpenCodeLogo, color: "text-cyan-400" },
  { name: "Aider", Logo: AiderLogo, color: "text-purple-400" },
  { name: "Goose", Logo: GooseLogo, color: "text-teal-400" },
  { name: "Amp", Logo: AmpLogo, color: "text-yellow-400" },
  { name: "Crush", Logo: CrushLogo, color: "text-pink-400" },
  { name: "Kilo", Logo: KiloLogo, color: "text-indigo-400" },
  { name: "Kiro", Logo: KiroLogo, color: "text-sky-400" },
  { name: "Droid", Logo: DroidLogo, color: "text-rose-400" },
]

export function SocialProof() {
  return (
    <section className="py-10">
      {/* Top separator */}
      <div className="mx-auto max-w-7xl px-6">
        <div className="h-px bg-zinc-800/60" />
      </div>

      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="mb-6 text-center text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/60">
          {/* WHY this eyebrow over "Trusted by N developers": real customer
              counts are still being instrumented (see notes.md placeholder #1).
              Until that number is verifiable, the agent compatibility framing
              is the strongest honest claim. */}
          Pairs with the 11 CLI agents already in your terminal
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-4 lg:flex-nowrap lg:gap-x-6">
          {agents.map((agent) => (
            <div key={agent.name} className="flex items-center gap-1.5 shrink-0">
              <agent.Logo className={`h-4 w-4 ${agent.color}`} />
              <span className={`text-xs font-medium tracking-tight whitespace-nowrap ${agent.color}`}>
                {agent.name}
              </span>
            </div>
          ))}
        </div>
        {/* Trust badges */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          {[
            "E2E encrypted (TweetNaCl)",
            "Zero-knowledge architecture",
            "CLI + Web + iOS",
          ].map((badge) => (
            <span
              key={badge}
              className="rounded-full border border-border/40 bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {badge}
            </span>
          ))}
        </div>
      </div>

      {/* Bottom separator */}
      <div className="mx-auto max-w-7xl px-6">
        <div className="h-px bg-zinc-800/60" />
      </div>
    </section>
  )
}
