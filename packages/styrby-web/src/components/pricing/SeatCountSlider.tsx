'use client';

import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

interface SeatCountSliderProps {
  /** Minimum allowed seat count. */
  min: number;
  /** Maximum allowed seat count. */
  max: number;
  /** Current seat count (controlled). */
  value: number;
  /** Called when the user changes the slider value. */
  onChange: (count: number) => void;
  /** Accessible label for the slider. */
  label: string;
  /** Optional CSS class override. */
  className?: string;
}

/**
 * Seat-count slider for team/business pricing cards.
 *
 * Wraps the Radix UI Slider primitive with Styrby styling and accessibility
 * attributes. The slider updates price displays live as the user drags.
 *
 * WHY controlled (not uncontrolled): parent state drives both the slider
 * position and the live price display simultaneously. Uncontrolled would
 * require a ref + effect to sync, which is more error-prone.
 *
 * WHY step=1: seats are whole numbers. Fractional seats have no business meaning.
 *
 * @param min - Minimum seat count (e.g. 3 for team, 10 for business).
 * @param max - Maximum seat count (typically 100).
 * @param value - Current seat count.
 * @param onChange - Called with the new seat count on every change.
 * @param label - Accessible label (screen reader).
 * @param className - Optional class overrides.
 */
export function SeatCountSlider({
  min,
  max,
  value,
  onChange,
  label,
  className,
}: SeatCountSliderProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {/* Label row: label on left, seat count on right */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-[0.1em]">
          {label}
        </label>
        <span className="text-sm font-semibold text-foreground tabular-nums">
          {value} seat{value !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Radix UI slider with amber accent */}
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={([newValue]) => onChange(newValue)}
        aria-label={`${label} - ${value} seats`}
        className={cn(
          '[&_.bg-primary]:bg-amber-500',
          '[&_.border-primary]:border-amber-500',
          '[&_.ring-ring]:ring-amber-500/50',
        )}
      />

      {/* Min/max hint */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/50">
        <span>{min} seats</span>
        <span>{max} seats</span>
      </div>
    </div>
  );
}
