/**
 * /legal/subprocessors — Subprocessor Transparency Page
 *
 * Purpose: Public page listing all third-party sub-processors that handle
 * personal data on behalf of Styrby (Steel Motion LLC) and, transitively,
 * on behalf of B2B customers acting as GDPR data controllers.
 *
 * WHY this page exists:
 *   GDPR Article 28 requires that data processors inform controllers of
 *   intended sub-processor changes with prior notice. Publishing this list
 *   publicly fulfills our DPA's general-authorization clause and reduces
 *   friction for enterprise procurement and legal review.
 *
 *   A public page also signals transparency to prospects — it is a
 *   competitive differentiator for acquisition-stage due diligence.
 *
 * Architecture:
 *   Server Component — no client-side JS needed. Data is static (typed
 *   config in lib/legal/subprocessors.ts). Page is fully cacheable by Vercel.
 *
 * Audit citations:
 *   GDPR Art. 28(1) — Sub-processor requirements
 *   GDPR Art. 28(2) — Prior written authorization mechanism
 *   GDPR Art. 30    — Records of processing activities (sub-processor registry)
 *   SOC2 CC1.3      — Third-party oversight
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { SUBPROCESSORS, SUBPROCESSORS_LAST_UPDATED } from '@/lib/legal/subprocessors';

export const metadata: Metadata = {
  title: 'Subprocessors | Styrby',
  description:
    'List of third-party subprocessors used by Styrby (Steel Motion LLC) to deliver the service. Maintained for GDPR Article 28 transparency and enterprise due diligence.',
  openGraph: {
    title: 'Styrby Subprocessors',
    description:
      'All third-party sub-processors engaged by Styrby under GDPR Art. 28. Includes location, DPF certification status, and categories of data shared.',
    type: 'website',
    url: 'https://styrbyapp.com/legal/subprocessors',
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Renders a DPF certification badge.
 *
 * @param certified - Whether the sub-processor holds EU-US DPF certification.
 * @returns A styled inline badge element.
 */
function DpfBadge({ certified }: { certified: boolean }) {
  if (certified) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-900/40 px-2.5 py-0.5 text-xs font-medium text-green-400 ring-1 ring-inset ring-green-500/30">
        Yes
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400 ring-1 ring-inset ring-zinc-700">
      No
    </span>
  );
}

/**
 * Subprocessors page — Server Component.
 *
 * Renders the canonical sub-processor table sourced from
 * lib/legal/subprocessors.ts. No auth required (public page).
 */
export default function SubprocessorsPage() {
  return (
    <div className="min-h-[100dvh] bg-zinc-950">
      {/* Navigation header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-lg font-bold text-white">S</span>
              </div>
              <span className="font-semibold text-zinc-100">Styrby</span>
            </Link>
            <Link
              href="/"
              className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Page header */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-zinc-100">Subprocessors</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Last updated: {SUBPROCESSORS_LAST_UPDATED}
          </p>
          <p className="mt-4 text-zinc-300 max-w-3xl">
            Steel Motion LLC (&quot;Styrby&quot;, &quot;we&quot;) engages the third-party
            sub-processors listed below to deliver our service. Under{' '}
            <strong className="text-zinc-200">GDPR Article 28</strong>, we maintain
            written contracts with each sub-processor requiring them to implement
            appropriate technical and organizational measures to protect personal data.
          </p>
          <p className="mt-3 text-zinc-300 max-w-3xl">
            Our{' '}
            <Link href="/dpa" className="text-orange-400 hover:text-orange-300 transition-colors">
              Data Processing Agreement (DPA)
            </Link>{' '}
            grants customers general authorization for these sub-processors and
            includes our commitment to notify you of intended additions or changes.
          </p>
        </div>

        {/* Subprocessor table */}
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table
            className="min-w-full divide-y divide-zinc-800"
            aria-label="Styrby subprocessors"
          >
            <thead className="bg-zinc-900">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Name
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Purpose
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Location
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  DPF Certified
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Categories
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Data Shared
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950">
              {SUBPROCESSORS.map((sp) => (
                <tr key={sp.name} className="hover:bg-zinc-900/50 transition-colors">
                  {/* Name + link */}
                  <td className="px-4 py-4 align-top">
                    <a
                      href={sp.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-orange-400 hover:text-orange-300 transition-colors whitespace-nowrap"
                    >
                      {sp.name}
                    </a>
                  </td>

                  {/* Purpose */}
                  <td className="px-4 py-4 text-sm text-zinc-300 align-top max-w-xs">
                    {sp.purpose}
                  </td>

                  {/* Location */}
                  <td className="px-4 py-4 text-sm text-zinc-300 align-top whitespace-nowrap">
                    {sp.location}
                  </td>

                  {/* DPF badge */}
                  <td className="px-4 py-4 align-top">
                    <DpfBadge certified={sp.dpf_certified} />
                  </td>

                  {/* Categories */}
                  <td className="px-4 py-4 text-sm text-zinc-400 align-top">
                    {sp.categories.join(', ')}
                  </td>

                  {/* Data shared */}
                  <td className="px-4 py-4 text-sm text-zinc-400 align-top max-w-sm">
                    {sp.data_shared}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* DPF explanation */}
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 text-sm text-zinc-400">
          <strong className="text-zinc-300">About EU-US Data Privacy Framework (DPF):</strong>{' '}
          The DPF is a transfer mechanism approved by the European Commission in July 2023
          that allows personal data to flow from the EU/EEA to certified US organizations.
          For sub-processors without DPF certification, Styrby relies on Standard Contractual
          Clauses (SCCs) or on the fact that the processor is incorporated in the EU.
        </div>

        {/* Footer note */}
        <div className="mt-8 border-t border-zinc-800 pt-6 text-sm text-zinc-500">
          <p>
            This list is kept current. For questions about sub-processor changes, data
            processing activities, or to request notification of future updates, email{' '}
            <a
              href="mailto:support@styrby.dev"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              support@styrby.dev
            </a>
            .
          </p>
          <p className="mt-3">
            Related:{' '}
            <Link href="/dpa" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Data Processing Agreement
            </Link>
            {' | '}
            <Link href="/privacy" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Privacy Policy
            </Link>
            {' | '}
            <Link href="/legal/retention-proof" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Retention Proof
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
