'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Right-pointing chevron used at the trailing edge of every link row.
 * Inlined here so link-row consumers don't each re-declare the same SVG.
 */
function ChevronRight() {
  return (
    <svg
      className="h-5 w-5 text-zinc-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

/** Props for the SettingsLinkRow primitive. */
export interface SettingsLinkRowProps {
  /** Destination href (app router). */
  href: string;
  /** Main label text (e.g. "API Keys"). */
  label: string;
  /** Optional secondary description line. */
  description?: string;
  /** Optional leading icon element (e.g. colored badge with SVG). */
  icon?: ReactNode;
  /** Optional trailing badge slot (e.g. the "Power" tier chip). */
  badge?: ReactNode;
  /** aria-label override — defaults to the label prop. */
  ariaLabel?: string;
}

/**
 * Reusable chrome for "row that links to a sub-page" in the settings surface.
 *
 * WHY: Integrations, Passkeys, Support tickets, and the future SSO section all
 * render the same structure: optional icon, label + description, optional
 * badge, chevron. Before this extraction each section duplicated the Link +
 * SVG markup, which was ~40 lines of repetition per row and a recipe for
 * drift. Row-level primitive keeps each section map-driven.
 */
export function SettingsLinkRow({
  href,
  label,
  description,
  icon,
  badge,
  ariaLabel,
}: SettingsLinkRowProps) {
  return (
    <Link
      href={href}
      className="px-4 py-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
      aria-label={ariaLabel ?? label}
    >
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-100">{label}</p>
            {badge}
          </div>
          {description && (
            <p className="text-sm text-zinc-500">{description}</p>
          )}
        </div>
      </div>
      <ChevronRight />
    </Link>
  );
}
