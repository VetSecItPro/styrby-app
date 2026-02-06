import { Terminal } from "lucide-react"

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

const agents = [
  { name: "Claude Code", Logo: AnthropicLogo },
  { name: "Codex", Logo: OpenAILogo },
  { name: "Gemini CLI", Logo: GeminiLogo },
  { name: "OpenCode", Logo: null },
  { name: "Aider", Logo: null },
]

export function SocialProof() {
  return (
    <section className="border-y border-border/40 py-10">
      <div className="mx-auto max-w-7xl px-6">
        <p className="mb-6 text-center text-sm text-muted-foreground">
          Works with
        </p>
        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-12">
          {agents.map((agent) => (
            <div key={agent.name} className="flex items-center gap-2.5">
              {agent.Logo ? (
                <agent.Logo className="h-5 w-5 text-zinc-400" />
              ) : (
                <Terminal className="h-5 w-5 text-zinc-400" />
              )}
              <span className="text-sm font-medium tracking-tight text-muted-foreground">
                {agent.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
