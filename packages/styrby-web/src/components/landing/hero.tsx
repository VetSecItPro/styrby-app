import Link from "next/link"
import Image from "next/image"
import { ArrowRight, Lock, Shield, Smartphone, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Dashboard screenshot with a double-bezel frame treatment.
 *
 * WHY double bezel: a single thin border looks flat at large sizes. The
 * outer ring provides contrast against the dark background; the inner ring
 * (slightly brighter) creates a perception of depth and frames the screenshot
 * like a physical device, which subconsciously signals premium hardware.
 */
function DashboardMockup() {
  return (
    <div className="relative mx-auto mt-20 max-w-5xl px-4 md:px-0">
      {/* Radial amber glow sitting behind the frame */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-12 -z-10 rounded-3xl"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% 100%, rgba(245,158,11,0.12) 0%, transparent 70%)",
        }}
      />
      {/* Outer bezel - faint border ring */}
      <div className="rounded-[18px] border border-white/[0.06] p-[3px] shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_32px_80px_rgba(0,0,0,0.7)]">
        {/* Inner bezel - slightly brighter, adds depth */}
        <div className="rounded-[15px] border border-white/[0.09] overflow-hidden">
          {/* WHY sizes: tells the browser the rendered width before layout is
              complete, so it can select the correct responsive image variant
              from the Next.js image srcset immediately, without waiting for
              CSS to compute the container width. This eliminates a speculative
              load of a larger image than needed on smaller viewports. */}
          <Image
            src="/screenshots/dashboard-overview.png"
            alt="Styrby dashboard showing real-time agent costs and session monitoring"
            width={1440}
            height={900}
            className="w-full"
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) calc(100vw - 48px), 1280px"
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Hero section for the Styrby landing page.
 *
 * WHY this headline: "11 Agents. One Dashboard. Your Phone." leads with the
 * remote-control story - not costs. The competitive moat against Anthropic
 * Channels / Dispatch is breadth (11 agents) + mobility (your phone). The
 * headline lands that in four words before the user has time to bounce.
 *
 * WHY asymmetric layout (DESIGN_VARIANCE 7): centering everything reads as
 * generic SaaS. Pinning the headline left with a constrained max-width creates
 * editorial tension that feels intentional and premium.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden pt-36 pb-24">
      {/* ── Background: mesh gradient + dot grid ── */}
      <div aria-hidden="true" className="absolute inset-0 dot-grid opacity-50" />

      {/* Left-anchored amber plume - asymmetric, editorial */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 -z-10"
        style={{
          width: "900px",
          height: "700px",
          background:
            "radial-gradient(ellipse 60% 55% at 15% 30%, rgba(245,158,11,0.07) 0%, transparent 65%)",
        }}
      />
      {/* Subtle right-side cool counter-weight so it doesn't look accidental */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 bottom-0 -z-10"
        style={{
          width: "600px",
          height: "500px",
          background:
            "radial-gradient(ellipse 70% 60% at 85% 80%, rgba(99,102,241,0.04) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-6">
        {/* ── Main headline - left-aligned, massive ── */}
        {/*
          WHY text-left: at DESIGN_VARIANCE 7 we break the centered-SaaS pattern.
          The headline reads like editorial typesetting, not a template.
          max-w-3xl keeps line lengths tight so the staggered line breaks read
          as intentional rather than wrapping accidents.
        */}
        <h1
          className={cn(
            "max-w-3xl text-left",
            "text-6xl md:text-[82px] font-bold leading-[1.15] tracking-tighter",
            "text-zinc-50"
          )}
        >
          {/* "11 Agents" gets the amber gradient - it's the moat, own it */}
          <span
            className="inline-block pb-1"
            style={{
              backgroundImage:
                "linear-gradient(135deg, #F59E0B 0%, #FBBF24 45%, #FCD34D 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            11 Agents.
          </span>
          <br />
          <span className="text-zinc-50">One Dashboard.</span>
          <br />
          <span className="text-zinc-300">Your Phone.</span>
        </h1>

        {/* ── Subheadline - controlled width, left-aligned ── */}
        {/*
          WHY this phrasing: the three verbs (approve, review, watch) map 1:1
          to the three primary mobile workflows shown later in MobileShowcase,
          so the reader sees the homepage promise made good further down. The
          encryption wedge is named upfront because it neutralises the top
          objection ("can attackers read my code?") before the reader has time
          to raise it themselves.
        */}
        <p className="mt-7 max-w-xl text-left text-lg leading-relaxed text-zinc-400 md:text-[18px]">
          Approve risky permissions, review code diffs, and watch token spend
          in real time. From your phone, end-to-end encrypted.
        </p>

        {/* ── CTAs ── */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            asChild
            size="lg"
            className={cn(
              "h-12 px-7 text-base font-semibold rounded-lg",
              "bg-amber-500 text-zinc-950 hover:bg-amber-400",
              "shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_4px_20px_rgba(245,158,11,0.35)]",
              "transition-all duration-200 hover:shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_6px_28px_rgba(245,158,11,0.5)]",
              "group"
            )}
          >
            <Link href="/signup" className="flex items-center gap-2">
              {/* WHY first-person CTA: ContentVerve testing shows first-person
                  ("my") outperforms second-person ("your") by up to 90% on CTR.
                  "Pair" is also more specific to the actual install flow than
                  "Connect": the user pairs their phone with a CLI machine,
                  not "connects an agent." */}
              Pair my first agent
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          </Button>

          <Button
            variant="ghost"
            size="lg"
            asChild
            className={cn(
              "h-12 px-7 text-base rounded-lg",
              "border border-white/[0.10] text-zinc-400",
              "hover:bg-white/[0.04] hover:text-zinc-200 hover:border-white/[0.16]",
              "transition-all duration-200"
            )}
          >
            <a href="#how-it-works">See how it works</a>
          </Button>
        </div>

        {/* ── Trust badges ── */}
        {/*
          WHY these 4: each one neutralises a specific buyer objection.
          E2E Encrypted = "can attackers read my code?" answered.
          Zero touch servers = "does Styrby store my IP?" answered.
          11 Agents = "will it work with my agent?" answered.
          Free tier = "what does it cost to try?" answered.
        */}
        <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3">
          {[
            { icon: Lock, text: "E2E encrypted on your machine" },
            { icon: Shield, text: "Your code never touches our servers" },
            { icon: Smartphone, text: "All 11 CLI agents in one view" },
            { icon: Zap, text: "Free on one machine, forever" },
          ].map(({ icon: Icon, text }) => (
            <div
              key={text}
              className="flex items-center gap-2 text-[13px] text-zinc-500"
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0 text-amber-500/60" />
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Dashboard mockup - full width within container ── */}
      <div className="mx-auto max-w-7xl px-6">
        <DashboardMockup />
      </div>
    </section>
  )
}
