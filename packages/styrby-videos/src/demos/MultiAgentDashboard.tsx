import { AbsoluteFill, useCurrentFrame } from 'remotion';

/**
 * Demo 3: One dashboard, multiple agents
 *
 * Scene flow:
 * 1. Dashboard with all 5 agent cards (Claude, Codex, Gemini, OpenCode, Aider)
 * 2. Statuses change in real time — active/idle/error
 * 3. Cost counters tick up on active agents
 * 4. Pull back to show unified view
 *
 * Duration: 10s (300 frames @ 30fps)
 */
export const MultiAgentDashboard: React.FC = () => {
  const frame = useCurrentFrame();

  // TODO: Implement 5 agent status cards with live heartbeat indicators,
  // color-coded borders (orange=claude, green=codex, blue=gemini,
  // purple=opencode, pink=aider), and real-time cost tickers.

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0b', fontFamily: 'Inter, sans-serif' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#71717a', fontSize: 24,
      }}>
        Multi-Agent Dashboard Demo — Scene {Math.floor(frame / 75) + 1}/4
      </div>
    </AbsoluteFill>
  );
};
