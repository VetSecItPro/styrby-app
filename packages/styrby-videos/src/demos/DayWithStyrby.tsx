import { AbsoluteFill, useCurrentFrame } from 'remotion';

/**
 * Demo 5: A day with Styrby
 *
 * Scene flow:
 * 1. Morning: Dashboard check — 2 agents active, $3.20 spent overnight
 * 2. Midday: Permission approval from phone while at lunch
 * 3. Afternoon: Budget alert — $45 threshold hit, agent auto-paused
 * 4. Evening: Session history review, bookmark important session
 *
 * Duration: 15s (450 frames @ 30fps)
 */
export const DayWithStyrby: React.FC = () => {
  const frame = useCurrentFrame();

  // Scene boundaries
  const scenes = [
    { start: 0, label: 'Morning — Dashboard Check' },
    { start: 112, label: 'Midday — Phone Approval' },
    { start: 225, label: 'Afternoon — Budget Alert' },
    { start: 337, label: 'Evening — Session Review' },
  ];

  const currentScene = scenes.reduce((acc, s) => (frame >= s.start ? s : acc), scenes[0]);

  // TODO: Implement 4-act day narrative with time-of-day
  // indicators, transitioning between dashboard views.
  // Use split-screen (desktop + phone) for the midday scene.

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0b', fontFamily: 'Inter, sans-serif' }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100%', gap: 16,
      }}>
        <p style={{ color: '#f59e0b', fontSize: 18, fontWeight: 600 }}>{currentScene.label}</p>
        <p style={{ color: '#71717a', fontSize: 24 }}>
          Day With Styrby — Scene {scenes.indexOf(currentScene) + 1}/4
        </p>
      </div>
    </AbsoluteFill>
  );
};
