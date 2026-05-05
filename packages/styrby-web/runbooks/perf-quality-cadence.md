# Perf + Quality Cadence Runbook

**Audience:** anyone shipping to styrbyapp.com.
**Why this exists:** per-PR Lighthouse was removed from CI in PR #246 (commit `8c5fd7a`, 2026-05-03) because CI cost was outpacing the signal value — most PRs don't change perf-relevant code, and the few that do generated noise from cold-cache variance. Without a runbook the perf signal is silently lost. This doc is the replacement: when, who, what.

## TL;DR

| Trigger | Run | Owner |
|---|---|---|
| Pre-launch / pre-marketing-push | `/perf` + `/quality` | shipper |
| Bundle-size regression flagged in CI (`size-limit`) | `/perf` | shipper |
| Quarterly health check | `/perf` + `/quality` + `/a11y` | rotating |
| Customer-reported slow page | `/perf` against the specific URL | first responder |
| New marketing page or major UI rebuild | `/perf` + `/quality` + `/a11y` | shipper |

## When `/perf` runs

`/perf` is on-demand only (no scheduled cron). Run it when ANY of the following are true:

1. **You're about to launch / promote / press-release a route.** Lighthouse + Web Vitals before the customer arrives, not after.
2. **The bundle-size CI gate (`size-limit`) failed or warned.** That gate fires on every PR and is the canary; a fail is a hard signal that perf needs a closer look.
3. **You changed any of:**
   - `next.config.ts`, `webpack` config, or build pipeline
   - A page in `app/(public)/` or any route in the marketing surface (`/`, `/pricing`, `/features`, `/blog/*`)
   - A heavy dependency (added a chart library, a Markdown renderer, a video embed)
   - The auth-shell or any layout that wraps many routes
4. **Customer report of "slow" anywhere.** Open the report, open `/perf` against the URL, get a number before guessing.
5. **Quarterly health pulse** (every 90 days regardless of activity). Calendar reminder owned by whoever is on rotation that quarter.

## When `/quality` runs

`/quality` is the broader sweep (perf + tests + a11y). Run it when:

1. **Pre-launch.** Same trigger as `/perf`; one command covers all three angles.
2. **Major refactor merged.** When a PR touches >20 files or rewrites a subsystem (e.g. the billing pipeline rewrite in PR #247), follow up with `/quality` to confirm nothing slipped through unit-test gaps.
3. **Before turning on a new tier of customer (e.g. Growth team plan launch).** Stress the surfaces that get more load.

## What "passing" means

`/perf` produces a Lighthouse-style report with scores 0-100 per category (Perf, Accessibility, SEO, Best Practices). Targets:

| Surface | Perf | Accessibility |
|---|---|---|
| `/` (marketing root) | ≥ 90 | ≥ 95 |
| `/pricing` (paid CTA path) | ≥ 90 | ≥ 95 |
| `/dashboard/*` (logged-in) | ≥ 75 | ≥ 90 |
| `/blog/[slug]` | ≥ 85 | ≥ 95 |

Below target = file as a `perf:` ticket in the backlog with the failing metric (LCP/CLS/INP) and the URL. Don't tail-chase a one-point regression unless it's caused by a known recent change.

## What gets recorded

`/perf` writes its output to `.perf-reports/<date>/` (gitignored). Every run is a file. That's the audit trail.

For quarterly checks, copy the headline numbers into `styrby-backlog.md` under a new "Quarterly perf snapshot" section so future-you can compare 90-day trends.

## What was removed and why

- **Per-PR Lighthouse** (was `.github/workflows/lighthouse.yml`) — removed PR #246. Reason: cold-cache variance gave 8-12 point noise on each run, more than the regressions we were trying to catch. Lighthouse-CI in github-actions also takes ~2 min and burns Vercel preview minutes.
- **Bundle-size gate** is what stayed. `size-limit` runs on every PR, has a ~5KB tolerance per chunk, and fires hard when crossed. That's the cheap continuous canary; on-demand `/perf` is the deep dive.

## Related

- `~/.claude/standards/STEEL_DISCIPLINE.md` — Steel Principle 1 (verification before claim) applies here: don't claim "perf is fine" without running this.
- `styrby-backlog.md` — record findings + follow-up tickets here.
- `.size-limit.js` — bundle budgets (the always-on canary).
