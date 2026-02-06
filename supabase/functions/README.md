# Supabase Edge Functions

## Deploying Functions

### Prerequisites
1. Install Supabase CLI: `npm install -g supabase`
2. Login: `supabase login`
3. Link project: `supabase link --project-ref akmtmxunjhsgldjztdtt`

### Deploy All Functions
```bash
supabase functions deploy
```

### Deploy Single Function
```bash
supabase functions deploy polar-webhook
```

### Set Environment Variables
```bash
# Required for polar-webhook
supabase secrets set POLAR_WEBHOOK_SECRET=whsec_xxx
supabase secrets set POLAR_PRO_PRODUCT_ID=prod_xxx
supabase secrets set POLAR_POWER_PRODUCT_ID=prod_xxx

# Required for generate-summary
supabase secrets set OPENAI_API_KEY=sk-xxx
```

## Functions

### polar-webhook
Handles Polar subscription lifecycle events:
- `subscription.created` - Creates subscription record, updates user tier
- `subscription.updated` - Updates subscription status and period
- `subscription.canceled` - Marks subscription canceled, downgrades tier
- `order.created` - Logs payment to audit trail

**Endpoint:** `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/polar-webhook`

**Configure in Polar Dashboard:**
1. Go to Settings → Webhooks → Create Webhook
2. URL: `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/polar-webhook`
3. Events: `subscription.created`, `subscription.updated`, `subscription.canceled`, `order.created`
4. Copy the webhook secret and set it as `POLAR_WEBHOOK_SECRET`

### generate-summary
Generates AI-powered summaries for completed coding sessions.

**Endpoint:** `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/generate-summary`

**Trigger:** Called automatically by database trigger when session status changes to `stopped` or `expired`.

**Features:**
- Fetches the 50 most recent messages from the session
- Calls OpenAI API (gpt-4o-mini) to generate a concise summary
- Stores the summary in the sessions table
- Only runs for Pro and Power tier users (free tier is skipped)

**Request Body:**
```json
{
  "session_id": "uuid-here",
  "user_id": "uuid-here"  // Optional, included by trigger
}
```

**Response:**
```json
{
  "success": true,
  "message": "Summary generated successfully",
  "session_id": "uuid-here",
  "summary": "The user worked on...",
  "tokens_used": 450
}
```

### send-push-notification
Delivers push notifications to users' mobile devices via Expo Push API.

**Endpoint:** `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/send-push-notification`

**Features:**
- Rate limiting (100 per user per hour)
- Notification preferences and quiet hours
- Deactivates invalid device tokens
- Supports permission requests, budget alerts, session events
