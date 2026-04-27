'use client';

import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { comparisonCategories } from './pricing-data';

/**
 * Renders a single cell value in the feature comparison table.
 *
 * @param value - `true` = included, `false` = not included, string = text label.
 */
function CellValue({ value }: { value: boolean | string }) {
  if (value === true) return <Check className="mx-auto h-4 w-4 text-amber-500" />;
  if (value === false) return <Minus className="mx-auto h-4 w-4 text-zinc-700" />;
  return <span className="text-sm text-foreground">{value}</span>;
}

/**
 * Renders a category header row and its feature rows.
 *
 * Extracted to avoid React Fragment key warnings and to keep the main table
 * render loop clean.
 *
 * @param category - One category entry from `comparisonCategories`.
 */
function ComparisonCategory({
  category,
}: {
  category: (typeof comparisonCategories)[number];
}) {
  return (
    <>
      <tr>
        <td
          colSpan={3}
          className="pt-8 pb-3 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-500/60"
        >
          {category.name}
        </td>
      </tr>
      {category.features.map((feature, idx) => (
        <tr
          key={feature.name}
          className={cn(
            'border-b border-zinc-800/30',
            idx === category.features.length - 1 && 'border-zinc-800/60',
          )}
        >
          <td className="py-3.5 text-sm text-zinc-300">{feature.name}</td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.pro} />
          </td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.growth} />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * Full feature comparison table for the two paid tiers (Pro and Growth).
 *
 * Phase 6: collapses the previous five-tier grid (Free / Solo / Team /
 * Business / Enterprise) into the canonical Pro vs. Growth comparison.
 * Horizontally scrollable on mobile to prevent layout overflow.
 *
 * @returns The full comparison table.
 */
export function ComparisonTable() {
  return (
    <div className="mt-12 overflow-x-auto">
      <table className="w-full min-w-[480px]">
        <thead>
          <tr className="border-b border-zinc-800/60">
            <th className="pb-4 text-left text-sm font-medium text-muted-foreground w-[50%]">
              Feature
            </th>
            <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[25%]">
              Pro
            </th>
            <th className="pb-4 text-center text-sm font-semibold w-[25%]">
              <span className="text-amber-400">Growth</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {comparisonCategories.map((category) => (
            <ComparisonCategory key={category.name} category={category} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
