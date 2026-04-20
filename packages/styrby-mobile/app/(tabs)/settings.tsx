/**
 * Settings Tab Entry Point
 *
 * WHY this file exists: expo-router requires a file at the tab path for the
 * Settings tab icon in the bottom bar to work. This redirect preserves the
 * tab icon while delegating all rendering to the settings route group at
 * app/settings/ (the hub + sub-screens).
 *
 * The 2,720-LOC monolith that previously lived here has been decomposed into:
 *   app/settings/index.tsx          — Hub orchestrator
 *   app/settings/account.tsx        — Profile, email, password, billing, delete
 *   app/settings/notifications.tsx  — Push, email, quiet hours, smart notifs
 *   app/settings/appearance.tsx     — Theme selector, haptics
 *   app/settings/voice.tsx          — Voice input toggle, mode, endpoint
 *   app/settings/agents.tsx         — Agent list, auto-approve
 *   app/settings/metrics.tsx        — OTEL metrics export (Power tier)
 *   app/settings/support.tsx        — Feedback, help, privacy, terms
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Step S12
 */

import { Redirect } from 'expo-router';

export default function SettingsTabEntryPoint() {
  return <Redirect href="/settings" />;
}
