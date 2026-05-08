# Cloud Tasks: Mobile Real-Device Walkthrough

**Owner:** Operator (real device required)
**Engineering status:** Complete (PR-1 #314, PR-2 #315, PR-3 #316 — task #97 closed end-to-end on 2026-05-08)
**Last verified:** Pending (this runbook is the verification)

---

## Purpose

Confirm the Power-tier "Cloud Monitoring" + "Code Review From Mobile" features
work end-to-end on a real iPhone and a real Android phone. Engineering side is
complete across three PRs; this runbook is the empirical
"does it actually work for a paying user" check.

Pipeline being verified:

```
Mobile app cold-launch as Power user
    ↓ Dashboard shows "CLOUD" section card
    ↓ tap card → /cloud-tasks
    ↓ ─ live task list rendered (or empty state) ─

Operator taps "+" FAB
    ↓ CloudTaskSubmitSheet opens
    ↓ pick agent + link recent session + type prompt
    ↓ tap Submit
    ↓ ─ INSERT into cloud_tasks (status='queued') ─

Realtime subscription delivers the new row
    ↓ task appears at top of list within 1-2 seconds
    ↓ ─ visible without manual refresh ─

CLI relay picks up queued task and runs it
    ↓ status transitions: queued → running → completed
    ↓ ─ each transition delivered via Realtime; UI updates live ─

Migration 092 trigger fires on terminal transition
    ↓ pg_net call → send-push-notification edge function
    ↓ Expo Push API → APNs/FCM → real device
    ↓ ─ push arrives within ~5s of completion ─

Operator taps notification (background or killed state)
    ↓ useNotifications.handleNotificationResponse
    ↓ data.screen='cloud-tasks' → router.push('/cloud-tasks')
    ↓ ─ app routes to the task list ─
```

If any link breaks, this runbook tells you which one.

---

## Prerequisites

| Item | Where | Verified? |
|------|-------|-----------|
| Migration 092 applied to Supabase | `supabase/migrations/092_*.sql` (CI gate "Apply migrations to Postgres" passed for PR #316) | ✅ PR #316 |
| send-push-notification edge function deployed with cloud_task_* event types | `supabase functions deploy send-push-notification` | Operator post-merge |
| `supabase_functions_api_key` in vault | Supabase Dashboard → Project Settings → Vault | ✅ Migration 019-era setup |
| Test user is `Power` tier | Supabase `subscriptions` table — `plan='power'` for that user | Operator |
| Test user has `push_session_complete=true` and `push_session_errors=true` | `notification_preferences` row | Operator |
| Real iPhone OR Android device, paired with the test user (P12 walkthrough complete) | Operator's device | ✅ Task #72 |
| At least one recent `sessions` row owned by the test user | Any prior CLI session | Operator |
| CLI bound to the test user's account, ready to pick up queued tasks | `styrby login` succeeded | Operator |

---

## Step 1 — Discoverability (Dashboard card)

1. Cold-launch the mobile app (force-quit first to bypass any in-memory state).
2. Sign in as the test user.
3. On the Dashboard tab, scroll down past AGENTS.

**Expected:** A "CLOUD" section appears between AGENTS and ACTIVITY with a
single card "Cloud Tasks — Monitor async agent jobs from your CLI". The card
icon is a cloud glyph in the orange brand color.

**Failure modes:**
- Card missing → check `app/(tabs)/index.tsx` was deployed; rebuild dev client.
- Card has wrong icon → CDN cache; force a hard reload from the dev menu.

---

## Step 2 — Tier gate enforcement (negative test)

1. In Supabase, temporarily set the test user's `subscriptions.plan` to `'pro'`.
2. Cold-launch the app, tap the Cloud Tasks card.

**Expected:** Full-screen "Power Plan Required" gate with cloud icon, "Cloud
Tasks is part of the Power plan." copy, and (Android only) an "Upgrade"
button linking to the Polar customer portal. iOS shows the platform billing
note instead of an upgrade button (App Store §3.1.3(a)).

3. Restore the user to `plan='power'` before continuing.

**Failure modes:**
- Free user can see the task list → `useSubscriptionTier` returned wrong value;
  check `subscriptions` row + RLS.
- Upgrade button shown on iOS → `getUpgradeButtonLabel` regression.

---

## Step 3 — Live task list (read path)

1. As the Power user, tap the Cloud Tasks card.
2. From a separate terminal, run:
   ```bash
   styrby cloud submit "list my open issues" --agent claude
   ```

**Expected:** Within 1-2 seconds of the CLI's success line, the new task
appears at the **top** of the mobile list with status badge "Queued" (yellow).
No manual refresh required.

3. Wait for the agent to start; status flips to "Running" (blue) with a
   spinning indicator.
4. Wait for completion; status flips to "Done" (green) with cost displayed.

**Expected:** All three transitions are delivered live via Realtime. The
list reorders if needed (newest startedAt first).

**Failure modes:**
- New task doesn't appear → check Realtime subscription in dev menu; the
  filter should be `user_id=eq.<user-id>`.
- Status doesn't update → CLI not writing back to `cloud_tasks` (separate
  bug, not this PR's scope).

---

## Step 4 — Cancel (write path)

1. Submit a long-running task: `styrby cloud submit "wait 60s then echo done"
   --agent claude`.
2. While it's `Running`, on mobile, swipe to the task and tap **Cancel**.

**Expected:** The Cancel button shows a spinner briefly, then the status
flips to "Cancelled" (gray). The optimistic UI update happens immediately;
the realtime confirmation arrives shortly after.

3. Confirm in Supabase Studio: the row's status is `cancelled` and
   `updated_at` reflects the moment you tapped.

**Failure modes:**
- Cancel button is missing on a running task → `CANCELLABLE_STATUSES`
  drift between mobile and CLI; verify `src/services/cloud-tasks.ts:32`.
- Tapping Cancel produces an error Alert with "Cannot cancel task with
  status..." → race between completion and cancel; expected, not a bug.

---

## Step 5 — Submit from mobile (dispatch path)

1. On the Cloud Tasks screen, tap the orange "+" FAB (bottom right).

**Expected:** Bottom-sheet modal "New Cloud Task" slides up. Three sections:
**Agent** (horizontal scroll chips, claude pre-selected), **Link to a recent
session (optional)** (radio list with up to 10 recent sessions + a "None"
option), **Prompt** (multi-line textarea).

2. Tap "Codex CLI" in the agent picker. Verify the chip turns orange.
3. Tap a recent session in the link list. Verify the radio dot fills, agent
   chip auto-changes to that session's agent, and the row shows the session's
   git branch.
4. Type "Show me the latest commits" in the prompt.
5. Tap **Submit Task**.

**Expected:**
- Submit button shows a spinner.
- Within ~1s, sheet dismisses.
- New task appears at the top of the underlying list with status "Queued",
  agent matching what you picked, and the linked session's git branch in
  the metadata badge.

**Failure modes:**
- Submit stays disabled → prompt is whitespace-only; service trims (parity
  with CLI cloud.ts:259).
- Sheet shows "Could not submit task: row violates row-level security
  policy" → user is not on Power tier despite #2 setup; check RLS on
  cloud_tasks.

---

## Step 6 — Push on completion (real device, the headline win)

1. Background the mobile app (swipe up to home; do NOT force-quit).
2. From CLI, dispatch a fast-completing task:
   ```bash
   styrby cloud submit "echo hello" --agent claude
   ```

**Expected:** Within ~5 seconds of the CLI marking `completed`, a push
notification arrives on the device:

- **Title:** "Cloud Task Complete"
- **Body:** "Claude Code: echo hello" (or the cost line if prompt is missing)
- **Channel (Android):** default
- **Priority:** default

3. Tap the notification.

**Expected:** App opens (or wakes from background), routes to `/cloud-tasks`,
the just-completed task is at the top of the list with green "Done" badge.

**Failure modes:**
- No push arrives → check, in order:
  1. `notification_preferences.push_enabled = true` for this user
  2. `push_session_complete = true`
  3. `device_tokens` has an active row for this user
  4. `pg_net._http_response` shows a 200 from the edge function (run
     `SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;`)
  5. Edge function logs in Supabase Dashboard show no errors
  6. Test user is not in quiet hours
- Push arrives but tap goes to the dashboard → `navigateToScreen` lacks
  the 'cloud-tasks' case; verify `src/hooks/useNotifications.ts:220`.

---

## Step 7 — Push on failure (negative scenario)

This requires a way to make a cloud task fail. One option:

```bash
styrby cloud submit "" --agent claude  # empty prompt
```

If the CLI rejects empty prompts client-side, fall back to forcing a failure
via a malformed prompt that confuses the agent.

**Expected:**
- Push title: "Cloud Task Failed"
- Push priority: high
- Body: "Claude Code failed on: <prompt preview>" (or generic if no prompt)
- Tapping routes to `/cloud-tasks`; the failed task is at the top with
  red "Failed" badge.

**Failure modes:** Same as Step 6, but verify `push_session_errors=true`
instead of `push_session_complete=true`.

---

## Step 8 — Cancelled status does NOT push

1. Repeat Step 4 (cancel a running task from mobile).

**Expected:** No push notification arrives on the device. The cancellation
is intentionally silent — the user just initiated it from the UI, so a
push would be redundant noise. Verify by checking the device's notification
shade is empty (for cloud tasks) for at least 30 seconds after the cancel.

**Failure modes:** A push arrived → migration 092's CASE statement is
incorrectly mapping `cancelled` to an event type; verify the trigger only
emits for `completed` and `failed`.

---

## Step 9 — Backwards compatibility (existing notifications still work)

1. Trigger a regular session-completed push (run a CLI session through to
   completion that's NOT a cloud task).

**Expected:** The push still arrives and tapping it still routes to
`/(tabs)/sessions` (legacy behavior). This PR's changes were strictly
additive — no existing routing affected.

---

## Sign-off checklist

- [ ] Step 1: Dashboard card visible
- [ ] Step 2: Tier gate enforced for free/pro user
- [ ] Step 3: Live task list updates without refresh
- [ ] Step 4: Cancel from list works + flips status in DB
- [ ] Step 5: Mobile submit dispatcher works + linked session metadata flows through
- [ ] Step 6: Push on completion arrives within 5s + tap routes to `/cloud-tasks`
- [ ] Step 7: Push on failure arrives with high priority + correct copy
- [ ] Step 8: Cancelled status does NOT push (silence verified for 30s)
- [ ] Step 9: Pre-existing notifications unaffected

When all 9 are checked: file the runbook execution result in `styrby-backlog.md`
under "Cloud Tasks Walkthrough — <date>" and mark task #97 fully closed.

If any step fails: open a fix PR using the failure-mode hints; this runbook
becomes the regression-test contract for that fix.

---

## Reference: end-to-end change inventory

The complete CloudTasks integration spans these artifacts:

- `supabase/migrations/063_cloud_tasks.sql` — table + RLS (pre-existing)
- `supabase/migrations/092_cloud_tasks_push_trigger.sql` — push trigger (PR #316)
- `supabase/functions/send-push-notification/index.ts` — extended for cloud_task_* events (PR #316)
- `packages/styrby-mobile/app/cloud-tasks.tsx` — screen orchestrator (PR #314)
- `packages/styrby-mobile/app/(tabs)/index.tsx` — Dashboard card link (PR #314)
- `packages/styrby-mobile/src/components/CloudTasks.tsx` — list + detail UI (pre-existing, wired in PR #314)
- `packages/styrby-mobile/src/components/cloud-tasks/CloudTaskSubmitSheet.tsx` — dispatcher modal (PR #315)
- `packages/styrby-mobile/src/components/tier/PowerTierGate.tsx` — generic tier gate (PR #314)
- `packages/styrby-mobile/src/services/cloud-tasks.ts` — submit + cancel service (PR #314 + PR #315)
- `packages/styrby-mobile/src/hooks/useNotifications.ts` — cloud-tasks routing (PR #316)
- `packages/styrby-cli/src/commands/cloud.ts` — CLI submit/list/cancel (pre-existing)
