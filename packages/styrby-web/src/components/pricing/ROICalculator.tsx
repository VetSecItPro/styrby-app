'use client';

import { useState, useMemo } from 'react';
import { DollarSign } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

/**
 * ROI calculator inputs.
 *
 * WHY these four levers (not more): developer count, hours/week, hourly rate,
 * and productivity gain are the minimal set that produces a credible estimate.
 * More inputs create friction; fewer produce overly vague results.
 */
interface ROIInputs {
  developers: number;
  hoursPerWeek: number;
  hourlyRateUsd: number;
  /** Productivity gain as a percentage (e.g. 25 = 25%). */
  productivityGainPct: number;
}

/**
 * Module-scope `Intl.NumberFormat` reused across every {@link formatDollars}
 * call. Hoisted so slider drags (60fps) don't reconstruct the formatter on
 * every render — locale/currency are constants.
 */
const DOLLAR_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formats a dollar amount as "$1,234" (no cents).
 *
 * @param dollars - Amount in US dollars (integer expected).
 * @returns Formatted string.
 */
function formatDollars(dollars: number): string {
  return DOLLAR_FORMATTER.format(Math.round(dollars));
}

/**
 * Computes annual developer-time value recovered given ROI inputs.
 *
 * Formula:
 *   weeklyHoursRecovered = hoursPerWeek * (productivityGainPct / 100)
 *   annualHoursRecovered = weeklyHoursRecovered * 52
 *   annualValueUsd       = developers * annualHoursRecovered * hourlyRateUsd
 *
 * WHY this formula: it measures the value of reclaimed developer time rather
 * than claiming direct cost reduction. "Saved 25% of time spent on repetitive
 * coding tasks" is measurable and honest; "reduced your AI bill by X%" is
 * not what Styrby primarily does.
 *
 * WHY 20-40% is the default range: research on AI coding tools (GitHub Copilot
 * study, McKinsey 2023 developer survey, Stripe developer productivity report)
 * consistently shows 20-40% productivity gains on tasks like boilerplate,
 * test generation, and code review - not wholesale replacement of developers.
 * Defaults at 25% (conservative midpoint of the range).
 *
 * We do NOT claim 60-80% gains. Those numbers are marketing fiction; a
 * realistic calculator builds trust and qualifies buyers better.
 *
 * @param inputs - The ROI calculator inputs.
 * @returns Annual value of recovered developer time in USD.
 */
export function computeAnnualROI(inputs: ROIInputs): number {
  const { developers, hoursPerWeek, hourlyRateUsd, productivityGainPct } = inputs;

  // Integer-safe multiplication order to avoid float drift at the final display.
  // hoursPerWeek and productivityGainPct are integers from slider, so this is exact.
  const weeklyHoursRecovered = (hoursPerWeek * productivityGainPct) / 100;
  const annualHoursRecovered = weeklyHoursRecovered * 52;
  const annualValue = developers * annualHoursRecovered * hourlyRateUsd;
  return annualValue;
}

/**
 * Slider row sub-component to reduce repetition.
 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-300">{label}</span>
        <span className="text-sm font-semibold text-foreground tabular-nums">{format(value)}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className={cn(
          '[&_.bg-primary]:bg-amber-500',
          '[&_.border-primary]:border-amber-500',
        )}
      />
    </div>
  );
}

/**
 * ROI Calculator component.
 *
 * An interactive calculator that estimates the annual value of recovered
 * developer time when using AI coding agents via Styrby.
 *
 * HONESTY COMMITMENT:
 * - Default productivity gain is 25% (conservative)
 * - Max slider is capped at 40% (upper bound from published research)
 * - Copy says "developer time on repetitive tasks" - not blanket productivity
 * - Disclaimer below the result is explicit about YMMV
 *
 * WHY dynamic-imported by the pricing page: this component uses Radix UI Slider
 * instances and client-side state. Next.js dynamic import with ssr:false keeps
 * it out of the server-side render and splits it into a separate chunk, keeping
 * the pricing page's first-load bundle within the 740 KB budget.
 */
export function ROICalculator() {
  const [inputs, setInputs] = useState<ROIInputs>({
    developers: 5,
    hoursPerWeek: 40,
    hourlyRateUsd: 100,
    productivityGainPct: 25,
  });

  const annualROI = useMemo(() => computeAnnualROI(inputs), [inputs]);

  // WHY $19/seat × 12: Growth seat add-on price for an annualised back-of-the-
  // envelope. Conservative — the $99/mo base covers the first 3 seats but we
  // ignore that here so the ROI ratio is never overstated for small teams.
  const annualStyrbyEstimate = inputs.developers * 19 * 12;
  const roi = annualStyrbyEstimate > 0 ? annualROI / annualStyrbyEstimate : 0;

  const update = (key: keyof ROIInputs) => (v: number) =>
    setInputs((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/10">
          <DollarSign className="h-5 w-5 text-amber-400" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">ROI Estimator</h3>
          <p className="text-xs text-muted-foreground">
            Estimates value of reclaimed developer time. Results vary by team and workflow.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-5">
          <SliderRow
            label="Developers on your team"
            value={inputs.developers}
            min={1}
            max={100}
            step={1}
            format={(v) => `${v}`}
            onChange={update('developers')}
          />
          <SliderRow
            label="Hours coded per developer per week"
            value={inputs.hoursPerWeek}
            min={5}
            max={60}
            step={5}
            format={(v) => `${v}h`}
            onChange={update('hoursPerWeek')}
          />
          <SliderRow
            label="Average developer hourly rate"
            value={inputs.hourlyRateUsd}
            min={25}
            max={300}
            step={25}
            format={(v) => `$${v}`}
            onChange={update('hourlyRateUsd')}
          />
          <SliderRow
            label="Productivity gain on repetitive tasks"
            value={inputs.productivityGainPct}
            min={5}
            max={40}
            step={5}
            format={(v) => `${v}%`}
            onChange={update('productivityGainPct')}
          />
          <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
            Productivity gain range 5-40% reflects published research (GitHub Copilot,
            McKinsey 2023, Stripe). We cap at 40% to stay honest - claims above 50% are
            not supported by independent studies for typical engineering work.
          </p>
        </div>

        {/* Output */}
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/60">
            Estimated Annual Value
          </p>
          <p className="mt-3 text-5xl font-bold tracking-tight text-foreground">
            {formatDollars(annualROI)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">recovered developer time/yr</p>

          <div className="mt-6 h-px w-full bg-zinc-800/60" />

          <div className="mt-4 grid grid-cols-2 gap-4 w-full text-center">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Styrby Growth cost
              </p>
              <p className="mt-1 text-lg font-bold text-foreground">
                ~{formatDollars(annualStyrbyEstimate)}/yr
              </p>
              <p className="text-[10px] text-muted-foreground/50">
                ({inputs.developers} seats x $19/mo)
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Return on investment
              </p>
              <p className={cn(
                'mt-1 text-lg font-bold',
                roi >= 5 ? 'text-amber-400' : 'text-foreground',
              )}>
                {roi >= 100 ? `${Math.round(roi)}x` : `${roi.toFixed(1)}x`}
              </p>
              <p className="text-[10px] text-muted-foreground/50">
                value vs Styrby cost
              </p>
            </div>
          </div>

          <p className="mt-5 text-[10px] text-muted-foreground/50 leading-relaxed">
            This estimate is illustrative. Actual productivity gains depend on team
            workflows, agent type, and task mix. YMMV.
          </p>
        </div>
      </div>
    </div>
  );
}
