/**
 * Blog article content registry.
 *
 * Maps article slugs to their React component content. Each article is
 * a default export from its own file to enable code-splitting at the
 * route level.
 */
import type { ComponentType } from "react";

import ElevenAgentsCheckpointsVoiceOtel from "./eleven-agents-checkpoints-voice-otel";
import StyrbyVsClaudeCodeChannels from "./styrby-vs-claude-code-channels";
import StyrbyVsDispatch from "./styrby-vs-dispatch";
import AiCodingAgentCostComparison2026 from "./ai-coding-agent-cost-comparison-2026";
import ClaudeCodePermissionsBuiltInVsRemote from "./claude-code-permissions-built-in-vs-remote";
import TrackingAiCostsSpreadsheetsVsAutomation from "./tracking-ai-costs-spreadsheets-vs-automation";
import E2eEncryptionAiCodingSessions from "./e2e-encryption-ai-coding-sessions";
import BudgetAlertsPreventRunawaySpend from "./budget-alerts-prevent-runaway-spend";
import RemotePermissionApproval from "./remote-permission-approval";
import SessionReplayReviewAgentWork from "./session-replay-review-agent-work";
import OfflineFirstArchitecture from "./offline-first-architecture";
import ErrorAttributionAgentBuildNetwork from "./error-attribution-agent-build-network";
import MultiAgentDashboardOneView from "./multi-agent-dashboard-one-view";
import ManagingAiCostsDevTeam from "./managing-ai-costs-dev-team";
import OvernightAgentSessionsRemoteMonitoring from "./overnight-agent-sessions-remote-monitoring";
import TrackingAiSpendPerProject from "./tracking-ai-spend-per-project";
import QuietHoursNotificationManagement from "./quiet-hours-notification-management";
import FiveTerminalsToOneDashboard from "./five-terminals-to-one-dashboard";
import UnderstandingAiTokenCosts from "./understanding-ai-token-costs";
import TweetNaclInProduction from "./tweetnacl-in-production";
import OfflineFirstReactNativeExpoSqlite from "./offline-first-react-native-expo-sqlite";
import RateLimitingSaasApis from "./rate-limiting-saas-apis";
import WhySupabaseOverFirebase from "./why-supabase-over-firebase";
import DesigningBudgetAlertSystems from "./designing-budget-alert-systems";
import TrueCostAiCodingAssistants2026 from "./true-cost-ai-coding-assistants-2026";
import AiAgentSecurityWhatToWorryAbout from "./ai-agent-security-what-to-worry-about";
import WhyWeBuiltStyrby from "./why-we-built-styrby";
import VeteranOwnedBuildingSoftwareAfterService from "./veteran-owned-building-software-after-service";
import SecurityModelOpenReview from "./security-model-open-review";
import StyrbyRoadmap2026 from "./styrby-roadmap-2026";
import FiveAgentsOneWorkflow from "./five-agents-one-workflow";

/**
 * Map of article slugs to their content components.
 *
 * Used by the dynamic [slug] route to render the correct article.
 */
export const blogContent: Record<string, ComponentType> = {
  "eleven-agents-checkpoints-voice-otel": ElevenAgentsCheckpointsVoiceOtel,
  "styrby-vs-claude-code-channels": StyrbyVsClaudeCodeChannels,
  "styrby-vs-dispatch": StyrbyVsDispatch,
  "ai-coding-agent-cost-comparison-2026": AiCodingAgentCostComparison2026,
  "claude-code-permissions-built-in-vs-remote": ClaudeCodePermissionsBuiltInVsRemote,
  "tracking-ai-costs-spreadsheets-vs-automation": TrackingAiCostsSpreadsheetsVsAutomation,
  "e2e-encryption-ai-coding-sessions": E2eEncryptionAiCodingSessions,
  "budget-alerts-prevent-runaway-spend": BudgetAlertsPreventRunawaySpend,
  "remote-permission-approval": RemotePermissionApproval,
  "session-replay-review-agent-work": SessionReplayReviewAgentWork,
  "offline-first-architecture": OfflineFirstArchitecture,
  "error-attribution-agent-build-network": ErrorAttributionAgentBuildNetwork,
  "multi-agent-dashboard-one-view": MultiAgentDashboardOneView,
  "managing-ai-costs-dev-team": ManagingAiCostsDevTeam,
  "overnight-agent-sessions-remote-monitoring": OvernightAgentSessionsRemoteMonitoring,
  "tracking-ai-spend-per-project": TrackingAiSpendPerProject,
  "quiet-hours-notification-management": QuietHoursNotificationManagement,
  "five-terminals-to-one-dashboard": FiveTerminalsToOneDashboard,
  "understanding-ai-token-costs": UnderstandingAiTokenCosts,
  "tweetnacl-in-production": TweetNaclInProduction,
  "offline-first-react-native-expo-sqlite": OfflineFirstReactNativeExpoSqlite,
  "rate-limiting-saas-apis": RateLimitingSaasApis,
  "why-supabase-over-firebase": WhySupabaseOverFirebase,
  "designing-budget-alert-systems": DesigningBudgetAlertSystems,
  "true-cost-ai-coding-assistants-2026": TrueCostAiCodingAssistants2026,
  "ai-agent-security-what-to-worry-about": AiAgentSecurityWhatToWorryAbout,
  "why-we-built-styrby": WhyWeBuiltStyrby,
  "veteran-owned-building-software-after-service": VeteranOwnedBuildingSoftwareAfterService,
  "security-model-open-review": SecurityModelOpenReview,
  "styrby-roadmap-2026": StyrbyRoadmap2026,
  "five-agents-one-workflow": FiveAgentsOneWorkflow,
};
