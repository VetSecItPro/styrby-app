# P12: Mobile Push Real-Device Test Runbook

**Owner:** Operator (real device required)
**Engineering status:** Complete (P2-A/B/C shipped — PRs #287/#290/#291)
**Last verified:** Pending (this runbook is the verification)

---

## Purpose

Confirm the mobile push pipeline works end-to-end on a real iPhone and a real
Android phone. Engineering side is complete; this is the empirical
"does a notification actually arrive" check.

Pipeline being verified:

```
Mobile app starts
    ↓ getExpoPushTokenAsync() (services/notifications.ts)
    ↓ POST /api/push/subscribe        ← persists to device_tokens
    ↓ ─ device is registered ─

Operator triggers test push
    ↓ POST /api/internal/test-push     ← admin-only
    ↓ → supabase fn send-push-notification
    ↓ → exp.host/--/api/v2/push/send
    ↓ → APNs (iOS) / FCM (Android)
    ↓ ─ device receives notification ─

Operator taps notification
    ↓ Notifications.addNotificationResponseReceivedListener
    ↓ ─ app routes to expected screen ─
```

If any link in this chain breaks, this runbook tells you which one.

---

## Prerequisites

| Item | Where | Verified? |
|------|-------|-----------|
| Apple Developer account on team `L68P4Y7N55` | Apple Developer Portal | ✅ P2-B |
| APNs auth key uploaded to EAS Credentials | `eas credentials -p ios` | ✅ P2-B |
| `google-services.json` at `packages/styrby-mobile/google-services.json` | repo | ✅ P2-C |
| Bundle ID `com.steelmotion.styrby` registered | Apple Developer Portal | ✅ P2-B |
| Expo project bound: `@vetsecitpro/styrby` (id `747dccfc-…`) | `app.json` | ✅ P2-A |
| Admin role for the test user | Supabase `site_admins` table | Verify in dashboard |
| `eas-cli` installed locally | `eas --version` | Operator |
| Real iPhone running iOS 16+ paired to same Apple ID as dev account | Operator's device | Operator |
| Real Android device with USB-debug enabled | Operator's device | Operator |

---

## Step 1 — Build a real-device dev client (one-time per platform)

The default `development` profile in `eas.json` builds for the **iOS
simulator** (won't install on a real iPhone). Use the new
`development-device` profile that came with this runbook.

### iOS

```bash
cd packages/styrby-mobile
eas build --profile development-device --platform ios
```

EAS will:
1. Auto-register the device if it's the first time (you'll get a QR code
   to scan on the iPhone — Apple's standard provisioning step).
2. Build a `.ipa` on EAS cloud (~15-20 min).
3. Output a QR code to install. Scan it on the iPhone, allow profile
   trust in Settings → General → VPN & Device Management.

### Android

```bash
eas build --profile development-device --platform android
```

EAS outputs an `.apk`. Download it on the Android phone (link from EAS
dashboard or QR code), open it, allow "Install unknown apps" for the
browser/file manager, and install.

> **Cost note:** Each EAS build counts against your monthly free tier
> (15 builds/month on the free EAS plan). Two real-device builds (one
> iOS + one Android) = 2 builds. Future re-tests reuse the installed
> client unless you change native code.

---

## Step 2 — Connect the dev client to your local dev server

```bash
cd packages/styrby-mobile
npx expo start --dev-client
```

Open the dev client app on the device, paste in the dev server URL
shown in your terminal (usually `http://<your-mac-LAN-ip>:8081`).
Phone and Mac must be on the same Wi-Fi.

The first time the JS bundle loads, the app:
1. Calls `services/notifications.ts → getExpoPushTokenAsync()`.
2. POSTs the token to `/api/push/subscribe`.
3. The token is persisted in `device_tokens` table with `is_active=true`.

Verify in Supabase Studio:

```sql
SELECT id, user_id, platform, is_active, created_at
FROM device_tokens
WHERE user_id = '<your-user-id>'
ORDER BY created_at DESC
LIMIT 5;
```

Note the `id` of the most recent row matching your platform. That's the
`device_token_id` for Step 3.

---

## Step 3 — Fire a test push from the web

`/api/internal/test-push` is admin-only and accepts:

```json
{ "device_token_id": "<UUID from Step 2>" }
```

### Easiest: browser DevTools (logged in as admin)

```js
await fetch('/api/internal/test-push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_token_id: '<UUID>' }),
}).then(r => r.json()).then(console.log);
```

Expected response:

```json
{
  "success": true,
  "message": "Push sent successfully",
  "edgeFunctionResponse": {
    "deviceCount": 1,
    "successCount": 1,
    "failureCount": 0
  }
}
```

### Equivalent: curl with a session cookie

```bash
curl -X POST https://www.styrbyapp.com/api/internal/test-push \
  -H 'Content-Type: application/json' \
  -H "Cookie: $(pbpaste)" \
  -d '{"device_token_id":"<UUID>"}'
```

(Where `$(pbpaste)` is the session cookie copied from a logged-in admin
browser tab — DevTools → Application → Cookies → copy the `sb-*-auth-token`
row.)

---

## Step 4 — Verify the notification

Within 1-5 seconds you should see on the device:

| Platform | Foreground (app open) | Background (app closed) | Locked screen |
|----------|----------------------|-------------------------|---------------|
| iOS | Banner + sound (per `services/notifications.ts:40` setNotificationHandler) | Banner + badge | Banner on lock |
| Android | Heads-up notification | Status bar notification | Heads-up + lock-screen banner |

Notification content:

```
Title: Styrby Push Test
Body:  Test notification sent by admin to <ios|android> device
```

### Tap the notification

Tapping fires `Notifications.addNotificationResponseReceivedListener`
(wired in `src/hooks/useNotifications.ts:377`). The test payload uses
`type: 'session_started'`, which routes to the sessions tab. If the app
opens to that screen — tap routing works.

---

## Step 5 — Record the result

Update the backlog `styrby-backlog.md` Pre-launch task list section:

```markdown
- [x] **P12** Mobile push on real devices — VERIFIED <YYYY-MM-DD>:
  iOS receipt + tap-route ✓, Android receipt + tap-route ✓.
  Test push id <edge fn audit_log id>.
```

And mark task #72 completed.

---

## Troubleshooting

### `getExpoPushTokenAsync` throws or returns null
- Verify `app.json` has correct `expo.ios.bundleIdentifier` and
  `expo.android.package` matching what's in EAS Credentials.
- Verify `ios.entitlements.aps-environment` is set (auto-handled by
  Expo when build profile uses production push entitlement; dev builds
  use sandbox APNs).
- Check device hasn't denied notifications in Settings.

### `device_tokens` row not appearing after app launch
- Check the dev server console for the POST `/api/push/subscribe` request.
- 401? User isn't authenticated (login flow incomplete).
- 500? Check Supabase logs; likely RLS denied insert — verify your user
  has the right `auth.uid()` and the policy in migration ~035 is intact.

### Edge function returns `successCount: 0, failureCount: 1`
- The Expo Push API rejected the token. Check the `error` field in the
  edge function audit log. Common causes:
  - **`DeviceNotRegistered`**: token expired or app uninstalled. Mark
    token `is_active=false` in DB and re-launch app to re-register.
  - **`InvalidCredentials`**: APNs key in EAS Credentials is wrong/expired.
    Re-run `eas credentials -p ios → Push Notifications`.
  - **`MismatchSenderId`** (Android): `google-services.json` doesn't match
    Firebase project. Re-download from Firebase console and re-deploy.

### Push delivers to one platform but not the other
- iOS-only failure → APNs side. Check Expo dashboard → Project →
  Credentials → iOS for "valid" status.
- Android-only failure → FCM side. Check Firebase console → Project
  Settings → Cloud Messaging → confirm app `com.steelmotion.styrby`
  is registered and the server key is current.

### Notification arrives but tap doesn't route correctly
- Add a temporary `console.log` to `useNotifications.ts:addNotificationResponseReceivedListener`
  callback. Verify the response payload has `data.type` matching what the
  test push sent (`session_started`).
- If type matches but routing is silent, check the tab navigator setup
  in `app/(tabs)/_layout.tsx`.

---

## When this runbook becomes stale

Re-run if any of these happens:

1. APNs key rotated (annual recommended; mandatory if leaked)
2. Firebase service-account key rotated
3. `app.json` bundle identifier or package name changes
4. Expo project re-bound to a different Expo account
5. After any major Expo SDK upgrade (next will be SDK 55)
