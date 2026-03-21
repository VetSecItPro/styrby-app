import { Composition } from 'remotion';
import { PhoneApproval } from './demos/PhoneApproval';
import { CostTracking } from './demos/CostTracking';
import { MultiAgentDashboard } from './demos/MultiAgentDashboard';
import { StuckSession } from './demos/StuckSession';
import { DayWithStyrby } from './demos/DayWithStyrby';

/**
 * Remotion Root — registers all demo video compositions.
 *
 * Each composition maps to one of Atlas's 5 recommended demo videos.
 * Render individually with: pnpm render:<name>
 * Render all with: pnpm render:all
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PhoneApproval"
        component={PhoneApproval}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />

      <Composition
        id="CostTracking"
        component={CostTracking}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />

      <Composition
        id="MultiAgentDashboard"
        component={MultiAgentDashboard}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />

      <Composition
        id="StuckSession"
        component={StuckSession}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />

      <Composition
        id="DayWithStyrby"
        component={DayWithStyrby}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
    </>
  );
};
