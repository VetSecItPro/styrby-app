'use client';

/**
 * Lazy-loaded wrapper for CommandPalette.
 *
 * WHY dynamic import: CommandPalette imports `cmdk` (~45 kB gzipped), which
 * is only needed when the user presses Cmd+K. Loading it eagerly penalises
 * every dashboard page load even though most users never open the palette.
 * Deferring the import moves cmdk out of the first-load shared chunk and into
 * an async chunk that is fetched only when CommandPalette renders.
 *
 * WHY ssr: false: CommandPalette uses keyboard event listeners (useEffect)
 * and dialog state (useState). There is no meaningful server-side render to
 * produce — the dialog starts closed and only opens on client interaction.
 * SSR: false avoids a hydration pass for a component that is always invisible
 * on first paint.
 *
 * WHY null loading fallback: CommandPalette renders nothing visible until the
 * user opens it (Cmd+K). A skeleton would flash and disappear immediately
 * before the user has even typed. null is the correct loading state here.
 *
 * @module components/dashboard/command-palette-dynamic
 */

import dynamic from 'next/dynamic';

/**
 * Dynamically imported CommandPalette — cmdk bundle is only fetched when this
 * component mounts (i.e. the user has navigated into the dashboard).
 */
export const CommandPaletteDynamic = dynamic(
  () =>
    import('./command-palette').then((mod) => ({ default: mod.CommandPalette })),
  {
    loading: () => null,
    ssr: false,
  }
);
