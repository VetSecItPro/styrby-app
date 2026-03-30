'use client';

/**
 * Lazy-loaded wrapper for PairingQR.
 *
 * WHY dynamic import: `qrcode.react` adds ~35 kB gzipped to the bundle.
 * The device pairing page is a rare flow (users visit it once or twice when
 * setting up machines). Deferring the QR library load avoids penalising every
 * page in the app with a heavier shared chunk.
 *
 * WHY ssr: false: `qrcode.react` relies on browser canvas APIs for SVG
 * measurement. Rendering on the server would cause hydration mismatches.
 * The skeleton is shown until the client-side bundle arrives.
 */

import dynamic from 'next/dynamic';

/**
 * Skeleton shown while the qrcode.react bundle is loading.
 * Matches the QR card layout in PairingQR to prevent layout shift.
 */
function PairingQRSkeleton() {
  return (
    <div className="flex flex-col items-center animate-pulse">
      <div className="h-64 w-64 rounded-lg bg-zinc-800" />
      <div className="mt-4 flex items-center gap-2">
        <div className="h-4 w-4 rounded-full bg-zinc-800" />
        <div className="h-4 w-32 rounded bg-zinc-800" />
      </div>
    </div>
  );
}

/**
 * Dynamically imported PairingQR — qrcode.react bundle is only fetched when
 * this component renders (i.e. the user navigates to the pairing page).
 */
export const PairingQRDynamic = dynamic(
  () => import('./pairing-qr').then((mod) => ({ default: mod.PairingQR })),
  {
    loading: () => <PairingQRSkeleton />,
    ssr: false,
  }
);
