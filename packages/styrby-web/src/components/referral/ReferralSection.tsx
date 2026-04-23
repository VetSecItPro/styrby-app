/**
 * ReferralSection
 *
 * "Invite a friend" section for the web settings page.
 * Renders the referral code, copyable link, and reward explanation.
 *
 * WHY server-fetched referral code via prop (not client-side hook):
 * The settings page is a Server Component that already fetches the profile.
 * Passing referral_code as a prop avoids a redundant client fetch and keeps
 * the component pure (no auth dependencies, easy to test).
 *
 * @module components/referral/ReferralSection
 */

'use client';

import { useState, useCallback } from 'react';
import { Gift, Copy, Users, Check } from 'lucide-react';

export interface ReferralSectionProps {
  /** User's referral code from profiles.referral_code */
  referralCode: string | null;
  /** User display name for share copy personalization */
  displayName?: string;
}

/**
 * Referral program UI for the web settings page.
 * Shows copyable link, share button, and reward description.
 *
 * @param referralCode - User's unique referral code (may be null if not yet generated)
 * @param displayName - User display name for personalized share copy
 */
export function ReferralSection({ referralCode, displayName }: ReferralSectionProps) {
  const [copied, setCopied] = useState(false);

  const referralUrl = referralCode
    ? `https://www.styrbyapp.com/r/${referralCode}`
    : null;

  /**
   * Copy the referral link to clipboard using the Clipboard API.
   * WHY navigator.clipboard: more reliable than document.execCommand in 2026.
   * Falls back gracefully with an alert if the API is unavailable.
   */
  const handleCopy = useCallback(async () => {
    if (!referralUrl) return;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS in dev)
      prompt('Copy your referral link:', referralUrl);
    }
  }, [referralUrl]);

  /**
   * Open the native Web Share API if available (mobile browsers).
   * Falls back to copy on desktop.
   */
  const handleShare = useCallback(async () => {
    if (!referralUrl) return;

    const firstName = displayName?.split(' ')[0] ?? '';
    const shareData = {
      title: 'Join Styrby',
      text: `${firstName ? `${firstName} invited you to ` : ''}Try Styrby - control your AI coding agents from your phone. Get 1 free month when you upgrade.`,
      url: referralUrl,
    };

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User cancelled or share failed - fall through to copy
        await handleCopy();
      }
    } else {
      await handleCopy();
    }
  }, [referralUrl, displayName, handleCopy]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/10">
          <Gift className="h-4 w-4 text-purple-400" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Invite a friend</h2>
          <p className="text-xs text-zinc-400">
            When they upgrade to Power, you both get 1 free month.
          </p>
        </div>
      </div>

      {referralCode ? (
        <>
          {/* Referral link box */}
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5">
            <span className="flex-1 truncate font-mono text-xs text-zinc-400">
              {referralUrl}
            </span>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 rounded p-1 text-zinc-400 hover:text-zinc-100 transition-colors"
              aria-label="Copy referral link"
              title="Copy link"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {copied && (
            <p
              role="status"
              aria-live="polite"
              className="mb-3 text-xs text-green-400"
            >
              Link copied to clipboard
            </p>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy link
            </button>
            <button
              onClick={handleShare}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-400 transition-colors"
            >
              <Users className="h-3.5 w-3.5" />
              Share
            </button>
          </div>

          {/* Code display */}
          <div className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-4">
            <span className="text-xs text-zinc-500">Your code:</span>
            <span className="font-mono text-xs font-semibold text-purple-400">
              {referralCode}
            </span>
          </div>
        </>
      ) : (
        <p className="text-sm italic text-zinc-500">
          Your invite link is being generated...
        </p>
      )}

      {/* Reward explanation */}
      <div className="mt-4 rounded-lg bg-zinc-800/50 p-3">
        <p className="text-xs text-zinc-400 leading-relaxed">
          <strong className="text-zinc-300">How it works:</strong> Share your link. When
          your friend signs up and upgrades to Power or Team, you each receive 1 free month
          applied to your next billing cycle. No limit on referrals.
        </p>
      </div>
    </div>
  );
}
