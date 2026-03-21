import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

/**
 * Demo 2: Where did the money go?
 *
 * Scene flow:
 * 1. Dashboard showing multiple agents running across projects
 * 2. Spend bars animate up per agent
 * 3. One project spikes — bar turns red
 * 4. Budget alert triggers with threshold indicator
 *
 * Duration: 10s (300 frames @ 30fps)
 */
export const CostTracking: React.FC = () => {
  const frame = useCurrentFrame();

  // TODO: Implement animated cost bars, spending trend chart,
  // and budget alert notification. Use the same amber/zinc color
  // palette as the web dashboard.

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0b', fontFamily: 'Inter, sans-serif' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#71717a', fontSize: 24,
      }}>
        Cost Tracking Demo — Scene {Math.floor(frame / 75) + 1}/4
      </div>
    </AbsoluteFill>
  );
};
