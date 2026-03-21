import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

/**
 * Demo 1: Approve from your phone
 *
 * Scene flow:
 * 1. Terminal showing Claude Code hitting a permission checkpoint
 * 2. Phone notification appears with risk badge
 * 3. User taps Approve
 * 4. Session resumes
 *
 * Duration: 10s (300 frames @ 30fps)
 */
export const PhoneApproval: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Scene timing (in frames)
  const terminalAppears = 0;
  const notificationAppears = 90;   // 3s
  const approvalTap = 180;          // 6s
  const sessionResumes = 240;       // 8s

  const notificationOpacity = interpolate(frame, [notificationAppears, notificationAppears + 15], [0, 1], { extrapolateRight: 'clamp' });
  const notificationScale = spring({ frame: frame - notificationAppears, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0b', fontFamily: 'Inter, sans-serif' }}>
      {/* Terminal panel (left 60%) */}
      <div style={{
        position: 'absolute', left: 60, top: 60, width: '55%', height: 'calc(100% - 120px)',
        backgroundColor: '#111113', borderRadius: 16, border: '1px solid #27272a',
        padding: 32, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ef4444' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#f59e0b' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#22c55e' }} />
          <span style={{ marginLeft: 12, color: '#71717a', fontSize: 13 }}>Claude Code — project/backend</span>
        </div>

        <pre style={{ color: '#a1a1aa', fontSize: 15, lineHeight: 1.8, fontFamily: 'JetBrains Mono, monospace' }}>
          {frame >= terminalAppears && '$ claude "refactor auth middleware"\n'}
          {frame >= 30 && '⠋ Analyzing auth/middleware.ts...\n'}
          {frame >= 60 && '⠋ Found 3 files to modify\n'}
          {frame >= notificationAppears && (
            <span style={{ color: '#f59e0b' }}>
              {'⚠ Permission required: bash rm -rf dist/\n'}
              {'  Risk level: HIGH\n'}
              {'  Waiting for approval...\n'}
            </span>
          )}
          {frame >= sessionResumes && (
            <span style={{ color: '#22c55e' }}>
              {'✓ Approved — continuing...\n'}
              {'  Deleted dist/\n'}
              {'  Rebuilding...\n'}
            </span>
          )}
        </pre>
      </div>

      {/* Phone mockup (right 35%) */}
      <div style={{
        position: 'absolute', right: 80, top: '50%', transform: 'translateY(-50%)',
        width: 340, height: 680, backgroundColor: '#111113', borderRadius: 40,
        border: '2px solid #27272a', overflow: 'hidden',
        opacity: notificationOpacity,
        scale: `${Math.min(notificationScale, 1)}`,
      }}>
        {/* Phone status bar */}
        <div style={{ padding: '12px 24px', display: 'flex', justifyContent: 'space-between', color: '#71717a', fontSize: 12 }}>
          <span>9:41</span>
          <span>●●●●</span>
        </div>

        {/* Notification card */}
        <div style={{
          margin: '20px 16px', padding: 20, backgroundColor: '#1c1c1e',
          borderRadius: 16, border: '1px solid #f59e0b40',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#f59e0b' }} />
            <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>HIGH RISK</span>
          </div>
          <p style={{ color: '#fafafa', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            Claude Code wants to run:
          </p>
          <code style={{ color: '#f59e0b', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>
            rm -rf dist/
          </code>
          <p style={{ color: '#71717a', fontSize: 12, marginTop: 12 }}>
            project/backend • 2 seconds ago
          </p>

          {/* Approve / Deny buttons */}
          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            <button style={{
              flex: 1, padding: '12px 0', borderRadius: 12,
              backgroundColor: frame >= approvalTap ? '#16a34a' : '#22c55e',
              color: '#000', fontWeight: 700, fontSize: 15, border: 'none',
              transform: frame >= approvalTap ? 'scale(0.95)' : 'scale(1)',
            }}>
              Approve
            </button>
            <button style={{
              flex: 1, padding: '12px 0', borderRadius: 12,
              backgroundColor: '#27272a', color: '#a1a1aa', fontWeight: 600,
              fontSize: 15, border: 'none',
            }}>
              Deny
            </button>
          </div>
        </div>
      </div>

      {/* Title */}
      <div style={{
        position: 'absolute', bottom: 40, left: 0, right: 0, textAlign: 'center',
        opacity: interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' }),
      }}>
        <p style={{ color: '#f59e0b', fontSize: 16, fontWeight: 600, letterSpacing: 1 }}>STYRBY</p>
        <p style={{ color: '#71717a', fontSize: 13, marginTop: 4 }}>Approve agent actions from your phone</p>
      </div>
    </AbsoluteFill>
  );
};
