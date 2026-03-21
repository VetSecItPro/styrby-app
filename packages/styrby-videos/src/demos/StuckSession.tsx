import { AbsoluteFill, useCurrentFrame } from 'remotion';

/**
 * Demo 4: Find the stuck session fast
 *
 * Scene flow:
 * 1. Dashboard with 4 sessions running
 * 2. One session stalls — status changes to error (red)
 * 3. Error attribution shows: "Build failure — TypeScript error in api/route.ts:42"
 * 4. User drills into session detail view
 *
 * Duration: 10s (300 frames @ 30fps)
 */
export const StuckSession: React.FC = () => {
  const frame = useCurrentFrame();

  // TODO: Implement session list with status transitions,
  // error attribution color coding (orange=styrby, red=agent,
  // blue=build, yellow=network), and detail drill-in animation.

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0b', fontFamily: 'Inter, sans-serif' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#71717a', fontSize: 24,
      }}>
        Stuck Session Demo — Scene {Math.floor(frame / 75) + 1}/4
      </div>
    </AbsoluteFill>
  );
};
