'use client';

/**
 * QR code component for device pairing.
 *
 * Generates a time-limited pairing token and displays it as a QR code.
 * Listens for successful pairing via Supabase Realtime and shows
 * success state when a new machine is registered.
 */

import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the PairingQR component.
 */
interface PairingQRProps {
  /** The user's ID for generating the pairing token */
  userId: string;
}

/**
 * Status of the pairing process.
 */
type PairingStatus = 'generating' | 'waiting' | 'success' | 'expired';

/**
 * Payload structure for the QR code.
 * This is what the mobile app will decode when scanning.
 */
interface PairingPayload {
  /** Version for future compatibility */
  version: number;
  /** User ID to associate the machine with */
  userId: string;
  /** One-time pairing token */
  token: string;
  /** ISO 8601 timestamp when the token expires */
  expiresAt: string;
  /** Supabase project URL for the mobile app to connect */
  supabaseUrl: string | undefined;
}

/* ──────────────────────────── Icons ──────────────────────────── */

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders a QR code for device pairing with countdown timer.
 *
 * WHY: QR codes expire after 5 minutes for security. The mobile app
 * must scan and complete pairing within this window. We use Supabase
 * Realtime to detect when a new machine is registered and show success.
 *
 * @param props - PairingQR configuration
 */
export function PairingQR({ userId }: PairingQRProps) {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<PairingStatus>('generating');
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [pairedDevice, setPairedDevice] = useState<string | null>(null);

  /**
   * Generates a new pairing token and QR code data.
   * Token is valid for 5 minutes.
   */
  const generatePairingData = useCallback(() => {
    // Generate a random pairing token using Web Crypto API
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Set expiry to 5 minutes from now
    const expiry = new Date(Date.now() + 5 * 60 * 1000);

    const payload: PairingPayload = {
      version: 1,
      userId,
      token,
      expiresAt: expiry.toISOString(),
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    };

    // Encode as base64 for compact QR code
    const encoded = btoa(JSON.stringify(payload));
    const qrUrl = `styrby://pair?data=${encoded}`;

    setQrData(qrUrl);
    setTimeLeft(300); // 5 minutes in seconds
    setStatus('waiting');
    setPairedDevice(null);
  }, [userId]);

  // Generate on mount
  // Note: generatePairingData sets initial state and must run once on mount.
  // This is intentional initialization, not a cascading render issue.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional one-time initialization on mount
    generatePairingData();
  }, [generatePairingData]);

  // Countdown timer
  useEffect(() => {
    if (status !== 'waiting') return;

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setStatus('expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [status]);

  // Listen for pairing success via Supabase Realtime
  useEffect(() => {
    if (status !== 'waiting') return;

    const supabase = createClient();
    let channel: RealtimeChannel | null = null;

    /**
     * Sets up a Realtime subscription to listen for new machines.
     */
    const setupSubscription = () => {
      channel = supabase
        .channel(`pairing:${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'machines',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            // A new machine was registered - pairing successful
            setStatus('success');
            const newMachine = payload.new as { name?: string };
            setPairedDevice(newMachine.name || 'New device');
          }
        )
        .subscribe();
    };

    setupSubscription();

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [userId, status]);

  /**
   * Formats seconds as M:SS countdown display.
   */
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  /**
   * Handles regenerating the QR code after expiry.
   */
  const handleRegenerate = () => {
    setStatus('generating');
    // Small delay for visual feedback
    setTimeout(generatePairingData, 100);
  };

  return (
    <div className="flex flex-col items-center">
      {/* Generating state */}
      {status === 'generating' && (
        <div className="h-64 w-64 rounded-lg bg-zinc-800 animate-pulse flex items-center justify-center">
          <div className="h-8 w-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Waiting state - show QR code */}
      {status === 'waiting' && qrData && (
        <>
          <div className="rounded-lg bg-white p-4 shadow-lg">
            <QRCodeSVG
              value={qrData}
              size={240}
              level="M"
              includeMargin={false}
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>

          {/* Countdown timer */}
          <div className="mt-4 flex items-center gap-2 text-zinc-400">
            <ClockIcon className="h-4 w-4" />
            <span>
              Expires in <span className="font-mono">{formatTime(timeLeft)}</span>
            </span>
          </div>

          {/* Progress bar */}
          <div className="mt-2 w-64 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all duration-1000"
              style={{ width: `${(timeLeft / 300) * 100}%` }}
            />
          </div>
        </>
      )}

      {/* Success state */}
      {status === 'success' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500">
            <CheckIcon className="h-10 w-10 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-zinc-100">
              Successfully Paired!
            </h3>
            <p className="text-zinc-400 mt-1">
              {pairedDevice || 'New device'} is now connected to your account
            </p>
          </div>
          <button
            onClick={handleRegenerate}
            className="mt-4 flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700 transition-colors"
          >
            <RefreshIcon className="h-4 w-4" />
            Pair Another Device
          </button>
        </div>
      )}

      {/* Expired state */}
      {status === 'expired' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-zinc-800">
            <ClockIcon className="h-10 w-10 text-zinc-500" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-zinc-100">
              QR Code Expired
            </h3>
            <p className="text-zinc-400 mt-1">
              The pairing code has expired for security reasons
            </p>
          </div>
          <button
            onClick={handleRegenerate}
            className="flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
          >
            <RefreshIcon className="h-4 w-4" />
            Generate New Code
          </button>
        </div>
      )}
    </div>
  );
}
