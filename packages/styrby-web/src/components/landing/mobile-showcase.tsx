/**
 * Mobile Showcase Section
 *
 * WHY this section exists: The mobile remote control story is the primary
 * differentiator vs. desktop-only dashboards. This section converts skeptics
 * by making the phone experience concrete: not "you can use your phone" but
 * "here is the permission approval screen, here is the diff viewer, here is
 * the voice command interface." Show, do not tell.
 *
 * WHY CSS-only phone mockups: Avoids screenshot dependencies that require
 * a finished app, introduces CLS on image load, and breaks on retina without
 * 2x assets. Styled div mockups render instantly and can be updated alongside
 * the code they represent.
 */

/**
 * Permission approval phone mockup.
 * Represents the primary remote control use case: approving risky agent actions.
 */
function PermissionApprovalMockup() {
  return (
    <div className="relative w-[220px] overflow-hidden rounded-[1.75rem] border-[5px] border-zinc-700 bg-zinc-900 shadow-2xl">
      {/* Notch */}
      <div className="absolute left-1/2 top-0 z-10 h-5 w-20 -translate-x-1/2 rounded-b-xl bg-zinc-700" />

      {/* Screen content */}
      <div className="min-h-[420px] bg-zinc-950 px-4 pb-6 pt-10">
        {/* Status bar */}
        <div className="mb-5 flex items-center justify-between px-1">
          <span className="font-mono text-[9px] text-zinc-500">9:41</span>
          <span className="font-mono text-[9px] text-zinc-500">styrby</span>
        </div>

        {/* Permission card */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            <span className="font-mono text-[9px] font-semibold text-amber-400">
              APPROVAL NEEDED
            </span>
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-zinc-300">
            claude-code wants to write to{" "}
            <span className="text-amber-300">src/auth/tokens.ts</span>
          </p>
        </div>

        {/* Risk badge */}
        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-mono text-[9px] text-red-400">
            HIGH RISK
          </span>
          <span className="font-mono text-[9px] text-zinc-500">auth file modification</span>
        </div>

        {/* Diff preview */}
        <div className="mt-3 overflow-hidden rounded-lg border border-white/[0.06] bg-black/40">
          <div className="px-3 py-2">
            <div className="font-mono text-[9px] text-red-400/80">
              - const token = jwt.sign(payload)
            </div>
            <div className="font-mono text-[9px] text-emerald-400/80">
              + const token = jwt.sign(payload, secret, &#123;
            </div>
            <div className="font-mono text-[9px] text-emerald-400/80">
              +   expiresIn: &apos;1h&apos;
            </div>
            <div className="font-mono text-[9px] text-emerald-400/80">
              + &#125;)
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="rounded-lg border border-red-500/30 bg-red-500/10 py-2 font-mono text-[10px] text-red-400">
            Deny
          </button>
          <button className="rounded-lg bg-amber-500 py-2 font-mono text-[10px] font-semibold text-black">
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Voice command interface phone mockup.
 * Shows the mic UI with waveform and recent command transcript.
 */
function VoiceCommandMockup() {
  return (
    <div className="relative w-[220px] overflow-hidden rounded-[1.75rem] border-[5px] border-zinc-700 bg-zinc-900 shadow-2xl">
      {/* Notch */}
      <div className="absolute left-1/2 top-0 z-10 h-5 w-20 -translate-x-1/2 rounded-b-xl bg-zinc-700" />

      {/* Screen content */}
      <div className="min-h-[420px] bg-zinc-950 px-4 pb-6 pt-10">
        {/* Status bar */}
        <div className="mb-5 flex items-center justify-between px-1">
          <span className="font-mono text-[9px] text-zinc-500">9:41</span>
          <span className="font-mono text-[9px] text-zinc-500">voice</span>
        </div>

        {/* Mic circle */}
        <div className="flex flex-col items-center py-4">
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-amber-500/40 bg-amber-500/10">
            {/* Pulse rings */}
            <div className="absolute inset-0 animate-ping rounded-full border border-amber-500/20" />
            {/* Mic icon (CSS) */}
            <div className="flex h-8 w-8 flex-col items-center justify-center gap-0.5">
              <div className="h-5 w-3 rounded-full border-2 border-amber-400" />
              <div className="h-1 w-5 border-b-2 border-amber-400" />
              <div className="h-0.5 w-2 bg-amber-400" />
            </div>
          </div>
          <p className="mt-3 font-mono text-[10px] text-amber-400">Listening...</p>
        </div>

        {/* Waveform bars */}
        <div className="flex items-center justify-center gap-0.5">
          {[2, 5, 8, 12, 8, 14, 10, 6, 11, 7, 4, 9, 5, 3].map((h, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-amber-500/60"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>

        {/* Transcript */}
        <div className="mt-4 space-y-2">
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.03] px-3 py-2">
            <p className="font-mono text-[9px] text-zinc-500">You said</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-300">
              &ldquo;Stop the codex session&rdquo;
            </p>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
            <p className="font-mono text-[9px] text-emerald-500">Executed</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-300">
              codex session terminated
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Code diff review phone mockup.
 * Shows a syntax-highlighted diff with approve/comment actions.
 */
function CodeReviewMockup() {
  return (
    <div className="relative w-[220px] overflow-hidden rounded-[1.75rem] border-[5px] border-zinc-700 bg-zinc-900 shadow-2xl">
      {/* Notch */}
      <div className="absolute left-1/2 top-0 z-10 h-5 w-20 -translate-x-1/2 rounded-b-xl bg-zinc-700" />

      {/* Screen content */}
      <div className="min-h-[420px] bg-zinc-950 px-4 pb-6 pt-10">
        {/* Status bar */}
        <div className="mb-5 flex items-center justify-between px-1">
          <span className="font-mono text-[9px] text-zinc-500">9:41</span>
          <span className="font-mono text-[9px] text-zinc-500">diff</span>
        </div>

        {/* File header */}
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[9px] text-zinc-400">src/api/users.ts</span>
          <div className="flex gap-1">
            <span className="rounded bg-emerald-500/20 px-1 font-mono text-[8px] text-emerald-400">+12</span>
            <span className="rounded bg-red-500/20 px-1 font-mono text-[8px] text-red-400">-3</span>
          </div>
        </div>

        {/* Diff lines */}
        <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/50">
          <div className="px-3 py-2 space-y-0.5">
            <div className="font-mono text-[8px] text-zinc-500">@@ -24,7 +24,16 @@</div>
            <div className="font-mono text-[9px] text-zinc-500"> export async function</div>
            <div className="font-mono text-[9px] text-zinc-500">   getUser(id: string)</div>
            <div className="font-mono text-[9px] text-red-400/80">- &#47;&#47; TODO: add caching</div>
            <div className="font-mono text-[9px] text-emerald-400/80">+ const cached = await</div>
            <div className="font-mono text-[9px] text-emerald-400/80">+   redis.get(id)</div>
            <div className="font-mono text-[9px] text-emerald-400/80">+ if (cached) return</div>
            <div className="font-mono text-[9px] text-emerald-400/80">+   JSON.parse(cached)</div>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 flex items-center gap-3">
          <span className="font-mono text-[9px] text-zinc-500">4 files changed</span>
          <span className="h-3 w-px bg-zinc-700" />
          <span className="font-mono text-[9px] text-zinc-500">claude-code</span>
        </div>

        {/* Actions */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 font-mono text-[10px] text-zinc-400">
            Comment
          </button>
          <button className="rounded-lg bg-amber-500 py-2 font-mono text-[10px] font-semibold text-black">
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Showcase entry metadata
// ---------------------------------------------------------------------------

const showcaseItems = [
  {
    mockup: <PermissionApprovalMockup />,
    label: "Permission Approval",
    caption: "Approve or deny risky actions with full diff context. No laptop needed.",
  },
  {
    mockup: <VoiceCommandMockup />,
    label: "Voice Commands",
    caption: "Stop sessions, trigger builds, or send prompts hands-free.",
  },
  {
    mockup: <CodeReviewMockup />,
    label: "Code Review",
    caption: "Syntax-highlighted diffs and one-tap approval from your phone.",
  },
]

export function MobileShowcase() {
  return (
    <section className="overflow-hidden py-16 md:py-24">
      <div className="mx-auto max-w-7xl px-6">
        {/* Section header */}
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
            Control Your Agents From Anywhere
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
            The full power of your development workflow, distilled to three taps. Approve
            permissions, review diffs, and issue voice commands without touching your laptop.
          </p>
        </div>

        {/* Phone mockup row */}
        <div className="mt-14 flex flex-col items-center justify-center gap-10 sm:flex-row sm:items-start sm:gap-8">
          {showcaseItems.map((item, i) => (
            <div key={item.label} className="flex flex-col items-center gap-4">
              {/*
                Middle phone is elevated slightly on desktop for visual depth.
                WHY: The three-phone layout needs a focal point. Elevating the
                center phone creates a pyramid that draws the eye to the most
                important mockup (voice commands - the most novel capability).
              */}
              <div className={i === 1 ? "sm:-mt-6" : ""}>
                {item.mockup}
              </div>
              <div className="max-w-[200px] text-center">
                <p className="text-xs font-semibold text-foreground">{item.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.caption}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom CTA callout */}
        <div className="mx-auto mt-16 max-w-xl rounded-xl border border-white/[0.06] bg-zinc-950/80 p-6 text-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]">
          <p className="text-sm font-semibold text-foreground">
            Your agents work around the clock. Now you can too, without being desk-bound.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            E2E encrypted. Zero-knowledge architecture. Your code never leaves your machine unencrypted.
          </p>
        </div>
      </div>
    </section>
  )
}
